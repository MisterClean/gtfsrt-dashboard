<script lang="ts">
  // Each hour's departures split into on time, late and early. On time sits on the
  // baseline so its height can be compared directly from hour to hour.
  import type {HourRow} from '../../engine/types';
  import {measure} from '../../lib/actions';
  import {hourRange, hourShort, int, pct} from '../../lib/format';
  import {isShown, sampleText} from '../../lib/stats';
  import {HOURS, PEAKS, linear} from '../../lib/scale';
  import {tooltip} from '../../lib/tooltip.svelte';

  const GAP = 2;

  let {rows, height = 230}: {rows: HourRow[]; height?: number} = $props();

  let width = $state(700);
  let active = $state<number | null>(null);
  const margin = {top: 8, right: 4, bottom: 22, left: 36};

  const byHour = $derived(new Map(rows.map(row => [row.hour, row])));
  const x = $derived(linear([HOURS[0], HOURS[HOURS.length - 1] + 1], [margin.left, width - margin.right]));
  const y = $derived(linear([0, 1], [height - margin.bottom, margin.top]));
  const slot = $derived((width - margin.left - margin.right) / HOURS.length);
  const barWidth = $derived(Math.min(18, Math.max(4, slot * 0.7)));
  const hourTicks = $derived(width < 460 ? HOURS.filter(h => (h - 4) % 6 === 0) : HOURS.filter(h => (h - 4) % 3 === 0));

  const SERIES = [
    {key: 'on_time', label: 'On time', color: 'var(--blue)'},
    {key: 'late', label: 'Late', color: 'var(--orange)'},
    {key: 'early', label: 'Early', color: 'var(--purple)'},
  ] as const;

  /** A bar segment with a rounded top and a square bottom. */
  function roundedTop(left: number, top: number, w: number, h: number) {
    const r = Math.min(4, h, w / 2);
    return `M${left},${top + h}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${top + h}Z`;
  }

  const columns = $derived(
    HOURS.flatMap(hour => {
      const row = byHour.get(hour);
      if (!row || !isShown(row.on_time.total)) return [];
      const left = x(hour) + (slot - barWidth) / 2;
      const plot = height - margin.top - margin.bottom;
      let base = height - margin.bottom;
      const visible = SERIES.filter(s => row.on_time[s.key] > 0);
      const segments = visible.map((s, index) => {
        const raw = (row.on_time[s.key] / row.on_time.total) * plot;
        const isLast = index === visible.length - 1;
        const h = Math.max(raw - (isLast ? 0 : GAP), 0.5);
        const top = base - h;
        base = top - (isLast ? 0 : GAP);
        return {color: s.color, d: isLast ? roundedTop(left, top, barWidth, h) : `M${left},${top + h}V${top}H${left + barWidth}V${top + h}Z`};
      });
      return [{hour, row, segments}];
    }),
  );

  function rowsFor(hour: number) {
    const row = byHour.get(hour);
    if (!row || !isShown(row.on_time.total)) return [{title: hourRange(hour)}, {note: `Too few trips to report (n = ${int(row?.on_time.total ?? 0)})`}];
    const {total, on_time, late, early} = row.on_time;
    return [
      {title: hourRange(hour)},
      {label: 'On time', value: pct(on_time / total)},
      {label: 'Late', value: pct(late / total)},
      {label: 'Early', value: pct(early / total)},
      {note: `${sampleText(total)} departures at timepoints`},
    ];
  }

  function hourAt(clientX: number, box: DOMRect) {
    const position = ((clientX - box.left) / box.width) * width;
    const raw = HOURS[0] + (position - margin.left) / slot;
    return Math.max(HOURS[0], Math.min(HOURS[HOURS.length - 1], Math.floor(raw)));
  }

  function move(event: PointerEvent) {
    active = hourAt(event.clientX, (event.currentTarget as SVGElement).getBoundingClientRect());
    tooltip.show(event, rowsFor(active));
  }

  function leave() {
    active = null;
    tooltip.hide();
  }

  function key(event: KeyboardEvent) {
    const current = active ?? HOURS[Math.floor(HOURS.length / 2)];
    let next = current;
    if (event.key === 'ArrowLeft') next = Math.max(HOURS[0], current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(HOURS[HOURS.length - 1], current + 1);
    else if (event.key === 'Home') next = HOURS[0];
    else if (event.key === 'End') next = HOURS[HOURS.length - 1];
    else return;
    event.preventDefault();
    active = next;
    tooltip.showFor(event.currentTarget as Element, rowsFor(next));
  }
</script>

<div class="chart" use:measure={w => (width = w)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    viewBox="0 0 {width} {height}"
    role="img"
    aria-label="Share of departures on time, late and early by hour. Use the arrow keys to read each hour."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onkeydown={key}
    onblur={leave}
  >
    {#each PEAKS as [a, b]}
      <rect class="peak-band" x={x(a)} y={margin.top} width={x(b) - x(a)} height={height - margin.top - margin.bottom} />
    {/each}
    {#each [0, 0.5, 1] as tick}
      <line class="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
      <text x={margin.left - 7} y={y(tick) + 4} text-anchor="end">{tick * 100}%</text>
    {/each}
    {#each hourTicks as hour}
      <text x={x(hour) + slot / 2} y={height - 6} text-anchor="middle">{hourShort(hour)}</text>
    {/each}
    {#if active !== null}
      <rect class="active" x={x(active)} y={margin.top} width={slot} height={height - margin.top - margin.bottom} />
    {/if}
    {#each columns as column}
      {#each column.segments as segment}
        <path d={segment.d} fill={segment.color} />
      {/each}
    {/each}
  </svg>
</div>
<div class="legend">
  {#each SERIES as s}
    <span class="key"><span class="swatch" style:background={s.color}></span>{s.label}</span>
  {/each}
  <span class="key"><span class="swatch" style:background="color-mix(in srgb, var(--orange) 14%, transparent)"></span>Peak periods</span>
</div>

<style>
  .active { fill: var(--ink); opacity: .06; }
</style>
