<script lang="ts">
  import Methods from '../charts/data/Methods.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import {dateLabel, dateNumber, datesLabel, pct, plural} from '../lib/format';
  import type {SnapshotManifest} from '../lib/snapshot';

  let {manifest}: {manifest: SnapshotManifest} = $props();
  const publishedDays = $derived(new Map(manifest.overview.days.map(day => [day.date, day])));
  const days = $derived(manifest.requestedDates.map(date => {
    const day = publishedDays.get(date);
    return {
      date,
      coverage: day?.status === 'Complete' ? 'Complete' : day?.status === 'Partial' ? 'Partial' : 'Unavailable',
      match: day?.trip_match ?? null,
      notes: day?.warnings.join(' ') ?? '',
    };
  }));
  const complete = $derived(days.filter(day => day.coverage === 'Complete').length);
  const partial = $derived(days.filter(day => day.coverage === 'Partial').length);
  type CoverageDay = (typeof days)[number];
  const columns: Column<CoverageDay>[] = [
    {key: 'date', label: 'Service day', left: true, value: day => day.date, format: day => dateLabel(day.date)},
    {key: 'coverage', label: 'Coverage', left: true, value: day => day.coverage},
    {key: 'match', label: 'Position reports matched', title: 'Share of eligible archived position reports assigned to an active scheduled trip', value: day => day.match, format: day => pct(day.match, 1)},
    {key: 'notes', label: 'Notes', left: true, wrap: true, value: day => day.notes || null},
  ];
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Data &amp; methods</h1>
      <p class="lede">CTA bus service on {plural(manifest.requestedDates.length, 'weekday')} from {datesLabel(manifest.requestedDates.map(dateNumber))}. All dates and hours use Chicago local service time.</p>
    </div>
  </div>

  <section class="section" aria-labelledby="coverage-heading">
    <div class="section-head">
      <div>
        <h2 id="coverage-heading">Archive coverage</h2>
        <p class="note">{complete} complete, {partial} partial and {days.length - complete - partial} unavailable. Partial days contribute the observations the archive captured.</p>
      </div>
    </div>
    <DataTable {columns} rows={days} caption="Archive coverage by requested weekday" defaultSort="date" filename="cta-archive-coverage.csv" />
    <p class="note">Position match rates count eligible vehicle reports assigned to an active scheduled trip. For a route, the scorecard uses the lower of its rate across the snapshot and the lowest systemwide daily rate to flag or withhold schedule-based figures.</p>
  </section>

  {#if manifest.sources?.length || manifest.notes?.length}
    <section class="section" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Sources and preparation</h2>
      <p class="note">An independent Transit Almanac analysis of Chicago Transit Authority bus service.</p>
      {#if manifest.sources?.length}
        <ul class="source-list">
          {#each manifest.sources as source}
            <li><a class="link-btn" href={source.url}>{source.label}</a></li>
          {/each}
        </ul>
      {/if}
      {#each manifest.notes ?? [] as note}
        <p class="note">{note}</p>
      {/each}
    </section>
  {/if}

  <section class="section" aria-labelledby="metrics-heading">
    <h2 id="metrics-heading">How the metrics are calculated</h2>
    <Methods />
  </section>
</div>

<style>
  .source-list { padding-left: 20px; }
  .source-list li + li { margin-top: 4px; }
</style>
