<script lang="ts">
  // Every step from raw archive rows to measured intervals, so nothing is removed
  // without a count beside it.
  import type {Quality, QualityDay} from '../../engine/types';
  import {downloadCsv} from '../../lib/download';
  import {dateLabel, DASH, int, pct} from '../../lib/format';
  import type {Units} from '../../lib/format';

  interface Props {
    days: QualityDay[];
    units: Units;
  }
  let {days, units}: Props = $props();

  interface Step {
    key: string;
    label: string;
    title?: string;
    indent?: boolean;
    strong?: boolean;
    value: (q: Quality) => number;
    /** The denominator for the share column. */
    base?: (q: Quality) => number;
    /** Counted against the whole read window, so days overlap and can't be summed. */
    noTotal?: boolean;
    format?: (value: number) => string;
  }

  /**
   * Rows that carry a usable trip but don't reach a trip on this day. These are
   * mostly repeated polls of an unchanged position. Raw rows are counted by hour
   * and trips by service day, so a few belong to a neighbouring day's trips.
   */
  const repeats = (q: Quality) => Math.max(0, q.rows - q.no_trip - q.no_vehicle - q.bad_coordinate - q.fixes_on_day);

  const distance = (meters: number) =>
    units === 'imperial' ? `${int(meters / 1609.34)} mi` : `${int(meters / 1000)} km`;
  const hours = (seconds: number) => `${int(seconds / 3600)} h`;

  const groups = $derived<{title: string; steps: Step[]}[]>([
    {
      title: 'Position reports',
      steps: [
        {key: 'rows', label: 'Archive rows in the service day', title: 'Rows fetched from 3 AM on the service date to 3 AM the next day', strong: true, value: q => q.rows},
        {key: 'no_trip', label: 'No trip assigned', title: 'Out-of-service moves and layovers. These rows carry no trip ID.', indent: true, value: q => q.no_trip, base: q => q.rows},
        {key: 'no_vehicle', label: 'No vehicle ID', indent: true, value: q => q.no_vehicle, base: q => q.rows},
        {key: 'bad', label: 'Unusable coordinates', title: 'Outside valid ranges, or exactly (0, 0)', indent: true, value: q => q.bad_coordinate, base: q => q.rows},
        {key: 'repeats', label: 'Repeated polls, and rows on other days’ trips', title: 'What remains after the steps above and the reports used below. Approximate, because rows are counted by hour and reports by service day.', indent: true, value: repeats, base: q => q.rows},
        {key: 'on_day', label: 'Distinct reports on this day’s trips', title: 'One per vehicle, trip and report time', strong: true, value: q => q.fixes_on_day, base: q => q.rows},
        {key: 'off_route', label: 'More than 120 m off the route line', title: 'Skipped, usually a detour', indent: true, value: q => q.off_route, base: q => q.fixes_on_day},
        {key: 'backward', label: 'Moved backward along the line', title: 'More than 30 m, usually GPS jitter. Held at the furthest point reached rather than removed.', indent: true, value: q => q.backward, base: q => q.fixes_on_day},
        {key: 'fallback', label: 'Fetch time used for a missing report time', title: 'The vehicle report had no timestamp, so the time it was captured stands in', indent: true, value: q => q.fallback_time},
        {key: 'unmatched', label: 'Trip ID missing from the schedule', title: 'Counted across everything read when the day was processed, which overlaps neighbouring days, so there is no total', indent: true, noTotal: true, value: q => q.fixes_trip_unmatched},
      ],
    },
    {
      title: 'Intervals between reports',
      steps: [
        {key: 'pairs', label: 'Intervals', title: 'Consecutive reports on one trip', strong: true, value: q => q.pairs},
        {key: 'layover', label: 'Terminal layover trimmed', indent: true, value: q => q.pairs_layover, base: q => q.pairs},
        {key: 'gap', label: 'Reporting gap over 3 minutes', indent: true, value: q => q.pairs_long_gap, base: q => q.pairs},
        {key: 'geometry', label: 'Progress the GPS doesn’t support', indent: true, value: q => q.pairs_geometry, base: q => q.pairs},
        {key: 'fast', label: 'Above the speed backstop', indent: true, value: q => q.pairs_too_fast, base: q => q.pairs},
        {key: 'standstill', label: 'Standstill of 10 minutes or more', indent: true, value: q => q.pairs_standstill, base: q => q.pairs},
        {key: 'kept', label: 'Kept for speed', strong: true, value: q => q.pairs_kept, base: q => q.pairs},
      ],
    },
    {
      title: 'Time and distance',
      steps: [
        {key: 'seconds', label: 'Time measured', strong: true, value: q => q.seconds_kept, format: hours},
        {key: 'meters', label: 'Distance measured', strong: true, value: q => q.meters_kept, format: distance},
        {key: 'layover_s', label: 'Time trimmed as layover', indent: true, value: q => q.seconds_layover, format: hours},
        {key: 'standstill_s', label: 'Time removed as standstill', indent: true, value: q => q.seconds_standstill, format: hours},
      ],
    },
    {
      title: 'Trips',
      steps: [
        {key: 'scheduled', label: 'Scheduled', strong: true, value: q => q.trips_scheduled},
        {key: 'observed', label: 'Observed over at least half the line', indent: true, value: q => q.trips_observed, base: q => q.trips_scheduled},
        {key: 'complete', label: 'Complete, over at least 90% of the line', indent: true, value: q => q.trips_complete, base: q => q.trips_scheduled},
      ],
    },
    {
      title: 'Stop passes',
      steps: [
        {key: 'expected', label: 'Stops on the observed trips', strong: true, value: q => q.stops_expected},
        {key: 'stops_observed', label: 'Passes found', title: 'Not found when a trip starts past the stop, ends before it, or has a reporting gap over 5 minutes around it', indent: true, value: q => q.stops_observed, base: q => q.stops_expected},
      ],
    },
  ]);

  const sum = (read: (q: Quality) => number) => days.reduce((total, day) => total + read(day.quality), 0);
  const display = (step: Step, value: number) => (step.format ? step.format(value) : int(value));

  function share(step: Step) {
    if (!step.base || step.noTotal) return null;
    const whole = sum(step.base);
    return whole > 0 ? sum(step.value) / whole : null;
  }

  function exportCsv() {
    const steps = groups.flatMap(group => group.steps.map(step => ({...step, group: group.title})));
    downloadCsv(
      'data-quality.csv',
      [
        {label: 'Group', value: (s: (typeof steps)[number]) => s.group},
        {label: 'Step', value: (s: (typeof steps)[number]) => s.label},
        {label: 'Total', value: (s: (typeof steps)[number]) => (s.noTotal ? null : sum(s.value))},
        ...days.map(day => ({label: day.date, value: (s: (typeof steps)[number]) => s.value(day.quality)})),
      ],
      steps,
    );
  }
</script>

<div class="tools end"><button class="btn small quiet" onclick={exportCsv}>Download CSV</button></div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="table-wrap" tabindex="0" role="region" aria-label="Steps from raw rows to measurements. Scrolls sideways.">
  <table class="data">
    <caption class="sr-only">Steps from raw archive rows to measured intervals, for the selection and for each service day</caption>
    <thead>
      <tr>
        <th class="left step" scope="col">Step</th>
        <th scope="col">All days</th>
        <th scope="col" title="Share of the bold row above it">Share</th>
        {#each days as day}<th scope="col">{dateLabel(day.date)}</th>{/each}
      </tr>
    </thead>
    {#each groups as group}
      <tbody>
        <tr class="group">
          <th class="left group-head" scope="rowgroup" colspan={3 + days.length}><span>{group.title}</span></th>
        </tr>
        {#each group.steps as step}
          <tr class:strong={step.strong}>
            <td class="left step" class:indent={step.indent} title={step.title}>{step.label}</td>
            <td>{step.noTotal ? DASH : display(step, sum(step.value))}</td>
            <td class="share">{step.base && !step.noTotal ? pct(share(step), 1) : ''}</td>
            {#each days as day}<td class="by-day">{display(step, step.value(day.quality))}</td>{/each}
          </tr>
        {/each}
      </tbody>
    {/each}
  </table>
</div>

<style>
  .end { justify-content: flex-end; }
  table.data .step { position: sticky; left: 0; z-index: 1; background: var(--paper); white-space: normal; min-width: 260px; }
  table.data th.step { z-index: 3; }
  table.data tbody tr:hover td.step { background: var(--surface); }
  table.data .indent { padding-left: 24px; color: var(--muted); }
  .strong td { font-weight: 650; }
  table.data .group-head { position: static; box-shadow: none; padding-top: 16px; font-size: 12.5px; font-weight: 650; color: var(--ink); border-bottom: 1px solid var(--rule-strong); }
  .group-head span { position: sticky; left: 10px; }
  .share { color: var(--muted); }
  .by-day { color: var(--muted); }
  .strong .by-day { color: var(--ink); }
</style>
