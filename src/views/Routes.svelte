<script lang="ts">
  import Dumbbell from '../charts/Dumbbell.svelte';
  import RouteHeat from '../charts/RouteHeat.svelte';
  import Spark from '../charts/Spark.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import RouteBadge from '../components/RouteBadge.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import Term from '../components/Term.svelte';
  import type {RouteScore} from '../engine/types';
  import {DASH, int, pct, ratioOf, routeName, signedPct, speed, speedUnit, toDisplaySpeed} from '../lib/format';
  import {CTA_ROUTE_MATCH_MIN, snapshotHash} from '../lib/snapshot';
  import {app} from '../lib/state.svelte';
  import {DEFINITIONS, MIN_EVENTS, TOO_FEW, coverageNote, coverageOf, isShown, sampleState, scheduleSuppressed, withMatchRate} from '../lib/stats';

  const coverage = $derived(coverageOf(app.overview));
  const caveat = $derived(coverageNote(coverage, !!app.snapshot));
  const matchText = $derived(coverage.matchRate === null ? '' : `${Math.round(coverage.matchRate * 100)}% ${app.snapshot ? 'position report' : 'trip-ID'} match`);
  const requested = $derived(app.snapshot?.manifest.requestedDates.length ?? 0);
  const partialDays = $derived(app.overview?.days.filter(day => day.status === 'Partial').length ?? 0);
  const routeMatch = (r: RouteScore) => app.snapshot?.manifest.routeTripMatch?.[r.id];
  const routeCoverage = (r: RouteScore) => withMatchRate(coverage, routeMatch(r), CTA_ROUTE_MATCH_MIN);
  const withheld = (r: RouteScore) => scheduleSuppressed(routeCoverage(r));
  const matchLabel = (r: RouteScore) => {
    const match = routeMatch(r);
    if (match === undefined) return DASH;
    const result = routeCoverage(r);
    const status = scheduleSuppressed(result) ? ' · withheld' : result.mode === 'partial' ? ' · partial' : '';
    return `${pct(match, 1)}${status}`;
  };
  const timedScope = $derived(app.snapshot ? 'at observed stops' : 'at timepoints');
  /** A share over n events: "too few trips" under the minimum, a * for a low sample. */
  const shownPct = (r: RouteScore, value: number | null, n: number) => (withheld(r) ? DASH : isShown(n) ? `${pct(value)}${sampleState(n) === 'low' ? '*' : ''}` : TOO_FEW);
  const minutesBare = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? DASH : (seconds / 60).toFixed(1));

  let peak = $state<'peak' | 'am' | 'pm'>('peak');

  const unit = $derived(speedUnit(app.units));
  /** Exports use the units in the column heading, not the engine's meters per second. */
  const speedCsv = (value: number | null | undefined) => (value === null || value === undefined ? null : Number(toDisplaySpeed(value, app.units).toFixed(2)));
  const minutesCsv = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? null : Number((seconds / 60).toFixed(1)));
  const days = $derived(Math.max(1, app.loadedDates.length));
  const onTime = (r: RouteScore) => (!withheld(r) && isShown(r.on_time.total) ? ratioOf(r.on_time.on_time, r.on_time.total) : null);
  const late = (r: RouteScore) => (!withheld(r) && isShown(r.on_time.total) ? ratioOf(r.on_time.late, r.on_time.total) : null);
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

  const allColumns = $derived<Column<RouteScore>[]>([
    {key: 'label', label: 'Route', left: true, value: r => r.label, cell: routeCell, csv: r => r.label},
    {key: 'long', label: 'Name', left: true, clip: true, hint: r => routeName(r.label, r.long_name), value: r => routeName(r.label, r.long_name) || null, format: r => routeName(r.label, r.long_name)},
    {key: 'hourly', label: '5 AM to 11 PM', noSort: true, value: () => null, cell: sparkCell, csv: () => ''},
    {key: 'speed', label: `All day, ${unit}`, descending: true, value: r => r.speed, format: r => speed(r.speed, app.units), csv: r => speedCsv(r.speed)},
    {key: 'mid', label: `Midday, ${unit}`, title: '10 AM to 2 PM', value: r => r.speed_mid, format: r => speed(r.speed_mid, app.units), csv: r => speedCsv(r.speed_mid)},
    {key: 'peak', label: `Peak, ${unit}`, title: '7 to 9 AM and 4 to 6 PM', value: r => r.speed_peak, format: r => speed(r.speed_peak, app.units), csv: r => speedCsv(r.speed_peak)},
    {key: 'change', label: 'Change', title: 'Peak speed against midday, with a 95% interval from resampling days', value: r => r.peak_change, cell: changeCell, csv: r => r.peak_change},
    {key: 'otp', label: 'On time', title: `Departures ${timedScope} within the on-time window (default \u22121 / +5 min). Shown from ${MIN_EVENTS} departures; * marks fewer than 100. ${coverage.mode === 'partial' ? `Partial: ${matchText || 'some days lack a schedule'}.` : ''}`, value: onTime, format: r => shownPct(r, onTime(r), r.on_time.total)},
    {key: 'timed', label: 'Timed departures (n)', title: `Departures ${timedScope} behind the on-time share`, descending: true, value: r => (withheld(r) ? null : r.on_time.total), format: r => (withheld(r) ? DASH : int(r.on_time.total))},
    {key: 'late', label: 'Late', descending: true, value: late, format: r => shownPct(r, late(r), r.on_time.total)},
    {key: 'bunched', label: 'Bunched', title: 'Share of vehicles under a quarter of the scheduled headway. Frequent service only.', descending: true, value: r => withheld(r) ? null : r.headways?.bunched ?? null, format: r => (r.headways ? shownPct(r, r.headways.bunched, r.headways.count) : DASH)},
    {key: 'ewt', label: 'Excess wait, min', title: 'Average wait beyond what the schedule promises. Frequent service only.', descending: true,
      value: r => withheld(r) ? null : r.headways?.excess_wait_s ?? null,
      format: r => !r.headways || withheld(r) ? DASH : isShown(r.headways.count) ? minutesBare(r.headways.excess_wait_s) : TOO_FEW,
      csv: r => withheld(r) ? null : minutesCsv(r.headways?.excess_wait_s),
    },
    {key: 'slowest', label: `Slowest half mile at peak, ${unit}`, left: true, clip: true, hint: r => (r.slowest ? `${r.slowest.from} to ${r.slowest.to}` : ''), value: r => r.slowest?.speed ?? null, cell: slowestCell, csv: r => (r.slowest ? `${speedCsv(r.slowest.speed)} ${unit}, ${r.slowest.from} to ${r.slowest.to}` : '')},
    {key: 'trips', label: 'Trips a day (avg)', title: 'Trips observed per selected day, averaged', descending: true, value: r => r.trips_observed / days, format: r => int(r.trips_observed / days)},
    {key: 'observed', label: 'Share observed', title: DEFINITIONS.observed, descending: true, value: r => (withheld(r) ? null : ratioOf(r.trips_observed, r.trips_scheduled)), format: r => (withheld(r) ? DASH : pct(ratioOf(r.trips_observed, r.trips_scheduled)))},
    ...(app.snapshot?.manifest.routeTripMatch ? [{
      key: 'match', label: 'Position reports matched', title: 'Share of eligible archived position reports assigned to an active scheduled trip', descending: true, value: routeMatch, format: matchLabel,
    }] : []),
    {key: 'am', label: `AM, ${unit}`, value: r => r.speed_am, format: r => speed(r.speed_am, app.units), csv: r => speedCsv(r.speed_am)},
    {key: 'pm', label: `PM, ${unit}`, value: r => r.speed_pm, format: r => speed(r.speed_pm, app.units), csv: r => speedCsv(r.speed_pm)},
    {key: 'sched', label: `Scheduled, ${unit}`, title: DEFINITIONS.scheduledSpeed, value: r => r.scheduled_speed, format: r => speed(r.scheduled_speed, app.units), csv: r => speedCsv(r.scheduled_speed)},
    {key: 'run', label: 'Run time, min', title: 'Median time to run the main pattern end to end', descending: true, value: r => r.run_p50_s, format: r => minutesBare(r.run_p50_s), csv: r => minutesCsv(r.run_p50_s)},
    {key: 'p90', label: '90th pct run time, min', title: 'One run in ten takes longer than this', descending: true, value: r => r.run_p90_s, format: r => minutesBare(r.run_p90_s), csv: r => minutesCsv(r.run_p90_s)},
    {key: 'stopped', label: 'Stopped', title: 'Share of measured time moving under 2 mph', descending: true, value: r => r.stopped_share, format: r => pct(r.stopped_share)},
    {key: 'veh', label: 'Peak vehicles', title: 'Most vehicles in service in any hour, averaged over the selected days', descending: true, value: r => r.peak_vehicles, format: r => r.peak_vehicles.toFixed(1)},
  ]);

  // With no schedule joined, these columns have nothing to measure against.
  const NEEDS_SCHEDULE = new Set(['otp', 'timed', 'late', 'bunched', 'ewt', 'trips', 'observed', 'sched', 'run', 'p90']);
  const columns = $derived(coverage.mode === 'gps' ? allColumns.filter(c => !NEEDS_SCHEDULE.has(c.key)) : allColumns);
</script>

{#snippet routeCell(r: RouteScore)}
  {#if app.snapshot}
    <a class="route-link" href={snapshotHash('route', r.id)} aria-label={`Open route ${r.label} ${routeName(r.label, r.long_name)}`.trim()}
      onclick={event => {
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        app.go('route', r.id);
      }}>
      <RouteBadge label={r.label} color={r.color} textColor={r.text_color} />
    </a>
  {:else}
    <RouteBadge label={r.label} color={r.color} textColor={r.text_color} />
  {/if}
{/snippet}
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
      {#if requested}
        <p class="note">Choose a route to see its speed map, trip chart, run times and stop-by-stop performance.</p>
        <p class="note">{app.loadedDates.length} of {requested} weekdays analyzed{partialDays ? `, including ${partialDays} with partial archive coverage` : ''}. <button class="link-btn" onclick={() => app.go('data')}>View coverage</button></p>
      {/if}
    </div>
  </div>

  <section class="section">
    {#if caveat}
      <p class="banner caution" role="note" data-coverage={coverage.mode}>{#if coverage.mode === 'gps'}<strong>Speeds only.</strong> {/if}{caveat}</p>
    {/if}
    <DataTable
      {columns}
      {rows}
      caption="Route performance. Choose a route to open it."
      defaultSort="peak"
      filename="routes.csv"
      search={r => `${r.label} ${r.long_name}`}
      placeholder="Find a route…"
      onrow={r => app.go('route', r.id)}
      limit={25}
      maxHeight="72vh"
    />
    {#if unobserved}<p class="note"><strong>{unobserved} {unobserved === 1 ? 'route has' : 'routes have'} scheduled trips but no observations.</strong> They appear in the table with blank figures. That can mean the service didn't run, or that the feed didn't report it.</p>{/if}
    <p class="note">Speeds count time at stops and red lights and exclude terminal layovers. Without five or more days, intervals aren't shown. Units sit in the column heading: speeds in {unit}, waits and run times in minutes, shares in percent, trips per day. On-time performance and headways read "{TOO_FEW}" under {MIN_EVENTS} events, and a * marks fewer than 100. <Term topic="speed">How these are calculated</Term>.</p>
  </section>

  <section class="section">
    <div class="section-head">
      <div><h2><Term topic="period">How much slower at peak?</Term></h2><p class="note">Each line runs from a route's midday speed to its peak speed.</p></div>
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
      <div><h2><Term topic="speed">Every route, every hour</Term></h2><p class="note">Sorted slowest at peak first. Colors use the same scale as the map.</p></div>
    </div>
    <SpeedLegend mode={app.scaleMode} units={app.units} />
    <RouteHeat routes={byPeak} units={app.units} mode={app.scaleMode} onselect={id => app.go('route', id)} />
  </section>
</div>

<style>
  .ci { font-size: 11px; color: var(--faint); }
  .dim { color: var(--muted); }
  .route-link { display: inline-flex; border-radius: 3px; text-decoration: none; }
  .route-link:hover { filter: brightness(1.12); }
</style>
