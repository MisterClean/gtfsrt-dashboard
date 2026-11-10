<script lang="ts">
  import {bytes, dateNumber, datesLabel, plural} from '../lib/format';
  import {estimateLoad} from '../lib/progress';
  import {app} from '../lib/state.svelte';
  import type {Mode} from '../engine/types';
  import AgencyPicker from './AgencyPicker.svelte';
  import DatePicker from './DatePicker.svelte';

  let {snapshot = false}: {snapshot?: boolean} = $props();
  const requestedDates = $derived(app.snapshot?.manifest.requestedDates ?? []);

  // The same figure as the heads-up and the progress panel, so the numbers agree.
  const estimate = $derived(app.feed ? estimateLoad(app.feed, app.uncachedDates.filter(d => app.pendingDates.includes(d))).bytes : 0);

  const modes: Mode[] = ['All', 'Bus', 'Rail', 'Ferry'];
  const availableModes = $derived.by(() => {
    const present = new Set(app.routes.map(route => route.mode));
    return modes.filter(mode => mode === 'All' || present.has(mode));
  });

  function setMode(mode: Mode) {
    app.mode = mode;
    app.writeUrl();
    app.refresh();
  }
</script>

<header class="topbar">
  <a class="brand" href={snapshot ? '#routes' : './'} aria-label={snapshot ? 'Transit Almanac route scorecard' : 'Transit Almanac home'}>Transit Almanac</a>
  <div class="selectors">
    {#if snapshot}
      <span class="fixed-scope">Chicago Transit Authority · Bus</span>
      {#if requestedDates.length}
        <span class="fixed-dates">
          <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12v12H4zM4 8h12M7 3v4m6-4v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <strong>{datesLabel(requestedDates.map(dateNumber))}</strong>
          <span>{plural(requestedDates.length, 'weekday')}</span>
        </span>
      {/if}
    {:else}
      <AgencyPicker />
      <DatePicker />
      {#if availableModes.length > 2}
        <div class="seg" role="group" aria-label="Transit mode">
          {#each availableModes as mode}
            <button aria-pressed={app.mode === mode} onclick={() => setMode(mode)}>{mode}</button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
  <div class="status" aria-live="polite">
    {#if snapshot}
      <span class="fine">Historical snapshot</span>
    {:else if app.running && app.stage}
      <span class="stage">
        <strong>{app.stage.message}</strong>
        {#if app.stage.dayCount > 1 && app.stage.dayIndex > 0}<span class="fine"> · day {Math.min(app.stage.dayIndex, app.stage.dayCount)} of {app.stage.dayCount}</span>{/if}
        {#if app.stalled}<span class="stalled">No progress for a while. The connection may have stalled. Stop keeps every finished day.</span>{/if}
      </span>
      <button class="btn small" onclick={() => app.stop()}>Stop</button>
    {:else if app.pendingDates.length}
      <span class="fine estimate">
        {#if estimate > 0}Up to {bytes(estimate)} from the archive{/if}
      </span>
      <button class="btn primary" onclick={() => app.analyze()}>
        Analyze {plural(app.pendingDates.length, app.hasResults ? 'more day' : 'day', app.hasResults ? 'more days' : 'days')}
      </button>
    {:else if app.hasResults}
      <span class="fine local"><span class="dot"></span>Analyzed on this device</span>
    {/if}
  </div>
</header>

<style>
  .topbar {
    position: sticky; top: 0; z-index: 30; grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center;
    gap: 8px 16px; min-height: 56px; padding: 9px var(--gutter) 9px 16px; background: var(--paper); border-bottom: 1px solid var(--rule);
  }
  .brand {
    width: calc(var(--rail) - 16px); flex: none; font: 800 21px/1 var(--font-display); text-transform: uppercase;
    letter-spacing: .01em; text-decoration: none; white-space: nowrap;
  }
  .selectors { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
  .fixed-scope { font-size: 13px; font-weight: 650; }
  .fixed-dates { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .fixed-scope + .fixed-dates { margin-left: 5px; padding-left: 13px; border-left: 1px solid var(--rule); }
  .fixed-dates strong { color: var(--ink); font-weight: 600; }
  .status { display: flex; align-items: center; gap: 12px; min-height: 36px; margin-left: auto; }
  .stage { font-size: 13px; }
  .stage strong { font-weight: 600; }
  .stalled { display: block; font-size: 12px; color: var(--danger); }
  .local { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
  @media (max-width: 860px) {
    /* A sticky bar would take a fifth of a phone screen. The report links stay reachable. */
    .topbar { position: relative; padding-left: var(--gutter); }
    .brand { width: auto; flex: 1 1 auto; }
    .status { order: 1; min-height: 0; }
    .selectors { order: 2; flex: 1 1 100%; }
    .fixed-scope + .fixed-dates { margin-left: 0; padding-left: 0; border: 0; }
    .estimate { display: none; }
  }
</style>
