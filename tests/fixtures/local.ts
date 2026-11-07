const worker = new Worker(new URL('./local.worker.ts', import.meta.url), {type: 'module'});
let id = 0;
const pending = new Map();
worker.onmessage = ({data}) => {
  if (pending.has(data.id)) {
    const {resolve, reject} = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(new Error(data.error)) : resolve(data.result);
  }
};
const call = (method, ...args) => new Promise((resolve, reject) => {
  pending.set(++id, {resolve, reject});
  worker.postMessage({id, method, args});
});
window.localFixture = async bytes => {
  const port = new MessageChannel();
  const ready = new Promise(resolve => port.port1.onmessage = resolve);
  worker.postMessage({fixture: new File([new Uint8Array(bytes)], 'positions.parquet')}, [port.port2]);
  await ready;
  await call('init', location.origin + '/');
  const result = await call('analyze', {run: 1, feedKey: 'local-fixture', dates: [20261102], dateMax: '2026-11-03'});
  await call('select', JSON.stringify({dates: [20261102], mode: 'All', early_s: -60, late_s: 300, periods: {am: [7,9], mid: [10,14], pm: [16,18]}}));
  return {result, overview: await call('overview'), routes: await call('routes')};
};
