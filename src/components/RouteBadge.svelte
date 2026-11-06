<script lang="ts">
  // Agencies publish route colors. Fall back to ink when they don't, or when the
  // published pair is unreadable.
  let {label, color = '', textColor = ''}: {label: string; color?: string; textColor?: string} = $props();
  const valid = (hex: string) => /^[0-9a-fA-F]{6}$/.test(hex);
  const usable = $derived(valid(color) && valid(textColor) && color.toLowerCase() !== textColor.toLowerCase());
</script>

{#if usable}
  <span class="route-badge" style:background="#{color}" style:color="#{textColor}">{label}</span>
{:else}
  <span class="route-badge">{label}</span>
{/if}
