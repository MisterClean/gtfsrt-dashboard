<script lang="ts">
  // Presets first, then a calendar with three explicit ways to pick: one day, a
  // range (first click, last click), or several separate days. Days already
  // analysed on this device are marked, because adding them costs nothing.
  import {addDays, dayTypeOf, lastDays, rangeDates, type DayType} from '../lib/dates';
  import {dateLabel, dateNumber, datesLabel, isoDate, parseIso, plural} from '../lib/format';
  import {app} from '../lib/state.svelte';

  let open = $state(false);
  let root = $state<HTMLElement>();
  let cursor = $state('');

  type PickMode = 'day' | 'range' | 'days';
  const pickModes: {key: PickMode; label: string; hint: string}[] = [
    {key: 'day', label: 'One day', hint: 'Click a day. Each click replaces the selection.'},
    {key: 'range', label: 'Range', hint: 'Click the first day, then the last. Every day between is included.'},
    {key: 'days', label: 'Several days', hint: 'Click days to add or remove them one by one.'},
  ];
  let pickMode = $state<PickMode>('day');
  /** In range mode: the first click, waiting for the last. */
  let anchor = $state<string | null>(null);
  let weekdaysOnly = $state(true);
  const hint = $derived(anchor ? 'Now click the last day of the range.' : pickModes.find(m => m.key === pickMode)!.hint);

  function inferMode(): PickMode {
    if (app.dates.length <= 1) return 'day';
    const first = app.dates[0];
    const last = app.dates[app.dates.length - 1];
    return app.dates.length > 1 && rangeDates(isoDate(first), isoDate(last)).length === app.dates.length ? 'range' : 'days';
  }
  function setPickMode(mode: PickMode) {
    pickMode = mode;
    anchor = null;
  }

  const feed = $derived(app.feed);
  const presets: {label: string; type: DayType; count: number}[] = [
    {label: 'Last weekday', type: 'weekday', count: 1},
    {label: 'Last 5 weekdays', type: 'weekday', count: 5},
    {label: 'Last 10 weekdays', type: 'weekday', count: 10},
    {label: 'Last 20 weekdays', type: 'weekday', count: 20},
    {label: 'Last 4 Saturdays', type: 'saturday', count: 4},
    {label: 'Last 4 Sundays', type: 'sunday', count: 4},
  ];

  function presetDates(preset: (typeof presets)[number]) {
    return feed ? lastDays(feed.date_min, feed.date_max, preset.type, preset.count) : [];
  }
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  function toggleOpen() {
    open = !open;
    if (open) {
      setPickMode(inferMode());
      const last = app.dates[app.dates.length - 1];
      const iso = last ? `${String(last).slice(0, 4)}-${String(last).slice(4, 6)}-01` : feed?.date_max.slice(0, 7) + '-01';
      cursor = iso;
    }
  }

  function outside(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }

  const monthLabel = $derived(cursor ? dateLabel(cursor, {month: 'long', year: 'numeric'}) : '');
  const cells = $derived.by(() => {
    if (!cursor) return [] as (string | null)[];
    const first = parseIso(cursor);
    const offset = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const list: (string | null)[] = Array(offset).fill(null);
    for (let day = 0; day < days; day += 1) list.push(addDays(cursor, day));
    return list;
  });

  function shift(months: number) {
    const date = parseIso(cursor);
    date.setUTCMonth(date.getUTCMonth() + months);
    cursor = date.toISOString().slice(0, 10);
  }

  function toggle(iso: string) {
    const number = dateNumber(iso);
    if (pickMode === 'day') return app.setDates([number]);
    if (pickMode === 'range') {
      if (!anchor) {
        anchor = iso;
        return app.setDates([number]);
      }
      const [from, to] = anchor <= iso ? [anchor, iso] : [iso, anchor];
      anchor = null;
      const all = rangeDates(from, to).filter(d => available(isoDate(d)));
      const weekdays = all.filter(d => dayTypeOf(isoDate(d)) === 'weekday');
      return app.setDates(weekdaysOnly && weekdays.length ? weekdays : all);
    }
    app.setDates(app.dates.includes(number) ? app.dates.filter(d => d !== number) : [...app.dates, number]);
  }

  const available = (iso: string) => !!feed && iso >= feed.date_min && iso <= feed.date_max;
</script>

<svelte:window onpointerdown={outside} onkeydown={event => { if (event.key === 'Escape') open = false; }} />

<div class="picker" bind:this={root}>
  <button class="btn trigger" aria-expanded={open} aria-haspopup="dialog" onclick={toggleOpen}>
    <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5h14M7 2.5v4M13 2.5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <span>{datesLabel(app.dates)}</span>
    <span class="count">{plural(app.dates.length, 'day')}</span>
  </button>
  {#if open}
    <div class="panel" role="dialog" aria-label="Choose service days">
      {#if app.stale?.stale}
        <p class="stale" role="status">
          No data near today. {app.feed ? 'This agency' : 'The feed'}'s newest day is {dateLabel(app.stale.latest_day, {month: 'short', day: 'numeric', year: 'numeric'})}.
          <button class="link-btn" onclick={() => { app.useLatestDay(); open = false; }}>Use that day</button>
        </p>
      {/if}
      <ul class="presets">
        {#each presets as preset}
          {@const dates = presetDates(preset)}
          <li>
            <button class:selected={same(dates, app.dates)} disabled={!dates.length} onclick={() => app.setDates(dates)}>
              {preset.label}
              {#if same(dates, app.dates)}
                <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      <div class="calendar">
        <div class="seg" role="group" aria-label="How to pick days">
          {#each pickModes as m}
            <button aria-pressed={pickMode === m.key} onclick={() => setPickMode(m.key)}>{m.label}</button>
          {/each}
        </div>
        <p class="fine hint" aria-live="polite">{hint}</p>
        {#if pickMode === 'range'}
          <label class="fine check"><input type="checkbox" bind:checked={weekdaysOnly} /> Weekdays only</label>
        {/if}
        <div class="month">
          <button class="btn small quiet" aria-label="Previous month" onclick={() => shift(-1)}>
            <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M13 3l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>
          </button>
          <strong>{monthLabel}</strong>
          <button class="btn small quiet" aria-label="Next month" onclick={() => shift(1)}>
            <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>
          </button>
        </div>
        <div class="days" role="grid">
          {#each ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as day}<span class="dow">{day}</span>{/each}
          {#each cells as iso}
            {#if iso}
              {@const number = dateNumber(iso)}
              <button
                class="day"
                class:selected={app.dates.includes(number)}
                class:anchor={anchor === iso}
                class:weekend={dayTypeOf(iso) !== 'weekday'}
                class:cached={app.cachedDates.includes(number)}
                disabled={!available(iso)}
                aria-pressed={app.dates.includes(number)}
                aria-label="{dateLabel(iso, {weekday: 'long', month: 'long', day: 'numeric'})}{app.cachedDates.includes(number) ? ', already on this device' : ''}"
                onclick={() => toggle(iso)}
              >{parseIso(iso).getUTCDate()}</button>
            {:else}
              <span></span>
            {/if}
          {/each}
        </div>
        <p class="fine foot"><strong>Selected:</strong> {app.dates.length ? `${datesLabel(app.dates)} (${plural(app.dates.length, 'day')})` : 'no days'}</p>
        <p class="fine foot"><span class="dot"></span> Already on this device</p>
        <p class="fine">Days are local service days. The newest day in the archive is missing its evening until the next file is published.</p>
      </div>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; }
  .trigger { font-weight: 550; }
  .count { color: var(--muted); font-weight: 450; }
  .panel {
    position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; display: grid; grid-template-columns: 170px 276px;
    background: var(--paper); border: 1px solid var(--rule-strong); border-radius: 6px; box-shadow: var(--shadow-pop);
  }
  .presets { list-style: none; padding: 8px; border-right: 1px solid var(--rule); display: grid; gap: 1px; align-content: start; }
  .presets button {
    width: 100%; display: flex; justify-content: space-between; align-items: center; min-height: 32px; padding: 4px 8px;
    border: 0; border-radius: 3px; background: none; font-size: 13px; text-align: left;
  }
  .presets button:hover:not(:disabled) { background: var(--surface); }
  .presets button.selected { font-weight: 650; }
  .calendar { padding: 10px 12px 12px; display: grid; gap: 8px; }
  .month { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .dow { text-align: center; font-size: 11px; color: var(--faint); padding-bottom: 2px; }
  .day {
    position: relative; aspect-ratio: 1.12; border: 0; border-radius: 3px; background: none;
    font-size: 12.5px; font-variant-numeric: tabular-nums;
  }
  .day:hover:not(:disabled) { background: var(--surface-2); }
  .day.weekend { color: var(--faint); }
  .day:disabled { opacity: .3; }
  .day.selected { background: var(--ink); color: var(--paper); font-weight: 650; }
  .day.selected:hover:not(:disabled) { background: var(--ink); }
  .day.cached::after {
    content: ""; position: absolute; left: 50%; bottom: 3px; width: 4px; height: 4px; margin-left: -2px;
    border-radius: 50%; background: var(--copper);
  }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--copper); margin-right: 3px; vertical-align: 1px; }
  .foot { padding-top: 2px; }
  .stale { grid-column: 1 / -1; margin: 0; padding: 8px 12px; font-size: 12.5px; background: var(--caution-pale); color: var(--caution-ink); border-radius: 6px 6px 0 0; }
  .hint { min-height: 2.6em; }
  .check { display: flex; gap: 6px; align-items: center; }
  .day.anchor { outline: 2px solid var(--copper); outline-offset: -2px; }
  @media (max-width: 560px) {
    .panel { grid-template-columns: 1fr; width: min(92vw, 300px); }
    .presets { border-right: 0; border-bottom: 1px solid var(--rule); grid-template-columns: 1fr 1fr; }
  }
</style>
