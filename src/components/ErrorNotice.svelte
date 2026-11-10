<script lang="ts">
  // A failure in plain language: what happened, what to do, a retry, and the technical
  // text behind a disclosure for bug reports.
  import {errorDetails, friendlyError, type EngineError} from '../engine/errors';

  let {failure, onretry, extra = ''}: {failure: EngineError; onretry?: () => void; extra?: string} = $props();

  const friendly = $derived(friendlyError(failure));
  const details = $derived(errorDetails(failure));
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(details);
      copied = true;
    } catch (error) {
      console.warn('[transit-almanac] could not copy the error details', error);
      copied = false;
    }
  }
</script>

<div class="banner error" role="alert">
  <strong>{friendly.title}</strong>
  {friendly.advice}{extra ? ` ${extra}` : ''}
  {#if onretry && friendly.retryable}
    <button class="btn small" onclick={onretry}>Try again</button>
  {/if}
  {#if failure.kind === 'engine_crash'}
    <button class="btn small" onclick={() => location.reload()}>Reload</button>
  {/if}
  <details>
    <summary>Details</summary>
    <pre>{details}</pre>
    <button class="btn small" onclick={copy}>{copied ? 'Copied' : 'Copy details'}</button>
  </details>
</div>

<style>
  details { margin-top: 6px; font-size: 12px; }
  summary { cursor: pointer; }
  pre { max-height: 180px; overflow: auto; margin: 6px 0; padding: 8px; white-space: pre-wrap; word-break: break-word; font: 11px/1.4 var(--font-mono, monospace); background: var(--rule); border-radius: 3px; }
</style>
