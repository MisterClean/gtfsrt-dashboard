// The main thread's handle on the worker: every call returns a promise.
import type {
  AnalyzeRequest, AnalyzeResult, CachedDays, EngineEvent, Feed, HotspotReport, NetworkMap, Overview,
  QualityReport, RouteDetail, RouteScore, Selection, StopsReport, StringLineResult,
} from './types';

type RunEvent = EngineEvent & {run: number};
type Pending = {resolve: (value: any) => void; reject: (reason: Error) => void};

class EngineClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private listeners = new Set<(event: RunEvent) => void>();
  private failure: Error | null = null;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module', name: 'transit-engine'});
    this.worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      if (data.event) {
        for (const listener of this.listeners) listener(data as RunEvent);
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    });
    this.worker.addEventListener('error', event => {
      this.failure = new Error('The analysis engine stopped unexpectedly. Reload the page to continue.');
      void event;
      for (const pending of this.pending.values()) pending.reject(this.failure);
      this.pending.clear();
    });
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.worker.postMessage({id, method, args});
    });
  }

  onEvent(listener: (event: RunEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  init = () => this.call<boolean>('init', document.baseURI);
  catalog = () => this.call<Feed[]>('catalog');
  analyze = (request: AnalyzeRequest) => this.call<AnalyzeResult>('analyze', request);
  stop = () => this.call<boolean>('stop');
  cachedDays = (feedKey: string) => this.call<CachedDays>('cachedDays', feedKey);
  clearCache = (feedKey?: string) => this.call<boolean>('clearCache', feedKey);
  openFeed = (feedKey: string) => this.call<boolean>('openFeed', feedKey);
  select = (selection: Selection) => this.call<boolean>('select', JSON.stringify(selection));
  overview = () => this.call<Overview>('overview');
  routes = () => this.call<RouteScore[]>('routes');
  networkMap = (route?: string) => this.call<NetworkMap>('networkMap', route);
  hotspots = () => this.call<HotspotReport>('hotspots');
  routeDetail = (route: string) => this.call<RouteDetail | null>('routeDetail', route);
  stringLine = (route: string, dir: number, date: number) => this.call<StringLineResult>('stringLine', route, dir, date);
  stops = () => this.call<StopsReport>('stops');
  quality = () => this.call<QualityReport>('quality');
}

export const engine = new EngineClient();
