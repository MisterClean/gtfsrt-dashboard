<script lang="ts">
  // Mean schedule deviation at each stop. A line that climbs along the route shows
  // where lateness builds up, and a line that falls shows where the schedule has
  // slack to recover it.
  import type {RouteStop} from '../../engine/types';
  import {measure} from '../../lib/actions';
  import {deviation, length as formatLength, type Units} from '../../lib/format';
  import {linePath, linear, ticks} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  interface Props {
    stops: RouteStop[];
    lengthM: number;
    units: Units;
    earlyS: number;
    lateS: number;
  }
  let {stops, lengthM, units, earlyS, lateS}: Props = $props();

  // Order and colors stay fixed so a period keeps its color across routes.
  const PERIODS = [
    {index: 1, label: '7–9 AM', color: 'var(--blue)'},
    {index: 2, label: '9 AM–4 PM', color: 'var(--green)'},
    {index: 3, label: '4–6 PM', color: 'var(--orange)'},
    {index: 4, label: 'After 6 PM', color: 'var(--purple)'},
    {index: 0, label: 'Before 7 AM', color: 'var(--gray-series)'},
  ];

  let width = $state(900);
  let hover = $state<number | null>(null);
  const height = 250;
  const margin = {top: 12, right: 12, bottom: 24, left: 44};

  const active = $derived(PERIODS.filter(period => stops.some(stop => stop.deviation_by_period[period.index] !== null)));
  const domain = $derived.by(() => {
    const values = stops.flatMap(stop => stop.deviation_by_period.filter((v): v is number => v !== null)).map(v => v / 60);
    if (!values.length) return [-1, 5] as [number, number];
    const low = Math.min(-1, ...values);
    const high = Math.max(2, ...values);
    return [Math.floor(low), Math.ceil(high)] as [number, number];
  });
  const x = $derived(linear([0, lengthM || 1], [margin.left, width - margin.right]));
  const y = $derived(linear(domain, [height - margin.bottom, margin.top]));
  const factor = $derived(units === 'imperial' ? 1 / 1609.34 : 1 / 1000);
  const unit = $derived(units === 'imperial' ? 'mi' : 'km');
  const distanceTicks = $derived(ticks(0, lengthM * factor, width < 560 ? 4 : 8));
  const minuteTicks = $derived(ticks(domain[0], domain[1], 5));

  const paths = $derived(
    active.map(period => ({
      ...period,
      d: linePath(
        stops.map(stop => {
          const value = stop.deviation_by_period[period.index];
          return value === null ? null : ([x(stop.s), y(value / 60)] as const);
        }),
      ),
    })),
  );

  function nearest(clientX: number, box: DOMRect) {
    const position = ((clientX - box.left) / box.width) * width;
    let best = 0;
    for (let i = 1; i < stops.length; i += 1) {
      if (Math.abs(x(stops[i].s) - position) < Math.abs(x(stops[best].s) - position)) best = i;
    }
    return best;
  }

  function rowsFor(index: number) {
    const stop = stops[index];
    return [
      {title: stop.name},
      {note: formatLength(stop.s, units)},
      ...active.map(period => ({label: period.label, value: deviation(stop.deviation_by_period[period.index])})),
    ];
  }

  function move(event: PointerEvent) {
    hover = nearest(event.clientX, (event.currentTarget as Element).getBoundingClientRect());
    tooltip.show(event, rowsFor(hover));
  }

  function leave() {
    hover = null;
    tooltip.hide();
  }

  function key(event: KeyboardEvent) {
    const current = hover ?? 0;
    let next = current;
    if (event.key === 'ArrowRight') next = Math.min(stops.length - 1, current + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = stops.length - 1;
    else return;
    event.preventDefault();
    hover = next;
    tooltip.showFor(event.currentTarget as Element, rowsFor(next));
  }

  const minuteLabel = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : 'On time');
</script>

<div class="chart" use:measure={w => (width = w)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    viewBox="0 0 {width} {height}"
    role="img"
    aria-label="Mean schedule deviation in minutes at each stop, by time of day. Use the arrow keys to read each stop."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onblur={leave}
    onkeydown={key}
  >
    <rect
      class="window"
      x={margin.left}
      width={width - margin.left - margin.right}
      y={y(Math.min(lateS / 60, domain[1]))}
      height={Math.max(0, y(Math.max(earlyS / 60, domain[0])) - y(Math.min(lateS / 60, domain[1])))}
    />
    {#each minuteTicks as tick}
      <line class={tick === 0 ? 'axis-line' : 'grid-line'} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
      <text x={margin.left - 7} y={y(tick) + 4} text-anchor="end">{minuteLabel(tick)}</text>
    {/each}
    {#each distanceTicks as tick, index}
      <text x={x(tick / factor)} y={height - 6} text-anchor="middle">{index === distanceTicks.length - 1 ? `${tick} ${unit}` : tick}</text>
    {/each}
    {#if hover !== null}
      <line class="crosshair" x1={x(stops[hover].s)} x2={x(stops[hover].s)} y1={margin.top} y2={height - margin.bottom} />
    {/if}
    {#each paths as path}
      <path d={path.d} fill="none" stroke={path.color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    {/each}
    {#if hover !== null}
      {#each active as period}
        {@const value = stops[hover].deviation_by_period[period.index]}
        {#if value !== null}
          <circle cx={x(stops[hover].s)} cy={y(value / 60)} r="4" fill={period.color} stroke="var(--paper)" stroke-width="2" />
        {/if}
      {/each}
    {/if}
  </svg>
</div>
<div class="legend">
  {#each active as period}
    <span class="key"><span class="line" style:background={period.color}></span>{period.label}</span>
  {/each}
  <span class="key"><span class="swatch window-key"></span>On-time window</span>
</div>

<style>
  .window { fill: var(--surface); }
  .window-key { background: var(--surface); box-shadow: inset 0 0 0 1px var(--rule-strong); }
</style>
