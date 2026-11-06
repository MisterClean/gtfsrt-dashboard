<script lang="ts">
  // How long a run takes, by the hour it was scheduled to start. The spread is the
  // recovery time a schedule has to allow for, not just the median.
  import type {RunTimeRow} from '../../engine/types';
  import {measure} from '../../lib/actions';
  import {hourRange, hourShort, minutes} from '../../lib/format';
  import {HOURS, PEAKS, linear, niceRange, ticks} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  let {rows}: {rows: RunTimeRow[]} = $props();

  let width = $state(700);
  let hover = $state<number | null>(null);
  const height = 240;
  const margin = {top: 10, right: 12, bottom: 22, left: 40};

  const byHour = $derived(new Map(rows.map(row => [row.hour, row])));
  const hours = $derived.by(() => {
    if (!rows.length) return HOURS;
    const first = Math.min(...rows.map(r => r.hour));
    const last = Math.max(...rows.map(r => r.hour));
    return HOURS.filter(h => h >= first && h <= last);
  });
  const domain = $derived.by(() => {
    const values = rows.flatMap(r => [r.p10, r.p90, r.scheduled]).map(v => v / 60);
    return values.length ? niceRange(Math.min(...values), Math.max(...values), 4) : ([0, 1] as [number, number]);
  });
  const x = $derived(linear([hours[0], hours[hours.length - 1] + 1], [margin.left, width - margin.right]));
  const y = $derived(linear(domain, [height - margin.bottom, margin.top]));
  const center = (hour: number) => x(hour + 0.5);
  const band = $derived((width - margin.left - margin.right) / hours.length);
  const barWidth = $derived(Math.max(4, Math.min(12, band * 0.4)));
  const hourTicks = $derived(hours.filter(h => (h - hours[0]) % (width < 460 ? 4 : 2) === 0));

  function tipRows(row: RunTimeRow) {
    return [
      {title: `Starting ${hourRange(row.hour)}`},
      {label: '90th percentile', value: minutes(row.p90)},
      {label: 'Median', value: minutes(row.p50)},
      {label: '10th percentile', value: minutes(row.p10)},
      {label: 'Scheduled', value: minutes(row.scheduled)},
      {label: 'Complete runs', value: String(row.count)},
    ];
  }

  function move(event: PointerEvent) {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    const position = ((event.clientX - box.left) / box.width) * width;
    const hour = Math.floor(hours[0] + ((position - margin.left) / (width - margin.left - margin.right)) * hours.length);
    const row = byHour.get(hour);
    hover = row ? hour : null;
    if (row) tooltip.show(event, tipRows(row));
    else tooltip.hide();
  }

  function leave() {
    hover = null;
    tooltip.hide();
  }

  function key(event: KeyboardEvent) {
    if (!rows.length) return;
    const list = rows.map(r => r.hour);
    const index = hover === null ? -1 : list.indexOf(hover);
    let next = index;
    if (event.key === 'ArrowRight') next = Math.min(list.length - 1, index + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, index < 0 ? 0 : index - 1);
    else return;
    event.preventDefault();
    hover = list[next];
    const row = byHour.get(list[next]);
    if (row) tooltip.showFor(event.currentTarget as Element, tipRows(row));
  }
</script>

<div class="chart" use:measure={w => (width = w)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    viewBox="0 0 {width} {height}"
    role="img"
    aria-label="Run time by scheduled start hour, showing the 10th to 90th percentile, the median and the scheduled time. Use the arrow keys to read each hour."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onblur={leave}
    onkeydown={key}
  >
    {#each PEAKS as [a, b]}
      {#if a >= hours[0] && b <= hours[hours.length - 1] + 1}
        <rect class="peak-band" x={x(a)} y={margin.top} width={x(b) - x(a)} height={height - margin.top - margin.bottom} />
      {/if}
    {/each}
    {#each ticks(domain[0], domain[1], 4) as tick}
      <line class="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
      <text x={margin.left - 7} y={y(tick) + 4} text-anchor="end">{tick}</text>
    {/each}
    {#each hourTicks as hour}
      <text x={center(hour)} y={height - 6} text-anchor="middle">{hourShort(hour)}</text>
    {/each}
    {#each rows as row}
      {@const cx = center(row.hour)}
      {@const thin = row.count < 4}
      <g class:thin class:active={hover === row.hour}>
        <rect
          class="range"
          x={cx - barWidth / 2}
          y={y(row.p90 / 60)}
          width={barWidth}
          height={Math.max(2, y(row.p10 / 60) - y(row.p90 / 60))}
          rx={Math.min(3, barWidth / 2)}
        />
        <line class="scheduled" x1={cx - barWidth / 2 - 4} x2={cx + barWidth / 2 + 4} y1={y(row.scheduled / 60)} y2={y(row.scheduled / 60)} />
        <circle class="median" {cx} cy={y(row.p50 / 60)} r="4" />
      </g>
    {/each}
  </svg>
</div>
<div class="legend">
  <span class="key"><span class="swatch range-key"></span>10th to 90th percentile</span>
  <span class="key"><span class="swatch dot-key"></span>Median run</span>
  <span class="key"><span class="line sched-key"></span>Scheduled</span>
  <span class="key">Minutes, end to end on the main pattern. Faded hours have fewer than four runs.</span>
</div>

<style>
  .range { fill: color-mix(in srgb, var(--blue) 32%, var(--paper)); }
  .median { fill: var(--blue); stroke: var(--paper); stroke-width: 2; }
  .scheduled { stroke: var(--ink); stroke-width: 2; stroke-linecap: round; }
  .thin { opacity: .45; }
  .active .range { fill: color-mix(in srgb, var(--blue) 50%, var(--paper)); }
  .range-key { background: color-mix(in srgb, var(--blue) 32%, var(--paper)); }
  .dot-key { background: var(--blue); border-radius: 50%; }
  .sched-key { background: var(--ink); }
</style>
