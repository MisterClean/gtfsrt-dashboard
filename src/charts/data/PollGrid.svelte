<script lang="ts">
  // Feed captures per service hour, one row per day. Archive outages show up as
  // pale or empty runs, which is the first thing to check before trusting a day.
  import type {QualityDay} from '../../engine/types';
  import {measure} from '../../lib/actions';
  import {dateLabel, hourRange, hourShort, int} from '../../lib/format';
  import {HOURS} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  let {days}: {days: QualityDay[]} = $props();

  const rowHeight = 20;
  const top = 20;
  const left = 86;
  const summaryWidth = 150;
  let available = $state(860);
  // Cells give way before the summary does, so gaps stay readable on a tablet.
  const cell = $derived(Math.max(14, Math.min(26, Math.floor((available - left - summaryWidth) / HOURS.length))));
  const width = $derived(left + HOURS.length * cell + summaryWidth);
  const height = $derived(top + days.length * rowHeight + 2);

  const max = $derived(Math.max(1, ...days.flatMap(day => HOURS.map(hour => day.quality.polls[hour] ?? 0))));

  /** The median captures for each hour across the selected days. */
  const usual = $derived.by(() => {
    const medians = new Map<number, number>();
    for (const hour of HOURS) {
      const values = days.map(day => day.quality.polls[hour] ?? 0).sort((a, b) => a - b);
      const middle = values.length / 2;
      medians.set(hour, values.length % 2 ? values[Math.floor(middle)] : (values[middle - 1] + values[middle]) / 2);
    }
    return medians;
  });

  const opacity = (polls: number) => 0.14 + 0.86 * (polls / max);
  const shortfall = (hour: number, polls: number) => days.length >= 2 && polls < 0.5 * (usual.get(hour) ?? 0);

  function gapText(day: QualityDay) {
    const minutes = day.quality.empty_buckets * 5;
    if (!minutes) return 'None';
    return minutes >= 120 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
  }

  function show(event: PointerEvent, day: QualityDay, hour: number) {
    const polls = day.quality.polls[hour] ?? 0;
    tooltip.show(event, [
      {title: dateLabel(day.date)},
      {note: hourRange(hour)},
      {label: 'Feed captures', value: int(polls)},
      {label: 'Usual for this hour', value: int(usual.get(hour) ?? 0)},
    ]);
  }

  const ramp = [0.25, 0.5, 0.75, 1];
  const anyShortfall = $derived(days.some(day => HOURS.some(hour => shortfall(hour, day.quality.polls[hour] ?? 0))));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="scroll-x" tabindex="0" role="region" aria-label="Feed captures by day and hour. Scrolls sideways." use:measure={w => (available = w)}>
  <svg class="grid" viewBox="0 0 {width} {height}" {width} {height} role="img" aria-label="Feed captures per service hour for each selected day. The same values are in the table below.">
    {#each HOURS as hour, i}
      {#if (hour - 4) % 3 === 0}
        <text x={left + i * cell + cell / 2} y="13" text-anchor="middle">{hourShort(hour)}</text>
      {/if}
    {/each}
    <text class="head" x={left + HOURS.length * cell + 12} y="13">Capture gaps</text>
    <text class="head" x={left + HOURS.length * cell + 96} y="13">Notes</text>
    {#each days as day, row}
      {@const y = top + row * rowHeight}
      <text class="day" x={left - 10} y={y + 14} text-anchor="end">{dateLabel(day.date)}</text>
      {#each HOURS as hour, i}
        {@const polls = day.quality.polls[hour] ?? 0}
        <rect
          role="presentation"
          class:empty={polls === 0}
          class:short={shortfall(hour, polls)}
          x={left + i * cell + 1}
          y={y + 1}
          width={cell - 2}
          height={rowHeight - 2}
          rx="2"
          fill={polls === 0 ? 'none' : 'var(--blue)'}
          fill-opacity={polls === 0 ? undefined : opacity(polls)}
          onpointermove={event => show(event, day, hour)}
          onpointerleave={() => tooltip.hide()}
        />
      {/each}
      <text class="summary" class:flag={day.quality.empty_buckets > 0} x={left + HOURS.length * cell + 12} y={y + 14}>{gapText(day)}</text>
      <text class="summary" class:flag={day.warnings.length > 0} x={left + HOURS.length * cell + 96} y={y + 14}>{day.warnings.length || 'None'}</text>
    {/each}
  </svg>
</div>

<div class="legend" aria-label="Capture shading">
  <span class="key"><span class="swatch none"></span>No captures</span>
  <span class="key">
    <span class="ramp">
      {#each ramp as step}<span class="swatch" style:background="var(--blue)" style:opacity={0.14 + 0.86 * step}></span>{/each}
    </span>
    Fewer to more, up to {int(max)} an hour
  </span>
  {#if anyShortfall}<span class="key"><span class="swatch outlined"></span>Under half the usual for that hour</span>{/if}
</div>

<details class="twin">
  <summary>Captures by hour as a table</summary>
  <div class="table-wrap">
    <table class="data">
      <caption class="sr-only">Feed captures per service hour for each selected day</caption>
      <thead>
        <tr>
          <th class="left" scope="col">Service day</th>
          {#each HOURS as hour}<th scope="col">{hourShort(hour)}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each days as day}
          <tr>
            <td class="left">{dateLabel(day.date)}</td>
            {#each HOURS as hour}<td>{day.quality.polls[hour] ?? 0}</td>{/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</details>

<style>
  .grid { display: block; }
  .grid text { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .grid text.day { fill: var(--ink); font-size: 12px; }
  .grid text.head { font-weight: 600; }
  .grid text.summary { fill: var(--ink); font-size: 12px; }
  .grid text.flag { fill: var(--orange); font-weight: 650; }
  .grid rect { stroke: transparent; stroke-width: 1; }
  .grid rect.empty { stroke: var(--rule-strong); }
  .grid rect.short { stroke: var(--orange); stroke-width: 1.5; }
  .swatch.none { border: 1px solid var(--rule-strong); }
  .swatch.outlined { border: 1.5px solid var(--orange); }
  .twin { font-size: 13px; }
  .twin summary { cursor: pointer; font-weight: 600; min-height: 28px; }
  .twin table.data { font-size: 12px; }
  .twin table.data th, .twin table.data td { padding: 4px 6px; }
</style>
