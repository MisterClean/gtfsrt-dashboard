import {registerPositionSource, openDailySource} from '../../src/engine/worker';
import {sha256} from '../../src/engine/sources/daily';
let file: File;
registerPositionSource({
  name: 'Local fixture',
  matches: key => key === 'local-fixture',
  discover: async () => [],
  async open(run, request) {
    const hash = await sha256(new Uint8Array(await file.arrayBuffer()));
    const object = {handle: {kind: 'local' as const, file, sha256: hash}, rows: 100};
    return openDailySource(run, request.dates, {
      timezone: 'America/Chicago', reportTime: 'Poll time', routeType: 1, gaps: [],
      objects: new Map([['2026-11-02', object], ['2026-11-03', object]]),
    });
  },
});
addEventListener('message', event => {
  if (event.data.fixture) {
    file = event.data.fixture;
    event.ports[0].postMessage(true);
  }
});
