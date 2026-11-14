// Application state. One selection scopes every view, and results are re-read
// from the worker's merged rollups whenever it changes.
import {engine} from '../engine/client';
import {EngineError, friendlyError} from '../engine/errors';
import type {
  AnalyzeResult, EngineEvent, Feed, Mode, Overview, QualityReport, ReadRecord, RouteScore, ScheduleRecord, Selection,
} from '../engine/types';
import {decodeDates, encodeDates, lastDays} from './dates';
import {slowestHour} from './findings';
import {dateNumber, plural, type Units} from './format.ts';
import {parseHealthFile, staleness, type FeedHealth} from './health.ts';
import {datesWhere, dayOf, inFlight, isPending, markSaved, queueDays, reduceDays, releaseDays, settleDays, type Days, type Outcome} from './days.ts';
import {IDLE, checkStall, endRun, failRun, runEvent, selectionChanged, startRun, type RunState} from './run.ts';
import {bootFailed, isBooting, type Boot, type BootStep} from './startup.ts';
import {readSnapshotLocation, snapshotHash, type SnapshotClient} from './snapshot';

export type View = 'overview' | 'map' | 'routes' | 'route' | 'reliability' | 'stops' | 'hotspots' | 'data';

// Keep the original key so saved preferences survive the rename.
const STORAGE_KEY = 'transit-notebook-preferences';
/** While a run is going, results refresh at most this often. Each refresh redraws every view. */
const RUN_REFRESH_MS = 20_000;

interface Preferences { units: Units; theme: 'auto' | 'light' | 'dark'; basemap: boolean }

/** A host whose content policy blocks the tile server (the Claude artifact) turns the street basemap off. */
function basemapAllowed() {
  return document.querySelector('meta[name="transit-basemap"]')?.getAttribute('content') !== 'off';
}

function loadPreferences(): Preferences {
  const defaults: Preferences = {units: 'imperial', theme: 'auto', basemap: true};
  let preferences = defaults;
  try {
    preferences = {...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')};
  } catch {
    // Defaults stand in a private window.
  }
  return {...preferences, basemap: preferences.basemap && basemapAllowed()};
}

class AppState {
  /** Where startup has got to. See startup.ts. */
  boot = $state.raw<Boot>({step: 'engine'});
  feeds = $state<Feed[]>([]);
  feedKey = $state<string | null>(null);
  /** Generated feed health, keyed by feed. Empty when the file is missing; every feed then stays selectable. */
  health = $state<Record<string, FeedHealth>>({});
  showAllFeeds = $state(false);

  dates = $state<number[]>([]);
  /** Every day of the open agency that has something to say about it. See days.ts. */
  days = $state.raw<Days>({});
  cachedBytes = $state(0);
  /** The analysis run: idle, running, stopped or failed. See run.ts. */
  run = $state.raw<RunState>(IDLE);
  /** The browser can't keep results. Said once, not per day. */
  cacheNotice = $state<string | null>(null);

  mode = $state<Mode>('All');
  earlyS = $state(-60);
  lateS = $state(300);

  view = $state<View>('overview');
  routeId = $state<string | null>(null);
  directionIndex = $state(0);
  mapHour = $state(17);
  /** The visitor picked an hour, or a link did. Until then the map opens on the slowest one. */
  private hourChosen = false;
  /** The method section a report link asked for, opened once the page is there. */
  methodTopic = $state<MethodTopic | null>(null);

  units = $state<Units>('imperial');
  theme = $state<'auto' | 'light' | 'dark'>('auto');
  basemap = $state(true);
  darkActive = $state(false);

  reportError = $state<string | null>(null);
  warnings = $state<string[]>([]);
  reads = $state<ReadRecord[]>([]);
  schedules = $state<ScheduleRecord[]>([]);
  result = $state<AnalyzeResult | null>(null);

  /** Bumps whenever merged results change. Views re-read their report on it. */
  version = $state(0);
  overview = $state<Overview | null>(null);
  // Raw: nothing mutates these, so there is no need to wrap every row in a reactive proxy.
  routes = $state.raw<RouteScore[]>([]);
  quality = $state<QualityReport | null>(null);
  snapshot = $state.raw<SnapshotClient | null>(null);

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Results from a run or a refresh that has been superseded are ignored. */
  private currentRun = 0;
  private refreshToken = 0;
  private lastRefresh = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  feed = $derived(this.feeds.find(f => f.base64url === this.feedKey) ?? null);
  feedHealth = $derived(this.feed ? this.health[this.feed.base64url] ?? null : null);
  /** Set when the feed's newest complete day is long past: its days are not near today. */
  stale = $derived(this.feed ? staleness(this.feed, new Date().toISOString().slice(0, 10)) : null);
  /** Which speed scale to color with. A commuter rail network on the bus scale is one solid color. */
  scaleMode = $derived.by((): Mode => {
    if (this.mode !== 'All') return this.mode;
    return (this.overview?.speed ?? 0) > 9 ? 'Rail' : 'Bus';
  });

  // Everything below is read off `days` and `run`. None of it is stored separately.
  cachedDates = $derived(datesWhere(this.days, day => day.saved));
  analyzedDates = $derived(datesWhere(this.days, day => day.status === 'loaded'));
  /** Days the archive has nothing for, with why. They aren't results, and aren't pending either. */
  unavailableDates = $derived<Record<number, string>>(Object.fromEntries(
    datesWhere(this.days, day => day.status === 'no_data').map(date => [date, this.days[date].reason ?? 'The archive has no data for this day.']),
  ));
  loadedDates = $derived(this.snapshot
    ? this.snapshot.manifest.overview.dates.map(dateNumber)
    : this.dates.filter(d => dayOf(this.days, d).status === 'loaded'));
  pendingDates = $derived(this.dates.filter(d => isPending(dayOf(this.days, d))));
  /** Selected days that are saved here and will load by themselves once the current run is done. */
  queuedNext = $derived.by(() => {
    const run = this.run;
    return run.phase === 'running' ? this.dates.filter(d => dayOf(this.days, d).status === 'queued' && !run.dates.includes(d)) : [];
  });
  hasResults = $derived(this.loadedDates.length > 0);
  uncachedDates = $derived(this.dates.filter(d => !dayOf(this.days, d).saved));

  running = $derived(this.run.phase === 'running');
  progress = $derived(this.run.phase === 'running' ? this.run.progress : null);
  stage = $derived(this.run.phase === 'running' ? this.run.progress : null);
  /** No sign of progress for a while, usually a stalled connection. */
  stalled = $derived(this.run.phase === 'running' && this.run.stalled);
  /** The last run's failure in words, while its notice is up. */
  error = $derived(this.run.phase === 'failed' ? errorText(this.run.failure) : null);

  constructor() {
    const preferences = loadPreferences();
    this.units = preferences.units;
    this.theme = preferences.theme;
    this.basemap = preferences.basemap;
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    engine.onEvent(event => {
      // Cache trouble can happen outside a run, so it isn't tied to the current one.
      if (event.event === 'cache') this.cacheNotice ??= event.message;
      else if (event.run === this.currentRun) this.handleEvent(event);
    });
  }

  // ---- Preferences ----------------------------------------------------------

  savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({units: this.units, theme: this.theme, basemap: this.basemap}));
    } catch {
      // Preferences just don't persist in a private window.
    }
  }

  applyTheme() {
    const dark = this.theme === 'dark' || (this.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    this.darkActive = dark;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  setTheme(theme: 'auto' | 'light' | 'dark') {
    this.theme = theme;
    this.applyTheme();
    this.savePreferences();
  }

  setUnits(units: Units) {
    this.units = units;
    this.savePreferences();
  }

  setBasemap(on: boolean) {
    this.basemap = on;
    this.savePreferences();
  }

  // ---- Startup --------------------------------------------------------------

  async start() {
    let step: BootStep = 'engine';
    try {
      this.boot = {step};
      await engine.init();
      this.boot = {step: (step = 'catalog')};
      const feeds = await engine.catalog();
      this.feeds = feeds
        .filter(f => f.feed_type === 'vehicle_positions' && /^[A-Za-z0-9_-]+$/.test(f.base64url))
        .sort((a, b) => feedLabel(a).localeCompare(feedLabel(b)));
      if (!this.feeds.length) throw new Error('The catalog lists no vehicle-position feeds. Try again later.');
      this.health = await loadHealth();
      this.boot = {step: (step = 'opening')};
      // Becomes ready inside, as soon as the days are chosen: loading saved days can take a while.
      await this.readUrl();
    } catch (error) {
      if (isBooting(this.boot)) {
        this.boot = bootFailed(step, error);
        console.error('[transit-almanac] startup failed while', this.boot.step === 'failed' ? this.boot.failure.context : step, error);
      } else {
        console.error('[transit-almanac] opening the first agency failed', error);
      }
    }
  }

  private readUrl() {
    const params = new URLSearchParams(location.search);
    const requested = params.get('feed');
    const fallback = this.feeds.find(f => f.agency_id === 'metro-transit-madison') ?? this.feeds[0];
    const feed = this.feeds.find(f => f.base64url === requested) ?? fallback;
    const view = params.get('view') as View | null;
    if (view && ['overview', 'map', 'routes', 'route', 'reliability', 'stops', 'hotspots', 'data'].includes(view)) this.view = view;
    this.routeId = params.get('route');
    const hour = Number(params.get('hour'));
    if (Number.isInteger(hour) && hour >= 0 && hour < 30 && params.has('hour')) this.setMapHour(hour);
    const mode = params.get('mode') as Mode | null;
    if (mode && ['All', 'Bus', 'Rail', 'Ferry', 'Other', 'Unknown'].includes(mode)) this.mode = mode;
    const dates = decodeDates(params);
    return this.selectFeed(feed.base64url, dates.length ? dates : null, true);
  }

  openSnapshot(snapshot: SnapshotClient) {
    this.snapshot = snapshot;
    this.mode = 'Bus';
    this.overview = snapshot.manifest.overview;
    this.routes = snapshot.manifest.routes;
    this.readSnapshotUrl();
  }

  readSnapshotUrl() {
    const {view, routeId} = readSnapshotLocation(location.hash);
    if (this.routeId !== routeId) this.directionIndex = 0;
    this.view = view;
    this.routeId = routeId;
  }

  writeUrl() {
    if (this.snapshot) {
      const view = this.view === 'route' || this.view === 'data' ? this.view : 'routes';
      const hash = snapshotHash(view, this.routeId);
      if (hash !== location.hash) history.pushState(null, '', hash);
      return;
    }
    const url = new URL(location.href);
    url.search = '';
    if (this.feedKey) url.searchParams.set('feed', this.feedKey);
    for (const [key, value] of Object.entries(encodeDates(this.dates))) url.searchParams.set(key, value as string);
    if (this.view !== 'overview') url.searchParams.set('view', this.view);
    if (this.routeId && this.view === 'route') url.searchParams.set('route', this.routeId);
    if (this.mode !== 'All') url.searchParams.set('mode', this.mode);
    if (this.view === 'map') url.searchParams.set('hour', String(this.mapHour));
    history.replaceState(null, '', url);
  }

  // ---- Choosing what to analyse --------------------------------------------

  async selectFeed(feedKey: string, dates: number[] | null, fromUrl = false) {
    const changed = feedKey !== this.feedKey;
    const previousDates = this.dates;
    this.feedKey = feedKey;
    if (changed) {
      // Nothing from the previous agency may land here from now on.
      this.resetFeed();
      this.warnings = [];
      this.result = null;
      this.mode = fromUrl ? this.mode : 'All';
      if (!fromUrl) this.routeId = null;
      await engine.openFeed(feedKey);
      if (feedKey !== this.feedKey) return;
      this.version += 1;
    }
    await this.refreshCached();
    if (feedKey !== this.feedKey) return;
    const feed = this.feed;
    if (dates && feed) this.dates = this.cleanDates(dates, feed);
    else if (feed) {
      // Keep the range when this agency has all of it. Otherwise start from its recent weekdays, but
      // never pick days from a feed that stopped long ago: the notice offers its latest day instead.
      const first = dateNumber(feed.date_min);
      const last = dateNumber(feed.date_max);
      const kept = previousDates.length > 0 && previousDates.every(d => d >= first && d <= last);
      this.dates = kept ? [...previousDates] : staleness(feed, new Date().toISOString().slice(0, 10)).stale ? [] : lastDays(feed.date_min, feed.date_max, 'weekday', 5);
    }
    this.writeUrl();
    if (isBooting(this.boot)) this.boot = {step: 'ready'};
    // Days already on this device load without asking. New downloads wait for a click.
    await this.analyze(this.savedToLoad());
  }

  /**
   * Everything that belongs to one agency's results and the run making them. Changing
   * agency and clearing saved results both start from here, so neither can leave a
   * piece of the old state behind.
   */
  private resetFeed() {
    this.currentRun += 1;
    this.refreshToken += 1;
    clearTimeout(this.refreshTimer);
    clearInterval(this.watchdog);
    this.run = IDLE;
    this.days = {};
    this.cachedBytes = 0;
    this.overview = null;
    this.routes = [];
    this.quality = null;
    this.reads = [];
    this.schedules = [];
    this.reportError = null;
    this.lastRefresh = 0;
  }

  /** Selected days that are saved on this device and not in memory yet. */
  private savedToLoad() {
    return this.dates.filter(d => {
      const day = dayOf(this.days, d);
      return day.saved && isPending(day);
    });
  }

  /** A shared link can name anything, so keep only real days this feed has. */
  private cleanDates(dates: number[], feed: Feed) {
    const first = dateNumber(feed.date_min);
    const last = dateNumber(feed.date_max);
    const unique = [...new Set(dates)].sort((a, b) => a - b);
    const inRange = unique.filter(d => d >= first && d <= last);
    if (inRange.length < unique.length) {
      this.addWarning(`${plural(unique.length - inRange.length, 'day')} in this link ${unique.length - inRange.length === 1 ? 'is' : 'are'} outside this feed's archive, from ${feed.date_min} to ${feed.date_max}, and ${unique.length - inRange.length === 1 ? 'was' : 'were'} left out.`);
    }
    return inRange;
  }

  async refreshCached() {
    if (!this.feedKey) return;
    const feedKey = this.feedKey;
    const cached = await engine.cachedDays(feedKey);
    if (feedKey !== this.feedKey) return;
    this.days = markSaved(this.days, cached.dates);
    this.cachedBytes = cached.bytes;
  }

  /** For a feed with nothing near today: select its newest complete day, on request. */
  useLatestDay() {
    if (this.stale) this.setDates([dateNumber(this.stale.latest_day)]);
  }

  setDates(dates: number[]) {
    this.dates = [...new Set(dates)].sort((a, b) => a - b);
    // A notice about days that are no longer selected has nothing left to say.
    this.run = selectionChanged(this.run, this.dates);
    this.writeUrl();
    this.scheduleRefresh();
    if (this.run.phase === 'running') {
      // Saved days can't join a run that is under way, so they wait for it and then load
      // by themselves. Ones deselected while waiting leave the line.
      const scope = this.run.dates;
      const waiting = datesWhere(this.days, day => day.status === 'queued').filter(d => !scope.includes(d));
      this.days = queueDays(releaseDays(this.days, waiting.filter(d => !this.dates.includes(d))), this.savedToLoad());
    } else {
      this.analyze(this.savedToLoad());
    }
  }

  // ---- Running --------------------------------------------------------------

  async analyze(dates = this.pendingDates) {
    if (!this.feedKey || !this.feed || this.running || !dates.length) return;
    const run = ++this.currentRun;
    // A notice from the run before this one comes back afterwards for whatever it still applies to.
    const earlier = this.run;
    this.days = queueDays(this.days, dates);
    this.run = startRun(run, dates);
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => (this.run = checkStall(this.run)), 5000);
    let stopped = false;
    let failure: unknown;
    try {
      const result = await engine.analyze({run, feedKey: this.feedKey, dates: [...dates], dateMax: this.feed.date_max});
      if (run === this.currentRun) this.result = result;
      stopped = result.stopped;
    } catch (error) {
      failure = error ?? new Error('The analysis failed.');
    }
    // An agency change or a cleared cache has already reset everything this run touched.
    if (run !== this.currentRun) return;
    clearInterval(this.watchdog);
    const left = dates.filter(d => inFlight(dayOf(this.days, d)));
    let next = failure === undefined ? endRun(this.run, stopped, left) : failRun(this.run, failure, left);
    const outcome: Outcome = next.phase === 'failed' ? {kind: 'failed', reason: friendlyError(next.failure).title}
      : next.phase === 'stopped' ? {kind: 'stopped'} : {kind: 'finished'};
    if (next.phase === 'failed') console.error('[transit-almanac] run failed:', next.failure.kind, next.failure.message, next.failure.cause ?? '');
    this.days = settleDays(this.days, outcome, dates);
    if (next.phase === 'idle' && (earlier.phase === 'failed' || earlier.phase === 'stopped')) {
      next = selectionChanged(earlier, this.pendingDates);
    }
    this.run = next;
    await this.refreshCached();
    await this.refresh();
    // Saved days selected while this run was going load now, however it ended: they need
    // nothing from the archive. A notice this run left comes back once they are in.
    if (run === this.currentRun) {
      await this.analyze(this.dates.filter(d => dayOf(this.days, d).status === 'queued'));
    }
  }

  /** Stops the analysis. Days already finished stay. */
  async stop() {
    await engine.stop();
  }

  /** Puts a stopped or failed run's notice away without acting on it. */
  dismissRun() {
    if (this.run.phase === 'stopped' || this.run.phase === 'failed') this.run = IDLE;
  }

  /** Asks the archive again for selected days it had nothing for. */
  recheck() {
    return this.analyze(this.dates.filter(d => dayOf(this.days, d).status === 'no_data'));
  }

  async clearCache(all = false) {
    await engine.clearCache(all ? undefined : this.feedKey ?? undefined);
    this.resetFeed();
    this.version += 1;
    if (this.feedKey) await engine.openFeed(this.feedKey);
    await this.refreshCached();
  }

  private addWarning(message: string) {
    if (!this.warnings.includes(message)) this.warnings = [...this.warnings, message];
  }

  private handleEvent(event: EngineEvent) {
    if (this.run.phase !== 'running') return;
    const scope = this.run.dates;
    this.run = runEvent(this.run, event);
    this.days = reduceDays(this.days, event, scope);
    switch (event.event) {
      case 'day':
        this.scheduleRefresh();
        break;
      case 'read':
        this.reads = [...this.reads, event.record];
        break;
      case 'schedule':
        this.schedules = [...this.schedules.filter(s => s.key !== event.record.key), event.record];
        break;
      case 'warning':
        this.addWarning(event.message);
        break;
    }
  }

  // ---- Results --------------------------------------------------------------

  selection(): Selection {
    return {
      dates: this.loadedDates,
      mode: this.mode,
      early_s: this.earlyS,
      late_s: this.lateS,
      periods: {am: [7, 9], mid: [10, 14], pm: [16, 18]},
    };
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    // The first day shows up at once. After that a run refines the views only now and
    // then, because redrawing a big agency's map and tables blocks the page for seconds.
    // The run's end always refreshes.
    const wait = this.running && this.lastRefresh ? Math.max(120, this.lastRefresh + RUN_REFRESH_MS - Date.now()) : 120;
    this.refreshTimer = setTimeout(() => this.refresh(), wait);
  }

  /** Re-merges the selected days and re-reads the shared reports. */
  async refresh() {
    clearTimeout(this.refreshTimer);
    if (!this.feedKey) return;
    const token = ++this.refreshToken;
    this.lastRefresh = Date.now();
    if (!this.loadedDates.length) {
      this.overview = null;
      this.routes = [];
      this.quality = null;
      this.reportError = null;
      this.version += 1;
      return;
    }
    try {
      await engine.select(this.selection());
      const [overview, routes, quality] = await Promise.all([engine.overview(), engine.routes(), engine.quality()]);
      if (token !== this.refreshToken) return;
      this.overview = overview;
      this.routes = routes;
      this.quality = quality;
      this.reportError = null;
      if (!this.hourChosen) this.mapHour = slowestHour(overview)?.hour ?? this.mapHour;
      this.version += 1;
    } catch (error) {
      if (token === this.refreshToken) this.reportError = errorText(error);
    }
  }

  // ---- Navigation -----------------------------------------------------------

  async loadRoute(id: string) {
    if (this.snapshot) {
      const report = await this.snapshot.route(id);
      return {id, route: report?.route ?? null, map: report?.map ?? null};
    }
    const [route, map] = await Promise.all([engine.routeDetail(id), engine.networkMap(id)]);
    return {id, route, map};
  }

  loadStringLine(id: string, dir: number, date: string) {
    return this.snapshot ? this.snapshot.stringLine(id, dir, date) : engine.stringLine(id, dir, dateNumber(date));
  }

  setMapHour(hour: number) {
    this.mapHour = hour;
    this.hourChosen = true;
  }

  showMethod(topic: MethodTopic) {
    this.methodTopic = topic;
    this.go('data');
  }

  go(view: View, routeId?: string) {
    this.view = view;
    if (routeId !== undefined) {
      this.routeId = routeId;
      this.directionIndex = 0;
    }
    this.writeUrl();
    document.querySelector('main')?.scrollTo?.({top: 0});
    scrollTo({top: 0});
  }
}

/** The sections of Data & methods a report can link to. */
export type MethodTopic = 'speed' | 'period' | 'ci' | 'time' | 'matching' | 'passes' | 'ontime' | 'headways' | 'runtime' | 'hotspots' | 'slowest' | 'spacing' | 'service';

export function feedLabel(feed: Feed) {
  const name = feed.agency_name ?? feed.agency_id ?? 'Unnamed agency';
  return feed.system_name ? `${name} · ${feed.system_name}` : name;
}

async function loadHealth() {
  try {
    const response = await fetch('./feed-health.json', {cache: 'no-cache'});
    return response.ok ? parseHealthFile(await response.json()) : {};
  } catch {
    return {};
  }
}

/** Plain-language text for an error: what happened and what to do. */
export function errorText(error: unknown) {
  if (error instanceof EngineError) {
    const friendly = friendlyError(error);
    return `${friendly.title} ${friendly.advice}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export const app = new AppState();
