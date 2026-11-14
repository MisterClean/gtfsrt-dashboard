<script lang="ts">
  import {hasRouteBadgeContrast} from '../lib/route-badge';

  // Agencies publish route colors. Fall back to ink when they don't, or when the
  // published pair is unreadable.
  let {label, color = '', textColor = ''}: {label: string; color?: string; textColor?: string} = $props();
  const usable = $derived(hasRouteBadgeContrast(color, textColor));
</script>

{#if usable}
  <span class="route-badge" style:background="#{color}" style:color="#{textColor}">{label}</span>
{:else}
  <span class="route-badge">{label}</span>
{/if}
