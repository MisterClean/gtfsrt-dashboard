<script lang="ts">
  // What the last run left behind, said once and in one place: a failure with the days
  // it did not finish, a stop with what was kept, and days the archive has nothing for.
  // Each offers the one action that follows from it.
  import ErrorNotice from './ErrorNotice.svelte';
  import {dateLabel, plural} from '../lib/format';
  import {app} from '../lib/state.svelte';

  const short = (date: number) => dateLabel(String(date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), {month: 'short', day: 'numeric'});
  const list = (dates: number[]) => (dates.length > 6 ? `${dates.slice(0, 5).map(short).join(', ')} and ${dates.length - 5} more` : dates.map(short).join(', '));
  const kept = (finished: number) =>
    finished > 0 ? `${plural(finished, 'day')} finished and ${finished === 1 ? 'is' : 'are'} kept.` : 'No day had finished, so nothing new was kept.';

  const run = $derived(app.run);
  const noData = $derived(app.dates.filter(date => date in app.unavailableDates));
</script>

{#if run.phase === 'failed'}
  <div class="notice" data-run="failed">
    <ErrorNotice
      failure={run.failure}
      extra={`Not finished: ${list(run.left)}.`}
      retryLabel={`Try ${run.left.length === 1 ? 'that day' : `those ${run.left.length} days`} again`}
      onretry={() => app.analyze(run.left)}
      ondismiss={() => app.dismissRun()}
    />
  </div>
{:else if run.phase === 'stopped'}
  <div class="notice" data-run="stopped">
    <div class="banner" role="status">
      <span><strong>Stopped.</strong> {kept(run.finished)} Still to do: {list(run.left)}.</span>
      <button class="btn small" onclick={() => app.analyze(run.left)}>Continue with {run.left.length === 1 ? 'that day' : `those ${run.left.length} days`}</button>
      <button class="btn small quiet" onclick={() => app.dismissRun()}>Dismiss</button>
    </div>
  </div>
{/if}
{#if noData.length}
  <div class="notice" data-run="no-data">
    <div class="banner caution" role="status">
      <span>
        {#each noData as date}{app.unavailableDates[date]}{' '}{/each}
        {noData.length === 1 ? 'It is' : 'They are'} left out of every figure.
      </span>
      <button class="btn small" disabled={app.running} onclick={() => app.recheck()}>Check the archive again</button>
    </div>
  </div>
{/if}

<style>
  .notice { padding: 12px var(--gutter) 0; }
</style>
