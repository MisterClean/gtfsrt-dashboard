<script lang="ts" module>
  export interface Column<R> {
    key: string;
    label: string;
    title?: string;
    left?: boolean;
    wrap?: boolean;
    /** One line, cut with an ellipsis, so one long cell can't set the row height. */
    clip?: boolean;
    /** The full text of a clipped cell. */
    hint?: (row: R) => string;
    /** The CSV heading, when it needs a unit the table shows another way. */
    csvLabel?: string;
    /** The value used to sort, and the CSV cell unless `csv` is given. */
    value: (row: R) => number | string | null | undefined;
    format?: (row: R) => string;
    csv?: (row: R) => unknown;
    cell?: Snippet<[R]>;
    /** Sort high to low on the first click. */
    descending?: boolean;
    noSort?: boolean;
  }
</script>

<script lang="ts" generics="T">
  // A sortable table with CSV export. Numbers sort by value; missing values sort last.
  import type {Snippet} from 'svelte';
  import {downloadCsv} from '../lib/download';



  interface Props {
    columns: Column<T>[];
    rows: T[];
    defaultSort?: string;
    defaultDescending?: boolean;
    limit?: number;
    onrow?: (row: T) => void;
    filename?: string;
    caption: string;
    search?: (row: T) => string;
    placeholder?: string;
    maxHeight?: string;
  }
  let {
    columns,
    rows,
    defaultSort,
    defaultDescending = false,
    limit = 0,
    onrow,
    filename,
    caption,
    search,
    placeholder = 'Filter…',
    maxHeight,
  }: Props = $props();

  let sortKey = $state<string | undefined>(undefined);
  let descending = $state(false);
  let query = $state('');
  let showAll = $state(false);
  $effect.pre(() => {
    if (sortKey === undefined) {
      sortKey = defaultSort;
      descending = defaultDescending;
    }
  });

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return needle && search ? rows.filter(row => search(row).toLowerCase().includes(needle)) : rows;
  });
  const sorted = $derived.by(() => {
    const column = columns.find(c => c.key === sortKey);
    if (!column) return filtered;
    const direction = descending ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const x = column.value(a);
      const y = column.value(b);
      const missingX = x === null || x === undefined;
      const missingY = y === null || y === undefined;
      if (missingX || missingY) return Number(missingX) - Number(missingY);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * direction;
      return String(x).localeCompare(String(y), undefined, {numeric: true}) * direction;
    });
  });
  const visible = $derived(limit && !showAll ? sorted.slice(0, limit) : sorted);

  function setSort(column: Column<T>) {
    if (sortKey === column.key) descending = !descending;
    else {
      sortKey = column.key;
      descending = column.descending ?? false;
    }
  }

  function exportCsv() {
    if (!filename) return;
    downloadCsv(filename, columns.map(c => ({label: c.csvLabel ?? c.label, value: c.csv ?? c.value})), sorted);
  }
</script>

{#if search || filename}
  <div class="tools table-tools">
    {#if search}
      <input class="input" type="search" {placeholder} aria-label={placeholder} bind:value={query} />
    {/if}
    <span class="fine">{filtered.length.toLocaleString('en-US')} {filtered.length === 1 ? 'row' : 'rows'}</span>
    {#if filename}<button class="btn small quiet" onclick={exportCsv}>Download CSV</button>{/if}
  </div>
{/if}
<div class="table-wrap" tabindex="0" role="region" aria-label={caption} style:max-height={!limit || showAll ? maxHeight : undefined}>
  <table class="data">
    <caption class="sr-only">{caption}</caption>
    <thead>
      <tr>
        {#each columns as column}
          <th
            class:left={column.left}
            scope="col"
            title={column.title}
            aria-sort={sortKey === column.key ? (descending ? 'descending' : 'ascending') : undefined}
          >
            {#if column.noSort}
              {column.label}
            {:else}
              <button onclick={() => setSort(column)}>
                {column.label}
                {#if sortKey === column.key}
                  <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                    <path d={descending ? 'M1 3l4 5 4-5' : 'M1 7l4-5 4 5'} fill="none" stroke="currentColor" stroke-width="1.6" />
                  </svg>
                {/if}
              </button>
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if !visible.length}
        <tr><td class="left empty-row" colspan={columns.length}>{query.trim() ? 'Nothing matches that filter.' : 'Nothing to show for this selection.'}</td></tr>
      {/if}
      {#each visible as row}
        <tr class:clickable={!!onrow} onclick={() => onrow?.(row)}>
          {#each columns as column}
            <td class:left={column.left} class:wrap={column.wrap} class:clip={column.clip} title={column.hint?.(row)}>
              {#if column.cell}{@render column.cell(row)}{:else}{column.format ? column.format(row) : (column.value(row) ?? '—')}{/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
{#if limit && sorted.length > limit}
  <button class="link-btn more" onclick={() => (showAll = !showAll)}>
    {showAll ? `Show first ${limit}` : `Show all ${sorted.length.toLocaleString('en-US')}`}
  </button>
{/if}

<style>
  .table-tools { justify-content: flex-end; }
  .table-tools input { width: min(260px, 100%); height: 30px; font-size: 12.5px; margin-right: auto; }
  .more { justify-self: start; font-size: 13px; }
  .empty-row { color: var(--muted); padding: 16px 10px; white-space: normal; }
</style>
