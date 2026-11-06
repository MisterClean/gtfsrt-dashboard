<script lang="ts">
  import Dumbbell from '../charts/Dumbbell.svelte';
  import RouteHeat from '../charts/RouteHeat.svelte';
  import Spark from '../charts/Spark.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import RouteBadge from '../components/RouteBadge.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import type {RouteScore} from '../engine/types';
  import {DASH, int, minutes, pct, ratioOf, routeName, signedPct, speed, speedUnit, toDisplaySpeed} from '../lib/format';
  import {app} from '../lib/state.svelte';

  let peak = $state<'peak' | 'am' | 'pm'>('peak');

  const unit = $derived(speedUnit(app.units));
  /** Exports use the units in the column heading, not the engine's meters per second. */
  const speedCsv = (value: number | null | undefined) => (value === null || value === undefined ? null : Number(toDisplaySpeed(value, app.units).toFixed(2)));
  const minutesCsv = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? null : Number((seconds / 60).toFixed(1)));
  const days = $derived(Math.max(1, app.loadedDates.length));
  const onTime = (r: RouteScore) => ratioOf(r.on_time.on_time, r.on_time.total);
  const late = (r: RouteScore) => ratioOf(r.on_time.late, r.on_time.total);
  const sparkDomain = $derived.by(() => {
    const values = app.routes.flatMap(r => r.hourly.slice(5, 24)).filter((v): v is number => v !== null);
    if (!values.length) return [0, 1];
    const sorted = [...values].sort((a, b) => a - b);
    return [sorted[Math.floor(sorted.length * 0.02)], sorted[Math.floor(sorted.length * 0.98)]];
  });
  const peakOf = (r: RouteScore) => (peak === 'am' ? r.speed_am : peak === 'pm' ? r.speed_pm : r.speed_peak);
  const peakLabel = $derived(peak === 'am' ? 'Morning peak' : peak === 'pm' ? 'Evening peak' : 'Peak');
  // Routes with service but no observations are the ones a planner most needs to see.
  const rows = $derived(app.routes.filter(r => r.trips_scheduled > 0 || r.speed !== null));
  const unobserved = $derived(app.routes.filter(r => r.trips_scheduled > 0 && r.trips_observed === 0 && r.speed === null).length);

  const dumbbell = $derived(rows.map(r => ({id: r.id, label: r.label, name: r.long_name, mid: r.speed_mid, peak: peakOf(r)})));
  const byPeak = $derived([...rows].sort((a, b) => (a.speed_peak ?? 99) - (b.speed_peak ?? 99)));

  const columns = $derived<Column<RouteScore>[]>([
    {key: 'label', label: 'Route', left: true, value: r => r.label, cell: routeCell, csv: r => r.label},
    {key: 'long', label: 'Name', left: true, wrap: true, value: r => routeName(r.label, r.long_name) || null, format: r => routeName(r.label, r.long_name)},
    {key: 'trips', label: 'Trips a day', descending: true, value: r => r.trips_observed / days, format: r => int(r.trips_observed / days)},
    {key: 'observed', label: 'Observed', title: 'Share of scheduled trips seen in the realtime feed', descending: true, value: r => ratioOf(r.trips_observed, r.trips_scheduled), format: r => pct(ratioOf(r.trips_observed, r.trips_scheduled))},
    {key: 'speed', label: `All day, ${unit}`, descending: true, value: r => r.speed, format: r => speed(r.speed, app.units), csv: r => speedCsv(r.speed)},
    {key: 'mid', label: 'Midday', title: '10 AM to 2 PM', value: r => r.speed_mid, format: r => speed(r.speed_mid, app.units), csv: r => speedCsv(r.speed_mid)},
    {key: 'peak', label: 'Peak', title: '7 to 9 AM and 4 to 6 PM', value: r => r.speed_peak, format: r => speed(r.speed_peak, app.units), csv: r => speedCsv(r.speed_peak)},
    {key: 'change', label: 'Change', title: 'Peak speed against midday, with a 95% interval from resampling days', value: r => r.peak_change, cell: changeCell, csv: r => r.peak_change},
    {key: 'am', label: 'AM', value: r => r.speed_am, format: r => speed(r.speed_am, app.units), csv: r => speedCsv(r.speed_am)},
    {key: 'pm', label: 'PM', value: r => r.speed_pm, format: r => speed(r.speed_pm, app.units), csv: r => speedCsv(r.speed_pm)},
    {key: 'sched', label: 'Scheduled', title: 'Speed implied by the schedule', value: r => r.scheduled_speed, format: r => speed(r.scheduled_speed, app.units), csv: r => speedCsv(r.scheduled_speed)},
    {key: 'otp', label: 'On time', title: 'Departures at timepoints within the on-time window', value: onTime, format: r => pct(onTime(r))},
    {key: 'late', label: 'Late', descending: true, value: late, format: r => pct(late(r))},
    {key: 'bunched', label: 'Bunched', title: 'Share of vehicles under a quarter of the scheduled headway. Frequent service only.', descending: true, value: r => r.headways?.bunched ?? null, format: r => pct(r.headways?.bunched)},
    {key: 'ewt', label: 'Excess wait', title: 'Average wait beyond what the schedule promises. Frequent service only.', descending: true, value: r => r.headways?.excess_wait_s ?? null, format: r => (r.headways ? minutes(r.headways.excess_wait_s, 1) : DASH), csv: r => minutesCsv(r.headways?.excess_wait_s)},
    {key: 'run', label: 'Run time', title: 'Median time to run the main pattern end to end', descending: true, value: r => r.run_p50_s, format: r => minutes(r.run_p50_s), csv: r => minutesCsv(r.run_p50_s)},
    {key: 'p90', label: '90th pct', title: 'One run in ten takes longer than this', descending: true, value: r => r.run_p90_s, format: r => minutes(r.run_p90_s), csv: r => minutesCsv(r.run_p90_s)},
    {key: 'stopped', label: 'Stopped', title: 'Share of measured time moving under 2 mph', descending: true, value: r => r.stopped_share, format: r => pct(r.stopped_share)},
    {key: 'veh', label: 'Vehicles', title: 'Peak vehicles in an hour', descending: true, value: r => r.peak_vehicles, format: r => r.peak_vehicles.toFixed(1)},
    {key: 'slowest', label: 'Slowest half mile at peak', left: true, wrap: true, value: r => r.slowest?.speed ?? null, cell: slowestCell, csv: r => (r.slowest ? `${speedCsv(r.slowest.speed)} ${unit}, ${r.slowest.from} to ${r.slowest.to}` : '')},
    {key: 'hourly', label: '5 AM to 11 PM', noSort: true, value: () => null, cell: sparkCell, csv: () => ''},
  ]);
</script>

{#snippet routeCell(r: RouteScore)}<RouteBadge label={r.label} color={r.color} textColor={r.text_color} />{/snippet}
{#snippet changeCell(r: RouteScore)}
  {signedPct(r.peak_change)}
  {#if r.peak_change_ci}<div class="ci">{signedPct(r.peak_change_ci[0])} to {signedPct(r.peak_change_ci[1])}</div>{/if}
{/snippet}
{#snippet slowestCell(r: RouteScore)}
  {#if r.slowest}
    <strong>{speed(r.slowest.speed, app.units)} {unit}</strong> <span class="dim">{r.slowest.from} to {r.slowest.to}</span>
  {:else}{DASH}{/if}
{/snippet}
{#snippet sparkCell(r: RouteScore)}
  <Spark values={r.hourly} min={sparkDomain[0]} max={sparkDomain[1]} label="Speed by hour on route {r.label}" />
{/snippet}

<div class="page">
  <div class="page-head">
    <div>
      <h1>Route scorecard</h1>
      <p class="lede">Every route, side by side. Period speeds compare the same street segments, so a route isn't penalized for running extra downtown trips at rush hour.</p>
    </div>
  </div>

  <section class="section">
    <DataTable
      {columns}
      {rows}
      caption="Route performance. Choose a route to open it."
      defaultSort="label"
      filename="routes.csv"
      search={r => `${r.label} ${r.long_name}`}
      placeholder="Find a route…"
      onrow={r => app.go('route', r.id)}
      maxHeight="72vh"
    />
    {#if unobserved}<p class="note"><strong>{unobserved} {unobserved === 1 ? 'route has' : 'routes have'} scheduled trips but no observations.</strong> They appear in the table with blank figures. That can mean the service didn't run, or that the feed didn't report it.</p>{/if}
    <p class="note">Speeds count time at stops and red lights and exclude terminal layovers. Without five or more days, intervals aren't shown. On-time performance and headways appear only where the data supports them; see Data &amp; methods.</p>
  </section>

  <section class="section">
    <div class="section-head">
      <div><h2>How much slower at peak?</h2><p class="note">Each line runs from a route's midday speed to its peak speed.</p></div>
      <div class="seg" role="group" aria-label="Peak period">
        <button aria-pressed={peak === 'peak'} onclick={() => (peak = 'peak')}>Both peaks</button>
        <button aria-pressed={peak === 'am'} onclick={() => (peak = 'am')}>7–9 AM</button>
        <button aria-pressed={peak === 'pm'} onclick={() => (peak = 'pm')}>4–6 PM</button>
      </div>
    </div>
    <Dumbbell rows={dumbbell} units={app.units} {peakLabel} onselect={id => app.go('route', id)} />
  </section>

  <section class="section">
    <div class="section-head">
      <div><h2>Every route, every hour</h2><p class="note">Sorted slowest at peak first. Colors use the same scale as the map.</p></div>
    </div>
    <SpeedLegend mode={app.scaleMode} units={app.units} />
    <RouteHeat routes={byPeak} units={app.units} mode={app.scaleMode} onselect={id => app.go('route', id)} />
  </section>
</div>

<style>
  .ci { font-size: 11px; color: var(--faint); }
  .dim { color: var(--muted); }
</style>
