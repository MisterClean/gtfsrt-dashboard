// The small amount of scale math the charts need.
export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Round tick values covering `[min, max]`. */
export function ticks(min: number, max: number, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw) ?? raw;
  const values: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) values.push(Number(v.toFixed(10)));
  return values;
}

/** Extends a range to round numbers. */
export function niceRange(min: number, max: number, count = 4): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw) ?? raw;
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

/** An SVG path for a series with gaps where values are missing. */
export function linePath(points: (readonly [number, number] | null)[]) {
  let path = '';
  let drawing = false;
  for (const point of points) {
    if (!point) {
      drawing = false;
      continue;
    }
    path += `${drawing ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    drawing = true;
  }
  return path;
}

/** The service hours shown on every hourly axis: 4 AM to 4 AM. */
export const HOURS = Array.from({length: 24}, (_, i) => i + 4);
export const PEAKS: [number, number][] = [[7, 9], [16, 18]];
