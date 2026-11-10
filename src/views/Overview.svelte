<script lang="ts">
  import LineChart from '../charts/LineChart.svelte';
  import Dumbbell from '../charts/Dumbbell.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import Term from '../components/Term.svelte';
  import {engine} from '../engine/client';
  import type {DayRow, HourRow, NetworkMap} from '../engine/types';
  import {findings, scopeLine} from '../lib/findings';
  import {DASH, dateLabel, datesLabel, int, minutes, pct, signedPct, speed, speedUnit, toDisplaySpeed} from '../lib/format';
  import {HOURS} from '../lib/scale';
  import {DEFINITIONS, MIN_EVENTS, coverageNote, coverageOf, isShown, sampleText, scheduleSuppressed, share as shareOf} from '../lib/stats';
  import {app, errorText, feedLabel} from '../lib/state.svelte';
  import HourTimeline from '../map/HourTimeline.svelte';
  import SpeedMap from '../map/SpeedMap.svelte';

  let network = $state<NetworkMap | null>(null);
  let mapFailure = $state<string | null>(null);
  let hover = $state<number | null>(null);
  let mapRequest = 0;

  $effect(() => {
    app.version;
    if (!app.hasResults) return;
    const request = ++mapRequest;
    engine.networkMap().then(
      result => {
        if (request !== mapRequest) return;
        network = result;
        mapFailure = null;
      },
      error => {
        if (request !== mapRequest) return;
        // Don't leave the last selection's map beside this selection's numbers.
        network = null;
        mapFailure = errorText(error);
      },
    );
  });

  const o = $derived(app.overview);
  const list = $derived(o ? findings(o, app.routes, app.units) : []);
  const lead = $derived(list[0] ?? null);
  const byHour = $derived(new Map<number, HourRow>((o?.hourly ?? []).map(row => [row.hour, row])));
  const at = <T,>(read: (row: HourRow) => T | null) => HOURS.map(h => {
    const row = byHour.get(h);
    return row ? read(row) : null;
  });
  const unit = $derived(speedUnit(app.units));
  const toSpeed = (v: number | null) => (v === null ? null : toDisplaySpeed(v, app.units));
  // Whole-day shares are shown whatever the count; hours and routes go through shareOf.
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

  const coverage = $derived(coverageOf(o));
  const speedsOnly = $derived(coverage.mode === 'gps');
  const withheld = $derived(scheduleSuppressed(coverage));
  const caveat = $derived(coverageNote(coverage));
  const matchText = $derived(coverage.matchRate === null ? '' : `${Math.round(coverage.matchRate * 100)}% trip-ID match`);
  const onTimeShown = $derived(!!o && !withheld && isShown(o.on_time.total));
  const onTimeShare = $derived(o && onTimeShown ? share(o.on_time.on_time, o.on_time.total) : null);
  const lateShare = $derived(o && onTimeShown ? share(o.on_time.late, o.on_time.total) : null);
  const windowShort = $derived(`${app.earlyS === 0 ? '0' : `\u2212${Math.abs(app.earlyS) / 60}`} / +${app.lateS / 60} min`);
  const onTimeDef = $derived(DEFINITIONS.ontime(app.earlyS === 0 ? 'on time (no early allowance)' : `${Math.abs(app.earlyS) / 60} min early`, `${app.lateS / 60} min late`));
  const observedShare = $derived(o && !withheld ? share(o.trips_observed_per_day, o.trips_scheduled_per_day) : null);
  const headwaysShown = $derived(!!o?.headways && !withheld && isShown(o.headways.count));
  const peakChange = $derived(o?.speed_peak && o?.speed_mid ? o.speed_peak / o.speed_mid - 1 : null);

  const dumbbellRows = $derived(app.routes.map(r => ({id: r.id, label: r.label, name: r.long_name, mid: r.speed_mid, peak: r.speed_peak})));

  const dayColumns = $derived<Column<DayRow>[]>([
    {key: 'date', label: 'Service day', left: true, value: d => d.date, format: d => dateLabel(d.date)},
    {key: 'speed', label: `Speed, ${unit}`, value: d => d.speed, format: d => speed(d.speed, app.units), csv: d => (d.speed === null ? null : Number(toDisplaySpeed(d.speed, app.units).toFixed(2))), descending: true},
    {key: 'peak', label: `Peak, ${unit}`, value: d => d.peak_speed, format: d => speed(d.peak_speed, app.units), csv: d => (d.peak_speed === null ? null : Number(toDisplaySpeed(d.peak_speed, app.units).toFixed(2))), descending: true},
    ...(speedsOnly ? [] : [
      {key: 'ontime', label: 'On time', title: `Departures at timepoints, ${windowShort}. Withheld under ${MIN_EVENTS} departures.`, value: (d: DayRow) => shareOf(d.on_time.on_time, d.on_time.total), format: (d: DayRow) => (isShown(d.on_time.total) ? pct(shareOf(d.on_time.on_time, d.on_time.total)) : DASH), descending: true},
      {key: 'timed', label: 'Timed departures', title: 'Sample size behind the on-time share', value: (d: DayRow) => d.on_time.total, format: (d: DayRow) => int(d.on_time.total), descending: true},
      {key: 'observed', label: 'Trips observed', value: (d: DayRow) => d.trips_observed, format: (d: DayRow) => int(d.trips_observed), descending: true},
      {key: 'scheduled', label: 'Trips scheduled', value: (d: DayRow) => d.trips_scheduled, format: (d: DayRow) => int(d.trips_scheduled), descending: true},
      {key: 'share', label: 'Share observed', value: (d: DayRow) => share(d.trips_observed, d.trips_scheduled), format: (d: DayRow) => pct(share(d.trips_observed, d.trips_scheduled)), descending: true},
    ] as Column<DayRow>[]),
    {key: 'gaps', label: 'Capture gaps', title: 'Five-minute periods during scheduled service with no archived feed capture', value: d => d.empty_buckets, format: d => (d.service_buckets === 0 ? '—' : d.empty_buckets ? `${(d.empty_buckets * 5).toLocaleString('en-US')} min` : 'None')},
    {key: 'status', label: 'Status', left: true, value: d => (d.status === 'Partial' ? 'Partial' : 'Complete'), format: d => (d.status === 'Partial' ? 'Partial, see note above' : d.empty_buckets > 0 ? 'Complete, with gaps' : 'Complete')},
  ]);
</script>

{#if o}
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{app.feed ? feedLabel(app.feed) : ''}</h1>
      </div>
    </div>
    <div class="lead-row">
      {#if lead}
        <p class="lead">
          {lead.text}
          {#if lead.route}<button class="link-btn" onclick={() => app.go('route', lead.route)}>Open route</button>{/if}
        </p>
      {/if}
      <p class="fine scope">{datesLabel(o.dates.map(d => Number(d.replaceAll('-', ''))))} · {scopeLine(o)}</p>
    </div>

    {#if caveat}
      <p class="banner caution" role="note" data-coverage={coverage.mode}>
        {#if speedsOnly}<strong>Speeds only.</strong> {/if}{caveat}
        {#if speedsOnly} On-time, trips observed, headways and run times need a schedule, so they are not shown rather than shown as zero.{/if}
      </p>
    {/if}

    <dl class="stats">
      <div class="stat">
        <dt><Term topic="speed" def={DEFINITIONS.speed}>Operating speed</Term></dt>
        <dd>{speed(o.speed, app.units)} <small>{unit}</small></dd>
        <div class="sub">{speedsOnly ? 'GPS only, no schedule to compare' : `${speed(o.scheduled_speed, app.units)} scheduled, stops included`}</div>
      </div>
      <div class="stat">
        <dt><Term topic="period">Peak speed</Term></dt>
        <dd>{speed(o.speed_peak, app.units)} <small>{unit}</small></dd>
        <div class="sub">{signedPct(peakChange)} against midday</div>
      </div>
      {#if !speedsOnly}
        <div class="stat" data-partial={coverage.mode === 'partial' || undefined}>
          <dt><Term topic="ontime" def={onTimeDef}>On-time departures</Term></dt>
          {#if onTimeShown}
            <dd>{pct(onTimeShare)}{#if coverage.mode === 'partial'} <small>partial</small>{/if}</dd>
            <div class="sub">{windowShort} at timepoints · {pct(lateShare)} late · {sampleText(o.on_time.total)}{#if matchText} · {matchText}{/if}</div>
          {:else}
            <dd>—</dd>
            <div class="sub">{withheld ? `withheld, ${matchText || 'schedule match too low'}` : sampleText(o.on_time.total)}</div>
          {/if}
        </div>
        <div class="stat" data-partial={coverage.mode === 'partial' || undefined}>
          <dt><Term topic="service" def={DEFINITIONS.observed}>Trips observed</Term></dt>
          {#if o.trips_scheduled_per_day > 0 && !withheld}
            <dd>{int(o.trips_observed_per_day)} <small>a day{#if coverage.mode === 'partial'}, partial{/if}</small></dd>
            <div class="sub">{pct(observedShare, 1)} of {int(o.trips_scheduled_per_day)} scheduled{#if matchText} · {matchText}{/if}</div>
          {:else}
            <dd>—</dd>
            <div class="sub">{withheld ? `withheld, ${matchText || 'schedule match too low'}` : 'No schedule to compare with'}</div>
          {/if}
        </div>
        {#if o.headways}
          <div class="stat">
            <dt><Term topic="headways" def={DEFINITIONS.excessWait}>Excess wait</Term></dt>
            {#if headwaysShown}
              <dd>{minutes(o.headways.excess_wait_s, 1)}</dd>
              <div class="sub">{pct(o.headways.bunched)} bunched · {sampleText(o.headways.count)} headways</div>
            {:else}
              <dd>—</dd>
              <div class="sub">{withheld ? 'withheld, schedule match too low' : sampleText(o.headways.count)}</div>
            {/if}
          </div>
        {/if}
      {/if}
      <div class="stat">
        <dt><Term topic="service">Vehicles at peak</Term></dt>
        <dd>{int(o.peak_vehicles)}</dd>
        <div class="sub">{int(o.service_hours_observed_per_day)} service hours a day</div>
      </div>
    </dl>

    <section class="hero" aria-label="Speed map and findings">
      <div class="hero-map">
        {#if mapFailure}<p class="banner error" role="alert">The map could not be drawn. {mapFailure}</p>{/if}
        <SpeedMap data={network} hour={app.mapHour} mode={app.scaleMode} units={app.units} height="max(360px, calc(100dvh - 506px))" onselect={() => app.go('map')} />
        <SpeedLegend mode={app.scaleMode} units={app.units} />
        <HourTimeline hours={network?.hours ?? []} hour={app.mapHour} units={app.units} onchange={h => app.setMapHour(h)} />
      </div>
      <aside class="findings">
        <h2>What the data shows</h2>
        <ul>
          {#each list.slice(1) as finding}
            <li>
              {finding.text}
              {#if finding.route}<button class="link-btn" onclick={() => app.go('route', finding.route)}>Open route</button>{/if}
            </li>
          {/each}
        </ul>
        <button class="btn small" onclick={() => app.go('hotspots')}>Open delay hotspots</button>
      </aside>
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>Through the day</h2><p class="note">Pointing at any chart moves all of them. Hours with fewer than {MIN_EVENTS} timed departures are left off the on-time chart. Shaded bands mark the 7–9 AM and 4–6 PM peaks.</p></div>
      </div>
      <div class="small-multiples">
        <figure>
          <figcaption><h3><Term topic="speed">Speed, {unit}</Term></h3></figcaption>
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
        {#if !speedsOnly}
        <figure>
          <figcaption><h3><Term topic="ontime">On-time departures at timepoints</Term></h3></figcaption>
          <LineChart
            bind:hover
            label="Share of departures on time by hour"
            yMin={0}
            yMax={1}
            format={v => `${(v * 100).toFixed(0)}%`}
            series={[{key: 'otp', label: 'On time', color: 'var(--blue)', values: at(r => (isShown(r.on_time.total) ? share(r.on_time.on_time, r.on_time.total) : null))}, {key: 'late', label: 'Late', color: 'var(--orange)', values: at(r => (isShown(r.on_time.total) ? share(r.on_time.late, r.on_time.total) : null))}]}
          />
        </figure>
        {#if !speedsOnly}
        <figure>
          <figcaption><h3><Term topic="service">Trips starting per hour</Term></h3></figcaption>
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
        {/if}
        {/if}
        <figure>
          <figcaption><h3><Term topic="service">Vehicles in service</Term></h3></figcaption>
          <LineChart
            bind:hover
            label="Distinct vehicles in service by hour"
            yMin={0}
            format={v => v.toFixed(0)}
            legend
            series={[{key: 'veh', label: 'Vehicles', color: 'var(--ink)', values: at(r => r.vehicles)}]}
          />
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2><Term topic="period">Slowest routes at peak</Term></h2>
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
  .page { gap: 22px; padding-top: 18px; }
  .page-head { margin-bottom: -14px; }
  .lead-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 32px; margin-bottom: -6px; }
  .lead { font-size: 18px; line-height: 1.35; color: var(--ink); text-wrap: pretty; }
  .lead :global(.link-btn) { font-size: 13px; margin-left: 4px; }
  .scope { flex: none; }
  .page :global(.section) { margin-top: 10px; }
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
