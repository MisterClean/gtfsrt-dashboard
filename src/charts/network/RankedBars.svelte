<script lang="ts" module>
  import type {TipRow} from '../../lib/tooltip.svelte';

  export interface RankedRow {
    id: string;
    label: string;
    name?: string;
    value: number;
    /** The value as printed at the end of the bar. */
    text: string;
    tip: TipRow[];
  }
</script>

<script lang="ts">
  // Ranked horizontal bars in one hue, already sorted by the caller. Choosing a row
  // opens that route.
  import {measure} from '../../lib/actions';
  import {linear} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  interface Props {
    rows: RankedRow[];
    color: string;
    label: string;
    max?: number;
    limit?: number;
    onselect?: (id: string) => void;
  }
  let {rows, color, label, max, limit = 15, onselect}: Props = $props();

  let width = $state(520);
  let showAll = $state(false);
  const rowHeight = 25;
  const barHeight = 11;

  const shown = $derived(showAll ? rows : rows.slice(0, limit));
  const shorten = (text: string) => (text.length > 26 ? `${text.slice(0, 25).trimEnd()}…` : text);
  const names = $derived(new Map(rows.map(row => [row.id, shorten(`${row.label} ${row.name ?? ''}`.trim())])));
  const longest = $derived(Math.max(0, ...[...names.values()].map(name => name.length)));
  const left = $derived(width < 420 ? 52 : Math.min(190, 18 + longest * 6.6));
  const right = 58;
  const domainMax = $derived(max ?? Math.max(0.0001, ...rows.map(row => row.value)));
  const x = $derived(linear([0, domainMax], [left, width - right]));
  const height = $derived(shown.length * rowHeight + 2);
  const nameOf = (row: RankedRow) => (width < 420 ? row.label.slice(0, 6) : names.get(row.id) ?? row.label);

  function roundedEnd(from: number, to: number, cy: number) {
    const top = cy - barHeight / 2;
    const w = Math.max(0, to - from);
    const r = Math.min(4, w, barHeight / 2);
    return `M${from},${top}H${from + w - r}Q${from + w},${top} ${from + w},${top + r}V${top + barHeight - r}Q${from + w},${top + barHeight} ${from + w - r},${top + barHeight}H${from}Z`;
  }
</script>

<div class="chart" use:measure={w => (width = w)}>
  <svg viewBox="0 0 {width} {height}" role="group" aria-label={label}>
    <line class="axis-line" x1={left} x2={left} y1="0" y2={height} />
    {#each shown as row, i}
      {@const cy = i * rowHeight + rowHeight / 2}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <g
        class="row"
        role="button"
        tabindex="0"
        aria-label="{row.label} {row.name ?? ''}: {row.text}"
        onclick={() => onselect?.(row.id)}
        onkeydown={event => { if (event.key === 'Enter') onselect?.(row.id); }}
        onpointermove={event => tooltip.show(event, row.tip)}
        onpointerleave={() => tooltip.hide()}
      >
        <rect class="hit" x="0" y={cy - rowHeight / 2} {width} height={rowHeight} />
        <text class="name" x={left - 8} y={cy + 4} text-anchor="end">{nameOf(row)}</text>
        {#if row.value > 0}
          <path d={roundedEnd(left, x(row.value), cy)} fill={color} />
        {/if}
        <text class="value" x={x(Math.max(0, row.value)) + 6} y={cy + 4}>{row.text}</text>
      </g>
    {/each}
  </svg>
</div>
{#if rows.length > limit}
  <button class="link-btn more" onclick={() => (showAll = !showAll)}>
    {showAll ? `Show first ${limit}` : `Show all ${rows.length.toLocaleString('en-US')}`}
  </button>
{/if}

<style>
  .row { cursor: pointer; outline: none; }
  .hit { fill: transparent; }
  .row:hover .hit, .row:focus-visible .hit { fill: var(--surface); }
  .chart :global(text.name) { fill: var(--ink); font-size: 12.5px; }
  .chart :global(text.value) { fill: var(--ink); font-weight: 650; font-size: 12px; }
  .more { justify-self: start; font-size: 13px; }
</style>
