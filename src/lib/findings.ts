// The plain-language summary at the top of the overview. Every sentence is computed
// from the same numbers as the charts beneath it, so they can't disagree.
import type {Overview, RouteScore} from '../engine/types';
import {hourRange, pct, plural, speedWithUnit, type Units} from './format';

export interface Finding {
  text: string;
  route?: string;
}

export function findings(overview: Overview, routes: RouteScore[], units: Units): Finding[] {
  const list: Finding[] = [];
  const s = (value: number | null | undefined) => speedWithUnit(value, units);

  const measured = overview.hourly.filter(h => h.speed !== null && h.service_hours_observed >= 3);
  if (measured.length) {
    // Night service runs fast on empty streets, so look at the hours with real service.
    const busiest = Math.max(...measured.map(h => h.service_hours_observed));
    const daytime = measured.filter(h => h.service_hours_observed >= busiest * 0.4);
    const slowest = daytime.reduce((a, b) => ((b.speed ?? 0) < (a.speed ?? 0) ? b : a));
    if (overview.speed_mid && slowest.speed) {
      const change = slowest.speed / overview.speed_mid - 1;
      list.push({
        text: `The slowest hour is ${hourRange(slowest.hour)}, at ${s(slowest.speed)}${Math.abs(change) >= 0.01 ? `, ${pct(Math.abs(change))} ${change < 0 ? 'below' : 'above'} midday` : ''}.`,
      });
    }
  }

  if (overview.speed && overview.scheduled_speed) {
    const gap = overview.speed / overview.scheduled_speed - 1;
    if (Math.abs(gap) >= 0.02) {
      list.push({
        text: `Vehicles run ${pct(Math.abs(gap))} ${gap < 0 ? 'slower' : 'faster'} than the schedule assumes (${s(overview.speed)} measured, ${s(overview.scheduled_speed)} scheduled).`,
      });
    } else {
      list.push({text: `Measured speed matches the schedule closely: ${s(overview.speed)} against ${s(overview.scheduled_speed)} scheduled.`});
    }
  }

  const timed = overview.hourly.filter(h => h.on_time.total >= 30);
  if (overview.on_time.total && timed.length) {
    const worst = timed.reduce((a, b) => (b.on_time.on_time / b.on_time.total < a.on_time.on_time / a.on_time.total ? b : a));
    list.push({
      text: `${pct(overview.on_time.on_time / overview.on_time.total)} of timepoint departures are on time, falling to ${pct(worst.on_time.on_time / worst.on_time.total)} in the ${hourRange(worst.hour)} hour.`,
    });
  }

  const comparable = routes.filter(r => r.speed_peak !== null && r.trips_observed >= overview.dates.length * 8);
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
  if (headways && headways.count >= 100) {
    const wait = headways.excess_wait_s;
    list.push({
      text: `On frequent service, ${pct(headways.bunched)} of vehicles arrive bunched and ${pct(headways.gapped)} follow a gap${wait !== null ? `, adding about ${Math.max(0, wait / 60).toFixed(1)} minutes to the average wait` : ''}.`,
    });
  }

  const share = overview.trips_scheduled_per_day > 0 ? overview.trips_observed_per_day / overview.trips_scheduled_per_day : null;
  if (share !== null && share < 0.9) {
    list.push({
      text: `Only ${pct(share)} of scheduled trips appear in the realtime feed. A missing trip may be a cancellation or a reporting gap, so treat service levels with care.`,
    });
  }
  return list;
}

export function scopeLine(overview: Overview) {
  const n = overview.dates.length;
  return `${plural(overview.route_count, 'route')} · ${plural(n, 'service day')}`;
}
