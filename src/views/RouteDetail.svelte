<script lang="ts">
  // One route in depth: where and when it slows, how each trip ran, and how
  // reliable it is against the schedule.
  import LineChart from '../charts/LineChart.svelte';
  import DelayProfile from '../charts/route/DelayProfile.svelte';
  import ProfileHeat from '../charts/route/ProfileHeat.svelte';
  import RunTimes from '../charts/route/RunTimes.svelte';
  import StringLineChart from '../charts/route/StringLineChart.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import RouteBadge from '../components/RouteBadge.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import {engine} from '../engine/client';
  import type {DirectionDetail, DirectionHour, NetworkMap, PatternSummary, RouteDetail, RouteStop, StringLine} from '../engine/types';
  import {downloadCsv} from '../lib/download';
  import {
    DASH, clock, dateLabel, dateNumber, datesLabel, deviation, hourRange, int, length as formatLength, minutes, pct, plural,
    ratioOf, routeName, shortLength, signedPct, speed, speedUnit, speedWithUnit, toDisplaySpeed,
  } from '../lib/format';
  import {HOURS} from '../lib/scale';
  import {app, errorText} from '../lib/state.svelte';
  import HourTimeline from '../map/HourTimeline.svelte';
  import SpeedMap from '../map/SpeedMap.svelte';

  let detail = $state<RouteDetail | null>(null);
  let network = $state<NetworkMap | null>(null);
  let loaded = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let refreshing = $state(false);
  let highlight = $state<[number, number][] | null>(null);

  let chosenDate = $state<string | null>(null);
  let timeWindow = $state<'all' | 'am' | 'mid' | 'pm' | 'eve'>('all');
  let line = $state<StringLine | null>(null);
  let eventsAvailable = $state(true);
  let lineFailure = $state<string | null>(null);
  let lineLoading = $state(false);
  let hover = $state<number | null>(null);
  let headwayHover = $state<number | null>(null);

  // The route.
  $effect(() => {
    app.version;
    const id = app.routeId;
    if (!id || !app.hasResults) {
      detail = null;
      network = null;
      loaded = null;
      return;
    }
    let current = true;
    refreshing = true;
    problem = null;
    Promise.all([engine.routeDetail(id), engine.networkMap(id)])
      .then(([route, map]) => {
        if (!current) return;
        detail = route;
        network = map;
        loaded = id;
        if (!route) problem = `Route ${id} has no service in the selected days.`;
      })
      .catch(error => {
        if (current) problem = errorText(error);
      })
      .finally(() => {
        if (current) refreshing = false;
      });
    return () => {
      current = false;
    };
  });

  const score = $derived(detail?.score ?? null);
  // One route's own mode picks the scale, whatever the rest of the agency runs.
  const scaleMode = $derived(detail?.score.mode === 'Rail' || detail?.score.mode === 'Ferry' ? detail.score.mode : app.mode === 'All' ? 'Bus' : app.mode);
  const directions = $derived(detail?.directions ?? []);
  const direction = $derived<DirectionDetail | null>(directions[Math.min(app.directionIndex, directions.length - 1)] ?? null);
  const name = $derived(score ? routeName(score.label, score.long_name) : '');
  const days = $derived(Math.max(1, detail?.dates.length ?? 1));
  const unit = $derived(speedUnit(app.units));
  const date = $derived(chosenDate && detail?.dates.includes(chosenDate) ? chosenDate : (detail?.dates[detail.dates.length - 1] ?? null));

  // The string-line chart for the chosen day.
  $effect(() => {
    app.version;
    const id = loaded;
    const dir = direction?.dir;
    const day = date;
    if (!id || dir === undefined || !day) {
      line = null;
      return;
    }
    let current = true;
    lineLoading = true;
    engine
      .stringLine(id, dir, dateNumber(day))
      .then(result => {
        if (!current) return;
        line = result.line;
        eventsAvailable = result.available;
        lineFailure = null;
      })
      .catch(error => {
        if (!current) return;
        line = null;
        lineFailure = errorText(error);
      })
      .finally(() => {
        if (current) lineLoading = false;
      });
    return () => {
      current = false;
    };
  });

  const windows = [
    {value: 'all', label: 'All day', from: null, to: null},
    {value: 'am', label: '6–10 AM', from: 6 * 3600, to: 10 * 3600},
    {value: 'mid', label: '10 AM–3 PM', from: 10 * 3600, to: 15 * 3600},
    {value: 'pm', label: '3–7 PM', from: 15 * 3600, to: 19 * 3600},
    {value: 'eve', label: 'After 7 PM', from: 19 * 3600, to: 26 * 3600},
  ] as const;
  const activeWindow = $derived(windows.find(option => option.value === timeWindow) ?? windows[0]);

  /** Tells directions apart even when an agency repeats a headsign. */
  function directionLabel(item: DirectionDetail, index: number) {
    const repeated = directions.some((other, i) => i !== index && other.headsign === item.headsign);
    if (!item.headsign) return `Direction ${item.dir === 2 ? index + 1 : item.dir}`;
    return repeated ? `${item.headsign} (${index + 1})` : item.headsign;
  }

  /** The part of a line between two distances, for marking it on the map. */
  function pathBetween(path: [number, number][], total: number, s0: number, s1: number) {
    const cumulative = [0];
    for (let i = 1; i < path.length; i += 1) {
      const k = Math.cos((path[i][1] * Math.PI) / 180);
      cumulative.push(cumulative[i - 1] + Math.hypot((path[i][0] - path[i - 1][0]) * k, path[i][1] - path[i - 1][1]));
    }
    const scale = total / (cumulative[cumulative.length - 1] || 1);
    return path.filter((_, i) => cumulative[i] * scale >= s0 && cumulative[i] * scale <= s1);
  }

  function showSlowest() {
    if (!direction?.slowest) return;
    const part = pathBetween(direction.path, direction.length_m, direction.slowest.s0, direction.slowest.s1);
    highlight = part.length >= 2 ? part : null;
  }

  // Charts over the hours.
  const hourly = $derived(new Map<number, DirectionHour>((direction?.hourly ?? []).map(row => [row.hour, row])));
  const at = <T,>(read: (row: DirectionHour) => T | null | undefined) =>
    HOURS.map(h => {
      const row = hourly.get(h);
      return row ? (read(row) ?? null) : null;
    });
  const toSpeed = (value: number | null) => (value === null ? null : toDisplaySpeed(value, app.units));
  const hasHeadways = $derived((direction?.hourly ?? []).some(row => row.headways !== null));
  const hasScheduledFrequent = $derived((direction?.hourly ?? []).some(row => row.scheduled_headway_s !== null));

  // Tables.
  const stopColumns = $derived<Column<RouteStop>[]>([
    {key: 'order', label: 'Stop', left: true, wrap: true, value: stop => stop.s, format: stop => stop.name, csv: stop => stop.name},
    {key: 'id', label: 'Stop ID', left: true, value: stop => stop.id},
    {key: 's', label: 'Along the route', value: stop => stop.s, format: stop => formatLength(stop.s, app.units), csv: stop => Math.round(stop.s)},
    {key: 'passes', label: 'Passes a day', descending: true, value: stop => stop.passes / days, format: stop => (stop.passes / days).toFixed(1)},
    {key: 'scheduled', label: 'Scheduled', descending: true, value: stop => stop.scheduled / days, format: stop => (stop.scheduled / days).toFixed(1)},
    {
      key: 'zone', label: 'Stop time', title: 'Average seconds within about 80 feet of the stop, including queuing and dwell',
      descending: true, value: stop => stop.zone_seconds, format: stop => (stop.zone_seconds === null ? DASH : `${Math.round(stop.zone_seconds)} s`),
    },
    {key: 'deviation', label: 'Mean deviation', title: 'Minutes:seconds against the schedule. Positive is late.', descending: true, value: stop => stop.deviation, format: stop => deviation(stop.deviation)},
    {key: 'ontime', label: 'On time', value: stop => ratioOf(stop.on_time.on_time, stop.on_time.total), format: stop => pct(ratioOf(stop.on_time.on_time, stop.on_time.total))},
    {key: 'bunched', label: 'Bunched', title: 'Frequent service only', descending: true, value: stop => stop.headways?.bunched ?? null, format: stop => pct(stop.headways?.bunched)},
    {key: 'gap', label: 'Gap to next stop', title: 'Distance along the line to the next stop', value: stop => stop.gap_to_next_m, format: stop => shortLength(stop.gap_to_next_m, app.units), csv: stop => (stop.gap_to_next_m === null ? '' : Math.round(stop.gap_to_next_m))},
  ]);

  const hourColumns = $derived<Column<DirectionHour>[]>([
    {key: 'hour', label: 'Hour', left: true, value: row => row.hour, format: row => hourRange(row.hour), csv: row => hourRange(row.hour)},
    {key: 'speed', label: `Speed, ${unit}`, descending: true, value: row => row.speed, format: row => speed(row.speed, app.units), csv: row => (row.speed === null ? '' : Number(speed(row.speed, app.units)))},
    {key: 'sched', label: `Scheduled, ${unit}`, descending: true, value: row => row.scheduled_speed, format: row => speed(row.scheduled_speed, app.units), csv: row => (row.scheduled_speed === null ? '' : Number(speed(row.scheduled_speed, app.units)))},
    {key: 'ontime', label: 'On time', value: row => ratioOf(row.on_time.on_time, row.on_time.total), format: row => pct(ratioOf(row.on_time.on_time, row.on_time.total))},
    {key: 'late', label: 'Late', descending: true, value: row => ratioOf(row.on_time.late, row.on_time.total), format: row => pct(ratioOf(row.on_time.late, row.on_time.total))},
    {key: 'tripsSched', label: 'Trips scheduled', descending: true, value: row => row.trips_scheduled, format: row => int(row.trips_scheduled)},
    {key: 'tripsObs', label: 'Observed', descending: true, value: row => row.trips_observed, format: row => int(row.trips_observed)},
    {key: 'headway', label: 'Headway', title: 'Average observed time between vehicles. Frequent service only.', value: row => (row.headways ? row.actual_headway_s : null), format: row => (row.headways ? minutes(row.actual_headway_s, 1) : DASH)},
    {key: 'headwaySched', label: 'Scheduled headway', value: row => (row.headways ? row.scheduled_headway_s : null), format: row => (row.headways ? minutes(row.scheduled_headway_s, 1) : DASH)},
    {key: 'bunched', label: 'Bunched', descending: true, value: row => row.headways?.bunched ?? null, format: row => pct(row.headways?.bunched)},
    {key: 'gapped', label: 'Gaps', descending: true, value: row => row.headways?.gapped ?? null, format: row => pct(row.headways?.gapped)},
  ]);

  const patternColumns = $derived<Column<PatternSummary>[]>([
    {key: 'headsign', label: 'Pattern', left: true, wrap: true, value: pattern => pattern.headsign || DASH, cell: patternCell},
    {key: 'stops', label: 'Stops', value: pattern => pattern.stops},
    {key: 'length', label: 'Length', value: pattern => pattern.length_m, format: pattern => formatLength(pattern.length_m, app.units)},
    {key: 'runs', label: 'Complete runs', descending: true, value: pattern => pattern.trips_observed, format: pattern => int(pattern.trips_observed)},
  ]);

  function downloadProfile() {
    if (!direction || !detail) return;
    const hoursShown = HOURS.filter(hour => direction.profile.some(bin => bin.speeds[hour] !== null));
    const columns = [
      {label: 'from_m', value: (bin: DirectionDetail['profile'][number]) => Math.round(bin.s0)},
      {label: 'to_m', value: (bin: DirectionDetail['profile'][number]) => Math.round(bin.s1)},
      {label: 'measurements', value: (bin: DirectionDetail['profile'][number]) => bin.measurements},
      ...hoursShown.map(hour => ({
        label: `${unit.replace('/', 'p')}_${hourRange(hour)}`,
        value: (bin: DirectionDetail['profile'][number]) => {
          const value = bin.speeds[hour];
          return value === null || value === undefined ? null : Number(speed(value, app.units, 2));
        },
      })),
    ];
    downloadCsv(`route-${detail.score.id}-speed-profile.csv`, columns, direction.profile);
  }

  function downloadLine() {
    if (!line || !detail) return;
    const rows = line.trips.flatMap(trip =>
      trip.observed.map(([time, s], index) => ({
        trip: trip.trip_id,
        vehicle: trip.vehicle,
        s,
        observed: time,
        scheduled: trip.scheduled[index]?.[0] ?? null,
      })),
    );
    downloadCsv(
      `route-${detail.score.id}-trips-${line.date}.csv`,
      [
        {label: 'trip_id', value: (row: (typeof rows)[number]) => row.trip},
        {label: 'vehicle', value: (row: (typeof rows)[number]) => row.vehicle},
        {label: 'distance_m', value: (row: (typeof rows)[number]) => Math.round(row.s)},
        {label: 'observed', value: (row: (typeof rows)[number]) => clock(row.observed)},
        {label: 'scheduled', value: (row: (typeof rows)[number]) => (row.scheduled === null ? '' : clock(row.scheduled))},
        {label: 'deviation_s', value: (row: (typeof rows)[number]) => (row.scheduled === null ? '' : row.observed - row.scheduled)},
      ],
      rows,
    );
  }
</script>

{#snippet patternCell(pattern: PatternSummary)}
  {pattern.headsign || DASH}
  {#if direction && pattern.index === direction.pattern}<span class="main-pattern">Main pattern, shown here</span>{/if}
{/snippet}

{#snippet chooser()}
  {#if app.routes.length}
    <ul class="chooser">
      {#each app.routes as route}
        <li>
          <button onclick={() => app.go('route', route.id)}>
            <RouteBadge label={route.label} color={route.color} textColor={route.text_color} />
            <span class="chooser-name">{routeName(route.label, route.long_name)}</span>
            <span class="fine num">{speedWithUnit(route.speed_peak ?? route.speed, app.units)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No routes in the selected days yet.</p>
  {/if}
{/snippet}

{#if !app.routeId}
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Choose a route</h1>
        <p class="lede">Each route has its own report: where and when it slows, how every trip ran, run times and stop by stop reliability. Speeds here are at peak.</p>
      </div>
    </div>
    {@render chooser()}
  </div>
{:else if problem && !detail}
  <div class="page">
    <button class="link-btn back" onclick={() => app.go('routes')}>
      <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M13 3l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>
      All routes
    </button>
    <div class="banner caution" role="status">{problem}</div>
    {@render chooser()}
  </div>
{:else if detail && score}
  <div class="page" class:refreshing>
    <div class="head">
      <button class="link-btn back" onclick={() => app.go('routes')}>
        <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M13 3l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>
        All routes
      </button>
      <div class="page-head">
        <div>
          <h1 class="title">
            <RouteBadge label={score.label} color={score.color} textColor={score.text_color} />
            <span>{name || `Route ${score.label}`}</span>
          </h1>
          <p class="lede">{datesLabel(detail.dates.map(dateNumber))} · {plural(detail.dates.length, 'service day')}</p>
        </div>
        <label class="field route-select">Route
          <select class="input" value={app.routeId} onchange={event => app.go('route', event.currentTarget.value)}>
            {#each app.routes as route}
              <option value={route.id}>{`${route.label} ${routeName(route.label, route.long_name)}`.trim()}</option>
            {/each}
          </select>
        </label>
      </div>
    </div>

    <dl class="stats">
      <div class="stat">
        <dt>Operating speed</dt>
        <dd>{speed(score.speed, app.units)} <small>{unit}</small></dd>
        <div class="sub">{speed(score.scheduled_speed, app.units)} scheduled</div>
      </div>
      <div class="stat">
        <dt>Peak against midday</dt>
        <dd>{signedPct(score.peak_change)}</dd>
        <div class="sub">
          {#if score.peak_change_ci}
            95% interval {signedPct(score.peak_change_ci[0])} to {signedPct(score.peak_change_ci[1])}
          {:else}
            {speed(score.speed_peak, app.units)} at peak, {speed(score.speed_mid, app.units)} midday
          {/if}
        </div>
      </div>
      <div class="stat">
        <dt>On-time departures</dt>
        <dd>{pct(ratioOf(score.on_time.on_time, score.on_time.total))}</dd>
        <div class="sub">{pct(ratioOf(score.on_time.late, score.on_time.total))} late, {pct(ratioOf(score.on_time.early, score.on_time.total))} early</div>
      </div>
      <div class="stat">
        <dt>Trips observed</dt>
        <dd>{int(score.trips_observed / days)} <small>a day</small></dd>
        <div class="sub">{pct(ratioOf(score.trips_observed, score.trips_scheduled), 1)} of {int(score.trips_scheduled / days)} scheduled</div>
      </div>
      {#if score.headways}
        <div class="stat">
          <dt>Excess wait</dt>
          <dd>{minutes(score.headways.excess_wait_s, 1)}</dd>
          <div class="sub">{pct(score.headways.bunched)} bunched, {pct(score.headways.gapped)} after a gap</div>
        </div>
      {/if}
      <div class="stat">
        <dt>Run time, median</dt>
        <dd>{minutes(score.run_p50_s)}</dd>
        <div class="sub">{minutes(score.run_p90_s)} at the 90th percentile, {minutes(score.run_scheduled_s)} scheduled</div>
      </div>
    </dl>

    {#if directions.length > 1}
      <div class="direction-bar">
        <span class="fine">The figures above cover the whole route. Everything below follows one direction:</span>
        <div class="seg directions" role="group" aria-label="Direction">
          {#each directions as item, index}
            <button
              aria-pressed={direction === item}
              onclick={() => {
                app.directionIndex = index;
                highlight = null;
              }}>{directionLabel(item, index)}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#if direction}
      <section class="section">
        <div class="section-head">
          <div>
            <h2>Where and when it slows</h2>
            <p class="note">Each column is a stretch of the route, first stop on the left. Each row is an hour. A vertical band is a place that is always slow; a horizontal one is a time of day that is. Choose a row to show that hour on the map.</p>
          </div>
          <button class="btn small quiet" onclick={downloadProfile}>Download CSV</button>
        </div>
        <SpeedLegend mode={scaleMode} units={app.units} />
        <ProfileHeat
          profile={direction.profile}
          stops={direction.stops}
          lengthM={direction.length_m}
          units={app.units}
          mode={scaleMode}
          slowest={direction.slowest}
          selectedHour={app.mapHour}
          onpick={hour => (app.mapHour = hour)}
        />
        <div class="map-row">
          <div class="map-col">
            {#key loaded}
              <SpeedMap
                data={network}
                hour={app.mapHour}
                mode={scaleMode}
                units={app.units}
                {highlight}
                height="420px"
                label="Map of average speed along route {score.label}"
              />
            {/key}
            <HourTimeline hours={network?.hours ?? []} hour={app.mapHour} units={app.units} height={96} scope="on this route" onchange={hour => (app.mapHour = hour)} />
          </div>
          <aside class="map-side">
            {#if direction.slowest}
              <div class="slowest">
                <h3>Slowest stretch at peak</h3>
                <p class="slowest-speed">{speedWithUnit(direction.slowest.speed, app.units)}</p>
                <p class="note">{direction.slowest.from} to {direction.slowest.to}, about {formatLength(direction.slowest.length_m, app.units)}.</p>
                <div class="tools">
                  <button class="btn small" onclick={showSlowest}>Show on map</button>
                  {#if highlight}<button class="btn small quiet" onclick={() => (highlight = null)}>Clear</button>{/if}
                </div>
              </div>
            {/if}
            <div class="patterns">
              <h3>{plural(direction.patterns.length, 'pattern')} in this direction</h3>
              {#if direction.patterns.length > 1}
                <p class="note">The charts follow the main pattern, the one with the most complete runs. Trips on other patterns appear in the string-line chart wherever they share its stops.</p>
                <DataTable columns={patternColumns} rows={direction.patterns} caption="Patterns in this direction" defaultSort="runs" defaultDescending limit={5} />
              {:else}
                <p class="note">Every trip in this direction follows the same stops and shape: {direction.stops.length} stops over {formatLength(direction.length_m, app.units)}.</p>
              {/if}
            </div>
          </aside>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Every trip on one day</h2>
            <p class="note">Time runs across and the route runs down. Lines that converge are vehicles catching each other, and a line flattening out is a vehicle standing still.</p>
          </div>
          <div class="tools">
            <label class="inline-field">
              <span class="fine">Service day</span>
              <select class="input" value={date} onchange={event => (chosenDate = event.currentTarget.value)}>
                {#each detail.dates as option}
                  <option value={option}>{dateLabel(option)}</option>
                {/each}
              </select>
            </label>
            <div class="seg" role="group" aria-label="Time of day">
              {#each windows as option}
                <button aria-pressed={timeWindow === option.value} onclick={() => (timeWindow = option.value)}>{option.label}</button>
              {/each}
            </div>
            {#if line}<span class="fine num">{plural(line.trips.length, 'trip')}</span>{/if}
            <button class="btn small quiet" disabled={!line} onclick={downloadLine}>Download CSV</button>
          </div>
        </div>
        {#if line && line.trips.length}
          <div class="line-frame" class:dimmed={lineLoading}>
            <StringLineChart data={line} units={app.units} from={activeWindow.from} to={activeWindow.to} />
          </div>
        {:else if lineLoading}
          <p class="empty">Loading this day's trips…</p>
        {:else}
          <p class="empty">
            {#if lineFailure}This chart could not be drawn. {lineFailure}
            {:else if !eventsAvailable}Trip-level detail for this day isn't on this device, usually because saving it failed. Clear this agency's results on Data &amp; methods and analyze the day again to see it.
            {:else}No trips were observed in this direction on this day.{/if}
          </p>
        {/if}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Run times</h2>
            <p class="note">How long the main pattern takes end to end, by the hour a trip was scheduled to start. A wide bar means an unpredictable run, which the schedule has to cover with recovery time.</p>
          </div>
        </div>
        {#if direction.run_times.length}
          <RunTimes rows={direction.run_times} />
        {:else}
          <p class="empty">No complete runs of the main pattern in the selected days. A run counts once it has been seen over 90% of the route.</p>
        {/if}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Where lateness builds</h2>
            <p class="note">Mean deviation from the schedule at each stop, by time of day. A climbing line is losing time; a falling one is recovering it. Many agencies interpolate times between timepoints, so read the trend rather than single stops.</p>
          </div>
        </div>
        {#if direction.stops.some(stop => stop.deviation !== null)}
          <DelayProfile stops={direction.stops} lengthM={direction.length_m} units={app.units} earlyS={app.earlyS} lateS={app.lateS} />
        {:else}
          <p class="empty">No stop passes were observed in this direction.</p>
        {/if}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Headways</h2>
            {#if hasHeadways}
              <p class="note">The time between vehicles, averaged across stops, in the hours scheduled every 15 minutes or better. Riders on frequent service don't time their arrival, so spacing matters more to them than the timetable.</p>
            {/if}
          </div>
        </div>
        {#if hasHeadways}
          <div class="pair">
            <figure>
              <figcaption><h3>Average headway, minutes</h3></figcaption>
              <LineChart
                bind:hover={headwayHover}
                label="Actual and scheduled headway by hour"
                yMin={0}
                format={value => `${value.toFixed(1)} min`}
                formatAxis={value => value.toFixed(0)}
                series={[
                  {key: 'actual', label: 'Actual', color: 'var(--ink)', values: at(row => (row.headways && row.actual_headway_s !== null ? row.actual_headway_s / 60 : null))},
                  {key: 'scheduled', label: 'Scheduled', color: 'var(--gray-series)', reference: true, values: at(row => (row.headways && row.scheduled_headway_s !== null ? row.scheduled_headway_s / 60 : null))},
                ]}
              />
            </figure>
            <figure>
              <figcaption><h3>Vehicles bunched or after a gap</h3></figcaption>
              <LineChart
                bind:hover={headwayHover}
                label="Share of vehicles bunched or following a gap, by hour"
                yMin={0}
                format={value => `${(value * 100).toFixed(0)}%`}
                series={[
                  {key: 'bunched', label: 'Bunched', color: 'var(--orange)', values: at(row => row.headways?.bunched)},
                  {key: 'gapped', label: 'After a gap', color: 'var(--purple)', values: at(row => row.headways?.gapped)},
                ]}
              />
            </figure>
          </div>
          <p class="note">Bunched means under a quarter of the scheduled headway. A gap is more than one and a half times the scheduled headway, so a trip missing from the realtime feed shows up as a gap here.</p>
        {:else if hasScheduledFrequent}
          <p class="note">Too few headways were measured in this direction to report them reliably.</p>
        {:else}
          <p class="note">This direction is never scheduled every 15 minutes or better, so riders plan around the timetable. On-time performance is the measure to use.</p>
        {/if}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Stop by stop</h2>
            <p class="note">Stop time is the average spent within about 80 feet of the stop, including queuing and dwell. With position reports every 20 seconds or so, it is only meaningful averaged over many passes.</p>
          </div>
        </div>
        <DataTable
          columns={stopColumns}
          rows={direction.stops}
          caption="Stops on the main pattern, in route order"
          defaultSort="order"
          filename="route-{score.id}-direction-{direction.dir}-stops.csv"
          search={stop => `${stop.name} ${stop.id}`}
          placeholder="Find a stop…"
          maxHeight="70vh"
        />
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Hour by hour</h2>
            <p class="note">The numbers behind this direction's charts. Pointing at either chart moves both.</p>
          </div>
        </div>
        <div class="pair">
          <figure>
            <figcaption><h3>Speed, {unit}</h3></figcaption>
            <LineChart
              bind:hover
              label="Measured and scheduled speed by hour"
              format={value => value.toFixed(1)}
              formatAxis={value => value.toFixed(0)}
              series={[
                {key: 'measured', label: 'Measured', color: 'var(--ink)', values: at(row => toSpeed(row.speed))},
                {key: 'scheduled', label: 'Scheduled', color: 'var(--gray-series)', reference: true, values: at(row => toSpeed(row.scheduled_speed))},
              ]}
            />
          </figure>
          <figure>
            <figcaption><h3>On-time departures at timepoints</h3></figcaption>
            <LineChart
              bind:hover
              label="Share of departures on time and late by hour"
              yMin={0}
              yMax={1}
              format={value => `${(value * 100).toFixed(0)}%`}
              series={[
                {key: 'ontime', label: 'On time', color: 'var(--blue)', values: at(row => (row.on_time.total >= 5 ? ratioOf(row.on_time.on_time, row.on_time.total) : null))},
                {key: 'late', label: 'Late', color: 'var(--orange)', values: at(row => (row.on_time.total >= 5 ? ratioOf(row.on_time.late, row.on_time.total) : null))},
              ]}
            />
          </figure>
        </div>
        <DataTable
          columns={hourColumns}
          rows={direction.hourly}
          caption="This direction by service hour"
          defaultSort="hour"
          filename="route-{score.id}-direction-{direction.dir}-hours.csv"
        />
      </section>
    {:else}
      <p class="empty">This route has no scheduled pattern in the selected days.</p>
    {/if}
  </div>
{:else}
  <div class="page"><p class="empty">Loading this route…</p></div>
{/if}

<style>
  .refreshing { opacity: .7; transition: opacity 150ms ease-out; }
  .head { display: grid; gap: 8px; }
  .back { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; justify-self: start; }
  .title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
  .title :global(.route-badge) { height: 32px; min-width: 42px; padding: 0 9px; font-size: 18px; font-family: var(--font-body); letter-spacing: 0; }
  .route-select select { min-width: 220px; max-width: 320px; }
  .direction-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .directions { flex-wrap: wrap; }

  .map-row { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start; padding-top: 12px; }
  .map-col { display: grid; gap: 10px; min-width: 0; }
  .map-side { display: grid; gap: 20px; min-width: 0; }
  .slowest { display: grid; gap: 4px; }
  .slowest-speed { font-size: 26px; font-weight: 650; letter-spacing: -.02em; line-height: 1.2; }
  .slowest .tools { padding-top: 4px; }
  .patterns { display: grid; gap: 6px; padding-top: 16px; border-top: 1px solid var(--rule); min-width: 0; }
  .main-pattern { display: block; font-size: 11.5px; color: var(--copper); font-weight: 600; }

  .inline-field { display: inline-flex; align-items: center; gap: 6px; }
  .inline-field select { height: 32px; font-size: 12.5px; }
  .line-frame { display: grid; gap: 8px; min-width: 0; }
  .dimmed { opacity: .6; transition: opacity 150ms ease-out; }

  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 28px 36px; }
  figure { display: grid; gap: 6px; min-width: 0; }

  .chooser { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0 28px; }
  .chooser li { border-bottom: 1px solid var(--rule); }
  .chooser button {
    width: 100%; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 4px; border: 0; background: none; text-align: left;
    transition: background-color 120ms ease-out;
  }
  .chooser button:hover { background: var(--surface); }
  .chooser-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }

  @media (max-width: 1100px) {
    .map-row { grid-template-columns: minmax(0, 1fr); }
  }
</style>
