<script lang="ts">
  // Before a big download, say so: roughly how much and how long, from the catalog's
  // own sizes. Silent for small loads, which are the common case.
  import {bytes} from '../lib/format';
  import {durationLabel, estimateLoad} from '../lib/progress';
  import {app} from '../lib/state.svelte';

  const estimate = $derived(app.feed ? estimateLoad(app.feed, app.uncachedDates.filter(d => app.pendingDates.includes(d))) : null);
</script>

{#if !app.running && estimate && estimate.level !== 'small'}
  <div class="notice">
    <div class="banner caution" role="status">
      <strong>{estimate.level === 'huge' ? 'This is a very large download.' : 'This is a large download.'}</strong>
      Up to {bytes(estimate.bytes)} of archive files for {app.pendingDates.length === 1 ? 'this day' : `these ${app.pendingDates.length} days`}, so expect {durationLabel(estimate.seconds)}.
      It runs in the background and you can cancel any time, but the page may feel slower. Fewer days finish sooner, and finished days stay on this device.
    </div>
  </div>
{/if}

<style>
  .notice { padding: 12px var(--gutter) 0; }
</style>
