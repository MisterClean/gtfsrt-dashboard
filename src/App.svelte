<script lang="ts">
  import {onMount} from 'svelte';
  import FeedNotice from './components/FeedNotice.svelte';
  import NavRail from './components/NavRail.svelte';
  import Tooltip from './components/Tooltip.svelte';
  import TopBar from './components/TopBar.svelte';
  import ErrorNotice from './components/ErrorNotice.svelte';
  import LoadHeadsUp from './components/LoadHeadsUp.svelte';
  import LoadProgress from './components/LoadProgress.svelte';
  import RunNotice from './components/RunNotice.svelte';
  import {BOOT_MESSAGE, bootWords} from './lib/startup';
  import {app, errorText, feedLabel} from './lib/state.svelte';
  import {SnapshotClient} from './lib/snapshot';
  import {dateLabel, plural} from './lib/format';
  import Overview from './views/Overview.svelte';
  import MapView from './views/MapView.svelte';
  import Routes from './views/Routes.svelte';
  import RouteDetailView from './views/RouteDetail.svelte';
  import Reliability from './views/Reliability.svelte';
  import Stops from './views/Stops.svelte';
  import Hotspots from './views/Hotspots.svelte';
  import DataView from './views/Data.svelte';
  import SnapshotData from './views/SnapshotData.svelte';

  let {snapshot = null}: {snapshot?: string | null} = $props();
  let snapshotError = $state<string | null>(null);

  async function startSnapshot() {
    if (!snapshot) return;
    snapshotError = null;
    try {
      app.openSnapshot(await SnapshotClient.open(new URL(snapshot, document.baseURI)));
    } catch (error) {
      snapshotError = errorText(error);
    }
  }

  onMount(() => {
    if (snapshot) {
      const onHashChange = () => app.readSnapshotUrl();
      addEventListener('hashchange', onHashChange);
      void startSnapshot();
      return () => removeEventListener('hashchange', onHashChange);
    }
    app.start();
    // Automated browser tests read results here. Regular visits don't get the hook.
    if (navigator.webdriver) (window as any).__transit = app;
  });

  const label = $derived(app.feed ? feedLabel(app.feed) : '');
  // One note per distinct message, naming the days when it doesn't apply to all of them.
  const notes = $derived.by(() => {
    const byMessage = new Map<string, string[]>();
    for (const day of app.overview?.days ?? []) {
      for (const warning of day.warnings) byMessage.set(warning, [...(byMessage.get(warning) ?? []), day.date]);
    }
    const total = app.overview?.days.length ?? 0;
    const fromDays = [...byMessage].map(([warning, dates]) =>
      dates.length === total || /^\d{4}-\d{2}-\d{2}:/.test(warning) ? warning : `${dates.map(date => dateLabel(date, {month: 'short', day: 'numeric'})).join(', ')}: ${warning}`,
    );
    return [...new Set([...app.warnings, ...fromDays])];
  });
</script>

<svelte:head>
  <title>{snapshot ? 'CTA Bus Route Scorecard · Transit Almanac' : label ? `${label} · Transit Almanac` : 'Transit Almanac'}</title>
</svelte:head>

<div class="shell">
  <TopBar snapshot={!!snapshot} />
  <NavRail snapshot={!!snapshot} />
  <main id="main">
    {#if !snapshot}
      {#if app.boot.step === 'failed'}
        <div class="page"><ErrorNotice failure={app.boot.failure} words={bootWords(app.boot)} onretry={() => app.start()} /></div>
      {/if}
      <LoadProgress />
      <FeedNotice />
      <RunNotice />
      {#if app.cacheNotice}
        <div class="notice"><div class="banner caution" role="status">{app.cacheNotice}</div></div>
      {/if}
      <LoadHeadsUp />
      {#if app.reportError}
        <div class="notice"><div class="banner error" role="alert"><strong>This report could not be updated, so what's on screen may be out of date.</strong> {app.reportError}</div></div>
      {/if}
      {#each notes as warning}
        <div class="notice"><div class="banner caution" role="status">{warning}</div></div>
      {/each}
    {/if}

    {#if snapshot}
      {#if snapshotError}
        <div class="page">
          <h1>Route scorecard</h1>
          <p class="banner error" role="alert"><strong>The CTA snapshot could not be opened.</strong> {snapshotError}</p>
          <div class="tools"><button class="btn" onclick={startSnapshot}>Retry</button></div>
        </div>
      {:else if !app.snapshot}
        <div class="page">
          <div class="page-head">
            <div><h1>Route scorecard</h1><p class="lede" role="status">Loading the CTA bus snapshot…</p></div>
          </div>
        </div>
      {:else if app.view === 'data'}
        <SnapshotData manifest={app.snapshot.manifest} />
      {:else if !app.hasResults}
        <div class="page">
          <h1>Route scorecard</h1>
          <p class="banner caution" role="status">No service days could be analyzed in this snapshot. See <button class="link-btn" onclick={() => app.go('data')}>Data &amp; methods</button> for coverage.</p>
        </div>
      {:else if app.view === 'route'}
        <RouteDetailView />
      {:else}
        <Routes />
      {/if}
    {:else if app.view === 'data'}
      <DataView />
    {:else if !app.hasResults}
      <div class="page start">
        <div class="start-copy">
          <h1>{label || 'Transit performance, on your device'}</h1>
          {#if app.running}
            <p class="lede">The first results appear as soon as the first day is finished, and they refine as each day is added. You can keep reading while it works.</p>
          {:else if app.feed && app.boot.step === 'ready'}
            <p class="lede">See how this system really ran: speeds street by street and hour by hour, on-time performance, headways, bunching, run times and stop spacing, all from archived vehicle positions and the schedule in force on each day.</p>
            <p class="lede">Your browser reads the public archive directly and does the analysis itself. There is no account, no upload and no query server. Results stay on this device, so a day only has to be analyzed once.</p>
            <div class="tools">
              <button class="btn primary big" disabled={!app.dates.length} onclick={() => app.analyze()}>Analyze {plural(app.pendingDates.length, 'day')}</button>
              <span class="fine">Choose another agency or other days above.</span>
            </div>
          {:else if app.boot.step !== 'failed' && app.boot.step !== 'ready'}
            <p class="lede" role="status" data-boot={app.boot.step}>{BOOT_MESSAGE[app.boot.step]}</p>
          {/if}
        </div>
      </div>
    {:else if app.view === 'overview'}
      <Overview />
    {:else if app.view === 'map'}
      <MapView />
    {:else if app.view === 'routes'}
      <Routes />
    {:else if app.view === 'route'}
      <RouteDetailView />
    {:else if app.view === 'reliability'}
      <Reliability />
    {:else if app.view === 'stops'}
      <Stops />
    {:else if app.view === 'hotspots'}
      <Hotspots />
    {/if}
  </main>
</div>
<Tooltip />

<style>
  .shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); grid-template-rows: auto 1fr; min-height: 100dvh; }
  main { min-width: 0; }
  .notice { padding: 12px var(--gutter) 0; }
  .start { max-width: 760px; padding-top: 72px; }
  .start-copy { display: grid; gap: 14px; }
  .start h1 { font-size: 44px; }
  .big { min-height: 44px; padding: 8px 20px; font-size: 14px; }
  @media (max-width: 860px) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    .start { padding-top: 32px; }
    .start h1 { font-size: 34px; }
  }
</style>
