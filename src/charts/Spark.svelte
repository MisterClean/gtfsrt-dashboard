<script lang="ts">
  // A route's speed from 5 AM to 11 PM inside a table row.
  import {PEAKS, linePath, linear} from '../lib/scale';

  let {values, min, max, label}: {values: (number | null)[]; min: number; max: number; label: string} = $props();
  const width = 112;
  const height = 26;
  const first = 5;
  const last = 23;
  const x = linear([first, last + 1], [0, width]);
  const y = $derived(linear([min, max], [height - 2, 2]));
  const d = $derived(
    linePath(
      Array.from({length: last - first + 1}, (_, i) => {
        const value = values[first + i];
        return value === null || value === undefined ? null : ([x(first + i + 0.5), y(value)] as const);
      }),
    ),
  );
</script>

<svg class="spark" viewBox="0 0 {width} {height}" width={width} height={height} role="img" aria-label={label}>
  {#each PEAKS as [a, b]}
    <rect x={x(a)} y="0" width={x(b) - x(a)} height={height} fill="var(--orange)" opacity=".1" />
  {/each}
  <path {d} fill="none" stroke="var(--ink)" stroke-width="1.25" stroke-linejoin="round" />
</svg>

<style>
  .spark { display: block; margin-left: auto; }
</style>
