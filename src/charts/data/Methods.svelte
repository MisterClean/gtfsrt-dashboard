<script lang="ts">
  // Exact definitions, in the language a planner would use. These must stay in step
  // with crates/core/src and docs/metrics.md.
  import {app} from '../../lib/state.svelte';

  const minutesText = (seconds: number) => {
    const value = Math.abs(seconds) / 60;
    return `${value % 1 ? value.toFixed(1) : value} ${value === 1 ? 'minute' : 'minutes'}`;
  };
  const windowText = $derived(`${minutesText(app.earlyS)} early to ${minutesText(app.lateS)} late`);

  const rules = [
    {tag: 'T1', name: 'Terminal layover', rule: 'Measured from the first report more than 500 ft (152 m) past where the trip was first seen, up to the first report within 500 ft of the furthest point it reached.', why: 'Vehicles waiting on purpose at the ends of a line are not running slowly.'},
    {tag: 'T2', name: 'Standstill', rule: 'A run of intervals each moving 100 ft (30 m) or less, lasting 10 minutes or more in total, is removed.', why: 'Breakdowns, holds and parked vehicles still logged in. Ordinary stop and signal time stays.'},
    {tag: 'T3', name: 'Reporting gap', rule: 'Intervals longer than 180 seconds are removed.', why: 'Speed across a long silence would be a guess.'},
    {tag: 'T4', name: 'Backward moves', rule: 'Progress along the line never decreases. A report that lands behind the furthest point reached is held there.', why: 'GPS jitter would otherwise create false reverse moves and false bursts of speed.'},
    {tag: 'T5', name: 'Geometry', rule: 'Progress along the line must be no more than twice the straight-line GPS distance plus 1,500 ft (457 m).', why: 'A match that jumped ahead along the line, with no matching movement.'},
    {tag: 'T6', name: 'Speed backstop', rule: 'Intervals above 80 mph are removed, or above 150 mph for rail and ferry routes.', why: 'A last check against bad data.'},
    {tag: 'T7', name: 'Short patterns', rule: 'Not applied. The CTA scorecard dropped short connector and rare patterns. Here every pattern is kept.', why: 'A planner reviewing one route needs to see its short turns.'},
    {tag: 'T8', name: 'Hour assignment', rule: 'Each interval belongs to the hour of its midpoint, in local service time.', why: 'Hours past midnight stay on their service day, so 1 AM can be hour 25.'},
  ];
</script>

<div class="claims">
  <h3>What these numbers don’t claim</h3>
  <ul>
    <li><strong>No ridership.</strong> Everything is weighted by vehicles and distance, not by passengers. A slow block with few riders counts the same as a crowded one.</li>
    <li><strong>A missing trip is not proof of cancellation.</strong> It may be a reporting gap. This app reports trips observed, never trips cancelled.</li>
    <li><strong>Stop times are inferred from GPS.</strong> The archive has no door-open events or confirmed arrivals, so times are interpolated between position reports along the route line.</li>
    <li><strong>Polling limits the detail.</strong> Most feeds report every 20 to 60 seconds. One pass of one stop is an estimate, and only averages over many passes should be read closely.</li>
    <li><strong>Schedules come from the archive.</strong> Results use the version in force on each day, and a trip counts only if its realtime ID matches that schedule.</li>
  </ul>
</div>

<div class="definitions">
  <details open>
    <summary>Operating speed</summary>
    <div class="body">
      <p>Distance along the route line divided by elapsed time between position reports, added up across intervals: total distance over total time, not an average of speeds. It includes time at stops, at signals and in traffic, which is the time a rider spends on board. It excludes terminal layovers. It leaves out walking and waiting, so it isn’t a door-to-door trip time.</p>
      <p>Scheduled speed is the same calculation using the distance between stops and the scheduled time from each departure to the next arrival.</p>
      <div class="table-wrap">
        <table class="data rules">
          <caption class="sr-only">The rules each interval must pass before it counts toward speed</caption>
          <thead><tr><th class="left" scope="col">Rule</th><th class="left" scope="col">Test</th><th class="left" scope="col">Why</th></tr></thead>
          <tbody>
            {#each rules as rule}
              <tr>
                <td class="left nowrap"><strong>{rule.tag}</strong> {rule.name}</td>
                <td class="left wrap">{rule.rule}</td>
                <td class="left wrap">{rule.why}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p>Tags match the thresholds in the CTA Bus Speed Scorecard, which these rules come from. A separate rule applies first: a run is one vehicle on one reported trip, with a new run after three hours of silence.</p>
    </div>
  </details>

  <details>
    <summary>Period speeds on fixed segments</summary>
    <div class="body">
      <p>Some trips only run at certain hours. A rush-only trip into slow downtown blocks would look like congestion if every measurement were simply pooled by period. So the route scorecard compares morning peak (7–9 AM), midday (10 AM–2 PM) and evening peak (4–6 PM) on the same street segments.</p>
      <p>A segment qualifies when it has enough measurements in all three periods. Each then counts by its length in every period: total length divided by the sum of length over speed. When qualifying segments cover less than half of a route’s length, the route falls back to pooled speeds, and its coverage is reported.</p>
      <p>A segment is one route and direction inside a 200 m grid cell, in one of eight compass sectors. Slivers under 40 m merge into the segment before them. A segment’s speed needs at least two measurements, and at least one for each day selected, before it is shown.</p>
    </div>
  </details>

  <details>
    <summary>Confidence intervals</summary>
    <div class="body">
      <p>With five or more days selected, the route scorecard shows a 95% interval on peak speed and on the change from midday. Days are resampled with replacement 1,000 times, using each route’s pooled daily speeds, so it reflects how much the result would move with a different set of days. It does not capture error in individual GPS reports. Because the interval uses pooled speeds, a fixed-segment estimate can fall just outside it.</p>
    </div>
  </details>

  <details>
    <summary>Service days and time</summary>
    <div class="body">
      <p>Days here are local GTFS service days, not UTC archive days. Scheduled times count from noon minus twelve hours on the service date, so a trip can run past 24:00:00 and daylight-saving days still line up. One service day overlaps two UTC archive files, and each file is read only once.</p>
      <p>A trip’s service date is the feed’s reported start date when there is one. Otherwise it is the active service date, among the local date and the days either side, whose scheduled window is nearest the run. A run more than four hours from any scheduled window isn’t counted as that trip.</p>
      <p>The schedule for each day is the most recently retrieved version covering that date and already published by then. If the archive only captured a covering version later, that one is used and flagged above.</p>
    </div>
  </details>

  <details>
    <summary>Placing vehicles on the route</summary>
    <div class="body">
      <p>A trip ID leads to a route line and stop list in that day’s schedule. Each report is projected onto the line inside a window that moves with the vehicle: from 60 m behind its last position to as far ahead as the speed backstop allows, plus 200 m. This keeps a match on the correct pass of a loop or an out-and-back line. Reports more than 120 m from the line count as off route and are skipped.</p>
      <p>Stops are placed along the line so that their order is preserved, choosing the combination that keeps stops closest to the line.</p>
    </div>
  </details>

  <details>
    <summary>Stop passes</summary>
    <div class="body">
      <p>A vehicle passes a stop when its progress crosses a point just beyond the stop, interpolated between the reports either side. If those reports are more than five minutes apart, or the trip started past the stop, no pass is recorded rather than guessing.</p>
      <p>Stop-zone time is the time between entering and leaving a zone 25 m either side of the stop, or half the distance to a neighboring stop where that is shorter. It approximates dwell plus queuing to reach the stop, and includes the few seconds a moving vehicle needs to cross the zone. The first and last stops of a trip are left out, because vehicles wait there by design, and so is any pass over ten minutes, which is a hold.</p>
    </div>
  </details>

  <details>
    <summary>On-time performance</summary>
    <div class="body">
      <p>The observed departure minus the scheduled departure at each timepoint, or the arrival at the last stop. The current window counts a departure as on time from {windowText}. Exactly {minutesText(app.earlyS)} early is on time, and exactly {minutesText(app.lateS)} late is late.</p>
      <p>When an agency’s schedule marks timepoints, only those count, because other stop times are usually interpolated. When a trip marks none, all its stops count. Each trip counts at each timepoint once, so repeated polling doesn’t change the weighting.</p>
    </div>
  </details>

  <details>
    <summary>Headways, bunching and excess wait</summary>
    <div class="body">
      <p>These apply to frequent service only: stops and times where the schedule runs every 15 minutes or better. At lower frequencies riders time their arrival, so schedule adherence is the right measure instead.</p>
      <p>An observed headway is the time between consecutive vehicles at a stop, on one route and direction, compared with the headway the full schedule promised at that point. Comparing it with the two observed trips’ own spacing would hide a missing trip, which is exactly the wait riders notice.</p>
      <ul class="plain">
        <li><strong>Bunched:</strong> under 25% of the scheduled headway.</li>
        <li><strong>Gap:</strong> over 150% of the scheduled headway.</li>
        <li><strong>Wait assessment:</strong> no more than three minutes over the scheduled headway.</li>
        <li><strong>Average wait:</strong> Σh² ÷ 2Σh, the wait for a rider arriving at random. Long gaps count for more because more riders arrive during them.</li>
        <li><strong>Excess wait:</strong> the observed average wait minus the same figure for the schedule.</li>
      </ul>
      <p>A trip missing from the feed lengthens observed headways, so read these beside the share of trips observed. A gap longer than both an hour and four scheduled headways isn't counted, because it means passes went unobserved. Fewer than ten headways shows nothing.</p>
    </div>
  </details>

  <details>
    <summary>Run times</summary>
    <div class="body">
      <p>Time from the first stop passed to the last, on trips observed moving over at least 90% of their line. The 10th, 50th and 90th percentiles come from the route’s main pattern in each direction, grouped by the hour the trip was scheduled to start, beside the median scheduled time between the same stops.</p>
    </div>
  </details>

  <details>
    <summary>Delay hotspots</summary>
    <div class="body">
      <p>Delay is time lost on a street cell compared with that cell’s own freest conditions, pooled across every route through it. The reference is the 85th percentile of its hourly speeds, and needs at least three hours with enough measurements. Delay is the sum over hours of time spent minus the time the same distance would take at the reference speed, counting only time above it.</p>
      <p>Hotspots grow from the cells losing the most time per meter, extending along the usual next and previous cells while each still loses at least 35% as much per meter as the starting cell, up to about 1.5 km. They’re ranked by vehicle hours lost per day, and named by the stops nearest each end.</p>
      <p>Because each cell is compared with itself, a block that is slow at every hour shows little delay. Check the speed map for those. Vehicle hours are not passenger hours.</p>
    </div>
  </details>

  <details>
    <summary>Slowest stretch</summary>
    <div class="body">
      <p>The slowest window of about half a mile (800 m) on a route’s main pattern at peak. It keeps a mile from each end of the line, or 10% of its length on routes under three miles, to avoid turnarounds and layovers. Named by the nearest stops.</p>
    </div>
  </details>

  <details>
    <summary>Stop spacing</summary>
    <div class="body">
      <p>Distances along the line between consecutive stops on each route’s main pattern in each direction. Under 800 ft (244 m) counts as closely spaced. This describes the stops as scheduled. It doesn’t weigh ridership, access or safety, so it’s where a stop balancing review starts rather than ends.</p>
    </div>
  </details>

  <details>
    <summary>Service levels and vehicles</summary>
    <div class="body">
      <p>A trip counts as observed when it moved over at least half of its line, by the hour it was scheduled to start. Scheduled trips come from the calendar and calendar exceptions for that date. Trips defined only through <code>frequencies.txt</code> aren’t expanded, so they count once and their schedule comparisons aren’t meaningful.</p>
      <p>Vehicles in service counts distinct vehicle IDs with a measured interval in the hour. The network count removes vehicles shared between routes, except under a mode filter, where interlined vehicles can count twice. Observed service hours run from a trip’s first report to its last, and can include some layover.</p>
    </div>
  </details>
</div>

<p class="note">The full reference, with formulas and how each measure compares with common agency practice, is in <a href="https://github.com/MisterClean/gtfsrt-dashboard/blob/main/docs/metrics.md" target="_blank" rel="noopener noreferrer">docs/metrics.md</a>.</p>

<style>
  .claims { display: grid; gap: 8px; }
  .claims ul, .plain { list-style: none; display: grid; gap: 6px; max-width: 72ch; }
  .claims li, .plain li, .body p { text-wrap: pretty; }
  .definitions { border-bottom: 1px solid var(--rule); }
  details { border-top: 1px solid var(--rule); }
  summary { cursor: pointer; padding: 9px 0; font-size: 14px; font-weight: 600; }
  summary:hover { color: var(--copper); }
  .body { display: grid; gap: 10px; padding: 0 0 16px; }
  .body p { max-width: 72ch; }
  .rules td.wrap { min-width: 240px; max-width: 460px; }
  .rules td.nowrap { white-space: nowrap; vertical-align: top; }
  .rules td { vertical-align: top; }
  .note a { font-weight: 600; }
</style>
