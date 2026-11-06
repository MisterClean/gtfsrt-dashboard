<script lang="ts">
  // Every route, every hour.
  import type {Mode, RouteScore} from '../engine/types';
  import {hourRange, hourShort, speedWithUnit, type Units} from '../lib/format';
  import {HOURS} from '../lib/scale';
  import {breaksMps, classVar} from '../lib/speed-scale';
  import {tooltip} from '../lib/tooltip.svelte';

  interface Props {
    routes: RouteScore[];
    units: Units;
    mode: Mode;
    onselect?: (id: string) => void;
  }
  let {routes, units, mode, onselect}: Props = $props();
  const breaks = $derived(breaksMps(mode));
  const cell = 28;
  const rowHeight = 21;
  const left = 54;
  const width = left + HOURS.length * cell;
  const height = $derived(20 + routes.length * rowHeight);
</script>

<div class="scroll-x" tabindex="0" role="region" aria-label="Speed by route and hour. Scrolls sideways.">
  <svg class="heat" viewBox="0 0 {width} {height}" width={width} height={height} role="group" aria-label="Speed by route and service hour">
    {#each HOURS as hour, i}
      {#if (hour - 4) % 2 === 0}
        <text x={left + i * cell + cell / 2} y="13" text-anchor="middle">{hourShort(hour)}</text>
      {/if}
    {/each}
    {#each routes as route, row}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <g class="route-row" onclick={() => onselect?.(route.id)}>
        <text class="label" x={left - 8} y={20 + row * rowHeight + 14} text-anchor="end">{route.label.slice(0, 6)}</text>
        {#each HOURS as hour, i}
          {@const value = route.hourly[hour]}
          {@const fill = classVar(value, breaks)}
          {#if fill}
            <rect
              class="cell"
              x={left + i * cell + 1}
              y={20 + row * rowHeight + 1}
              width={cell - 2}
              height={rowHeight - 2}
              rx="2"
              style:fill={fill}
              role="img"
              aria-label="{route.label}, {hourRange(hour)}: {speedWithUnit(value, units)}"
              onpointermove={event => tooltip.show(event, [{title: route.label}, {label: hourRange(hour), value: speedWithUnit(value, units)}])}
              onpointerleave={() => tooltip.hide()}
            />
          {/if}
        {/each}
      </g>
    {/each}
  </svg>
</div>

<style>
  .heat { display: block; }
  .heat text { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .heat text.label { fill: var(--ink); font-size: 12px; font-weight: 600; }
  .route-row { cursor: pointer; }
  .route-row:hover text.label { fill: var(--copper); }
  .cell { transition: opacity 80ms ease-out; }
  .cell:hover { stroke: var(--ink); stroke-width: 1.5; }
</style>
