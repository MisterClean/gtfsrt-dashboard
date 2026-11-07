<script lang="ts">
  import type {Mode} from '../engine/types';
  import type {Units} from '../lib/format';
  import {CLASS_VARS, classLabels} from '../lib/speed-scale';

  let {mode, units}: {mode: Mode; units: Units} = $props();
  const scale = $derived(classLabels(mode, units));
</script>

<div class="legend" aria-label="Speed colors">
  <span class="key"><strong>{scale.unit}</strong></span>
  {#each scale.labels as label, i}
    <span class="key"><span class="swatch" style:background="var({CLASS_VARS[i]})"></span>{label}</span>
  {/each}
</div>
