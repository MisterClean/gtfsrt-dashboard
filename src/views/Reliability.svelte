<script lang="ts">
  import Term from '../components/Term.svelte';
  import LineChart from '../charts/LineChart.svelte';
  import DeviationHistogram from '../charts/network/DeviationHistogram.svelte';
  import HourlyStack from '../charts/network/HourlyStack.svelte';
  import RankedBars, {type RankedRow} from '../charts/network/RankedBars.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import RouteBadge from '../components/RouteBadge.svelte';
  import type {HourRow, RouteScore} from '../engine/types';
  import {DASH, deviation, int, minutes, pct, ratioOf, routeName} from '../lib/format';
  import {HOURS} from '../lib/scale';
  import {app} from '../lib/state.svelte';
  import {DEFINITIONS, MIN_EVENTS, SOLID_EVENTS, TOO_FEW, coverageNote, coverageOf, isShown, isSolid, sampleState, sampleText, scheduleSuppressed} from '../lib/stats';

  const coverage = $derived(coverageOf(app.overview));
  const withheld = $derived(scheduleSuppressed(coverage));
  const caveat = $derived(coverageNote(coverage));
  const matchText = $derived(coverage.matchRate === null ? '' : `${Math.round(coverage.matchRate * 100)}% trip-ID match`);

  const EARLY_OPTIONS = [0, 1, 3, 5];
  const LATE_OPTIONS = [1, 2, 3, 5, 10, 15];

  type HeadwayMeasure = 'bunched' | 'gapped' | 'excess';
  let measure = $state<HeadwayMeasure>('bunched');

  const o = $derived(app.overview);
  const onShown = $derived(!!o && !withheld && isShown(o.on_time.total));
  const hwShown = $derived(!!o?.headways && !withheld && isShown(o.headways.count));
  const earlyMinutes = $derived(Math.abs(app.earlyS) / 60);
  const lateMinutes = $derived(app.lateS / 60);
  const windowText = $derived(
    `${earlyMinutes === 0 ? 'no earlier than scheduled' : `no more than ${earlyMinutes} min early`} and less than ${lateMinutes} min late`,
  );

  const windowDef = $derived(DEFINITIONS.ontime(earlyMinutes === 0 ? 'on time (no early allowance)' : `${earlyMinutes} min early`, `${lateMinutes} min late`));
  /** A figure over n events, or "too few trips" when n is under the shared minimum. */
  const rate = (value: number | null, n: number) => (isShown(n) ? pct(value) : TOO_FEW);

  function setWindow(early: number, late: number) {
    app.earlyS = -early * 60;
    app.lateS = late * 60;
    app.refresh();
  }

  const onTimeOf = (r: RouteScore) => (isShown(r.on_time.total) ? ratioOf(r.on_time.on_time, r.on_time.total) : null);
  const lowMark = (n: number) => (sampleState(n) === 'low' ? '*' : '');
  const shownPct = (value: number | null, n: number) => (isShown(n) ? `${pct(value)}${lowMark(n)}` : TOO_FEW);
  const headwayPct = (r: RouteScore, value: number | undefined) => (r.headways ? shownPct(value ?? null, r.headways.count) : DASH);
  const earlyOf = (r: RouteScore) => (isShown(r.on_time.total) ? ratioOf(r.on_time.early, r.on_time.total) : null);
  const lateOf = (r: RouteScore) => (isShown(r.on_time.total) ? ratioOf(r.on_time.late, r.on_time.total) : null);
  const asMinutes = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? null : Number((seconds / 60).toFixed(2)));
  const titleOf = (r: RouteScore) => `${r.label} ${routeName(r.label, r.long_name)}`.trim();

  const onTimeRows = $derived<RankedRow[]>(
    app.routes
      .filter(r => isShown(r.on_time.total))
      .sort((a, b) => (onTimeOf(a) ?? 0) - (onTimeOf(b) ?? 0))
      .map(r => ({
        id: r.id,
        label: r.label,
        name: routeName(r.label, r.long_name),
        value: onTimeOf(r) ?? 0,
        text: pct(onTimeOf(r)),
        tip: [
          {title: titleOf(r)},
          {label: 'On time', value: pct(onTimeOf(r))},
          {label: 'Late', value: pct(lateOf(r))},
          {label: 'Early', value: pct(earlyOf(r))},
          {note: `${sampleText(r.on_time.total)} departures at timepoints`},
        ],
      })),
  );

  const headwayValue = (r: RouteScore) => {
    if (!r.headways) return 0;
    if (measure === 'bunched') return r.headways.bunched;
    if (measure === 'gapped') return r.headways.gapped;
    return (r.headways.excess_wait_s ?? 0) / 60;
  };
  const headwayRows = $derived<RankedRow[]>(
    app.routes
      .filter(r => isShown(r.headways?.count))
      .sort((a, b) => headwayValue(b) - headwayValue(a))
      .map(r => ({
        id: r.id,
        label: r.label,
        name: routeName(r.label, r.long_name),
        value: headwayValue(r),
        text: measure === 'excess' ? `${headwayValue(r).toFixed(1)} min` : pct(headwayValue(r)),
        tip: [
          {title: titleOf(r)},
          {label: 'Bunched', value: pct(r.headways?.bunched)},
          {label: 'After a gap', value: pct(r.headways?.gapped)},
          {label: 'Excess wait', value: minutes(r.headways?.excess_wait_s, 1)},
          {note: `${sampleText(r.headways?.count ?? 0)} headways on frequent service`},
        ],
      })),
  );

  const byHour = $derived(new Map<number, HourRow>((o?.hourly ?? []).map(row => [row.hour, row])));
  const hourlyHeadway = (read: (row: HourRow) => number | null | undefined) =>
    HOURS.map(h => {
      const row = byHour.get(h);
      return row && isSolid(row.headways?.count) ? (read(row) ?? null) : null;
    });
  const hasHourlyHeadways = $derived((o?.hourly ?? []).some(row => isSolid(row.headways?.count)));

  const tableRows = $derived(withheld ? [] : app.routes.filter(r => r.on_time.total > 0 || r.headways));
  const columns = $derived<Column<RouteScore>[]>([
    {key: 'label', label: 'Route', left: true, value: r => r.label, cell: routeCell, csv: r => r.label},
    {key: 'name', label: 'Name', left: true, wrap: true, value: r => routeName(r.label, r.long_name) || null, format: r => routeName(r.label, r.long_name)},
    {key: 'ontime', label: 'On time', title: `Departures at timepoints ${windowText}. Shown from ${MIN_EVENTS} departures; * marks a low sample.`, value: onTimeOf, format: r => shownPct(onTimeOf(r), r.on_time.total)},
    {key: 'late', label: 'Late', descending: true, value: lateOf, format: r => shownPct(lateOf(r), r.on_time.total)},
    {key: 'early', label: 'Early', descending: true, value: earlyOf, format: r => shownPct(earlyOf(r), r.on_time.total)},
    {key: 'dev', label: 'Mean deviation', csvLabel: 'Mean deviation, min', title: 'Average time from schedule, in minutes and seconds. Positive means late.', descending: true, value: r => asMinutes(r.mean_deviation_s), format: r => deviation(r.mean_deviation_s)},
    {key: 'timed', label: 'Timed departures (n)', title: 'Departures at timepoints behind the on-time shares', descending: true, value: r => r.on_time.total, format: r => int(r.on_time.total)},
    {key: 'bunched', label: 'Bunched', title: 'Vehicles arriving within a quarter of the scheduled headway. Frequent service only.', descending: true, value: r => r.headways?.bunched ?? null, format: r => headwayPct(r, r.headways?.bunched)},
    {key: 'gapped', label: 'After a gap', title: `Vehicles arriving more than one and a half scheduled headways after the one before. Frequent service only. ${DEFINITIONS.gapFloor}`, descending: true, value: r => r.headways?.gapped ?? null, format: r => headwayPct(r, r.headways?.gapped)},
    {key: 'wait', label: 'Wait assessment', title: 'Headways no more than three minutes over schedule. Frequent service only.', value: r => r.headways?.wait_ok ?? null, format: r => headwayPct(r, r.headways?.wait_ok)},
    {key: 'hwn', label: 'Headways (n)', title: 'Headways on frequent service behind the shares', descending: true, value: r => r.headways?.count ?? null, format: r => (r.headways ? int(r.headways.count) : DASH)},
    {key: 'actual', label: 'Average wait, min', title: 'Wait implied by actual headways, for a rider arriving at random', descending: true, value: r => asMinutes(r.headways?.actual_wait_s), format: r => (r.headways ? (asMinutes(r.headways.actual_wait_s)?.toFixed(1) ?? '—') : '—')},
    {key: 'scheduled', label: 'Scheduled wait, min', title: 'Wait implied by scheduled headways', descending: true, value: r => asMinutes(r.headways?.scheduled_wait_s), format: r => (r.headways ? (asMinutes(r.headways.scheduled_wait_s)?.toFixed(1) ?? '—') : '—')},
    {key: 'excess', label: 'Excess wait, min', title: 'Average wait beyond what the schedule promises', descending: true, value: r => asMinutes(r.headways?.excess_wait_s), format: r => (r.headways ? (asMinutes(r.headways.excess_wait_s)?.toFixed(1) ?? '—') : '—')},
  ]);
</script>

{#snippet routeCell(r: RouteScore)}<RouteBadge label={r.label} color={r.color} textColor={r.text_color} />{/snippet}

{#if o}
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Reliability</h1>
        <p class="lede">Whether vehicles keep to the schedule, and whether they stay evenly spaced where service is frequent.</p>
      </div>
      <div class="tools" role="group" aria-label="On-time window">
        <label class="field">Early by more than
          <select class="input" value={earlyMinutes} onchange={event => setWindow(Number(event.currentTarget.value), lateMinutes)}>
            {#each EARLY_OPTIONS as option}<option value={option}>{option === 0 ? 'Any amount' : `${option} min`}</option>{/each}
          </select>
        </label>
        <label class="field">Late by at least
          <select class="input" value={lateMinutes} onchange={event => setWindow(earlyMinutes, Number(event.currentTarget.value))}>
            {#each LATE_OPTIONS as option}<option value={option}>{option} min</option>{/each}
          </select>
        </label>
      </div>
    </div>

    {#if caveat}
      <p class="banner caution" role="note" data-coverage={coverage.mode}>{#if coverage.mode === 'gps'}<strong>Speeds only.</strong> {/if}{caveat}</p>
    {/if}
    {#if withheld}
      <section class="section">
        <p class="note">Reliability compares each vehicle with the timetable, so it cannot be calculated here. The speed pages, the speed map and delay hotspots do not need a schedule and are unaffected.</p>
      </section>
    {:else}
    <div class="stats-pair">
      <dl class="stats" aria-label="Schedule adherence at timepoints">
        <div class="stat">
          <dt><Term topic="ontime" def={windowDef}>On time</Term></dt>
          <dd>{onShown ? pct(ratioOf(o.on_time.on_time, o.on_time.total)) : '—'}</dd>
          <div class="sub">{windowText} at timepoints · {sampleText(o.on_time.total)}{#if coverage.mode === 'partial'} · partial{#if matchText}, {matchText}{/if}{/if}</div>
        </div>
        <div class="stat">
          <dt><Term topic="ontime">Early</Term></dt>
          <dd>{onShown ? pct(ratioOf(o.on_time.early, o.on_time.total)) : '—'}</dd>
          <div class="sub">{earlyMinutes === 0 ? 'before the scheduled time' : `over ${earlyMinutes} min ahead of schedule`}</div>
        </div>
        <div class="stat">
          <dt><Term topic="ontime">Late</Term></dt>
          <dd>{onShown ? pct(ratioOf(o.on_time.late, o.on_time.total)) : '—'}</dd>
          <div class="sub">{lateMinutes} min or more behind schedule</div>
        </div>
        <div class="stat">
          <dt><Term topic="ontime">Mean deviation</Term></dt>
          <dd>{onShown ? deviation(o.mean_deviation_s) : '—'}</dd>
          <div class="sub">minutes:seconds, positive means late</div>
        </div>
      </dl>
      {#if o.headways && !withheld}
        <dl class="stats" aria-label="Headways on frequent service">
          <div class="stat">
            <dt><Term topic="headways" def={DEFINITIONS.bunched}>Bunched</Term></dt>
            <dd>{hwShown ? pct(o.headways.bunched) : '—'}</dd>
            <div class="sub">within a quarter of the scheduled headway · {sampleText(o.headways.count)} headways</div>
          </div>
          <div class="stat">
            <dt><Term topic="headways">After a gap</Term></dt>
            <dd>{hwShown ? pct(o.headways.gapped) : '—'}{#if hwShown}<small>, at least</small>{/if}</dd>
            <div class="sub" title={DEFINITIONS.gapFloor}>over 1.5 scheduled headways behind the last (a floor)</div>
          </div>
          <div class="stat">
            <dt><Term topic="headways" def={DEFINITIONS.excessWait}>Excess wait</Term></dt>
            <dd>{hwShown ? minutes(o.headways.excess_wait_s, 1) : '—'}</dd>
            <div class="sub">{minutes(o.headways.actual_wait_s, 1)} actual, {minutes(o.headways.scheduled_wait_s, 1)} scheduled</div>
          </div>
          <div class="stat">
            <dt><Term topic="headways">Wait assessment</Term></dt>
            <dd>{hwShown ? pct(o.headways.wait_ok) : '—'}</dd>
            <div class="sub">within 3 min over the scheduled headway</div>
          </div>
        </dl>
      {/if}
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Keeping to the schedule</h2>
          <p class="note">Departures at the stops agencies mark as timepoints. On time here means {windowText}. Hours with fewer than {MIN_EVENTS} departures are left out.</p>
        </div>
      </div>
      <div class="pair wide-left">
        <figure>
          <figcaption><h3><Term topic="ontime">On time, late and early by hour</Term></h3></figcaption>
          <HourlyStack rows={o.hourly} />
        </figure>
        <figure>
          <figcaption><h3><Term topic="ontime">How far from the schedule</Term></h3></figcaption>
          <DeviationHistogram bins={o.deviation_bins} edges={o.deviation_edges} earlyS={app.earlyS} lateS={app.lateS} />
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>Which routes</h2><p class="note">Worst first. Choose a route to open it. Routes need at least {MIN_EVENTS} timed departures or headways to be ranked here, and show "{TOO_FEW}" below that; every route is in the table below. * marks fewer than {SOLID_EVENTS}.</p></div>
      </div>
      <div class="pair">
        <figure>
          <figcaption><h3><Term topic="ontime">On-time departures</Term></h3></figcaption>
          {#if onTimeRows.length}
            <RankedBars rows={onTimeRows} color="var(--blue)" max={1} label="Routes ranked by on-time share, worst first" onselect={id => app.go('route', id)} />
          {:else}
            <p class="note">No route has at least {MIN_EVENTS} timed departures in this selection.</p>
          {/if}
        </figure>
        <figure>
          <figcaption class="with-control">
            <h3><Term topic="headways">Headways on frequent service</Term></h3>
            <div class="seg" role="group" aria-label="Headway measure">
              <button aria-pressed={measure === 'bunched'} onclick={() => (measure = 'bunched')}>Bunched</button>
              <button aria-pressed={measure === 'gapped'} onclick={() => (measure = 'gapped')}>After a gap</button>
              <button aria-pressed={measure === 'excess'} onclick={() => (measure = 'excess')}>Excess wait</button>
            </div>
          </figcaption>
          {#if headwayRows.length}
            <RankedBars rows={headwayRows} color="var(--orange)" label="Routes ranked by headway reliability, worst first" onselect={id => app.go('route', id)} />
          {:else}
            <p class="note">No route has at least {MIN_EVENTS} headways at stops and times scheduled every 15 minutes or better.</p>
          {/if}
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2><Term topic="headways">Headway regularity through the day</Term></h2>
          <p class="note">Only stops and times the schedule serves every 15 minutes or better. At lower frequencies riders time their arrival, so keeping to the schedule is the measure that matters. Hours with fewer than {SOLID_EVENTS} headways are left out, because late at night a handful of overlapping trips can look like frequent service.</p>
        </div>
      </div>
      {#if hasHourlyHeadways}
        <LineChart
          label="Share of vehicles bunched and arriving after a gap by hour"
          yMin={0}
          format={v => `${(v * 100).toFixed(0)}%`}
          series={[
            {key: 'bunched', label: 'Bunched', color: 'var(--orange)', values: hourlyHeadway(r => r.headways?.bunched)},
            {key: 'gapped', label: 'After a gap', color: 'var(--purple)', values: hourlyHeadway(r => r.headways?.gapped)},
          ]}
        />
      {:else}
        <p class="note">This selection has no frequent service to measure.</p>
      {/if}
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>Every route</h2><p class="note">Headway columns stay blank for routes without frequent service.</p></div>
      </div>
      <div class="compact-heads">
      <DataTable
        {columns}
        rows={tableRows}
        caption="Reliability by route. Choose a route to open it."
        defaultSort="label"
        filename="reliability.csv"
        search={r => `${r.label} ${r.long_name}`}
        placeholder="Find a route…"
        onrow={r => app.go('route', r.id)}
        limit={25}
        maxHeight="72vh"
      />
      </div>
      <p class="note">Departure times are inferred from GPS positions, not reported by the vehicle, so treat small differences between routes with care. A trip that never appears in the feed may be a reporting gap rather than a cancellation. Missing trips count as longer headways here, because riders experience them that way.</p>
    </section>
    {/if}
  </div>
{/if}

<style>
  .stats-pair { display: grid; }
  .stats-pair dl + dl { border-top: 0; }
  .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px 36px; align-items: start; }
  .pair.wide-left { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); }
  figure { display: grid; gap: 8px; min-width: 0; align-content: start; }
  figcaption { min-height: 34px; display: flex; align-items: center; }
  .with-control { flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; }
  .compact-heads { display: grid; gap: 12px; min-width: 0; }
  .compact-heads :global(table.data th) { white-space: normal; min-width: 62px; line-height: 1.25; }
  @media (max-width: 1000px) {
    .pair, .pair.wide-left { grid-template-columns: minmax(0, 1fr); }
  }
</style>
