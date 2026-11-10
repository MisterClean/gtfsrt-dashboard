<script lang="ts">
  // The running analysis in words: what stage, how much of the archive, how long it has
  // taken, which days are done, and a way out. Honest about what it can't know: the byte
  // figure is archive file size by position, not network traffic.
  import {onDestroy} from 'svelte';
  import {bytes} from '../lib/format';
  import {loading} from '../lib/loading.svelte';
  import {DAY_STATUS_LABEL, durationLabel, formatElapsed, type Phase} from '../lib/progress';
  import {app} from '../lib/state.svelte';
  import {dateLabel} from '../lib/format';

  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));

  const progress = $derived(loading.progress);
  const percent = $derived(progress ? Math.round(progress.fraction * 100) : 0);
  const elapsed = $derived(progress ? formatElapsed(now - progress.startedAt) : '0:00');
  const hints: Partial<Record<Phase, string>> = {
    database: 'This is a database that runs inside your browser. The first start can take a few seconds.',
    lookup: 'Finding this agency’s files and schedule in the archive.',
    schedule: 'Reading the timetable so positions can be compared with it.',
    analyze: 'Computing speeds, delays and headways for the day.',
  };
  const hint = $derived(progress?.phase ? hints[progress.phase] : undefined);
  const days = $derived(progress ? Object.entries(progress.days).map(([date, status]) => ({date: Number(date), status})).sort((a, b) => a.date - b.date) : []);

  async function retry() {
    await app.stop();
    for (let waited = 0; app.running && waited < 5000; waited += 100) await new Promise(done => setTimeout(done, 100));
    app.analyze();
  }
</script>

{#if app.running && progress}
  <section class="load" aria-label="Analysis progress">
    <div class="line">
      <strong>{progress.message}</strong>
      {#if progress.dayCount > 1 && progress.dayIndex > 0}<span class="fine"> · day {Math.min(progress.dayIndex, progress.dayCount)} of {progress.dayCount}</span>{/if}
      <span class="spacer"></span>
      <span class="fine num" title="Time since the run started">{elapsed} elapsed</span>
      <button class="btn small" onclick={() => app.stop()}>Cancel</button>
    </div>
    <div class="bar" role="progressbar" aria-label="Analysis progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style:width="{percent}%"></span></div>
    <div class="meta fine">
      <span class="num">{percent}%</span>
      {#if progress.bytesTotal}
        <span title="Archive file sizes by position in each file. What is actually downloaded is usually less.">
          about {bytes(Math.min(progress.bytesDone ?? 0, progress.bytesTotal))} of {bytes(progress.bytesTotal)} of archive files
        </span>
      {/if}
      {#if hint}<span>{hint}</span>{/if}
    </div>
    {#if days.length > 1}
      <ul class="days" aria-label="Days in this run">
        {#each days as day}
          <li class={day.status}><span class="name">{dateLabel(String(day.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), {month: 'short', day: 'numeric'})}</span> {DAY_STATUS_LABEL[day.status]}</li>
        {/each}
      </ul>
    {/if}
    {#if app.stalled}
      <p class="stalled" role="alert">
        No progress for a while. The connection may have stalled.
        <button class="btn small" onclick={retry}>Stop and retry</button>
        Finished days are kept.
      </p>
    {/if}
    {#if progress.bytesTotal && progress.bytesTotal > 500e6}
      <p class="fine">This is a large feed. The page stays usable, but the analysis can take a minute or more.</p>
    {/if}
  </section>
{/if}

<style>
  .load { display: grid; gap: 6px; margin: 12px var(--gutter) 0; padding: 10px 14px; border: 1px solid var(--rule); border-left: 3px solid var(--copper); background: var(--paper); border-radius: 4px; }
  .line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; }
  .line strong { font-weight: 600; }
  .spacer { flex: 1 1 auto; }
  .bar { height: 4px; background: var(--rule); border-radius: 2px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--copper); transition: width 300ms ease-out; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .num { font-variant-numeric: tabular-nums; }
  .days { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 2px 0 0; padding: 0; list-style: none; font-size: 12px; }
  .days li { padding: 1px 8px; border: 1px solid var(--rule); border-radius: 10px; color: var(--muted, inherit); }
  .days li .name { font-weight: 600; }
  .days li.done, .days li.cached { border-color: var(--green); }
  .days li.reading, .days li.analyzing { border-color: var(--copper); }
  .days li.no_data { border-style: dashed; }
  .stalled { margin: 0; font-size: 12px; color: var(--danger); }
</style>
