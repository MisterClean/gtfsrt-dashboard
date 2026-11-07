<script lang="ts">
  // Where a skeptical reader decides whether to trust the numbers. Works before any
  // analysis too, because what the app does with data should be readable up front.
  import Methods from '../charts/data/Methods.svelte';
  import PollGrid from '../charts/data/PollGrid.svelte';
  import QualityTable from '../charts/data/QualityTable.svelte';
  import {THRESHOLDS} from '../charts/data/thresholds';
  import type {ReadRecord} from '../engine/types';
  import {downloadFile} from '../lib/download';
  import {bytes, dateLabel, dateNumber, datesLabel, int, isoDate, plural} from '../lib/format';
  import {app, feedLabel, errorText} from '../lib/state.svelte';

  const days = $derived(app.quality?.days ?? []);
  const feed = $derived(app.feed);

  const shortDigest = (key: string) => key.split('+').map(part => part.replace(/^v1:/, '').slice(0, 12)).join(' + ');
  const retrievedDate = (value: string) => dateLabel(value.slice(0, 10), {month: 'short', day: 'numeric', year: 'numeric'});

  /** Versions from the results themselves, so days restored from cache are listed too. */
  const versions = $derived.by(() => {
    const byKey = new Map<string, number[]>();
    for (const day of days) {
      const list = byKey.get(day.digest) ?? [];
      list.push(dateNumber(day.date));
      byKey.set(day.digest, list);
    }
    for (const schedule of app.schedules) {
      if (!byKey.has(schedule.key)) byKey.set(schedule.key, []);
    }
    return [...byKey].map(([key, dates]) => ({key, dates, record: app.schedules.find(s => s.key === key) ?? null}));
  });
  const anyWithoutRecord = $derived(versions.some(version => !version.record));

  const reads = $derived(app.reads);
  const totalRead = $derived(reads.reduce((sum, read) => sum + read.bytes, 0));

  // ---- SQL ------------------------------------------------------------------
  const queries = $derived(reads.filter(read => read.sql));
  let chosenRead = $state<string | null>(null);
  const shownRead = $derived<ReadRecord | undefined>(queries.find(read => read.date === chosenRead) ?? queries[0]);

  // ---- Notes by day ---------------------------------------------------------
  const notes = $derived.by(() => {
    const byText = new Map<string, string[]>();
    for (const day of days) {
      for (const warning of day.warnings) {
        const list = byText.get(warning) ?? [];
        list.push(day.date);
        byText.set(warning, list);
      }
    }
    return [...byText].map(([text, dates]) => ({text, dates}));
  });

  // ---- This device ----------------------------------------------------------
  let confirming = $state<'feed' | 'all' | null>(null);
  let clearing = $state(false);
  let clearFailure = $state<string | null>(null);

  async function clear(all: boolean) {
    clearing = true;
    clearFailure = null;
    try {
      await app.clearCache(all);
    } catch (error) {
      clearFailure = errorText(error);
    } finally {
      clearing = false;
      confirming = null;
    }
  }

  // ---- Provenance -----------------------------------------------------------
  function downloadProvenance() {
    const selection = app.selection();
    const payload = {
      generated_at: new Date().toISOString(),
      feed: feed && {
        base64url: feed.base64url,
        agency_id: feed.agency_id,
        agency_name: feed.agency_name,
        system_id: feed.system_id,
        system_name: feed.system_name,
        catalog_range: [feed.date_min, feed.date_max],
      },
      service_days: app.loadedDates.map(isoDate),
      metric_version: app.quality?.metric_version ?? null,
      sql_engine: app.result?.engineVersion ?? null,
      selection,
      thresholds: THRESHOLDS,
      schedules: versions.map(version => ({
        digest: version.key,
        days: version.dates.map(isoDate),
        retrieved: version.record?.retrieved ?? null,
        published_before: version.record?.published_before ?? null,
        timezone: version.record?.timezone ?? null,
        sources: version.record?.bases ?? null,
      })),
      archive_reads_this_session: reads,
      warnings: app.warnings,
      quality: app.quality,
    };
    const name = app.loadedDates.length
      ? `transit-provenance-${isoDate(app.loadedDates[0])}-to-${isoDate(app.loadedDates[app.loadedDates.length - 1])}.json`
      : 'transit-provenance.json';
    downloadFile(name, JSON.stringify(payload, null, 2), 'application/json');
  }
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Data &amp; methods</h1>
      <p class="lede">What went into these results, what was removed and why, and exactly how each number is calculated.</p>
    </div>
  </div>

  <section class="section" aria-labelledby="analyzed-heading">
    <h2 id="analyzed-heading">What was analyzed</h2>
    {#if feed}
      <dl class="facts">
        <div><dt>Agency and feed</dt><dd>{feedLabel(feed)}</dd></div>
        <div><dt>Service days</dt><dd>{app.loadedDates.length ? `${datesLabel(app.loadedDates)} · ${plural(app.loadedDates.length, 'day')}` : 'None analyzed yet'}{#if app.pendingDates.length}<span class="dim">{' · '}{plural(app.pendingDates.length, app.loadedDates.length ? 'more day' : 'day')} chosen, not analyzed</span>{/if}</dd></div>
        <div><dt>In the archive</dt><dd>{dateLabel(feed.date_min, {month: 'short', day: 'numeric', year: 'numeric'})} to {dateLabel(feed.date_max, {month: 'short', day: 'numeric', year: 'numeric'})} · {int(feed.total_records)} rows · {bytes(feed.total_bytes)}</dd></div>
        <div><dt>Source</dt><dd><a href="https://gtfsrt.io/" target="_blank" rel="noopener noreferrer">gtfsrt.io</a> public GTFS-RT archive, vehicle positions</dd></div>
        {#if app.quality}<div><dt>Calculation version</dt><dd>{app.quality.metric_version}</dd></div>{/if}
        {#if app.result?.engineVersion}<div><dt>Query engine</dt><dd>DuckDB {app.result.engineVersion} in this browser</dd></div>{/if}
      </dl>
    {:else}
      <p class="empty">Loading the archive catalog…</p>
    {/if}

    <h3>Schedule versions</h3>
    {#if versions.length}
      <div class="table-wrap">
        <table class="data">
          <caption class="sr-only">Schedule versions used for each service day</caption>
          <thead>
            <tr>
              <th class="left" scope="col">Version</th>
              <th class="left" scope="col">Used for</th>
              <th class="left" scope="col">Retrieved by the archive</th>
              <th class="left" scope="col">Published before the day</th>
              <th class="left" scope="col">Time zone</th>
            </tr>
          </thead>
          <tbody>
            {#each versions as version}
              <tr>
                <td class="left"><code title={version.key}>{shortDigest(version.key)}</code></td>
                <td class="left">{version.dates.length ? `${datesLabel(version.dates)} · ${plural(version.dates.length, 'day')}` : 'Being read'}</td>
                <td class="left">{version.record ? version.record.retrieved.map(retrievedDate).join(', ') : 'Not recorded'}</td>
                <td class="left">{#if !version.record}Not recorded{:else if version.record.published_before}Yes{:else}<span class="flag">No, captured later</span>{/if}</td>
                <td class="left">{version.record?.timezone ?? 'Not recorded'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if anyWithoutRecord}
        <p class="note">Retrieval dates are known only for schedules read in this session. Days restored from this device keep their version, shown here, but not those details.</p>
      {/if}
    {:else}
      <p class="empty">No schedule has been used yet. Analyze a day to see which version applied.</p>
    {/if}

    <h3>Archive files read in this session</h3>
    {#if reads.length}
      <div class="table-wrap">
        <table class="data">
          <caption class="sr-only">Archive files read in this session</caption>
          <thead>
            <tr>
              <th class="left" scope="col">UTC file</th>
              <th class="left" scope="col">Status</th>
              <th scope="col">Object size</th>
              <th scope="col">Rows read</th>
              <th scope="col">Seconds</th>
              <th class="left" scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {#each reads as read}
              <tr>
                <td class="left">{read.date}</td>
                <td class="left">{#if read.status === 'read'}Read{:else}<span class="flag">Not in the archive</span>{/if}</td>
                <td>{read.status === 'read' ? bytes(read.bytes) : '—'}</td>
                <td>{int(read.rows)}</td>
                <td>{read.seconds.toFixed(1)}</td>
                <td class="left"><a href={read.url} target="_blank" rel="noopener noreferrer">Parquet object</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="note">{bytes(totalRead)} of objects in total. Downloads are usually smaller, because only the footer and the needed columns and hours are requested. A missing file means the archive has nothing for that date, not that no service ran.</p>
    {:else if app.hasResults}
      <p class="note">None. These days were restored from results already saved on this device, so nothing was downloaded this time.</p>
    {:else}
      <p class="empty">Nothing read yet.</p>
    {/if}
  </section>

  <section class="section" aria-labelledby="coverage-heading">
    <div class="section-head">
      <div>
        <h2 id="coverage-heading">Coverage</h2>
        <p class="note">How often the archive captured this feed, hour by hour. A 20 second feed gives about 180 captures an hour. A pale run during the day points to an archive outage, which depresses trip counts and lengthens headways. Overnight hours can be empty simply because nothing is running.</p>
      </div>
    </div>
    {#if days.length}
      <PollGrid {days} />
      <p class="note">Capture gaps count five-minute periods within the day’s scheduled service with no capture at all. Notes are explained below when there are any.</p>
      {#if notes.length}
        <ul class="notes">
          {#each notes as note}
            <li class="banner caution"><span><strong>{plural(note.dates.length, 'day')}:</strong> {note.text}</span></li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p class="empty">Analyze a day to see its coverage.</p>
    {/if}
  </section>

  <section class="section" aria-labelledby="funnel-heading">
    <div class="section-head">
      <div>
        <h2 id="funnel-heading">From raw rows to measurements</h2>
        <p class="note">Each step shows what was removed and why. Most feeds repeat a position across several polls, so a large share of rows normally falls away as repeats. Point at a step for more detail.</p>
      </div>
    </div>
    {#if days.length}
      <QualityTable {days} units={app.units} />
      <p class="note">The repeats row is what remains after the other steps, so it is approximate: raw rows are counted by hour and reports by service day, which places a few rows near 3 AM on a neighboring day. Intervals with no elapsed time are skipped without a count.</p>
    {:else}
      <p class="empty">Analyze a day to see what was kept and what was removed.</p>
    {/if}
  </section>

  <section class="section" aria-labelledby="methods-heading">
    <div class="section-head">
      <div>
        <h2 id="methods-heading">How each number is calculated</h2>
        <p class="note">The speed method comes from the <a href="https://michaelmclean.me/cta-bus-speed-scorecard" target="_blank" rel="noopener noreferrer">CTA Bus Speed Scorecard</a>, generalized to any GTFS-RT feed.</p>
      </div>
    </div>
    <Methods />
  </section>

  <section class="section" aria-labelledby="sql-heading">
    <div class="section-head">
      <div>
        <h2 id="sql-heading">The SQL</h2>
        <p class="note">DuckDB runs this in this browser, directly against the archive’s Parquet object. Rust then does the map-matching and rollups on the returned columns.</p>
      </div>
      {#if queries.length > 1}
        <label class="field">UTC file
          <select class="input" value={shownRead?.date} onchange={event => (chosenRead = event.currentTarget.value)}>
            {#each queries as read}<option value={read.date}>{read.date}</option>{/each}
          </select>
        </label>
      {/if}
    </div>
    {#if shownRead}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre class="sql" tabindex="0" role="region" aria-label="The SQL query for this archive file"><code>{shownRead.sql}</code></pre>
      <p class="note"><code>{shownRead.sql.match(/read_parquet\('([^']+)'\)/)?.[1] ?? 'The file'}</code> is registered to <a href={shownRead.url} target="_blank" rel="noopener noreferrer">this object</a>. Fixed templates build the query in <code>crates/core/src/sql.rs</code>, and columns an older file lacks become typed nulls.</p>
    {:else}
      <p class="note">No query ran in this session{app.hasResults ? ', because these days came from results saved on this device' : ''}. Analyzing a new day shows its exact query here. The templates are in <a href="https://github.com/MisterClean/gtfsrt-dashboard/blob/main/crates/core/src/sql.rs" target="_blank" rel="noopener noreferrer">crates/core/src/sql.rs</a>.</p>
    {/if}
    <p class="prose">Each archive file holds thousands of row groups, one per poll, and each records its earliest and latest fetch time. The time filter lets DuckDB skip row groups outside the hours a service day needs, and it asks only for the columns named here from the groups it keeps. It groups nearby byte ranges, so the actual download can run larger than that suggests. Every read also needs the footer, which is large: about 14 MB of a 34 MB Madison object. That’s why each file is read only once, even when two service days share it.</p>
  </section>

  <section class="section" aria-labelledby="device-heading">
    <h2 id="device-heading">Your data and this device</h2>
    <p class="prose">Results stay in this browser’s IndexedDB storage so a day is only analyzed once. These are rollups and stop-by-stop times, not raw vehicle data. Nothing is sent anywhere, and clearing them only means the next look at those days downloads and calculates again. Your units, theme and basemap preference are in local storage.</p>
    <dl class="facts">
      <div><dt>This agency</dt><dd>{plural(app.cachedDates.length, 'day')} saved{#if app.cachedDates.length}{` · ${datesLabel(app.cachedDates)} · about ${bytes(app.cachedBytes)} of daily rollups, plus stop times and schedule details`}{/if}</dd></div>
    </dl>
    <div class="tools">
      {#if confirming}
        <span class="confirm">{confirming === 'all' ? 'Remove saved results for every agency?' : 'Remove saved results for this agency?'}</span>
        <button class="btn small" disabled={clearing} onclick={() => clear(confirming === 'all')}>{clearing ? 'Clearing…' : 'Yes, remove them'}</button>
        <button class="btn small quiet" disabled={clearing} onclick={() => (confirming = null)}>Keep them</button>
      {:else}
        <button class="btn small" disabled={app.running || !app.cachedDates.length} onclick={() => (confirming = 'feed')}>Clear this agency’s results</button>
        <button class="btn small" disabled={app.running} onclick={() => (confirming = 'all')}>Clear all results</button>
      {/if}
    </div>

    {#if clearFailure}<p class="banner error" role="alert">{clearFailure}</p>{/if}
    <h3>Who sees what</h3>
    <div class="table-wrap">
      <table class="data">
        <caption class="sr-only">Who can see what when you use this app</caption>
        <thead><tr><th class="left" scope="col">Who</th><th class="left" scope="col">What they see</th></tr></thead>
        <tbody>
          <tr><td class="left"><strong>Archive host</strong> (Google Cloud Storage)</td><td class="left wrap">Your network address and which public files are requested. Your browser requests them directly.</td></tr>
          <tr><td class="left"><strong>Map tiles</strong> (OpenFreeMap)</td><td class="left wrap">Your network address and the map area on screen, while the basemap is on. No transit data goes there.</td></tr>
          <tr><td class="left"><strong>This website’s host</strong></td><td class="left wrap">Ordinary requests for the application’s static files, including the address you open, which can name an agency and dates. Queries and results never reach it, because there is no server to send them to.</td></tr>
          <tr><td class="left"><strong>Anyone you send a link to</strong></td><td class="left wrap">The agency, days and view named in the link. Opening it runs the analysis on their own device. No results travel with it.</td></tr>
        </tbody>
      </table>
    </div>
    <label class="check"><input type="checkbox" checked={app.basemap} onchange={event => app.setBasemap(event.currentTarget.checked)} /> Show the street basemap</label>
    <p class="note">There are no accounts, no analytics and no uploads. Your browser may also keep ordinary cached copies of files it downloaded.</p>
  </section>

  <section class="section" aria-labelledby="downloads-heading">
    <h2 id="downloads-heading">Downloads</h2>
    <p class="prose">The provenance file records the feed, days, calculation version, schedule versions, archive files, SQL, thresholds, warnings and data-quality counts behind these results, so someone else can check them or reproduce them.</p>
    <div class="tools">
      <button class="btn" disabled={!app.hasResults} onclick={downloadProvenance}>Download provenance JSON</button>
      <a class="btn" href="https://github.com/MisterClean/gtfsrt-dashboard" target="_blank" rel="noopener noreferrer">Source code</a>
      <a class="btn" href="https://gtfsrt.io/" target="_blank" rel="noopener noreferrer">gtfsrt.io archive</a>
    </div>
    <p class="note">Each report’s tables download as CSV from that report, and the speed map downloads as GeoJSON.</p>
  </section>
</div>

<style>
  h3 { margin-top: 6px; }
  .empty { padding: 2px 0 4px; font-size: 13px; }
  .facts { display: grid; }
  .facts div { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 2px 16px; padding: 7px 0; border-bottom: 1px solid var(--rule); font-size: 13.5px; }
  .facts div:first-child { border-top: 1px solid var(--rule); }
  .facts dt { color: var(--muted); font-weight: 600; font-size: 12.5px; }
  .facts dd { min-width: 0; overflow-wrap: anywhere; }
  .dim { color: var(--muted); }
  .flag { color: var(--orange); font-weight: 650; }
  .prose { max-width: 72ch; text-wrap: pretty; }
  .notes { list-style: none; display: grid; gap: 6px; }
  .sql { margin: 0; padding: 12px 14px; max-height: 340px; overflow: auto; background: var(--surface); border-radius: 4px; }
  .sql code { font: 12px/1.65 var(--font-mono); }
  .confirm { font-size: 13px; font-weight: 600; }
  .check { display: flex; gap: 7px; align-items: center; font-size: 13.5px; }
  a.btn { text-decoration: none; }
  @media (max-width: 620px) {
    .facts div { grid-template-columns: minmax(0, 1fr); }
  }
</style>
