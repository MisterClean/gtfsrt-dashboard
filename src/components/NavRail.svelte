<script lang="ts">
  import {app, type View} from '../lib/state.svelte';

  const items: {view: View; label: string; icon: string}[] = [
    {view: 'overview', label: 'Overview', icon: 'M3 16.5V10m4.7 6.5V4m4.6 12.5V8m4.7 8.5v-5'},
    {view: 'map', label: 'Speed map', icon: 'M7 3.5L3 5.5v11l4-2 6 2 4-2v-11l-4 2-6-2zM7 3.5v11M13 5.5v11'},
    {view: 'hotspots', label: 'Delay hotspots', icon: 'M10 17.5s5.5-5 5.5-9.5a5.5 5.5 0 10-11 0c0 4.5 5.5 9.5 5.5 9.5zM10 10a2 2 0 100-4 2 2 0 000 4z'},
    {view: 'routes', label: 'Routes', icon: 'M5 16.5a2 2 0 100-4 2 2 0 000 4zm0-4V7.5a3 3 0 013-3h4a3 3 0 010 6H8a3 3 0 000 6h4M15 18l2-2-2-2'},
    {view: 'reliability', label: 'Reliability', icon: 'M10 18a8 8 0 100-16 8 8 0 000 16zM10 5.5V10l3 2'},
    {view: 'stops', label: 'Stops', icon: 'M6 3.5h8a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 13V5A1.5 1.5 0 016 3.5zM4.5 10h11M7 17.5h.01M13 17.5h.01'},
    {view: 'data', label: 'Data & methods', icon: 'M4 5.5C4 4.1 6.7 3 10 3s6 1.1 6 2.5S13.3 8 10 8 4 6.9 4 5.5zM4 5.5v9C4 15.9 6.7 17 10 17s6-1.1 6-2.5v-9M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5'},
  ];
  const active = (view: View) => app.view === view || (view === 'routes' && app.view === 'route');
</script>

<nav class="rail" aria-label="Reports">
  <ul>
    {#each items as item}
      <li>
        <button class:active={active(item.view)} aria-current={active(item.view) ? 'page' : undefined} onclick={() => app.go(item.view)}>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d={item.icon} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {item.label}
        </button>
      </li>
    {/each}
  </ul>
  <div class="prefs">
    <div class="seg" role="group" aria-label="Units">
      <button aria-pressed={app.units === 'imperial'} onclick={() => app.setUnits('imperial')}>mph</button>
      <button aria-pressed={app.units === 'metric'} onclick={() => app.setUnits('metric')}>km/h</button>
    </div>
    <div class="seg" role="group" aria-label="Color theme">
      <button aria-pressed={app.theme === 'light'} aria-label="Light theme" onclick={() => app.setTheme('light')}>
        <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <button aria-pressed={app.theme === 'auto'} onclick={() => app.setTheme('auto')}>Auto</button>
      <button aria-pressed={app.theme === 'dark'} aria-label="Dark theme" onclick={() => app.setTheme('dark')}>
        <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 12.2A7 7 0 017.8 3.5a7 7 0 108.7 8.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <p class="fine">No account, upload or query server. Your browser reads the public archive directly and does the analysis itself.</p>
  </div>
</nav>

<style>
  .rail {
    position: sticky; top: 57px; align-self: start; height: calc(100dvh - 57px); display: flex; flex-direction: column;
    justify-content: space-between; gap: 16px; padding: 14px 8px 16px; border-right: 1px solid var(--rule); overflow-y: auto;
  }
  ul { list-style: none; display: grid; gap: 1px; }
  li button {
    width: 100%; display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 4px 8px; border: 0; border-radius: 4px;
    background: none; color: var(--muted); font-size: 13.5px; font-weight: 500; text-align: left;
    transition: background-color 120ms ease-out, color 120ms ease-out;
  }
  li button:hover { background: var(--surface); color: var(--ink); }
  li button.active { background: var(--surface); color: var(--ink); font-weight: 650; }
  li button.active svg { color: var(--copper); }
  .prefs { display: grid; gap: 8px; padding: 0 8px; justify-items: start; }
  .prefs .seg button { min-height: 24px; padding: 1px 7px; font-size: 11.5px; display: inline-flex; align-items: center; }
  .prefs p { line-height: 1.4; font-size: 11.5px; }
  @media (max-width: 860px) {
    .rail { top: 0; z-index: 25; height: auto; background: var(--paper); border-right: 0; border-bottom: 1px solid var(--rule); padding: 4px var(--gutter); overflow-x: auto; }
    ul { display: flex; gap: 2px; }
    li button { white-space: nowrap; padding: 4px 8px; }
    li button svg { display: none; }
    .prefs { display: none; }
  }
</style>
