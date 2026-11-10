// Application state. One selection scopes every view, and results are re-read
// from the worker's merged rollups whenever it changes.
import {engine} from '../engine/client';
import type {
  AnalyzeResult, EngineEvent, Feed, Mode, Overview, QualityReport, ReadRecord, RouteScore, ScheduleRecord, Selection,
} from '../engine/types';
import {decodeDates, encodeDates, lastDays} from './dates';
import {slowestHour} from './findings';
import {dateNumber, plural, type Units} from './format.ts';
import {parseHealthFile, staleness, type FeedHealth} from './health.ts';

export type View = 'overview' | 'map' | 'routes' | 'route' | 'reliability' | 'stops' | 'hotspots' | 'data';

// Keep the original key so saved preferences survive the rename.
const STORAGE_KEY = 'transit-notebook-preferences';
/** With streaming reads, this long without a sign of progress means something is stuck. */
const STALL_MS = 120_000;

interface Preferences { units: Units; theme: 'auto' | 'light' | 'dark'; basemap: boolean }

function loadPreferences(): Preferences {
  const defaults: Preferences = {units: 'imperial', theme: 'auto', basemap: true};
  try {
    return {...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')};
  } catch {
    return defaults;
  }
}

class AppState {
  feeds = $state<Feed[]>([]);
  feedKey = $state<string | null>(null);
  catalogError = $state<string | null>(null);
  /** Generated feed health, keyed by feed. Empty when the file is missing; every feed then stays selectable. */
  health = $state<Record<string, FeedHealth>>({});
  showAllFeeds = $state(false);

  dates = $state<number[]>([]);
  cachedDates = $state<number[]>([]);
  cachedBytes = $state(0);
  analyzedDates = $state<number[]>([]);
  /** Days the archive has nothing for. They aren't results, and aren't pending either. */
  unavailableDates = $state<Record<number, string>>({});

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

  running = $state(false);
  stage = $state<{message: string; fraction: number; dayIndex: number; dayCount: number} | null>(null);
  error = $state<string | null>(null);
  reportError = $state<string | null>(null);
  /** No sign of progress for a while, usually a stalled connection. */
  stalled = $state(false);
  warnings = $state<string[]>([]);
  reads = $state<ReadRecord[]>([]);
  schedules = $state<ScheduleRecord[]>([]);
  result = $state<AnalyzeResult | null>(null);

  /** Bumps whenever merged results change. Views re-read their report on it. */
  version = $state(0);
  overview = $state<Overview | null>(null);
  routes = $state<RouteScore[]>([]);
  quality = $state<QualityReport | null>(null);

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Results from a run or a refresh that has been superseded are ignored. */
  private currentRun = 0;
  private refreshToken = 0;
  private lastProgress = 0;
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
  loadedDates = $derived(this.dates.filter(d => this.analyzedDates.includes(d)));
  pendingDates = $derived(this.dates.filter(d => !this.analyzedDates.includes(d) && !(d in this.unavailableDates)));
  hasResults = $derived(this.loadedDates.length > 0);
  uncachedDates = $derived(this.dates.filter(d => !this.cachedDates.includes(d)));

  constructor() {
    const preferences = loadPreferences();
    this.units = preferences.units;
    this.theme = preferences.theme;
    this.basemap = preferences.basemap;
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    engine.onEvent(event => {
      if (event.run === this.currentRun) this.handleEvent(event);
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
    try {
      await engine.init();
      const feeds = await engine.catalog();
      this.feeds = feeds
        .filter(f => f.feed_type === 'vehicle_positions' && /^[A-Za-z0-9_-]+$/.test(f.base64url))
        .sort((a, b) => feedLabel(a).localeCompare(feedLabel(b)));
      if (!this.feeds.length) throw new Error('The catalog lists no vehicle-position feeds. Try again later.');
      this.health = await loadHealth();
      this.readUrl();
    } catch (error) {
      this.catalogError = errorText(error);
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
    this.selectFeed(feed.base64url, dates.length ? dates : null, true);
  }

  writeUrl() {
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
      this.currentRun += 1;
      this.refreshToken += 1;
      clearTimeout(this.refreshTimer);
      this.running = false;
      this.stage = null;
      this.analyzedDates = [];
      this.unavailableDates = {};
      this.overview = null;
      this.routes = [];
      this.quality = null;
      this.reads = [];
      this.schedules = [];
      this.warnings = [];
      this.result = null;
      this.error = null;
      this.reportError = null;
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
    // Days already on this device load without asking. New downloads wait for a click.
    if (this.dates.some(d => this.cachedDates.includes(d))) {
      await this.analyze(this.dates.filter(d => this.cachedDates.includes(d)));
    }
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
    const cached = await engine.cachedDays(this.feedKey);
    this.cachedDates = cached.dates;
    this.cachedBytes = cached.bytes;
  }

  /** For a feed with nothing near today: select its newest complete day, on request. */
  useLatestDay() {
    if (this.stale) this.setDates([dateNumber(this.stale.latest_day)]);
  }

  setDates(dates: number[]) {
    this.dates = [...new Set(dates)].sort((a, b) => a - b);
    this.writeUrl();
    this.scheduleRefresh();
    const known = this.dates.filter(d => this.cachedDates.includes(d) && !this.analyzedDates.includes(d));
    if (known.length && !this.running) this.analyze(known);
  }

  // ---- Running --------------------------------------------------------------

  async analyze(dates = this.pendingDates) {
    if (!this.feedKey || !this.feed || this.running || !dates.length) return;
    const run = ++this.currentRun;
    this.running = true;
    this.error = null;
    this.stalled = false;
    this.lastProgress = Date.now();
    this.stage = {message: 'Starting', fraction: 0, dayIndex: 0, dayCount: dates.length};
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.running) this.stalled = Date.now() - this.lastProgress > STALL_MS;
    }, 5000);
    try {
      const result = await engine.analyze({run, feedKey: this.feedKey, dates: [...dates], dateMax: this.feed.date_max});
      if (run === this.currentRun) this.result = result;
    } catch (error) {
      if (run === this.currentRun) this.error = errorText(error);
    } finally {
      if (run === this.currentRun) {
        clearInterval(this.watchdog);
        this.running = false;
        this.stalled = false;
        this.stage = null;
        await this.refreshCached();
        await this.refresh();
      }
    }
  }

  /** Stops the analysis. Days already finished stay. */
  async stop() {
    await engine.stop();
  }

  async clearCache(all = false) {
    await engine.clearCache(all ? undefined : this.feedKey ?? undefined);
    this.currentRun += 1;
    this.running = false;
    this.stage = null;
    this.analyzedDates = [];
    this.unavailableDates = {};
    this.overview = null;
    this.routes = [];
    this.quality = null;
    this.version += 1;
    if (this.feedKey) await engine.openFeed(this.feedKey);
    await this.refreshCached();
  }

  private addWarning(message: string) {
    if (!this.warnings.includes(message)) this.warnings = [...this.warnings, message];
  }

  private handleEvent(event: EngineEvent) {
    this.lastProgress = Date.now();
    this.stalled = false;
    switch (event.event) {
      case 'stage':
        this.stage = {message: event.message, fraction: event.fraction, dayIndex: event.dayIndex, dayCount: event.dayCount};
        break;
      case 'day':
        if (!this.analyzedDates.includes(event.date)) this.analyzedDates = [...this.analyzedDates, event.date];
        this.scheduleRefresh();
        break;
      case 'unavailable':
        this.unavailableDates = {...this.unavailableDates, [event.date]: event.reason};
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
    this.refreshTimer = setTimeout(() => this.refresh(), 120);
  }

  /** Re-merges the selected days and re-reads the shared reports. */
  async refresh() {
    clearTimeout(this.refreshTimer);
    if (!this.feedKey) return;
    const token = ++this.refreshToken;
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

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const app = new AppState();
