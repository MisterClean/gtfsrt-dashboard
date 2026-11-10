<script lang="ts" module>
  export interface Series {
    key: string;
    label: string;
    color: string;
    values: (number | null)[];
    /** Quieter line for reference series such as the schedule. */
    reference?: boolean;
  }
</script>

<script lang="ts">
  // Lines over service hours, with a crosshair that snaps to the nearest hour.
  // Charts sharing `hover` move together.
  import {measure} from '../lib/actions';
  import {hourLabel, hourRange, hourShort} from '../lib/format';
  import {HOURS, PEAKS, linePath, linear, niceRange, ticks} from '../lib/scale';
  import {tooltip} from '../lib/tooltip.svelte';



  interface Props {
    /** Keeps the legend row for one series, so the plot lines up with charts beside it. */
    legend?: boolean;
    series: Series[];
    hours?: number[];
    format: (value: number) => string;
    formatAxis?: (value: number) => string;
    height?: number;
    hover?: number | null;
    yMin?: number;
    yMax?: number;
    label: string;
    showPeaks?: boolean;
  }

  let {
    series,
    hours = HOURS,
    format,
    formatAxis,
    height = 190,
    hover = $bindable(null),
    yMin,
    yMax,
    label,
    showPeaks = true,
    legend = false,
  }: Props = $props();

  let width = $state(600);
  const margin = {top: 10, right: 14, bottom: 22, left: 40};

  const domain = $derived.by(() => {
    const values = series.flatMap(s => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    if (!values.length) return [0, 1] as [number, number];
    const [low, high] = niceRange(yMin ?? Math.min(...values), yMax ?? Math.max(...values));
    return [yMin ?? low, yMax ?? high] as [number, number];
  });
  const x = $derived(linear([hours[0], hours[hours.length - 1] + 1], [margin.left, width - margin.right]));
  const y = $derived(linear(domain, [height - margin.bottom, margin.top]));
  const center = (hour: number) => x(hour + 0.5);
  const tickValues = $derived(ticks(domain[0], domain[1], 3));
  const hourTicks = $derived(width < 420 ? hours.filter(h => (h - 4) % 6 === 0) : hours.filter(h => (h - 4) % 3 === 0));

  const paths = $derived(
    series.map(s => ({
      ...s,
      d: linePath(s.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : [center(hours[i]), y(v)] as const))),
    })),
  );

  function hourAt(clientX: number, box: DOMRect) {
    const position = ((clientX - box.left) / box.width) * width;
    const raw = hours[0] + ((position - margin.left) / (width - margin.left - margin.right)) * hours.length;
    return Math.max(hours[0], Math.min(hours[hours.length - 1], Math.floor(raw)));
  }

  function rowsFor(hour: number) {
    const index = hours.indexOf(hour);
    return [
      {title: hourRange(hour)},
      ...series.map(s => {
        const value = s.values[index];
        return {label: s.label, value: value === null || value === undefined ? '—' : format(value)};
      }),
    ];
  }

  function move(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement;
    hover = hourAt(event.clientX, target.getBoundingClientRect());
    tooltip.show(event, rowsFor(hover));
  }

  function leave() {
    hover = null;
    tooltip.hide();
  }

  function key(event: KeyboardEvent) {
    const current = hover ?? hours[Math.floor(hours.length / 2)];
    let next = current;
    if (event.key === 'ArrowLeft') next = Math.max(hours[0], current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(hours[hours.length - 1], current + 1);
    else if (event.key === 'Home') next = hours[0];
    else if (event.key === 'End') next = hours[hours.length - 1];
    else return;
    event.preventDefault();
    hover = next;
    tooltip.showFor(event.currentTarget as Element, rowsFor(next));
  }
</script>

<!-- The wrapper is the focusable control (role application, arrow keys read each hour), so the svg inside stays a plain picture. Svelte does not count application as interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="chart"
  use:measure={w => (width = w)}
  role="application"
  aria-roledescription="line chart"
  aria-label="{label}. Use the arrow keys to read each hour."
  tabindex="0"
  onpointermove={move}
  onpointerleave={leave}
  onkeydown={key}
  onblur={leave}
>
  <svg
    viewBox="0 0 {width} {height}"
    aria-hidden="true"
  >
    {#if showPeaks}
      {#each PEAKS as [a, b]}
        <rect class="peak-band" x={x(a)} y={margin.top} width={x(b) - x(a)} height={height - margin.top - margin.bottom} />
      {/each}
    {/if}
    {#each tickValues as tick}
      <line class="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
      <text x={margin.left - 7} y={y(tick) + 4} text-anchor="end">{(formatAxis ?? format)(tick)}</text>
    {/each}
    {#each hourTicks as hour}
      <text x={center(hour)} y={height - 6} text-anchor="middle">{hourShort(hour)}</text>
    {/each}
    {#if hover !== null}
      <line class="crosshair" x1={center(hover)} x2={center(hover)} y1={margin.top} y2={height - margin.bottom} />
    {/if}
    {#each paths as line}
      <path d={line.d} fill="none" stroke={line.color} stroke-width={line.reference ? 1.5 : 2} stroke-linecap="round" stroke-linejoin="round" />
    {/each}
    {#if hover !== null}
      {#each series as s}
        {@const value = s.values[hours.indexOf(hover)]}
        {#if value !== null && value !== undefined && Number.isFinite(value)}
          <circle cx={center(hover)} cy={y(value)} r="4" fill={s.color} stroke="var(--paper)" stroke-width="2" />
        {/if}
      {/each}
    {/if}
  </svg>
</div>
{#if series.length > 1 || legend}
  <div class="legend">
    {#each series as s}
      <span class="key"><span class="line" style:background={s.color}></span>{s.label}</span>
    {/each}
    {#if showPeaks}<span class="key"><span class="swatch" style:background="color-mix(in srgb, var(--orange) 14%, transparent)"></span>Peak periods</span>{/if}
  </div>
{/if}
