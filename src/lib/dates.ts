// Choosing service days. The newest UTC file can't hold a complete local service
// day, because evening service spills into the next UTC date.
import {dateNumber, isoDate, parseIso} from './format.ts';

export function addDays(iso: string, days: number) {
  const date = parseIso(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export const weekdayOf = (iso: string) => parseIso(iso).getUTCDay();

export type DayType = 'weekday' | 'saturday' | 'sunday';
export const dayTypeOf = (iso: string): DayType => {
  const day = weekdayOf(iso);
  return day === 0 ? 'sunday' : day === 6 ? 'saturday' : 'weekday';
};

/** Most recent `count` days of a type on or before the last complete service day. */
export function lastDays(dateMin: string, dateMax: string, type: DayType, count: number) {
  const dates: number[] = [];
  let cursor = addDays(dateMax, -1);
  while (cursor >= dateMin && dates.length < count) {
    if (dayTypeOf(cursor) === type) dates.push(dateNumber(cursor));
    cursor = addDays(cursor, -1);
  }
  return dates.reverse();
}

export function rangeDates(from: string, to: string, weekdays?: Set<number>) {
  const dates: number[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    if (!weekdays || weekdays.has(weekdayOf(cursor))) dates.push(dateNumber(cursor));
  }
  return dates;
}

/** Serializes dates for the URL, as a range when they form one. */
export function encodeDates(dates: number[]) {
  if (!dates.length) return {};
  const sorted = [...dates].sort((a, b) => a - b);
  const from = isoDate(sorted[0]);
  const to = isoDate(sorted[sorted.length - 1]);
  const everyDay = rangeDates(from, to);
  if (everyDay.length === sorted.length) return {from, to};
  const weekdaysOnly = rangeDates(from, to, new Set([1, 2, 3, 4, 5]));
  if (weekdaysOnly.length === sorted.length && weekdaysOnly.every((d, i) => d === sorted[i])) return {from, to, days: 'wk'};
  return {dates: sorted.map(d => String(d)).join(',')};
}

export function decodeDates(params: URLSearchParams) {
  const list = params.get('dates');
  if (list) return list.split(',').map(Number).filter(d => d > 20000101 && d < 21000101);
  const from = params.get('from');
  const to = params.get('to');
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return [];
  const weekdays = params.get('days') === 'wk' ? new Set([1, 2, 3, 4, 5]) : undefined;
  return rangeDates(from, to, weekdays).slice(0, 62);
}
