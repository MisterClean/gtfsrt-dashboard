<script lang="ts">
  import SpacingHistogram from '../charts/network/SpacingHistogram.svelte';
  import StopsMap from '../charts/network/StopsMap.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import RouteBadge from '../components/RouteBadge.svelte';
  import {engine} from '../engine/client';
  import type {RouteSpacing, StopRow, StopsReport} from '../engine/types';
  import {int, pct, shortLength} from '../lib/format';
  import {app, errorText} from '../lib/state.svelte';

  const FEET = 3.28084;
  const MILES_PER_KM = 1.60934;

  let report = $state<StopsReport | null>(null);
  let failure = $state<string | null>(null);
  let request = 0;

  $effect(() => {
    app.version;
    if (!app.hasResults) return;
    const current = ++request;
    engine.stops()
      .then(result => {
        if (current === request) {
          report = result;
          failure = null;
        }
      })
      .catch(error => {
        if (current === request) failure = errorText(error);
      });
  });

  const imperial = $derived(app.units === 'imperial');
  // The threshold is defined as 800 feet, which shouldn't read as 801 after rounding.
  const thresholdText = $derived.by(() => {
    if (!report) return '';
    const meters = report.close_threshold_m;
    return imperial ? `${(Math.round((meters * FEET) / 10) * 10).toLocaleString('en-US')} ft` : `${Math.round(meters)} m`;
  });
  const distanceUnit = $derived(imperial ? 'ft' : 'm');
  const toDistance = (meters: number | null | undefined) =>
    meters === null || meters === undefined ? null : Math.round(imperial ? meters * FEET : meters);
  const toDensity = (perKm: number) => (imperial ? perKm * MILES_PER_KM : perKm);
  const densityUnit = $derived(imperial ? 'mile' : 'km');

  const inUse = $derived((report?.stops ?? []).filter(stop => stop.passes_per_day > 0 || stop.scheduled_per_day > 0));

  const summary = $derived.by(() => {
    if (!report) return null;
    const lines = report.spacing.map(row => ({gaps: Math.max(0, row.stops - 1), row}));
    const gaps = lines.reduce((sum, line) => sum + line.gaps, 0);
    const distance = lines.reduce((sum, line) => sum + line.gaps * line.row.mean_m, 0);
    const close = lines.reduce((sum, line) => sum + line.gaps * line.row.close_share, 0);
    // The median gap, read from the histogram and interpolated within its bin.
    const counts = report.spacing_histogram;
    const total = counts.reduce((sum, value) => sum + value, 0);
    let running = 0;
    let median: number | null = null;
    for (let i = 0; i < counts.length && total > 0; i += 1) {
      if (running + counts[i] >= total / 2) {
        median = (i + (total / 2 - running) / Math.max(1, counts[i])) * report.spacing_bin_m;
        break;
      }
      running += counts[i];
    }
    return {
      median,
      perKm: distance > 0 ? gaps / (distance / 1000) : null,
      closeShare: gaps > 0 ? close / gaps : null,
    };
  });

  const routeMeta = $derived(new Map(app.routes.map(route => [route.id, route])));

  const spacingColumns = $derived<Column<RouteSpacing>[]>([
    {key: 'route', label: 'Route', left: true, value: r => r.label, cell: routeCell, csv: r => r.label},
    {key: 'headsign', label: 'Direction', left: true, wrap: true, value: r => r.headsign || `Direction ${r.dir}`},
    {key: 'stops', label: 'Stops', descending: true, value: r => r.stops, format: r => int(r.stops)},
    {key: 'mean', label: `Mean spacing, ${distanceUnit}`, descending: true, value: r => toDistance(r.mean_m), format: r => int(toDistance(r.mean_m))},
    {key: 'median', label: `Median spacing, ${distanceUnit}`, descending: true, value: r => toDistance(r.median_m), format: r => int(toDistance(r.median_m))},
    {key: 'density', label: `Stops per ${densityUnit}`, descending: true, value: r => Number(toDensity(r.per_km).toFixed(2)), format: r => toDensity(r.per_km).toFixed(1)},
    {key: 'close', label: 'Closely spaced', title: `Share of gaps under ${thresholdText}`, descending: true, value: r => r.close_share, format: r => pct(r.close_share)},
    {key: 'zone', label: 'Time in stop zones', title: 'Share of measured running time spent within about 25 m of a stop', descending: true, value: r => r.zone_share, format: r => pct(r.zone_share)},
  ]);

  const deviationMinutes = (seconds: number | null) => (seconds === null ? null : Number((seconds / 60).toFixed(2)));
  const signedMinutes = (seconds: number | null) => {
    if (seconds === null) return '—';
    const value = (seconds / 60).toFixed(1);
    return seconds > 0 ? `+${value}` : value.replace('-', '−');
  };

  const stopColumns = $derived<Column<StopRow>[]>([
    {key: 'name', label: 'Stop', left: true, wrap: true, value: s => s.name},
    {key: 'code', label: 'Code', left: true, value: s => s.code || null, format: s => s.code},
    {key: 'routes', label: 'Routes', left: true, wrap: true, value: s => s.routes.join(', ')},
    {key: 'passes', label: 'Passes a day', title: 'Vehicles seen passing this stop', descending: true, value: s => Number(s.passes_per_day.toFixed(1)), format: s => int(s.passes_per_day)},
    {key: 'scheduled', label: 'Scheduled a day', descending: true, value: s => Number(s.scheduled_per_day.toFixed(1)), format: s => int(s.scheduled_per_day)},
    {key: 'zone', label: 'Stop zone, s', title: 'Average seconds within about 25 m either side of the stop', descending: true, value: s => (s.zone_seconds === null ? null : Number(s.zone_seconds.toFixed(1))), format: s => (s.zone_seconds === null ? '—' : s.zone_seconds.toFixed(0))},
    {key: 'hours', label: 'Stop zone, hours a day', title: 'Vehicle hours spent in this stop zone each day', descending: true, value: s => Number(s.zone_hours_per_day.toFixed(2)), format: s => s.zone_hours_per_day.toFixed(1)},
    {key: 'deviation', label: 'Mean deviation, min', title: 'Average minutes from schedule at this stop. Positive means late.', descending: true, value: s => deviationMinutes(s.mean_deviation_s), format: s => signedMinutes(s.mean_deviation_s)},
    {key: 'nearest', label: `Nearest stop, ${distanceUnit}`, title: 'Shortest distance along any route to a neighbouring stop', value: s => toDistance(s.nearest_stop_m), format: s => int(toDistance(s.nearest_stop_m))},
  ]);
</script>

{#snippet routeCell(r: RouteSpacing)}
  {@const meta = routeMeta.get(r.route)}
  <RouteBadge label={r.label} color={meta?.color ?? ''} textColor={meta?.text_color ?? ''} />
{/snippet}

<div class="page">
  <div class="page-head">
    <div>
      <h1>Stops</h1>
      <p class="lede">How far apart stops are and how much time vehicles spend around them.</p>
    </div>
  </div>

  {#if failure}
    <div class="banner error" role="alert">The stop report could not be calculated. {failure}</div>
  {/if}

  {#if report && summary}
    <dl class="stats">
      <div class="stat">
        <dt>Stops in use</dt>
        <dd>{int(inUse.length)}</dd>
        <div class="sub">with scheduled or observed service</div>
      </div>
      <div class="stat">
        <dt>Median spacing</dt>
        <dd>{shortLength(summary.median, app.units)}</dd>
        <div class="sub">on each route's main line</div>
      </div>
      <div class="stat">
        <dt>Stops per {densityUnit}</dt>
        <dd>{summary.perKm === null ? '—' : toDensity(summary.perKm).toFixed(1)}</dd>
        <div class="sub">along those lines</div>
      </div>
      <div class="stat">
        <dt>Closely spaced gaps</dt>
        <dd>{pct(summary.closeShare)}</dd>
        <div class="sub">under {thresholdText}</div>
      </div>
    </dl>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Stop spacing</h2>
          <p class="note">From the schedule, using the main pattern of each route and direction. A stop shared by several routes counts once per route. The last bar collects the longest few percent of gaps.</p>
        </div>
      </div>
      <div class="pair">
        <figure>
          <figcaption><h3>Gaps between consecutive stops</h3></figcaption>
          <SpacingHistogram histogram={report.spacing_histogram} binM={report.spacing_bin_m} thresholdM={report.close_threshold_m} units={app.units} height={320} />
        </figure>
        <figure>
          <figcaption><h3>Where stops sit closest together</h3></figcaption>
          <StopsMap stops={inUse} thresholdM={report.close_threshold_m} units={app.units} height="320px" />
          <div class="legend">
            <span class="key"><span class="swatch dot" style:background="var(--orange)"></span>Under {thresholdText} from a neighbouring stop</span>
            <span class="key"><span class="swatch dot" style:background="var(--gray-series)"></span>Farther apart</span>
          </div>
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>By route</h2><p class="note">Choose a route to open it.</p></div>
      </div>
      <DataTable
        columns={spacingColumns}
        rows={report.spacing}
        caption="Stop spacing by route and direction. Choose a row to open the route."
        defaultSort="route"
        filename="route-stop-spacing.csv"
        search={r => `${r.label} ${r.headsign}`}
        placeholder="Find a route…"
        onrow={r => app.go('route', r.route)}
        maxHeight="56vh"
      />
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Every stop</h2>
          <p class="note">Sorted by vehicle hours spent around the stop. Stop-zone time runs from about 25 m before the stop to about 25 m after it, so it approximates dwell plus queuing. With positions every 20 seconds or so it only means something in aggregate, not for a single pass. It leaves out the first and last stops of each trip and any pass over ten minutes, but a timepoint's shorter scheduled hold stays in, so timepoints can rank high for reasons other than delay. It says nothing about how many riders use a stop, because the archive has no ridership.</p>
        </div>
      </div>
      <DataTable
        columns={stopColumns}
        rows={inUse}
        caption="Stops with their service, time around the stop and distance to the nearest stop"
        defaultSort="hours"
        defaultDescending
        limit={100}
        filename="stops.csv"
        search={s => `${s.name} ${s.code} ${s.routes.join(' ')}`}
        placeholder="Find a stop or route…"
        maxHeight="72vh"
      />
    </section>
  {:else if !failure}
    <p class="empty">Calculating…</p>
  {/if}
</div>

<style>
  .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px 36px; align-items: start; }
  figure { display: grid; gap: 8px; min-width: 0; align-content: start; }
  .dot { border-radius: 50%; }
  @media (max-width: 1000px) {
    .pair { grid-template-columns: minmax(0, 1fr); }
  }
</style>
