<script lang="ts">
  import {tooltip} from '../lib/tooltip.svelte';

  let element = $state<HTMLDivElement>();
  let left = $state(0);
  let top = $state(0);

  $effect(() => {
    if (!tooltip.rows || !element) return;
    const {offsetWidth: w, offsetHeight: h} = element;
    let x = tooltip.x + 14;
    if (x + w > innerWidth - 8) x = tooltip.x - w - 14;
    let y = tooltip.y - h - 10;
    if (y < 8) y = tooltip.y + 18;
    left = Math.max(8, x);
    top = y;
  });
</script>

{#if tooltip.rows}
  <div class="tip" role="tooltip" bind:this={element} style:left="{left}px" style:top="{top}px">
    {#each tooltip.rows as row}
      {#if row.title}<div class="tip-title">{row.title}</div>{/if}
      {#if row.label !== undefined}<div class="tip-row"><span>{row.label}</span><strong>{row.value}</strong></div>{/if}
      {#if row.note}<div class="tip-note">{row.note}</div>{/if}
    {/each}
  </div>
{/if}
