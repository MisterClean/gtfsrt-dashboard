<script lang="ts">
  import Term from '../components/Term.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import {engine} from '../engine/client';
  import type {MapFeature, NetworkMap} from '../engine/types';
  import {download} from '../lib/map-export';
  import {hourRange, int, pct, routeName, speedUnit, speedWithUnit, toDisplaySpeed} from '../lib/format';
  import {HOURS} from '../lib/scale';
  import {app, errorText} from '../lib/state.svelte';
  import LineChart from '../charts/LineChart.svelte';
  import HourTimeline from '../map/HourTimeline.svelte';
  import SpeedMap, {type MapMetric, type MapPeriod} from '../map/SpeedMap.svelte';
  import {CLASS_VARS} from '../lib/speed-scale';

  let network = $state<NetworkMap | null>(null);
  let route = $state('');
  let period = $state<MapPeriod>('hour');
  let metric = $state<MapMetric>('speed');
  let pinned = $state<MapFeature | null>(null);

  let failure = $state<string | null>(null);
  let request = 0;

  $effect(() => {
    app.version;
    const filter = route || undefined;
    if (!app.hasResults) return;
    const current = ++request;
    engine.networkMap(filter).then(
      result => {
        if (current !== request) return;
        network = result;
        failure = null;
      },
      error => {
        if (current !== request) return;
        network = null;
        pinned = null;
        failure = errorText(error);
      },
    );
  });

  const current = $derived(network?.hours.find(h => h.hour === app.mapHour) ?? null);
  const periods: {value: MapPeriod; label: string}[] = [
    {value: 'hour', label: 'Hour by hour'},
    {value: 'am', label: 'AM peak'},
    {value: 'mid', label: 'Midday'},
    {value: 'pm', label: 'PM peak'},
    {value: 'all', label: 'All day'},
  ];
  const versusLabels = ['under −30%', '−30 to −20%', '−20 to −10%', 'within 10%', '+10 to +20%', '+20 to +35%', 'over +35%'];
  const unit = $derived(speedUnit(app.units));

  function setHour(hour: number) {
    app.setMapHour(hour);
    app.writeUrl();
  }
</script>

<div class="page map-page">
  <div class="head">
    <div class="title">
      <h1>Speed map</h1>
      <p class="note">Average speed on each street, stops included. Every route on a street is pooled. Zoom in to see each direction.</p>
    </div>
    <div class="tools">
      <div class="seg" role="group" aria-label="Time period">
        {#each periods as option}
          <button aria-pressed={period === option.value} onclick={() => (period = option.value)}>{option.label}</button>
        {/each}
      </div>
      <div class="seg" role="group" aria-label="Measure">
        <button aria-pressed={metric === 'speed'} onclick={() => (metric = 'speed')}>Speed</button>
        <button aria-pressed={metric === 'versus'} onclick={() => (metric = 'versus')}>Against midday</button>
      </div>
      <label>
        <span class="sr-only">Route</span>
        <select class="input route-select" bind:value={route}>
          <option value="">All routes</option>
          {#each app.routes as r}<option value={r.id}>{`${r.label} ${routeName(r.label, r.long_name)}`.trim()}</option>{/each}
        </select>
      </label>
    </div>
  </div>

  {#if failure}<p class="banner error" role="alert">The map could not be drawn. {failure}</p>{/if}
  <div class="layout">
    <div class="main-col">
      <SpeedMap data={network} hour={app.mapHour} {period} {metric} mode={app.scaleMode} units={app.units} height="calc(100dvh - {period === 'hour' ? 396 : 228}px)" onselect={f => (pinned = f)} />
      {#if metric === 'speed'}
        <SpeedLegend mode={app.scaleMode} units={app.units} />
      {:else}
        <div class="legend">
          {#each versusLabels as label, i}
            <span class="key"><span class="swatch" style:background="var({CLASS_VARS[i]})"></span>{label}</span>
          {/each}
        </div>
      {/if}
      {#if period === 'hour'}
        <HourTimeline hours={network?.hours ?? []} hour={app.mapHour} units={app.units} onchange={setHour} />
      {/if}
    </div>
    <aside class="side">
      {#if period === 'hour' && current}
        <dl class="facts">
          <div><dt><Term topic="speed">Streets under {app.units === 'imperial' ? '8 mph' : '13 km/h'}</Term></dt><dd>{pct(current.slow_share)}</dd><span class="fine">of {int(current.cells)} measured segments, {hourRange(app.mapHour)}</span></div>
          <div><dt><Term topic="speed">Network speed</Term></dt><dd>{speedWithUnit(current.speed, app.units)}</dd><span class="fine">pooled over every segment this hour</span></div>
        </dl>
      {/if}
      {#if pinned}
        <div class="pinned">
          <div class="pinned-head"><h3>This street</h3><button class="btn small quiet" onclick={() => (pinned = null)}>Clear</button></div>
          <p class="fine">{pinned.routes.length === 1 ? 'Route' : 'Routes'} {pinned.routes.join(', ')}</p>
          <LineChart
            height={130}
            label="Speed by hour on this street"
            format={v => `${v.toFixed(1)} ${unit}`}
            formatAxis={v => v.toFixed(0)}
            yMin={0}
            series={[{key: 'speed', label: 'Speed', color: 'var(--ink)', values: HOURS.map(h => {
              const value = pinned?.speeds[h];
              return value === null || value === undefined ? null : toDisplaySpeed(value, app.units);
            })}]}
          />
          <dl class="mini">
            <div><dt>AM peak</dt><dd>{speedWithUnit(pinned.am, app.units)}</dd></div>
            <div><dt>Midday</dt><dd>{speedWithUnit(pinned.mid, app.units)}</dd></div>
            <div><dt>PM peak</dt><dd>{speedWithUnit(pinned.pm, app.units)}</dd></div>
            <div><dt>All day</dt><dd>{speedWithUnit(pinned.all_day, app.units)}</dd></div>
            <div><dt>Vehicle hours a day</dt><dd>{pinned.bus_hours_per_day.toFixed(1)}</dd></div>
            <div><dt>Measurements</dt><dd>{int(pinned.measurements)}</dd></div>
          </dl>
        </div>
      {:else}
        <p class="note">Select a street on the map to see how its speed changes through the day.</p>
      {/if}
      <div class="basemap">
        <label><input type="checkbox" checked={app.basemap} onchange={event => app.setBasemap(event.currentTarget.checked)} /> Show street basemap</label>
        <p class="fine">Basemap tiles come from OpenFreeMap, which sees your network address and the area on screen. Transit data never goes there.</p>
      </div>
      <button class="btn small" disabled={!network} onclick={() => network && download(network, app)}>Download GeoJSON</button>
      <p class="note">A street is colored when it has at least two measurements and one for each day selected. Gray lines had no measured service in this period. A segment near the end of a route can reflect a vehicle turning around, and one at a busy stop includes boarding time.</p>
    </aside>
  </div>
</div>

<style>
  .map-page { gap: 12px; padding-top: 14px; padding-bottom: 28px; }
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 8px 24px; }
  .title { display: grid; gap: 2px; min-width: 0; flex: 1 1 320px; }
  .title h1 { font-size: 30px; }
  .route-select { width: 190px; height: 34px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; align-items: start; }
  .main-col { display: grid; gap: 8px; min-width: 0; }
  .side { display: grid; gap: 18px; position: sticky; top: 72px; }
  .facts { display: grid; gap: 14px; }
  .facts dt { font-size: 12px; font-weight: 600; color: var(--muted); }
  .facts dd { font-size: 26px; font-weight: 650; letter-spacing: -.02em; line-height: 1.2; }
  .pinned { display: grid; gap: 8px; padding-top: 14px; border-top: 1px solid var(--rule); }
  .pinned-head { display: flex; justify-content: space-between; align-items: center; }
  .mini div { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid var(--rule); font-size: 12.5px; }
  .mini dt { color: var(--muted); }
  .mini dd { font-variant-numeric: tabular-nums; font-weight: 600; }
  .basemap { display: grid; gap: 4px; padding-top: 14px; border-top: 1px solid var(--rule); }
  .basemap label { display: flex; gap: 6px; align-items: center; font-size: 13px; }
  @media (max-width: 1000px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .side { position: static; }
  }
</style>
