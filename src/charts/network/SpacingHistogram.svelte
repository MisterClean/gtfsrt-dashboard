<script lang="ts">
  // How far apart stops are. Gaps below the closely spaced threshold stand out in
  // one color; everything else stays quiet.
  import {measure} from '../../lib/actions';
  import {int, pct, shortLength, type Units} from '../../lib/format';
  import {linear, niceRange, ticks} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  interface Props {
    histogram: number[];
    binM: number;
    thresholdM: number;
    units: Units;
    height?: number;
  }
  let {histogram, binM, thresholdM, units, height = 250}: Props = $props();

  let width = $state(600);
  let active = $state<number | null>(null);
  const margin = {top: 24, right: 8, bottom: 22, left: 40};

  // Long gaps trail off for miles, so the last bar collects the longest few percent.
  const bars = $derived.by(() => {
    const total = histogram.reduce((sum, value) => sum + value, 0);
    let running = 0;
    let last = histogram.length - 1;
    for (let i = 0; i < histogram.length; i += 1) {
      running += histogram[i];
      if (running >= total * 0.97) {
        last = i;
        break;
      }
    }
    const values = histogram.slice(0, last + 1);
    values[last] = histogram.slice(last).reduce((sum, value) => sum + value, 0);
    return values;
  });
  const total = $derived(bars.reduce((sum, value) => sum + value, 0));
  const maxMeters = $derived(bars.length * binM);
  const x = $derived(linear([0, maxMeters], [margin.left, width - margin.right]));
  const slot = $derived((width - margin.left - margin.right) / Math.max(1, bars.length));
  const barWidth = $derived(Math.min(24, Math.max(2, slot - 2)));
  const yMax = $derived(niceRange(0, Math.max(1, ...bars), 3)[1]);
  const y = $derived(linear([0, yMax], [height - margin.bottom, margin.top]));
  const yTicks = $derived(ticks(0, yMax, 3));
  const FEET = 3.28084;
  const xTicks = $derived.by(() => {
    const factor = units === 'imperial' ? FEET : 1;
    return ticks(0, maxMeters * factor, width < 460 ? 3 : 6).map(value => value / factor);
  });
  const isClose = (index: number) => (index + 0.5) * binM < thresholdM;
  // The threshold is defined as 800 feet, which shouldn't read as 801 after rounding.
  const thresholdText = $derived(units === 'imperial' ? `${(Math.round((thresholdM * FEET) / 10) * 10).toLocaleString('en-US')} ft` : `${Math.round(thresholdM)} m`);

  function rowsFor(index: number) {
    const low = index * binM;
    const range = index === bars.length - 1 ? `${shortLength(low, units)} or more` : `${shortLength(low, units)} to ${shortLength(low + binM, units)}`;
    return [
      {title: range},
      {label: 'Gaps between stops', value: int(bars[index])},
      {label: 'Share', value: pct(total > 0 ? bars[index] / total : null, 1)},
    ];
  }

  function indexAt(clientX: number, box: DOMRect) {
    const position = ((clientX - box.left) / box.width) * width;
    return Math.max(0, Math.min(bars.length - 1, Math.floor((position - margin.left) / slot)));
  }

  function move(event: PointerEvent) {
    active = indexAt(event.clientX, (event.currentTarget as SVGElement).getBoundingClientRect());
    tooltip.show(event, rowsFor(active));
  }

  function leave() {
    active = null;
    tooltip.hide();
  }

  function key(event: KeyboardEvent) {
    const current = active ?? 0;
    let next = current;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(bars.length - 1, current + 1);
    else return;
    event.preventDefault();
    active = next;
    tooltip.showFor(event.currentTarget as Element, rowsFor(next));
  }

  function roundedTop(left: number, top: number, w: number, h: number) {
    const r = Math.min(4, h, w / 2);
    return `M${left},${top + h}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${top + h}Z`;
  }
</script>

<div class="chart" use:measure={w => (width = w)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    viewBox="0 0 {width} {height}"
    role="img"
    aria-label="Number of gaps between stops by distance. Use the arrow keys to read each bar."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onkeydown={key}
    onblur={leave}
  >
    {#each yTicks as tick}
      <line class="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
      <text x={margin.left - 7} y={y(tick) + 4} text-anchor="end">{tick.toLocaleString('en-US')}</text>
    {/each}
    {#each xTicks as tick}
      <text x={x(tick)} y={height - 6} text-anchor="middle">{shortLength(tick, units)}</text>
    {/each}
    {#if active !== null}
      <rect class="active" x={margin.left + active * slot} y={margin.top} width={slot} height={height - margin.top - margin.bottom} />
    {/if}
    {#each bars as count, index}
      {#if count > 0}
        {@const top = y(count)}
        <path
          d={roundedTop(margin.left + index * slot + (slot - barWidth) / 2, top, barWidth, Math.max(0.5, height - margin.bottom - top))}
          fill={isClose(index) ? 'var(--orange)' : 'var(--gray-series)'}
        />
      {/if}
    {/each}
    <line class="threshold" x1={x(thresholdM)} x2={x(thresholdM)} y1={margin.top - 8} y2={height - margin.bottom} />
    <text class="threshold-label" x={x(thresholdM) + 6} y={margin.top - 10}>Closely spaced: under {thresholdText}</text>
  </svg>
</div>

<style>
  .active { fill: var(--ink); opacity: .06; }
  .threshold { stroke: var(--ink); stroke-width: 1; shape-rendering: crispEdges; }
  .chart :global(text.threshold-label) { fill: var(--ink); font-weight: 650; font-size: 12px; }
</style>
