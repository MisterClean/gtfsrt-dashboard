// One speed scale for every map and heatmap, so a color always means the same
// thing. Classes are absolute so agencies can be compared; rail and ferry run a
// wider range and use their own breaks.
import type {Mode} from '../engine/types';
import {speedUnit, type Units} from './format';

const BUS_MPH = [5, 8, 10, 13, 16, 20];
const FAST_MPH = [10, 15, 20, 28, 36, 45];

export const CLASS_VARS = ['--c0', '--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];

export function breaksMps(mode: Mode) {
  const breaks = mode === 'Rail' || mode === 'Ferry' ? FAST_MPH : BUS_MPH;
  return breaks.map(mph => mph / 2.23694);
}

export function classOf(mps: number, breaks: number[]) {
  let index = 0;
  while (index < breaks.length && mps >= breaks[index]) index += 1;
  return index;
}

export function classVar(mps: number | null | undefined, breaks: number[]) {
  return mps === null || mps === undefined ? null : `var(${CLASS_VARS[classOf(mps, breaks)]})`;
}

export function classLabels(mode: Mode, units: Units) {
  const breaks = (mode === 'Rail' || mode === 'Ferry' ? FAST_MPH : BUS_MPH).map(mph =>
    units === 'imperial' ? mph : Math.round((mph * 1.60934) / 5) * 5,
  );
  const labels = [`under ${breaks[0]}`];
  for (let i = 0; i < breaks.length - 1; i += 1) labels.push(`${breaks[i]}–${breaks[i + 1]}`);
  labels.push(`${breaks[breaks.length - 1]}+`);
  return {labels, unit: speedUnit(units)};
}

/** Reads the current theme's class colors, for canvas and map layers. */
export function classColors() {
  const style = getComputedStyle(document.documentElement);
  return CLASS_VARS.map(name => style.getPropertyValue(name).trim());
}
