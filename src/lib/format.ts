// Display formatting. Rust reports in SI units; everything visible goes through here.
export type Units = 'imperial' | 'metric';

const MPH = 2.23694;
const KMH = 3.6;
export const DASH = '—';

export function toDisplaySpeed(mps: number, units: Units) {
  return mps * (units === 'imperial' ? MPH : KMH);
}
export const speedUnit = (units: Units) => (units === 'imperial' ? 'mph' : 'km/h');
export function speed(mps: number | null | undefined, units: Units, digits = 1) {
  return mps === null || mps === undefined || Number.isNaN(mps) ? DASH : toDisplaySpeed(mps, units).toFixed(digits);
}
export function speedWithUnit(mps: number | null | undefined, units: Units) {
  return mps === null || mps === undefined ? DASH : `${speed(mps, units)} ${speedUnit(units)}`;
}

export function int(value: number | null | undefined) {
  return value === null || value === undefined ? DASH : Math.round(value).toLocaleString('en-US');
}
export function compact(value: number) {
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e4) return `${Math.round(value / 1e3)}K`;
  return Math.round(value).toLocaleString('en-US');
}
export function pct(value: number | null | undefined, digits = 0) {
  return value === null || value === undefined || Number.isNaN(value) ? DASH : `${(value * 100).toFixed(digits)}%`;
}
export function signedPct(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  const number = (value * 100).toFixed(digits);
  return value > 0 ? `+${number}%` : `${number.replace('-', '−')}%`;
}
export function ratioOf(part: number, whole: number) {
  return whole > 0 ? part / whole : null;
}

/** Service hours run past midnight: 25 reads as 1 AM. */
export function hourLabel(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
export function hourShort(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}
export const hourRange = (hour: number) => `${hourLabel(hour)}–${hourLabel(hour + 1)}`;

export function minutes(seconds: number | null | undefined, digits = 0) {
  return seconds === null || seconds === undefined ? DASH : `${(seconds / 60).toFixed(digits)} min`;
}
/** A signed schedule deviation such as `+2:30` or `−0:45`. */
export function deviation(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return DASH;
  const sign = seconds < 0 ? '−' : '+';
  const whole = Math.abs(Math.round(seconds));
  return `${sign}${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
/** A clock time from seconds past the GTFS origin. */
export function clock(seconds: number) {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const display = ((h % 24) + 24) % 24;
  const suffix = display < 12 ? 'a' : 'p';
  return `${display % 12 === 0 ? 12 : display % 12}:${String(m).padStart(2, '0')}${suffix}`;
}

export function length(meters: number | null | undefined, units: Units) {
  if (meters === null || meters === undefined) return DASH;
  return units === 'imperial' ? `${(meters / 1609.34).toFixed(meters < 1609 ? 2 : 1)} mi` : `${(meters / 1000).toFixed(meters < 1000 ? 2 : 1)} km`;
}
/** Short distances, which planners discuss in feet. */
export function shortLength(meters: number | null | undefined, units: Units) {
  if (meters === null || meters === undefined) return DASH;
  return units === 'imperial' ? `${Math.round(meters * 3.28084).toLocaleString('en-US')} ft` : `${Math.round(meters)} m`;
}

export function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

export const dateNumber = (iso: string) => Number(iso.replaceAll('-', ''));
export function isoDate(number: number) {
  return `${Math.floor(number / 10000)}-${String(Math.floor(number / 100) % 100).padStart(2, '0')}-${String(number % 100).padStart(2, '0')}`;
}
export function parseIso(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function dateLabel(iso: string, options: Intl.DateTimeFormatOptions = {weekday: 'short', month: 'short', day: 'numeric'}) {
  return parseIso(iso).toLocaleDateString('en-US', {...options, timeZone: 'UTC'});
}
/** A compact description of a set of dates, such as `Nov 2–6, 2026`. */
export function datesLabel(dates: number[]) {
  if (!dates.length) return 'No days';
  const sorted = [...dates].sort((a, b) => a - b);
  const first = isoDate(sorted[0]);
  const last = isoDate(sorted[sorted.length - 1]);
  const year = dateLabel(last, {year: 'numeric'});
  if (first === last) return dateLabel(first, {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'});
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const end = sameMonth ? dateLabel(last, {day: 'numeric'}) : dateLabel(last, {month: 'short', day: 'numeric'});
  return `${dateLabel(first, {month: 'short', day: 'numeric'})}–${end}, ${year}`;
}
export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** A route's name, unless it only repeats the number: `Route 80` adds nothing to `80`. */
export function routeName(label: string, longName: string) {
  const name = longName.trim();
  if (!name || name === label) return '';
  return name.replace(/^route\s+/i, '') === label ? '' : name;
}
