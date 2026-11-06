<script lang="ts" module>
  export interface Row { id: string; label: string; name: string; mid: number | null; peak: number | null }
</script>

<script lang="ts">
  // Each route's midday speed against its speed in a peak period, slowest first.
  import {measure} from '../lib/actions';
  import {routeName, speed, speedWithUnit, type Units} from '../lib/format';
  import {linear, ticks} from '../lib/scale';
  import {tooltip} from '../lib/tooltip.svelte';



  interface Props {
    rows: Row[];
    units: Units;
    peakLabel: string;
    limit?: number;
    onselect?: (id: string) => void;
  }
  let {rows, units, peakLabel, limit = 0, onselect}: Props = $props();

  let width = $state(700);
  const rowHeight = 26;
  const top = 8;
  const bottom = 24;

  const usable = $derived(
    rows
      .filter((r): r is Row & {mid: number; peak: number} => r.mid !== null && r.peak !== null)
      .sort((a, b) => a.peak - b.peak),
  );
  const shown = $derived(limit ? usable.slice(0, limit) : usable);
  const names = $derived(new Map(usable.map(r => [r.id, `${r.label} ${routeName(r.label, r.name)}`.trim().slice(0, 30)])));
  const longest = $derived(Math.max(0, ...[...names.values()].map(n => n.length)));
  const left = $derived(width < 520 ? 60 : Math.min(220, 24 + longest * 6.6));
  const right = 52;
  const height = $derived(top + shown.length * rowHeight + bottom);
  const extent = $derived.by(() => {
    const values = usable.flatMap(r => [r.mid, r.peak]);
    if (!values.length) return [0, 1] as [number, number];
    return [Math.min(...values) * 0.94, Math.max(...values) * 1.03] as [number, number];
  });
  const x = $derived(linear(extent, [left, width - right]));
  const factor = $derived(units === 'imperial' ? 2.23694 : 3.6);
  const tickValues = $derived(ticks(extent[0] * factor, extent[1] * factor, 5));
</script>

<div class="chart" use:measure={w => (width = w)}>
  <svg viewBox="0 0 {width} {height}" role="group" aria-label="Midday and {peakLabel} speed for each route, slowest first">
    {#each tickValues as tick}
      <line class="grid-line" x1={x(tick / factor)} x2={x(tick / factor)} y1={top} y2={height - bottom} />
      <text x={x(tick / factor)} y={height - 7} text-anchor="middle">{tick}</text>
    {/each}
    {#each shown as row, i}
      {@const cy = top + i * rowHeight + rowHeight / 2}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <g
        class="row"
        role="button"
        tabindex="0"
        aria-label="{row.label} {row.name}: midday {speedWithUnit(row.mid, units)}, {peakLabel} {speedWithUnit(row.peak, units)}"
        onclick={() => onselect?.(row.id)}
        onkeydown={event => { if (event.key === 'Enter') onselect?.(row.id); }}
        onpointermove={event => tooltip.show(event, [
          {title: `${row.label} ${routeName(row.label, row.name)}`.trim()},
          {label: 'Midday', value: speedWithUnit(row.mid, units)},
          {label: peakLabel, value: speedWithUnit(row.peak, units)},
          {label: 'Change', value: `${(((row.peak / row.mid) - 1) * 100).toFixed(0).replace('-', '−')}%`},
        ])}
        onpointerleave={() => tooltip.hide()}
      >
        <rect class="hit" x="0" y={cy - rowHeight / 2} width={width} height={rowHeight} />
        <text class="name" x={left - 10} y={cy + 4} text-anchor="end">{width < 520 ? row.label : names.get(row.id)}</text>
        <line x1={x(row.mid)} x2={x(row.peak)} y1={cy} y2={cy} stroke="var(--rule-strong)" stroke-width="2" />
        <circle cx={x(row.mid)} {cy} r="5" fill="var(--blue)" stroke="var(--paper)" stroke-width="2" />
        <circle cx={x(row.peak)} {cy} r="5" fill="var(--orange)" stroke="var(--paper)" stroke-width="2" />
        <text class="value" x={width - 4} y={cy + 4} text-anchor="end">{speed(row.peak, units)}</text>
      </g>
    {/each}
  </svg>
</div>
<div class="legend">
  <span class="key"><span class="swatch" style:background="var(--blue)" style:border-radius="50%"></span>Midday</span>
  <span class="key"><span class="swatch" style:background="var(--orange)" style:border-radius="50%"></span>{peakLabel}</span>
  <span class="key">Right: {peakLabel.toLowerCase()} speed</span>
</div>

<style>
  .row { cursor: pointer; outline: none; }
  .hit { fill: transparent; }
  .row:hover .hit, .row:focus-visible .hit { fill: var(--surface); }
  .chart :global(text.name) { fill: var(--ink); font-size: 12.5px; }
  .chart :global(text.value) { fill: var(--ink); font-weight: 650; font-size: 12px; }
</style>
