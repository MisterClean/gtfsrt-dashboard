// Application state. One selection scopes every view, and results are re-read
// from the worker's merged rollups whenever it changes.
import {engine} from '../engine/client';
import type {
  AnalyzeResult, EngineEvent, Feed, Mode, Overview, QualityReport, ReadRecord, RouteScore, ScheduleRecord, Selection,
} from '../engine/types';
import {decodeDates, encodeDates, lastDays} from './dates';
import type {Units} from './format';

export type View = 'overview' | 'map' | 'routes' | 'route' | 'reliability' | 'stops' | 'hotspots' | 'data';

const STORAGE_KEY = 'transit-notebook-preferences';

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

  dates = $state<number[]>([]);
  cachedDates = $state<number[]>([]);
  cachedBytes = $state(0);
  analyzedDates = $state<number[]>([]);

  mode = $state<Mode>('All');
  earlyS = $state(-60);
  lateS = $state(300);

  view = $state<View>('overview');
  routeId = $state<string | null>(null);
  directionIndex = $state(0);
  mapHour = $state(17);

  units = $state<Units>('imperial');
  theme = $state<'auto' | 'light' | 'dark'>('auto');
  basemap = $state(true);
  darkActive = $state(false);

  running = $state(false);
  stage = $state<{message: string; fraction: number; dayIndex: number; dayCount: number} | null>(null);
  error = $state<string | null>(null);
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

  feed = $derived(this.feeds.find(f => f.base64url === this.feedKey) ?? null);
  loadedDates = $derived(this.dates.filter(d => this.analyzedDates.includes(d)));
  pendingDates = $derived(this.dates.filter(d => !this.analyzedDates.includes(d)));
  hasResults = $derived(this.loadedDates.length > 0);
  uncachedDates = $derived(this.dates.filter(d => !this.cachedDates.includes(d)));

  constructor() {
    const preferences = loadPreferences();
    this.units = preferences.units;
    this.theme = preferences.theme;
    this.basemap = preferences.basemap;
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    engine.onEvent(event => this.handleEvent(event));
    addEventListener('popstate', () => this.readUrl());
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
    if (Number.isInteger(hour) && hour >= 0 && hour < 30 && params.has('hour')) this.mapHour = hour;
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
    if (this.running) await this.stop();
    const changed = feedKey !== this.feedKey;
    this.feedKey = feedKey;
    if (changed) {
      this.analyzedDates = [];
      this.overview = null;
      this.routes = [];
      this.quality = null;
      this.reads = [];
      this.schedules = [];
      this.warnings = [];
      this.result = null;
      this.error = null;
      this.mode = fromUrl ? this.mode : 'All';
      if (!fromUrl) this.routeId = null;
      await engine.openFeed(feedKey);
    }
    await this.refreshCached();
    const feed = this.feed;
    if (dates) this.dates = dates;
    else if (feed) this.dates = lastDays(feed.date_min, feed.date_max, 'weekday', 5);
    this.writeUrl();
    // Days already on this device load without asking. New downloads wait for a click.
    if (this.dates.some(d => this.cachedDates.includes(d))) {
      await this.analyze(this.dates.filter(d => this.cachedDates.includes(d)));
    }
  }

  async refreshCached() {
    if (!this.feedKey) return;
    const cached = await engine.cachedDays(this.feedKey);
    this.cachedDates = cached.dates;
    this.cachedBytes = cached.bytes;
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
    this.running = true;
    this.error = null;
    this.stage = {message: 'Starting', fraction: 0, dayIndex: 0, dayCount: dates.length};
    try {
      const result = await engine.analyze({feedKey: this.feedKey, dates: [...dates], dateMax: this.feed.date_max});
      this.result = result;
      for (const skipped of result.skipped) this.addWarning(`${skipped.date}: ${skipped.reason}`);
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.running = false;
      this.stage = null;
      await this.refreshCached();
      await this.refresh();
    }
  }

  async stop() {
    await engine.stop();
    this.running = false;
    this.stage = null;
  }

  async clearCache(all = false) {
    await engine.clearCache(all ? undefined : this.feedKey ?? undefined);
    this.analyzedDates = [];
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
    switch (event.event) {
      case 'stage':
        this.stage = {message: event.message, fraction: event.fraction, dayIndex: event.dayIndex, dayCount: event.dayCount};
        break;
      case 'day':
        if (!this.analyzedDates.includes(event.date)) this.analyzedDates = [...this.analyzedDates, event.date];
        this.scheduleRefresh();
        break;
      case 'read':
        this.reads = [...this.reads, event.record];
        break;
      case 'schedule':
        this.schedules = [...this.schedules.filter(s => s.key !== event.record.key), event.record];
        for (const warning of event.record.warnings) this.addWarning(warning);
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
    if (!this.loadedDates.length) {
      this.overview = null;
      this.routes = [];
      this.quality = null;
      this.version += 1;
      return;
    }
    try {
      await engine.select(this.selection());
      const [overview, routes, quality] = await Promise.all([engine.overview(), engine.routes(), engine.quality()]);
      this.overview = overview;
      this.routes = routes;
      this.quality = quality;
      this.version += 1;
    } catch (error) {
      this.error = errorText(error);
    }
  }

  // ---- Navigation -----------------------------------------------------------

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

export function feedLabel(feed: Feed) {
  const name = feed.agency_name ?? feed.agency_id ?? 'Unnamed agency';
  return feed.system_name ? `${name} · ${feed.system_name}` : name;
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const app = new AppState();
