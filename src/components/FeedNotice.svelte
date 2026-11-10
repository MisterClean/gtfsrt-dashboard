<script lang="ts">
  // Pre-flight notice for the selected agency: why it is limited, and, when the
  // feed stopped long ago, an offer of its latest day instead of a silent pick.
  import {dateLabel} from '../lib/format';
  import {feedId, STATUS_BADGE} from '../lib/health';
  import {app} from '../lib/state.svelte';

  const health = $derived(app.feedHealth);
  const limited = $derived(health && health.status !== 'ok');
  const latest = $derived(app.stale?.stale ? app.stale.latest_day : null);
</script>

{#if app.feed && (limited || latest || health?.note)}
  <div class="notice">
    <div class="banner caution" role="status">
      {#if health && (limited || health.note)}
        <span>{#if limited}<strong>{STATUS_BADGE[health.status]}.</strong> {health.reason}.{/if}{#if health.note} {health.note}{/if}</span>
      {/if}
      {#if latest}
        <span>
          No data near today: the newest day is {dateLabel(latest, {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'})}.
          {#if app.dates.length !== 1 || app.dates[0] !== Number(latest.replaceAll('-', ''))}
            <button class="link-btn" onclick={() => app.useLatestDay()}>Use {dateLabel(latest, {month: 'short', day: 'numeric'})}</button>
          {/if}
        </span>
      {/if}
      <span class="fine id">Feed id {feedId(app.feed)}</span>
    </div>
  </div>
{/if}

<style>
  .notice { padding: 12px var(--gutter) 0; }
  .id { margin-left: auto; font-family: var(--font-mono); }
</style>
