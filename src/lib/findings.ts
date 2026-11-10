// The plain-language summary at the top of the overview. Every sentence is computed
// from the same numbers as the charts beneath it, so they can't disagree.
import type {Overview, RouteScore} from '../engine/types';
import {hourRange, pct, plural, speedWithUnit, type Units} from './format';
import {SOLID_EVENTS, coverageOf, headlineHours, isShown, scheduleSuppressed} from './stats';

export interface Finding {
  text: string;
  route?: string;
}

/**
 * The slowest hour with real service. Night service runs fast on empty streets, and a
 * lone overnight run can look slow or fast, so an hour must carry enough trips and at
 * least half the service of a typical operating hour (see headlineHours in stats.ts).
 */
export function slowestHour(overview: Overview) {
  const days = Math.max(1, overview.dates.length);
  const measured = overview.hourly.filter(h => h.speed !== null);
  const pool = headlineHours(
    measured,
    h => h.service_hours_observed,
    h => Math.max(h.trips_observed, h.vehicles) * days,
  );
  if (!pool.length) return null;
  return pool.reduce((a, b) => ((b.speed ?? 0) < (a.speed ?? 0) ? b : a));
}

export function findings(overview: Overview, routes: RouteScore[], units: Units): Finding[] {
  const list: Finding[] = [];
  const s = (value: number | null | undefined) => speedWithUnit(value, units);

  const slowest = slowestHour(overview);
  if (slowest && overview.speed_mid && slowest.speed) {
    const change = slowest.speed / overview.speed_mid - 1;
    list.push({
      text: `The slowest hour is ${hourRange(slowest.hour)}, at ${s(slowest.speed)}${Math.abs(change) >= 0.01 ? `, ${pct(Math.abs(change))} ${change < 0 ? 'below' : 'above'} midday` : ''}.`,
    });
  }

  // Service running to schedule says the least, so it comes last.
  let matchesSchedule: Finding | null = null;
  if (overview.speed && overview.scheduled_speed) {
    const gap = overview.speed / overview.scheduled_speed - 1;
    if (Math.abs(gap) >= 0.02) {
      list.push({
        text: `Vehicles run ${pct(Math.abs(gap))} ${gap < 0 ? 'slower' : 'faster'} than the schedule assumes (${s(overview.speed)} measured, ${s(overview.scheduled_speed)} scheduled).`,
      });
    } else {
      matchesSchedule = {text: `Measured speed matches the schedule closely: ${s(overview.speed)} against ${s(overview.scheduled_speed)} scheduled.`};
    }
  }

  const coverage = coverageOf(overview);
  const timed = headlineHours(overview.hourly.filter(h => h.on_time.total > 0), h => h.service_hours_observed, h => h.on_time.total);
  if (!scheduleSuppressed(coverage) && isShown(overview.on_time.total) && timed.length) {
    const worst = timed.reduce((a, b) => (b.on_time.on_time / b.on_time.total < a.on_time.on_time / a.on_time.total ? b : a));
    list.push({
      text: `${pct(overview.on_time.on_time / overview.on_time.total)} of timepoint departures are on time, falling to ${pct(worst.on_time.on_time / worst.on_time.total)} in the ${hourRange(worst.hour)} hour.`,
    });
  }

  // Trips observed is zero on a speeds-only day, so rank on measured speed there.
  const comparable = routes.filter(r => r.speed_peak !== null && (coverage.mode === 'gps' || r.trips_observed >= overview.dates.length * 8));
  if (comparable.length >= 3) {
    const slowest = comparable.reduce((a, b) => ((b.speed_peak ?? 0) < (a.speed_peak ?? 0) ? b : a));
    list.push({text: `Route ${slowest.label} is the slowest at peak, averaging ${s(slowest.speed_peak)}.`, route: slowest.id});
    const penalized = comparable.filter(r => r.peak_change !== null);
    if (penalized.length) {
      const hit = penalized.reduce((a, b) => ((b.peak_change ?? 0) < (a.peak_change ?? 0) ? b : a));
      if ((hit.peak_change ?? 0) <= -0.03 && hit.id !== slowest.id) {
        list.push({text: `Route ${hit.label} loses the most at peak, running ${pct(Math.abs(hit.peak_change ?? 0))} slower than at midday.`, route: hit.id});
      }
    }
  }

  const headways = overview.headways;
  if (!scheduleSuppressed(coverage) && headways && headways.count >= SOLID_EVENTS) {
    const wait = headways.excess_wait_s;
    list.push({
      text: `On frequent service, ${pct(headways.bunched)} of vehicles arrive bunched and ${pct(headways.gapped)} follow a gap${wait !== null ? `, adding about ${Math.max(0, wait / 60).toFixed(1)} minutes to the average wait` : ''}.`,
    });
  }

  const share = !scheduleSuppressed(coverage) && overview.trips_scheduled_per_day > 0 ? overview.trips_observed_per_day / overview.trips_scheduled_per_day : null;
  if (share !== null && share < 0.9) {
    list.push({
      text: `Only ${pct(share)} of scheduled trips appear in the realtime feed. A missing trip may be a cancellation or a reporting gap, so treat service levels with care.`,
    });
  }
  if (coverage.mode === 'gps') {
    if (overview.speed_peak && overview.speed_mid) {
      const change = overview.speed_peak / overview.speed_mid - 1;
      list.push({text: `At the peaks vehicles average ${s(overview.speed_peak)}, ${pct(Math.abs(change))} ${change < 0 ? 'below' : 'above'} their midday ${s(overview.speed_mid)}.`});
    }
    if (overview.stopped_share !== null) list.push({text: `Vehicles spend ${pct(overview.stopped_share)} of measured time moving slower than 2 mph.`});
    if (overview.peak_vehicles > 0) list.push({text: `Up to ${Math.round(overview.peak_vehicles)} vehicles are in service in the busiest hour.`});
  }
  if (matchesSchedule) list.push(matchesSchedule);
  return list;
}

export function scopeLine(overview: Overview) {
  const n = overview.dates.length;
  return `${plural(overview.route_count, 'route')} · ${plural(n, 'service day')}`;
}
