<script lang="ts">
  // A string-line (Marey) chart. Each line is one trip: time runs across, distance
  // runs down. Lines that converge are vehicles catching each other, and a flat
  // stretch is a vehicle standing still.
  import type {StringLine, StringLineTrip} from '../../engine/types';
  import {measure} from '../../lib/actions';
  import {clock, deviation, hourLabel, hourShort, length as formatLength, type Units} from '../../lib/format';
  import {PEAKS, linear} from '../../lib/scale';
  import {app} from '../../lib/state.svelte';
  import {tooltip} from '../../lib/tooltip.svelte';
  import {chartFont, cssVar, fitText, lastAtOrBefore, prepareCanvas} from './canvas';

  interface Props {
    data: StringLine;
    units: Units;
    /** Seconds from the service origin. `null` shows the whole day. */
    from?: number | null;
    to?: number | null;
  }
  let {data, units, from = null, to = null}: Props = $props();

  let canvas = $state<HTMLCanvasElement>();
  let width = $state(900);
  let hovered = $state<number | null>(null);

  const narrow = $derived(width < 560);
  const height = $derived(narrow ? 420 : 560);
  const margin = $derived({top: 26, right: 12, bottom: 12, left: narrow ? 104 : 176});

  const extent = $derived.by(() => {
    let low = Infinity;
    let high = -Infinity;
    for (const trip of data.trips) {
      for (const [t] of trip.observed) {
        low = Math.min(low, t);
        high = Math.max(high, t);
      }
      for (const [t] of trip.scheduled) {
        low = Math.min(low, t);
        high = Math.max(high, t);
      }
    }
    if (!Number.isFinite(low)) return [5 * 3600, 24 * 3600] as const;
    return [Math.floor(low / 1800) * 1800, Math.ceil(high / 1800) * 1800] as const;
  });
  const t0 = $derived(from ?? extent[0]);
  const t1 = $derived(to ?? extent[1]);
  const x = $derived(linear([t0, t1], [margin.left, width - margin.right]));
  const y = $derived(linear([0, data.length_m || 1], [margin.top, height - margin.bottom]));

  /**
   * Stops where a vehicle arrived within a quarter of the scheduled headway of the
   * one ahead. Only on service scheduled at 15 minutes or better, as elsewhere.
   */
  const bunched = $derived.by(() => {
    const flagged = new Map<number, Set<number>>();
    const byStop = new Map<string, {trip: number; point: number; observed: number; scheduled: number}[]>();
    data.trips.forEach((trip, tripIndex) => {
      trip.observed.forEach(([t, s], point) => {
        const key = s.toFixed(1);
        const list = byStop.get(key) ?? [];
        list.push({trip: tripIndex, point, observed: t, scheduled: trip.scheduled[point]?.[0] ?? t});
        byStop.set(key, list);
      });
    });
    for (const list of byStop.values()) {
      list.sort((a, b) => a.observed - b.observed);
      for (let i = 1; i < list.length; i += 1) {
        const gap = list[i].observed - list[i - 1].observed;
        const promised = Math.abs(list[i].scheduled - list[i - 1].scheduled);
        if (promised > 0 && promised <= 900 && gap < 0.25 * promised) {
          for (const entry of [list[i], list[i - 1]]) {
            const set = flagged.get(entry.trip) ?? new Set<number>();
            set.add(entry.point);
            flagged.set(entry.trip, set);
          }
        }
      }
    }
    return flagged;
  });

  /**
   * Whether two neighbouring points could be one vehicle moving. Trips on other
   * patterns share only some stops with the main line, and a stop the line passes
   * twice maps to one position, so joining every point would draw vehicles jumping
   * the length of the route.
   */
  function plausible(a: [number, number], b: [number, number]) {
    const elapsed = b[0] - a[0];
    const moved = b[1] - a[1];
    if (moved < -30) return false;
    return elapsed <= 0 ? moved <= 400 : moved / elapsed <= 40;
  }

  function draw() {
    if (!canvas) return;
    const context = prepareCanvas(canvas, width, height);
    if (!context) return;
    const rule = cssVar('--rule');
    const muted = cssVar('--muted');
    const ink = cssVar('--ink');
    const plotTop = margin.top;
    const plotBottom = height - margin.bottom;

    context.font = chartFont();
    context.textBaseline = 'alphabetic';

    // Peak periods.
    context.fillStyle = cssVar('--orange');
    context.globalAlpha = 0.07;
    for (const [a, b] of PEAKS) {
      const left = Math.max(margin.left, x(a * 3600));
      const right = Math.min(width - margin.right, x(b * 3600));
      if (right > left) context.fillRect(left, plotTop, right - left, plotBottom - plotTop);
    }
    context.globalAlpha = 1;

    // Hours across the top.
    const span = (t1 - t0) / 3600;
    const step = span <= 6 ? 1 : narrow ? 4 : span <= 12 ? 2 : 3;
    const firstHour = Math.ceil(t0 / 3600 / step) * step;
    context.textAlign = 'center';
    for (let hour = firstHour; hour * 3600 <= t1; hour += step) {
      const position = x(hour * 3600);
      context.fillStyle = rule;
      context.fillRect(Math.round(position), plotTop, 1, plotBottom - plotTop);
      context.fillStyle = muted;
      context.fillText(span <= 6 ? hourLabel(hour) : hourShort(hour), position, plotTop - 9);
    }

    // Stop names down the side, thinned so they never collide.
    const minimumGap = 17;
    const labels: number[] = [];
    const stops = data.stops;
    if (stops.length) {
      labels.push(0);
      for (let i = 1; i < stops.length - 1; i += 1) {
        const last = labels[labels.length - 1];
        const fitsAfter = y(stops[i][0]) - y(stops[last][0]) >= minimumGap;
        const fitsBefore = y(stops[stops.length - 1][0]) - y(stops[i][0]) >= minimumGap;
        if (fitsAfter && fitsBefore) labels.push(i);
      }
      if (stops.length > 1) labels.push(stops.length - 1);
    }
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (const index of labels) {
      const [s, name] = stops[index];
      const position = y(s);
      context.fillStyle = rule;
      context.fillRect(margin.left, Math.round(position), width - margin.left - margin.right, 1);
      context.fillStyle = muted;
      context.fillText(fitText(context, name, margin.left - 10), margin.left - 8, position);
    }
    context.textBaseline = 'alphabetic';

    // Everything below stays inside the plot when zoomed.
    context.save();
    context.beginPath();
    context.rect(margin.left, plotTop - 1, width - margin.left - margin.right, plotBottom - plotTop + 2);
    context.clip();
    context.lineJoin = 'round';

    // The schedule, quietly, then what happened.
    context.strokeStyle = cssVar('--rule-strong');
    context.lineWidth = 1;
    for (const trip of data.trips) drawLine(context, trip.scheduled);

    context.strokeStyle = ink;
    context.lineWidth = 1.25;
    context.globalAlpha = 0.85;
    for (const trip of data.trips) drawLine(context, trip.observed);
    context.globalAlpha = 1;

    context.strokeStyle = cssVar('--orange');
    context.lineWidth = 2.25;
    data.trips.forEach((trip, index) => {
      const flagged = bunched.get(index);
      if (!flagged) return;
      context.beginPath();
      trip.observed.forEach(([t, s], point) => {
        if (point > 0 && flagged.has(point) && flagged.has(point - 1) && plausible(trip.observed[point - 1], [t, s])) {
          const [pt, ps] = trip.observed[point - 1];
          context.moveTo(x(pt), y(ps));
          context.lineTo(x(t), y(s));
        }
      });
      context.stroke();
    });

    if (hovered !== null && data.trips[hovered]) {
      const trip = data.trips[hovered];
      context.strokeStyle = cssVar('--blue');
      context.lineWidth = 1.5;
      drawLine(context, trip.scheduled);
      context.strokeStyle = ink;
      context.lineWidth = 2.75;
      drawLine(context, trip.observed);
    }
    context.restore();
  }

  function drawLine(context: CanvasRenderingContext2D, points: [number, number][]) {
    if (points.length < 2) return;
    context.beginPath();
    points.forEach((point, index) => {
      const [t, s] = point;
      if (index === 0 || !plausible(points[index - 1], point)) context.moveTo(x(t), y(s));
      else context.lineTo(x(t), y(s));
    });
    context.stroke();
  }

  $effect(() => {
    app.darkActive;
    data;
    width;
    height;
    t0;
    t1;
    hovered;
    bunched;
    draw();
  });

  /** The trip whose line passes closest to a point, in pixels. */
  function nearestTrip(px: number, py: number) {
    let best: number | null = null;
    let bestDistance = 22;
    data.trips.forEach((trip, index) => {
      const points = trip.observed;
      for (let i = 1; i < points.length; i += 1) {
        if (!plausible(points[i - 1], points[i])) continue;
        const ax = x(points[i - 1][0]);
        const bx = x(points[i][0]);
        if (Math.max(ax, bx) < px - bestDistance || Math.min(ax, bx) > px + bestDistance) continue;
        const ay = y(points[i - 1][1]);
        const by = y(points[i][1]);
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const fraction = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
        const distance = Math.hypot(px - (ax + dx * fraction), py - (ay + dy * fraction));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    });
    return best;
  }

  function rowsFor(trip: StringLineTrip, py?: number) {
    const rows: {title?: string; label?: string; value?: string; note?: string}[] = [{title: `Trip ${trip.trip_id}`}];
    if (trip.vehicle) rows.push({label: 'Vehicle', value: trip.vehicle});
    const first = trip.scheduled[0];
    if (first) rows.push({label: 'Scheduled start', value: clock(first[0])});
    if (py !== undefined && trip.observed.length) {
      const meters = ((py - margin.top) / (height - margin.top - margin.bottom)) * data.length_m;
      let index = 0;
      trip.observed.forEach((point, i) => {
        if (Math.abs(point[1] - meters) < Math.abs(trip.observed[index][1] - meters)) index = i;
      });
      const [time, s] = trip.observed[index];
      const scheduled = trip.scheduled[index]?.[0];
      const stopIndex = Math.max(0, lastAtOrBefore(data.stops.map(stop => stop[0]), s));
      rows.push({note: data.stops[stopIndex]?.[1] ?? formatLength(s, units)});
      rows.push({label: 'Passed at', value: clock(time)});
      if (scheduled !== undefined) rows.push({label: 'Against schedule', value: deviation(time - scheduled)});
    }
    if (trip.deviation_end_s !== null) rows.push({label: 'At last stop', value: deviation(trip.deviation_end_s)});
    return rows;
  }

  function move(event: PointerEvent) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const index = px >= margin.left ? nearestTrip(px, py) : null;
    hovered = index;
    if (index === null) tooltip.hide();
    else tooltip.show(event, rowsFor(data.trips[index], py));
  }

  function leave() {
    hovered = null;
    tooltip.hide();
  }

  function key(event: KeyboardEvent) {
    const count = data.trips.length;
    if (!count) return;
    let next = hovered;
    if (event.key === 'ArrowRight') next = hovered === null ? 0 : Math.min(count - 1, hovered + 1);
    else if (event.key === 'ArrowLeft') next = hovered === null ? count - 1 : Math.max(0, hovered - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    hovered = next;
    if (next !== null) tooltip.showFor(event.currentTarget as Element, rowsFor(data.trips[next]));
  }
</script>

<div class="line-chart" use:measure={w => (width = w)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="surface"
    role="img"
    aria-label="String-line chart of {data.trips.length} trips on {data.date}. Use the left and right arrow keys to step through trips."
    tabindex="0"
    onpointermove={move}
    onpointerleave={leave}
    onblur={leave}
    onkeydown={key}
  >
    <canvas bind:this={canvas} style:width="{width}px" style:height="{height}px"></canvas>
  </div>
</div>
<div class="legend">
  <span class="key"><span class="line" style:background="var(--ink)"></span>Observed</span>
  <span class="key"><span class="line" style:background="var(--rule-strong)"></span>Scheduled</span>
  <span class="key"><span class="line thick" style:background="var(--orange)"></span>Bunched: under a quarter of the scheduled headway</span>
</div>

<style>
  .line-chart { min-width: 0; width: 100%; }
  .surface { cursor: crosshair; }
  canvas { display: block; }
  .thick { height: 3px; }
</style>
