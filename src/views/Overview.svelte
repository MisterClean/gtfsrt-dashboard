<script lang="ts">
  import LineChart from '../charts/LineChart.svelte';
  import Dumbbell from '../charts/Dumbbell.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import {engine} from '../engine/client';
  import type {DayRow, HourRow, NetworkMap} from '../engine/types';
  import {findings, scopeLine} from '../lib/findings';
  import {dateLabel, datesLabel, int, minutes, pct, signedPct, speed, speedUnit, toDisplaySpeed} from '../lib/format';
  import {HOURS} from '../lib/scale';
  import {app, feedLabel} from '../lib/state.svelte';
  import HourTimeline from '../map/HourTimeline.svelte';
  import SpeedMap from '../map/SpeedMap.svelte';

  let network = $state<NetworkMap | null>(null);
  let hover = $state<number | null>(null);

  $effect(() => {
    app.version;
    if (!app.hasResults) return;
    engine.networkMap().then(result => (network = result)).catch(() => {});
  });

  const o = $derived(app.overview);
  const list = $derived(o ? findings(o, app.routes, app.units) : []);
  const byHour = $derived(new Map<number, HourRow>((o?.hourly ?? []).map(row => [row.hour, row])));
  const at = <T,>(read: (row: HourRow) => T | null) => HOURS.map(h => {
    const row = byHour.get(h);
    return row ? read(row) : null;
  });
  const unit = $derived(speedUnit(app.units));
  const toSpeed = (v: number | null) => (v === null ? null : toDisplaySpeed(v, app.units));
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

  const onTimeShare = $derived(o ? share(o.on_time.on_time, o.on_time.total) : null);
  const lateShare = $derived(o ? share(o.on_time.late, o.on_time.total) : null);
  const observedShare = $derived(o ? share(o.trips_observed_per_day, o.trips_scheduled_per_day) : null);
  const peakChange = $derived(o?.speed_peak && o?.speed_mid ? o.speed_peak / o.speed_mid - 1 : null);

  const dumbbellRows = $derived(app.routes.map(r => ({id: r.id, label: r.label, name: r.long_name, mid: r.speed_mid, peak: r.speed_peak})));

  const dayColumns = $derived<Column<DayRow>[]>([
    {key: 'date', label: 'Service day', left: true, value: d => d.date, format: d => dateLabel(d.date)},
    {key: 'speed', label: `Speed, ${unit}`, value: d => d.speed, format: d => speed(d.speed, app.units), descending: true},
    {key: 'peak', label: `Peak, ${unit}`, value: d => d.peak_speed, format: d => speed(d.peak_speed, app.units), descending: true},
    {key: 'ontime', label: 'On time', value: d => share(d.on_time.on_time, d.on_time.total), format: d => pct(share(d.on_time.on_time, d.on_time.total)), descending: true},
    {key: 'observed', label: 'Trips observed', value: d => d.trips_observed, format: d => int(d.trips_observed), descending: true},
    {key: 'scheduled', label: 'Scheduled', value: d => d.trips_scheduled, format: d => int(d.trips_scheduled), descending: true},
    {key: 'share', label: 'Share', value: d => share(d.trips_observed, d.trips_scheduled), format: d => pct(share(d.trips_observed, d.trips_scheduled)), descending: true},
    {key: 'gaps', label: 'Capture gaps', title: 'Five-minute periods during scheduled service with no archived feed capture', value: d => d.empty_buckets, format: d => (d.empty_buckets ? `${(d.empty_buckets * 5).toLocaleString('en-US')} min` : 'None')},
  ]);
</script>

{#if o}
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{app.feed ? feedLabel(app.feed) : ''}</h1>
        <p class="lede">{datesLabel(o.dates.map(d => Number(d.replaceAll('-', ''))))} · {scopeLine(o)}</p>
      </div>
    </div>

    <dl class="stats">
      <div class="stat">
        <dt>Operating speed</dt>
        <dd>{speed(o.speed, app.units)} <small>{unit}</small></dd>
        <div class="sub">{speed(o.scheduled_speed, app.units)} scheduled, stops included</div>
      </div>
      <div class="stat">
        <dt>Peak speed</dt>
        <dd>{speed(o.speed_peak, app.units)} <small>{unit}</small></dd>
        <div class="sub">{signedPct(peakChange)} against midday</div>
      </div>
      <div class="stat">
        <dt>On-time departures</dt>
        <dd>{pct(onTimeShare)}</dd>
        <div class="sub">{pct(lateShare)} late, at timepoints</div>
      </div>
      <div class="stat">
        <dt>Trips observed</dt>
        <dd>{int(o.trips_observed_per_day)} <small>a day</small></dd>
        <div class="sub">{pct(observedShare, 1)} of {int(o.trips_scheduled_per_day)} scheduled</div>
      </div>
      {#if o.headways}
        <div class="stat">
          <dt>Excess wait</dt>
          <dd>{minutes(o.headways.excess_wait_s, 1)}</dd>
          <div class="sub">{pct(o.headways.bunched)} bunched on frequent service</div>
        </div>
      {/if}
      <div class="stat">
        <dt>Vehicles at peak</dt>
        <dd>{int(o.peak_vehicles)}</dd>
        <div class="sub">{int(o.service_hours_observed_per_day)} service hours a day</div>
      </div>
    </dl>

    <section class="hero" aria-label="Speed map and findings">
      <div class="hero-map">
        <SpeedMap data={network} hour={app.mapHour} mode={app.mode} units={app.units} height="min(58vh, 560px)" onselect={() => app.go('map')} />
        <HourTimeline hours={network?.hours ?? []} hour={app.mapHour} units={app.units} onchange={h => (app.mapHour = h)} />
        <SpeedLegend mode={app.mode} units={app.units} />
      </div>
      <aside class="findings">
        <h2>What the data shows</h2>
        <ul>
          {#each list as finding}
            <li>
              {finding.text}
              {#if finding.route}<button class="link-btn" onclick={() => app.go('route', finding.route)}>Open route</button>{/if}
            </li>
          {/each}
        </ul>
        <button class="btn small" onclick={() => app.go('hotspots')}>See where the time goes</button>
      </aside>
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>Through the day</h2><p class="note">Pointing at any chart moves all four. Shaded bands mark the 7–9 AM and 4–6 PM peaks.</p></div>
      </div>
      <div class="small-multiples">
        <figure>
          <figcaption><h3>Speed, {unit}</h3></figcaption>
          <LineChart
            bind:hover
            label="Measured and scheduled speed by hour"
            format={v => v.toFixed(1)}
            formatAxis={v => v.toFixed(0)}
            series={[
              {key: 'obs', label: 'Measured', color: 'var(--ink)', values: at(r => toSpeed(r.speed))},
              {key: 'sched', label: 'Scheduled', color: 'var(--gray-series)', reference: true, values: at(r => toSpeed(r.scheduled_speed))},
            ]}
          />
        </figure>
        <figure>
          <figcaption><h3>On-time departures at timepoints</h3></figcaption>
          <LineChart
            bind:hover
            label="Share of departures on time by hour"
            yMin={0}
            yMax={1}
            format={v => `${(v * 100).toFixed(0)}%`}
            series={[{key: 'otp', label: 'On time', color: 'var(--blue)', values: at(r => (r.on_time.total >= 10 ? share(r.on_time.on_time, r.on_time.total) : null))}, {key: 'late', label: 'Late', color: 'var(--orange)', values: at(r => (r.on_time.total >= 10 ? share(r.on_time.late, r.on_time.total) : null))}]}
          />
        </figure>
        <figure>
          <figcaption><h3>Trips starting per hour</h3></figcaption>
          <LineChart
            bind:hover
            label="Trips scheduled and observed by hour"
            yMin={0}
            format={v => v.toFixed(0)}
            series={[
              {key: 'obs', label: 'Observed', color: 'var(--ink)', values: at(r => r.trips_observed)},
              {key: 'sched', label: 'Scheduled', color: 'var(--gray-series)', reference: true, values: at(r => r.trips_scheduled)},
            ]}
          />
        </figure>
        <figure>
          <figcaption><h3>Vehicles in service</h3></figcaption>
          <LineChart
            bind:hover
            label="Distinct vehicles in service by hour"
            yMin={0}
            format={v => v.toFixed(0)}
            series={[{key: 'veh', label: 'Vehicles', color: 'var(--ink)', values: at(r => r.vehicles)}]}
          />
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Slowest routes at peak</h2>
          <p class="note">Midday against the 7–9 AM and 4–6 PM peaks, on the same street segments in each period. Choose a route to open it.</p>
        </div>
        <button class="btn small" onclick={() => app.go('routes')}>All routes</button>
      </div>
      <Dumbbell rows={dumbbellRows} units={app.units} peakLabel="Peak" limit={12} onselect={id => app.go('route', id)} />
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>Day by day</h2><p class="note">Look here first when one result seems off. A capture gap means the archive has no feed snapshots for that time, not that service stopped.</p></div>
      </div>
      <DataTable columns={dayColumns} rows={o.days} caption="Results by service day" defaultSort="date" filename="days.csv" />
    </section>
  </div>
{/if}

<style>
  .hero { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; align-items: start; }
  .hero-map { display: grid; gap: 12px; min-width: 0; }
  .findings { display: grid; gap: 14px; }
  .findings ul { list-style: none; display: grid; }
  .findings li { padding: 11px 0; border-top: 1px solid var(--rule); font-size: 14px; line-height: 1.45; text-wrap: pretty; }
  .findings li :global(.link-btn) { font-size: 12.5px; margin-left: 2px; }
  .small-multiples { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 28px 36px; }
  figure { display: grid; gap: 6px; min-width: 0; }
  @media (max-width: 1100px) {
    .hero { grid-template-columns: minmax(0, 1fr); }
  }
</style>
