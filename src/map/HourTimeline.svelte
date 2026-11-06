<script lang="ts">
  // The network's speed through the day, doubling as the map's time control. Drag
  // across the line or use the arrow keys to move through the hours.
  import type {MapHour} from '../engine/types';
  import {measure} from '../lib/actions';
  import {hourLabel, hourRange, hourShort, speed, speedUnit, toDisplaySpeed, type Units} from '../lib/format';
  import {HOURS, PEAKS, linePath, linear, niceRange, ticks} from '../lib/scale';

  interface Props {
    hours: MapHour[];
    hour: number;
    units: Units;
    height?: number;
    onchange: (hour: number) => void;
  }
  let {hours, hour, units, height = 96, onchange}: Props = $props();

  let width = $state(600);
  let playing = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  const margin = {top: 10, right: 12, bottom: 20, left: 34};

  const byHour = $derived(new Map(hours.map(row => [row.hour, row])));
  const valueAt = (h: number) => {
    const speedValue = byHour.get(h)?.speed;
    return speedValue === null || speedValue === undefined ? null : toDisplaySpeed(speedValue, units);
  };
  const domain = $derived.by(() => {
    const values = hours.map(row => row.speed).filter((v): v is number => v !== null).map(v => toDisplaySpeed(v, units));
    return values.length ? niceRange(Math.min(...values), Math.max(...values), 3) : ([0, 1] as [number, number]);
  });
  const x = $derived(linear([HOURS[0], HOURS[HOURS.length - 1] + 1], [margin.left, width - margin.right]));
  const y = $derived(linear(domain, [height - margin.bottom, margin.top]));
  const center = (h: number) => x(h + 0.5);
  const points = (list: number[]) =>
    list.map(h => {
      const value = valueAt(h);
      return value === null ? null : ([center(h), y(value)] as const);
    });
  const track = $derived(linePath(points(HOURS)));
  const progress = $derived(linePath(points(HOURS.filter(h => h <= hour))));
  const tickValues = $derived(ticks(domain[0], domain[1], 2));
  const hourTicks = $derived(width < 460 ? [4, 10, 16, 22] : [4, 7, 10, 13, 16, 19, 22, 25]);
  const current = $derived(valueAt(hour));
  const firstHour = HOURS[0];
  const lastHour = HOURS[HOURS.length - 1];

  function toggle() {
    playing = !playing;
    clearInterval(timer);
    if (playing) {
      timer = setInterval(() => onchange(hour >= lastHour ? firstHour : hour + 1), 650);
    }
  }
  $effect(() => () => clearInterval(timer));
</script>

<div class="timeline">
  <div class="readout">
    <button class="btn small play" aria-label={playing ? 'Pause the hourly map' : 'Play the hourly map'} onclick={toggle}>
      {#if playing}
        <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h3.5v14H5zM11.5 3H15v14h-3.5z" fill="currentColor"/></svg>
        Pause
      {:else}
        <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3l12 7-12 7z" fill="currentColor"/></svg>
        Play
      {/if}
    </button>
    <output class="clock" for="map-hour">{hourLabel(hour)}</output>
    <span class="now">
      {#if byHour.get(hour)?.speed}<strong>{speed(byHour.get(hour)?.speed, units)} {speedUnit(units)}</strong> across the network, {hourRange(hour)}{:else}No measured service in this hour{/if}
    </span>
  </div>
  <div class="track" use:measure={w => (width = w)}>
    <svg viewBox="0 0 {width} {height}" aria-hidden="true">
      {#each PEAKS as [a, b]}
        <rect class="peak-band" x={x(a)} y={margin.top} width={x(b) - x(a)} height={height - margin.top - margin.bottom} />
      {/each}
      {#each tickValues as tick}
        <line class="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
        <text x={margin.left - 6} y={y(tick) + 4} text-anchor="end">{tick}</text>
      {/each}
      {#each hourTicks as h}
        <text x={center(h)} y={height - 5} text-anchor="middle">{hourShort(h)}</text>
      {/each}
      <path d={track} class="line-track" />
      <path d={progress} class="line-progress" />
      <line class="cursor" x1={center(hour)} x2={center(hour)} y1={margin.top} y2={height - margin.bottom} />
      {#if current !== null}
        <circle cx={center(hour)} cy={y(current)} r="5.5" class="dot" />
      {/if}
    </svg>
    <input
      id="map-hour"
      type="range"
      min={firstHour}
      max={lastHour}
      step="1"
      value={hour}
      aria-label="Hour shown on the map"
      aria-valuetext="{hourRange(hour)}, {current === null ? 'no data' : `${current.toFixed(1)} ${speedUnit(units)}`}"
      style:left="{margin.left}px"
      style:right="{margin.right}px"
      style:width="calc(100% - {margin.left + margin.right}px)"
      oninput={event => {
        if (playing) toggle();
        onchange(Number(event.currentTarget.value));
      }}
    />
  </div>
</div>

<style>
  .timeline { display: grid; gap: 4px; }
  .readout { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .play { align-self: center; }
  .clock { font: 800 27px/1 var(--font-display); text-transform: uppercase; min-width: 4.2ch; }
  .now { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .now strong { color: var(--ink); font-weight: 650; }
  .track { position: relative; border-radius: 4px; }
  .track:focus-within { outline: 3px solid var(--focus); outline-offset: 2px; }
  .track svg { display: block; width: 100%; height: auto; overflow: visible; }
  .track text { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .line-track { fill: none; stroke: var(--rule-strong); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .line-progress { fill: none; stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .cursor { stroke: var(--orange); stroke-width: 1; }
  .dot { fill: var(--orange); stroke: var(--paper); stroke-width: 2; }
  input {
    position: absolute; top: 0; bottom: 18px; height: calc(100% - 18px); margin: 0; opacity: 0; appearance: none;
    -webkit-appearance: none; cursor: ew-resize; touch-action: pan-y;
  }
  input::-webkit-slider-thumb { -webkit-appearance: none; width: 2px; height: 100px; }
  input::-moz-range-thumb { width: 2px; height: 100px; border: 0; }
</style>
