<script lang="ts">
  // Distance along the route against hour of the day. Each cell is the speed on
  // that stretch in that hour, so a recurring bottleneck reads as a vertical
  // band and a peak slowdown as a horizontal one.
  import type {Mode, ProfileBin, RouteStop, Stretch} from '../../engine/types';
  import {measure} from '../../lib/actions';
  import {hourLabel, hourRange, hourShort, length as formatLength, speedWithUnit, type Units} from '../../lib/format';
  import {HOURS, PEAKS, linear, ticks} from '../../lib/scale';
  import {breaksMps, classColors, classOf} from '../../lib/speed-scale';
  import {app} from '../../lib/state.svelte';
  import {tooltip} from '../../lib/tooltip.svelte';
  import {chartFont, cssVar, fitText, lastAtOrBefore, prepareCanvas} from './canvas';

  interface Props {
    profile: ProfileBin[];
    stops: RouteStop[];
    lengthM: number;
    units: Units;
    mode: Mode;
    slowest?: Stretch | null;
    selectedHour?: number;
    onpick?: (hour: number) => void;
  }
  let {profile, stops, lengthM, units, mode, slowest = null, selectedHour, onpick}: Props = $props();

  let canvas = $state<HTMLCanvasElement>();
  let width = $state(900);
  let cursor = $state<{bin: number; row: number} | null>(null);

  const rowHeight = 16;
  const top = 34;
  const bottom = 46;
  const left = 40;
  const right = 8;

  const hours = $derived.by(() => {
    const seen = HOURS.filter(hour => profile.some(bin => bin.speeds[hour] !== null && bin.speeds[hour] !== undefined));
    if (!seen.length) return HOURS;
    return HOURS.filter(hour => hour >= seen[0] && hour <= seen[seen.length - 1]);
  });
  const height = $derived(top + hours.length * rowHeight + bottom);
  const x = $derived(linear([0, lengthM || 1], [left, width - right]));
  const stopPositions = $derived(stops.map(stop => stop.s));
  const binStarts = $derived(profile.map(bin => bin.s0));

  function stopsAround(meters: number) {
    const before = lastAtOrBefore(stopPositions, meters);
    const previous = stops[Math.max(0, before)];
    const next = stops[Math.min(stops.length - 1, before + 1)];
    return {previous, next};
  }

  function draw() {
    if (!canvas) return;
    const context = prepareCanvas(canvas, width, height);
    if (!context) return;
    const colors = classColors();
    const breaks = breaksMps(mode);
    const plotHeight = hours.length * rowHeight;
    const plotWidth = width - left - right;
    const muted = cssVar('--muted');
    const ink = cssVar('--ink');

    context.fillStyle = cssVar('--surface');
    context.fillRect(left, top, plotWidth, plotHeight);

    for (const bin of profile) {
      const x0 = x(bin.s0);
      const span = Math.max(1, x(bin.s1) - x0);
      hours.forEach((hour, row) => {
        const value = bin.speeds[hour];
        if (value === null || value === undefined) return;
        context.fillStyle = colors[classOf(value, breaks)];
        context.fillRect(x0, top + row * rowHeight, span + 0.4, rowHeight - 1);
      });
    }

    // Hours, with the peak periods marked in the margin.
    context.font = chartFont();
    context.textBaseline = 'middle';
    context.textAlign = 'right';
    hours.forEach((hour, row) => {
      const y = top + row * rowHeight;
      if (PEAKS.some(([a, b]) => hour >= a && hour < b)) {
        context.fillStyle = cssVar('--orange');
        context.fillRect(left - 4, y, 2, rowHeight - 1);
      }
      if ((hour - hours[0]) % 2 === 0) {
        context.fillStyle = muted;
        context.fillText(hourShort(hour), left - 8, y + rowHeight / 2);
      }
    });

    // A tick for every stop along the top edge.
    context.fillStyle = cssVar('--faint');
    for (const stop of stops) context.fillRect(Math.round(x(stop.s)), top - 7, 1, 5);

    // The slowest stretch at peak, bracketed.
    if (slowest) {
      const a = x(slowest.s0);
      const b = x(slowest.s1);
      context.fillStyle = ink;
      context.fillRect(a, top - 13, Math.max(2, b - a), 2);
      context.textAlign = a > width / 2 ? 'right' : 'left';
      context.textBaseline = 'alphabetic';
      context.fillText('Slowest stretch at peak', a > width / 2 ? b : a, top - 18);
    }

    // Distance axis, in the visitor's units.
    const factor = units === 'imperial' ? 1 / 1609.34 : 1 / 1000;
    const unit = units === 'imperial' ? 'mi' : 'km';
    const axisY = top + plotHeight + 14;
    context.textBaseline = 'alphabetic';
    context.fillStyle = muted;
    const distanceTicks = ticks(0, lengthM * factor, width < 560 ? 4 : 8);
    distanceTicks.forEach((tick, index) => {
      const position = x(tick / factor);
      context.textAlign = 'center';
      context.fillText(index === distanceTicks.length - 1 ? `${tick} ${unit}` : String(tick), position, axisY);
    });

    // Stop names, thinned to what fits. The two ends are placed first so the first
    // and last stops always show, then the rest fill the room left between them.
    if (stops.length) {
      const slots = Math.max(1, Math.floor(plotWidth / 170));
      const room = Math.max(70, plotWidth / (slots + 1) - 10);
      const order = [0, slots, ...Array.from({length: Math.max(0, slots - 1)}, (_, i) => i + 1)];
      const taken: [number, number][] = [];
      const used = new Set<number>();
      context.fillStyle = ink;
      for (const slot of order) {
        const target = (slot / slots) * lengthM;
        let nearest = 0;
        for (let i = 1; i < stops.length; i += 1) {
          if (Math.abs(stops[i].s - target) < Math.abs(stops[nearest].s - target)) nearest = i;
        }
        if (used.has(nearest)) continue;
        const text = fitText(context, stops[nearest].name, room);
        const textWidth = context.measureText(text).width;
        const position = x(stops[nearest].s);
        const align = slot === 0 ? 'left' : slot === slots ? 'right' : 'center';
        const start = align === 'left' ? position : align === 'right' ? position - textWidth : position - textWidth / 2;
        const end = start + textWidth;
        if (taken.some(([a, b]) => start < b + 10 && end > a - 10)) continue;
        taken.push([start, end]);
        used.add(nearest);
        context.textAlign = align;
        context.fillText(text, position, axisY + 18);
      }
    }

    // Selected hour and the cell under the pointer.
    if (selectedHour !== undefined) {
      const row = hours.indexOf(selectedHour);
      if (row >= 0) {
        context.strokeStyle = ink;
        context.lineWidth = 1;
        context.strokeRect(left - 0.5, top + row * rowHeight - 0.5, plotWidth + 1, rowHeight);
      }
    }
    if (cursor) {
      const bin = profile[cursor.bin];
      if (bin) {
        context.strokeStyle = ink;
        context.lineWidth = 1.5;
        const a = x(bin.s0);
        context.strokeRect(a - 0.75, top + cursor.row * rowHeight - 0.75, Math.max(2, x(bin.s1) - a) + 1.5, rowHeight + 0.5);
      }
    }
  }

  $effect(() => {
    // Everything draw() reads, so a theme or data change redraws.
    app.darkActive;
    profile;
    stops;
    width;
    height;
    cursor;
    selectedHour;
    slowest;
    mode;
    units;
    draw();
  });

  function rowsFor(binIndex: number, row: number) {
    const bin = profile[binIndex];
    const hour = hours[row];
    const value = bin?.speeds[hour];
    const {previous, next} = stopsAround((bin.s0 + bin.s1) / 2);
    return [
      {title: value === null || value === undefined ? 'No measured service' : speedWithUnit(value, units)},
      {note: hourRange(hour)},
      {note: previous && next ? (previous === next ? `At ${previous.name}` : `${previous.name} to ${next.name}`) : ''},
      {label: 'Along the route', value: formatLength((bin.s0 + bin.s1) / 2, units)},
    ];
  }

  function cellAt(event: PointerEvent) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    if (px < left || px > width - right || py < top || py > top + hours.length * rowHeight) return null;
    const meters = ((px - left) / (width - left - right)) * lengthM;
    const bin = Math.max(0, lastAtOrBefore(binStarts, meters));
    return {bin, row: Math.floor((py - top) / rowHeight)};
  }

  function move(event: PointerEvent) {
    const cell = cellAt(event);
    cursor = cell;
    if (cell) tooltip.show(event, rowsFor(cell.bin, cell.row));
    else tooltip.hide();
  }

  function leave() {
    cursor = null;
    tooltip.hide();
  }

  function pick(event: MouseEvent) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const row = Math.floor((event.clientY - box.top - top) / rowHeight);
    if (row >= 0 && row < hours.length) onpick?.(hours[row]);
  }

  function key(event: KeyboardEvent) {
    const current = cursor ?? {bin: Math.floor(profile.length / 2), row: Math.max(0, hours.indexOf(selectedHour ?? 17))};
    const next = {...current};
    if (event.key === 'ArrowLeft') next.bin = Math.max(0, current.bin - 1);
    else if (event.key === 'ArrowRight') next.bin = Math.min(profile.length - 1, current.bin + 1);
    else if (event.key === 'ArrowUp') next.row = Math.max(0, current.row - 1);
    else if (event.key === 'ArrowDown') next.row = Math.min(hours.length - 1, current.row + 1);
    else if (event.key === 'Enter') {
      onpick?.(hours[current.row]);
      return;
    } else return;
    event.preventDefault();
    cursor = next;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const bin = profile[next.bin];
    tooltip.show({clientX: box.left + x((bin.s0 + bin.s1) / 2), clientY: box.top + top + next.row * rowHeight}, rowsFor(next.bin, next.row));
  }
</script>

<div class="heat" use:measure={w => (width = w)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="surface"
    role="img"
    aria-label="Speed along the route by hour, from {hourLabel(hours[0])} to {hourLabel(hours[hours.length - 1])}. Use the arrow keys to read each cell, and Enter to show that hour on the map."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onblur={leave}
    onkeydown={key}
    onclick={pick}
  >
    <canvas bind:this={canvas} style:width="{width}px" style:height="{height}px"></canvas>
  </div>
</div>

<style>
  .heat { min-width: 0; }
  .surface { cursor: crosshair; }
  canvas { display: block; }
</style>
