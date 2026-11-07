<script lang="ts">
  // A figure or chart name that opens the exact definition behind it, so every number
  // can be traced to its method by mouse, keyboard or touch.
  import type {Snippet} from 'svelte';
  import {app, type MethodTopic} from '../lib/state.svelte';

  let {topic, children}: {topic: MethodTopic; children: Snippet} = $props();
</script>

<button class="term" title="How this is calculated" onclick={() => app.showMethod(topic)}>{@render children()}</button>

<style>
  .term {
    all: unset; cursor: pointer; text-decoration: underline dotted var(--rule-strong) 1px; text-underline-offset: 3px;
    transition: color 120ms ease-out;
  }
  .term:hover { color: var(--copper); text-decoration-color: currentColor; }
  .term:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
</style>
