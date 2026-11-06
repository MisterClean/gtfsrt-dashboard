const element = id => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const labels = {
  'browser-fetch-inventory': 'Fetch the public feed catalog',
  'browser-head': 'Read archive file metadata',
  'browser-range': 'Read a four-byte Parquet range',
  'instantiate-wasm': 'Start the WebAssembly engine',
  'engine-version': 'Verify the SQL engine version',
  'register-remote-parquet': 'Register the remote Parquet file',
  'vehicle-schema': 'Read the vehicle-position schema',
  'vehicle-row-count': 'Count archived records',
  'vehicle-sample': 'Read two complete records',
  'vehicle-route-aggregate': 'Aggregate records by route',
  'feed-metadata': 'Read feed and schedule metadata',
  'schedule-catalog': 'Fetch historical schedule versions',
};

function render() {
  let result;
  try { result = JSON.parse(element('output').textContent); } catch { return; }
  const checks = result.checks || [];
  const value = name => checks.find(check => check.name === name && check.ok)?.value;
  const passes = checks.filter(check => check.ok).length;
  const status = element('status');
  status.dataset.state = result.ok === true ? 'pass' : result.ok === false ? 'fail' : 'running';
  status.textContent = result.ok === true ? `Direct browser queries passed · ${passes} checks complete`
    : result.ok === false ? 'The browser test stopped with an error'
    : `Testing direct browser access… ${passes} checks passed`;

  const version = value('engine-version')?.rows?.[0]?.engine_version;
  if (version) element('engine').textContent = `DuckDB ${version}`;
  if (result.selection) {
    element('selection').textContent = `${result.selection.feed.agency_name} · ${result.selection.date} UTC`;
  }
  const records = value('vehicle-row-count')?.rows?.[0]?.rows;
  if (records !== undefined) element('records').textContent = `${number.format(BigInt(records))} snapshot rows`;
  const size = value('browser-head')?.contentLength;
  if (size) element('size').textContent = `${(Number(size) / 1e6).toFixed(2)} MB · ${number.format(Number(size))} bytes`;
  element('error').hidden = !result.error;
  element('error').textContent = result.error ? `${result.error}\nCheck your connection and run again; inspect the evidence below for the failed step.` : '';

  element('checks').replaceChildren(...checks.map(check => {
    const row = document.createElement('li');
    const state = document.createElement('span');
    state.className = 'check-state';
    state.dataset.state = check.ok ? 'pass' : 'fail';
    state.textContent = check.ok ? 'Pass' : 'Fail';
    const label = document.createElement('span');
    label.textContent = labels[check.name] || check.name;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = check.milliseconds < 1000 ? `${check.milliseconds} ms` : `${(check.milliseconds / 1000).toFixed(2)} s`;
    row.append(state, label, time);
    return row;
  }));

  const aggregate = value('vehicle-route-aggregate');
  if (aggregate) {
    element('route-pending').hidden = true;
    element('route-results').hidden = false;
    element('routes').replaceChildren(...aggregate.rows.map(route => {
      const row = document.createElement('tr');
      for (const text of [route.route_id ?? 'Missing route ID', number.format(BigInt(route.snapshot_rows)), number.format(BigInt(route.distinct_reported_vehicles))]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }));
    element('sql-details').hidden = false;
    element('sql').textContent = aggregate.sql.trim();
  }
  if (result.finishedAt) element('run-time').textContent = `Finished ${new Date(result.finishedAt).toLocaleTimeString()}`;
}

new MutationObserver(render).observe(element('output'), {childList: true, characterData: true, subtree: true});
element('rerun').addEventListener('click', () => location.reload());
render();
