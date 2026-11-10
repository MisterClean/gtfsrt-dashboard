import type {NetworkMap, Overview, RouteDetail, RouteScore, StringLine, StringLineResult, StringLineTrip} from '../engine/types';

export const CTA_ROUTE_MATCH_MIN = 0.5;

export interface SnapshotManifest {
  version: 1;
  requestedDates: string[];
  overview: Overview;
  routes: RouteScore[];
  /** A report filename per route, relative to the manifest. */
  details: Record<string, string>;
  /** Share of eligible position reports assigned to an active scheduled trip, by route. */
  routeTripMatch?: Record<string, number>;
  notes?: string[];
  sources?: {label: string; url: string}[];
}

type SnapshotLines = Record<string, Record<string, StringLineResult>>;

type PackedTrip = [tripId: string, vehicle: string, deviationEnd: number | null, points: number[]];
type PackedLine = Omit<StringLine, 'trips'> & {trips: PackedTrip[]};
interface PackedSnapshotLines {
  version: 1;
  distances: number[];
  directions: Record<string, Record<string, {available: boolean; line: PackedLine | null}>>;
}

type LineData = SnapshotLines | PackedSnapshotLines;

interface SnapshotReport {
  route: RouteDetail;
  map: NetworkMap;
  /** A companion report keeps trip-level data off the route report's critical path. */
  lines?: string | LineData;
}

export type SnapshotLocation = {view: 'routes' | 'data'; routeId: null} | {view: 'route'; routeId: string};

export function readSnapshotLocation(hash: string): SnapshotLocation {
  if (hash === '#data') return {view: 'data', routeId: null};
  if (hash.startsWith('#route/')) {
    try {
      const routeId = decodeURIComponent(hash.slice('#route/'.length));
      if (routeId) return {view: 'route', routeId};
    } catch {
      // A malformed URL opens the scorecard.
    }
  }
  return {view: 'routes', routeId: null};
}

export function snapshotHash(view: SnapshotLocation['view'], routeId: string | null) {
  if (view === 'data') return '#data';
  return view === 'route' && routeId ? `#route/${encodeURIComponent(routeId)}` : '#routes';
}

async function readJson<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The snapshot file could not be read (HTTP ${response.status}).`);
  if (url.pathname.endsWith('.gz')) {
    const bytes = await response.arrayBuffer();
    const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
    if (header[0] === 0x1f && header[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).json() as Promise<T>;
    }
    // Some hosts deliver gzip files already decoded via Content-Encoding.
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  return response.json() as Promise<T>;
}

function resolveFile(base: URL, path: string) {
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error('The snapshot refers to a report outside its data directory.');
  }
  return url;
}

function isPacked(data: LineData): data is PackedSnapshotLines {
  return data.version === 1;
}

function unpackTrip([tripId, vehicle, deviationEnd, points]: PackedTrip, distances: number[]): StringLineTrip {
  const observed: StringLineTrip['observed'] = [];
  const scheduled: StringLineTrip['scheduled'] = [];
  let scheduleTime = 0;
  let distanceIndex = 0;
  // Each stop event stores the scheduled time delta, deviation and distance index delta.
  for (let i = 0; i < points.length; i += 3) {
    scheduleTime += points[i];
    distanceIndex += points[i + 2];
    const distance = distances[distanceIndex];
    scheduled.push([scheduleTime, distance]);
    observed.push([scheduleTime + points[i + 1], distance]);
  }
  return {trip_id: tripId, vehicle, deviation_end_s: deviationEnd, observed, scheduled};
}

/** Immutable reports. Keep the selected route's promises so changing day or direction reuses them. */
export class SnapshotClient {
  readonly manifest: SnapshotManifest;
  private readonly base: URL;
  private active: {id: string; report: Promise<SnapshotReport>; lines?: Promise<LineData>} | null = null;

  private constructor(manifest: SnapshotManifest, base: URL) {
    this.manifest = manifest;
    this.base = base;
  }

  static async open(url: URL) {
    const manifest = await readJson<SnapshotManifest>(url);
    if (manifest?.version !== 1 || !Array.isArray(manifest.requestedDates) || !manifest.requestedDates.length ||
      !Array.isArray(manifest.overview?.dates) || !Array.isArray(manifest.overview.days) ||
      !Array.isArray(manifest.routes) || !manifest.details) {
      throw new Error('The snapshot index is missing or uses an unsupported format.');
    }
    return new SnapshotClient(manifest, new URL('./', url));
  }

  private readRoute(id: string) {
    if (!Object.hasOwn(this.manifest.details, id)) return null;
    if (this.active?.id === id) return this.active;
    const report = readJson<SnapshotReport>(resolveFile(this.base, this.manifest.details[id]));
    this.active = {id, report};
    void report.catch(() => {
      if (this.active?.report === report) this.active = null;
    });
    return this.active;
  }

  async route(id: string) {
    const entry = this.readRoute(id);
    return entry ? entry.report : null;
  }

  async stringLine(id: string, direction: number, date: string): Promise<StringLineResult> {
    const entry = this.readRoute(id);
    if (!entry) return {available: false, line: null};
    const {lines} = await entry.report;
    if (typeof lines === 'string' && !entry.lines) {
      const request = readJson<LineData>(resolveFile(this.base, lines));
      entry.lines = request;
      void request.catch(() => {
        if (entry.lines === request) entry.lines = undefined;
      });
    }
    const data = typeof lines === 'string' ? await entry.lines : lines;
    if (data && isPacked(data)) {
      const selected = data.directions[String(direction)]?.[date];
      if (!selected) return {available: false, line: null};
      const {available, line} = selected;
      return {available, line: line && {...line, trips: line.trips.map(trip => unpackTrip(trip, data.distances))}};
    }
    return data?.[String(direction)]?.[date] ?? {available: false, line: null};
  }
}
