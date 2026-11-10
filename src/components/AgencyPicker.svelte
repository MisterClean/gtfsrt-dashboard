<script lang="ts">
  // The agency list, grouped by feed health so working feeds come first. Feeds
  // that can only partly be analysed carry a badge and a one-line reason before
  // anyone starts a download. A feed missing from the health file is simply
  // unmarked and fully selectable.
  import {bytes} from '../lib/format';
  import {addIsoDays, feedId, groupOf, shortDate, STATUS_BADGE, type FeedHealth, type HealthGroup} from '../lib/health';
  import {app, feedLabel} from '../lib/state.svelte';
  import type {Feed} from '../engine/types';

  let open = $state(false);
  let root = $state<HTMLElement>();

  const healthOf = (feed: Feed): FeedHealth | null => app.health[feed.base64url] ?? null;
  const groups: {key: HealthGroup; title: string}[] = [
    {key: 'working', title: 'Working'},
    {key: 'limited', title: 'Limited'},
    {key: 'stale', title: 'Out of date or empty'},
  ];

  const hiddenCount = $derived(app.feeds.filter(f => healthOf(f)?.hidden && f.base64url !== app.feedKey).length);
  const visible = $derived(app.feeds.filter(f => app.showAllFeeds || !healthOf(f)?.hidden || f.base64url === app.feedKey));
  const sections = $derived(groups
    .map(group => ({...group, feeds: visible.filter(f => (groupOf(healthOf(f)?.status ?? null) === 'unknown' ? 'working' : groupOf(healthOf(f)?.status ?? null)) === group.key)}))
    .filter(group => group.feeds.length));
  // With no health data at all there is nothing to group by.
  const grouped = $derived(Object.keys(app.health).length > 0);

  function choose(feed: Feed) {
    open = false;
    if (feed.base64url !== app.feedKey) app.selectFeed(feed.base64url, null);
  }
  function outside(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }
  const selected = $derived(app.feed);
  const selectedHealth = $derived(selected ? healthOf(selected) : null);
  /** Secondary text: the feed id for bug reports, then size and last day. */
  function meta(feed: Feed, health: FeedHealth | null) {
    const parts = [feedId(feed)];
    if (health?.large) parts.push(`large, about ${bytes(health.approx_bytes_per_day)} a day`);
    if (health && health.status !== 'stale' && health.status !== 'empty') parts.push(`to ${shortDate(addIsoDays(feed.date_max, -1))}`);
    return parts.join(' \u00b7 ');
  }
  const badge = (h: FeedHealth | null) => (h && h.status !== 'ok' ? STATUS_BADGE[h.status] : '');
</script>

<svelte:window onpointerdown={outside} onkeydown={event => { if (event.key === 'Escape') open = false; }} />

<div class="agency" bind:this={root}>
  <button
    class="input trigger" aria-haspopup="dialog" aria-expanded={open} disabled={!app.feeds.length}
    title={selected ? `Feed id: ${feedId(selected)}` : undefined} onclick={() => (open = !open)}
  >
    <span class="name">{selected ? feedLabel(selected) : 'Loading agencies…'}</span>
    {#if badge(selectedHealth)}<span class="badge {selectedHealth?.status}">{badge(selectedHealth)}</span>{/if}
    <svg width="10" height="10" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>
  </button>
  {#if open}
    <div class="panel" role="dialog" aria-label="Choose a transit agency">
      {#each sections as section}
        <section>
          {#if grouped}<h3>{section.title}</h3>{/if}
          <ul>
            {#each section.feeds as feed (feed.base64url)}
              {@const health = healthOf(feed)}
              <li>
                <button class="row" class:current={feed.base64url === app.feedKey} aria-current={feed.base64url === app.feedKey ? 'true' : undefined} onclick={() => choose(feed)}>
                  <span class="line">
                    <span class="name">{feedLabel(feed)}</span>
                    {#if badge(health)}<span class="badge {health?.status}">{badge(health)}</span>{/if}
                  </span>
                  {#if health?.reason}<span class="reason">{health.reason}</span>{/if}
                  <span class="meta">{meta(feed, health)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if hiddenCount || app.showAllFeeds}
        <label class="all">
          <input type="checkbox" bind:checked={app.showAllFeeds} />
          Show all agencies{#if hiddenCount && !app.showAllFeeds} ({hiddenCount} hidden: no data){/if}
        </label>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agency { position: relative; min-width: 0; flex: 0 1 340px; }
  .trigger {
    width: min(340px, 100%); display: flex; align-items: center; gap: 8px; font-weight: 550; text-align: left; cursor: pointer;
  }
  .trigger .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel {
    position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; width: min(420px, 92vw); max-height: min(70vh, 640px); overflow-y: auto;
    background: var(--paper); border: 1px solid var(--rule-strong); border-radius: 6px; box-shadow: var(--shadow-pop); padding: 4px 0 0;
  }
  h3 { margin: 0; padding: 10px 14px 4px; font: 650 11px/1 var(--font-body); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0 6px; }
  .row {
    width: 100%; display: grid; gap: 1px; padding: 6px 8px; border: 0; border-radius: 4px; background: none; text-align: left; font-size: 13px;
  }
  .row:hover { background: var(--surface); }
  .row.current { background: var(--surface-2); }
  .line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .line .name { font-weight: 550; min-width: 0; }
  .reason { font-size: 12px; color: var(--ink); }
  .meta { font: 11px/1.3 var(--font-mono); color: var(--faint); overflow-wrap: anywhere; }
  .badge {
    flex: none; padding: 1px 6px; border-radius: 3px; font-size: 10.5px; font-weight: 650; letter-spacing: .02em;
    background: var(--caution-pale); color: var(--caution-ink);
  }
  .badge.stale, .badge.empty { background: var(--danger-pale); color: var(--danger); }
  .all {
    position: sticky; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 10px 14px; margin-top: 4px;
    border-top: 1px solid var(--rule); background: var(--paper); font-size: 12.5px; color: var(--muted);
  }
</style>
