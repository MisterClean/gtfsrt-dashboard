<script lang="ts">
  // How far departures run from the schedule. The bins widen toward the extremes,
  // so bars are drawn evenly spaced and labelled at their edges.
  import {measure} from '../../lib/actions';
  import {int, pct} from '../../lib/format';
  import {linear, niceRange, ticks} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  interface Props {
    bins: number[];
    edges: number[];
    earlyS: number;
    lateS: number;
    height?: number;
  }
  let {bins, edges, earlyS, lateS, height = 230}: Props = $props();

  let width = $state(480);
  let active = $state<number | null>(null);
  const margin = {top: 26, right: 4, bottom: 22, left: 36};

  const total = $derived(bins.reduce((sum, value) => sum + value, 0));
  const shares = $derived(bins.map(value => (total > 0 ? value / total : 0)));
  const earlyEdge = $derived(edges.filter(edge => edge <= earlyS).length);
  const lateEdge = $derived(edges.filter(edge => edge <= lateS).length);
  const onTimeShare = $derived(shares.slice(earlyEdge, lateEdge).reduce((a, b) => a + b, 0));

  const yMax = $derived(niceRange(0, Math.max(0.05, ...shares), 3)[1]);
  const slot = $derived((width - margin.left - margin.right) / Math.max(1, bins.length));
  const barWidth = $derived(Math.min(24, Math.max(4, slot - 4)));
  const x = (index: number) => margin.left + index * slot;
  const y = $derived(linear([0, yMax], [height - margin.bottom, margin.top]));
  const yTicks = $derived(ticks(0, yMax, 3));

  const minutes = (seconds: number) => {
    const value = seconds / 60;
    return value === 0 ? '0' : value > 0 ? `+${value}` : `−${Math.abs(value)}`;
  };
  const colorOf = (index: number) => (index < earlyEdge ? 'var(--purple)' : index < lateEdge ? 'var(--blue)' : 'var(--orange)');

  function binLabel(index: number) {
    if (index === 0) return `More than ${Math.abs(edges[0] / 60)} min early`;
    if (index === bins.length - 1) return `${edges[edges.length - 1] / 60} min late or more`;
    return `${minutes(edges[index - 1])} to ${minutes(edges[index])} min`;
  }

  function rowsFor(index: number) {
    return [
      {title: binLabel(index)},
      {label: 'Share', value: pct(shares[index], 1)},
      {label: 'Departures', value: int(bins[index])},
      {note: index < earlyEdge ? 'Counts as early' : index < lateEdge ? 'Counts as on time' : 'Counts as late'},
    ];
  }

  function indexAt(clientX: number, box: DOMRect) {
    const position = ((clientX - box.left) / box.width) * width;
    return Math.max(0, Math.min(bins.length - 1, Math.floor((position - margin.left) / slot)));
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
    const current = active ?? earlyEdge;
    let next = current;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(bins.length - 1, current + 1);
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
    aria-label="Departures by minutes from schedule. {pct(onTimeShare)} fall in the on-time window. Use the arrow keys to read each bar."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onkeydown={key}
    onblur={leave}
  >
    <rect class="window" x={x(earlyEdge)} y={margin.top} width={(lateEdge - earlyEdge) * slot} height={height - margin.top - margin.bottom} />
    {#each yTicks as tick}
      <line class="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
      <text x={margin.left - 7} y={y(tick) + 4} text-anchor="end">{(tick * 100).toFixed(0)}%</text>
    {/each}
    <line class="bracket" x1={x(earlyEdge) + 1} x2={x(lateEdge) - 1} y1={margin.top - 6} y2={margin.top - 6} />
    <text class="window-label" x={(x(earlyEdge) + x(lateEdge)) / 2} y={margin.top - 11} text-anchor="middle">On time: {pct(onTimeShare)}</text>
    {#each edges as edge, index}
      {#if width >= 420 || index % 2 === 1}
        <text x={x(index + 1)} y={height - 6} text-anchor="middle">{minutes(edge)}</text>
      {/if}
    {/each}
    {#if active !== null}
      <rect class="active" x={x(active)} y={margin.top} width={slot} height={height - margin.top - margin.bottom} />
    {/if}
    {#each shares as share, index}
      {#if share > 0}
        {@const top = y(share)}
        <path d={roundedTop(x(index) + (slot - barWidth) / 2, top, barWidth, Math.max(0.5, height - margin.bottom - top))} fill={colorOf(index)} />
      {/if}
    {/each}
  </svg>
</div>
<div class="legend">
  <span class="key"><span class="swatch" style:background="var(--purple)"></span>Early</span>
  <span class="key"><span class="swatch" style:background="var(--blue)"></span>On time</span>
  <span class="key"><span class="swatch" style:background="var(--orange)"></span>Late</span>
  <span class="key">Minutes from schedule. Bins widen toward the ends.</span>
</div>

<style>
  .window { fill: var(--blue); opacity: .06; }
  .active { fill: var(--ink); opacity: .06; }
  .bracket { stroke: var(--muted); stroke-width: 1; shape-rendering: crispEdges; }
  .chart :global(text.window-label) { fill: var(--ink); font-weight: 650; font-size: 12px; }
</style>
