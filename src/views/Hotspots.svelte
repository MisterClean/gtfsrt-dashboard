<script lang="ts">
  import Spark from '../charts/Spark.svelte';
  import DataTable, {type Column} from '../components/DataTable.svelte';
  import SpeedLegend from '../components/SpeedLegend.svelte';
  import Term from '../components/Term.svelte';
  import {engine} from '../engine/client';
  import type {Hotspot, HotspotReport, NetworkMap} from '../engine/types';
  import {hourLabel, int, length, pct, speed, speedUnit, toDisplaySpeed} from '../lib/format';
  import {app, errorText} from '../lib/state.svelte';
  import SpeedMap, {type MapPeriod} from '../map/SpeedMap.svelte';

  type SortKey = 'delay' | 'worst' | 'hours';

  let report = $state<HotspotReport | null>(null);
  let network = $state<NetworkMap | null>(null);
  let failure = $state<string | null>(null);
  let selected = $state<Hotspot | null>(null);
  let period = $state<MapPeriod>('pm');
  let sort = $state<SortKey>('delay');
  let mapElement = $state<HTMLElement>();
  let request = 0;

  $effect(() => {
    app.version;
    if (!app.hasResults) return;
    const current = ++request;
    Promise.all([engine.hotspots(), engine.networkMap()])
      .then(([hotspots, map]) => {
        if (current !== request) return;
        report = hotspots;
        network = map;
        failure = null;
        // Ranks can shift when days are added, so a pinned stretch may no longer exist.
        if (selected && !hotspots.hotspots.some(h => sameStretch(h, selected as Hotspot))) selected = null;
      })
      .catch(error => {
        if (current === request) failure = errorText(error);
      });
  });

  /** Overnight hours can rest on one or two vehicles, so the worst hour is read from 5 AM on. */
  function worstOf(h: Hotspot) {
    let worst: {hour: number; speed: number} | null = null;
    for (let hour = 5; hour < 24; hour += 1) {
      const value = h.hourly[hour];
      if (value !== null && value !== undefined && (!worst || value < worst.speed)) worst = {hour, speed: value};
    }
    return worst ?? {hour: h.worst_hour, speed: h.worst_speed};
  }

  const sameStretch = (a: Hotspot, b: Hotspot) => a.from === b.from && a.to === b.to && a.length_m === b.length_m;
  const unit = $derived(speedUnit(app.units));
  const hotspots = $derived(report?.hotspots ?? []);

  const sorted = $derived(
    [...hotspots].sort((a, b) => {
      if (sort === 'worst') return worstOf(a).speed - worstOf(b).speed;
      if (sort === 'hours') return b.bus_hours_per_day - a.bus_hours_per_day;
      return b.delay_hours_per_day - a.delay_hours_per_day;
    }),
  );

  // The list and the map's numbers match, whichever way the stretches are ranked.
  const TOP = 10;
  const top = $derived(sorted.slice(0, TOP).filter(h => h.path.length > 1).map((h, index) => ({path: h.path, rank: index + 1, label: `${index + 1}: ${stretchName(h)}`})));

  const delayShare = $derived(report && report.bus_hours_per_day > 0 ? report.delay_hours_per_day / report.bus_hours_per_day : null);
  const topTenShare = $derived.by(() => {
    if (!report || report.delay_hours_per_day <= 0) return null;
    const top = [...hotspots].sort((a, b) => b.delay_hours_per_day - a.delay_hours_per_day).slice(0, 10);
    return top.reduce((sum, h) => sum + h.delay_hours_per_day, 0) / report.delay_hours_per_day;
  });

  const distance = (meters: number) => Number((meters / (app.units === 'imperial' ? 1609.34 : 1000)).toFixed(2));
  const routeList = (routes: string[], limit: number) =>
    routes.length > limit ? `${routes.slice(0, limit).join(', ')} and ${routes.length - limit} more` : routes.join(', ');
  // With no schedule there are no stop names, so a stretch is named by where it is.
  const nearCoordinates = (h: Hotspot) => {
    const middle = h.path[Math.floor(h.path.length / 2)];
    return middle ? `Stretch near ${middle[1].toFixed(4)}, ${middle[0].toFixed(4)}` : `Stretch ${h.rank}`;
  };
  const stretchName = (h: Hotspot) => (h.from && h.to && h.from !== h.to ? `${h.from} to ${h.to}` : h.from || h.to || nearCoordinates(h));
  const csvSpeed = (mps: number | null) => (mps === null ? null : Number(toDisplaySpeed(mps, app.units).toFixed(2)));
  // One scale for every row so lines can be compared, trimmed so a stray hour
  // doesn't flatten the rest.
  const hourly = $derived(hotspots.flatMap(h => h.hourly.slice(5, 24)).filter((v): v is number => v !== null).sort((a, b) => a - b));
  const sparkMin = $derived(hourly.length ? hourly[Math.floor(hourly.length * 0.02)] : 0);
  const sparkMax = $derived(hourly.length ? hourly[Math.floor(hourly.length * 0.95)] : 1);

  function choose(hotspot: Hotspot) {
    selected = selected && sameStretch(selected, hotspot) ? null : hotspot;
    if (selected) mapElement?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }

  const periods: {value: MapPeriod; label: string}[] = [
    {value: 'am', label: 'AM peak'},
    {value: 'mid', label: 'Midday'},
    {value: 'pm', label: 'PM peak'},
    {value: 'all', label: 'All day'},
  ];
  const sorts: {value: SortKey; label: string}[] = [
    {value: 'delay', label: 'Time lost'},
    {value: 'worst', label: 'Worst speed'},
    {value: 'hours', label: 'Vehicle hours'},
  ];

  const columns = $derived<Column<Hotspot>[]>([
    {key: 'stretch', label: 'Stretch', left: true, wrap: true, value: stretchName},
    {key: 'rank', label: 'Rank', value: h => h.rank},
    {key: 'routes', label: 'Routes', left: true, wrap: true, value: h => h.routes.join(', ')},
    {key: 'length', label: `Length, ${app.units === 'imperial' ? 'mi' : 'km'}`, descending: true, value: h => distance(h.length_m), format: h => distance(h.length_m).toFixed(2)},
    {key: 'delay', label: 'Time lost, hours a day', title: 'Vehicle hours lost each day against this stretch\'s freest conditions', descending: true, value: h => Number(h.delay_hours_per_day.toFixed(2)), format: h => h.delay_hours_per_day.toFixed(1)},
    {key: 'hours', label: 'Vehicle hours a day', title: 'All time vehicles spend on this stretch each day', descending: true, value: h => Number(h.bus_hours_per_day.toFixed(2)), format: h => h.bus_hours_per_day.toFixed(1)},
    {key: 'free', label: `Freest, ${unit}`, title: 'The 85th percentile of this stretch\'s hourly speeds', descending: true, value: h => h.reference_speed, format: h => speed(h.reference_speed, app.units), csv: h => csvSpeed(h.reference_speed)},
    {key: 'worst', label: `Worst, ${unit}`, title: 'Slowest hour on this stretch between 5 AM and midnight', value: h => worstOf(h).speed, format: h => speed(worstOf(h).speed, app.units), csv: h => csvSpeed(worstOf(h).speed)},
    {key: 'worstHour', label: 'Worst hour', value: h => worstOf(h).hour, format: h => hourLabel(worstOf(h).hour)},
    {key: 'peak', label: `Peak, ${unit}`, title: '7 to 9 AM and 4 to 6 PM', value: h => h.peak_speed, format: h => speed(h.peak_speed, app.units), csv: h => csvSpeed(h.peak_speed)},
    {key: 'stopped', label: 'Stopped', title: 'Share of time moving under 2 mph', descending: true, value: h => h.stopped_share, format: h => pct(h.stopped_share)},
    {key: 'hourly', label: '5 AM to 11 PM', noSort: true, value: () => null, cell: sparkCell, csv: h => h.hourly.slice(5, 24).map(v => (v === null ? '' : csvSpeed(v))).join(' ')},
  ]);
</script>

{#snippet sparkCell(h: Hotspot)}
  <Spark values={h.hourly} min={sparkMin} max={sparkMax} label="Speed by hour on {stretchName(h)}" />
{/snippet}

<div class="page">
  <div class="page-head">
    <div>
      <h1>Delay hotspots</h1>
      <p class="lede">Where vehicles lose the most time, measured against each street's own freest hours.</p>
    </div>
  </div>

  {#if failure}
    <div class="banner error" role="alert">The delay report could not be calculated. {failure}</div>
  {/if}

  {#if report}
    <dl class="stats">
      <div class="stat">
        <dt><Term topic="hotspots">Time lost</Term></dt>
        <dd>{int(report.delay_hours_per_day)} <small>vehicle hours a day</small></dd>
        <div class="sub">against each street's freest hours</div>
      </div>
      <div class="stat">
        <dt><Term topic="hotspots">Share of vehicle hours</Term></dt>
        <dd>{pct(delayShare)}</dd>
        <div class="sub">of {int(report.bus_hours_per_day)} measured hours a day</div>
      </div>
      <div class="stat">
        <dt><Term topic="hotspots">Top 10 stretches</Term></dt>
        <dd>{pct(topTenShare)}</dd>
        <div class="sub">of all time lost across the network</div>
      </div>
    </dl>

    <section class="section" aria-label="Map and ranked stretches">
      <div class="tools">
        <span class="fine">Map colors</span>
        <div class="seg" role="group" aria-label="Time period shown on the map colors">
          {#each periods as option}
            <button aria-pressed={period === option.value} onclick={() => (period = option.value)}>{option.label}</button>
          {/each}
        </div>
        {#if selected}
          <button class="btn small quiet" onclick={() => (selected = null)}>Clear selection</button>
        {/if}
      </div>
      <div class="layout">
        <div class="map-col" bind:this={mapElement}>
          <SpeedMap
            data={network}
            hour={app.mapHour}
            {period}
            mode={app.scaleMode}
            units={app.units}
            height="max(360px, min(calc(100dvh - 360px), 680px))"
            highlight={selected?.path ?? null}
            ranked={top}
            onrank={rank => choose(sorted[rank - 1])}
            label="Map of speed on each street, with the top {top.length} stretches outlined and numbered"
          />
          <SpeedLegend mode={app.scaleMode} units={app.units} />
        </div>
        <div class="ranked">
          <div class="ranked-head">
            <h3>Ranked by</h3>
            <div class="seg" role="group" aria-label="Rank stretches by">
              {#each sorts as option}
                <button aria-pressed={sort === option.value} onclick={() => (sort = option.value)}>{option.label}</button>
              {/each}
            </div>
          </div>
          {#if sorted.length}
            <ol class="list">
              {#each sorted.slice(0, TOP) as hotspot, index}
                {@const active = !!selected && sameStretch(selected, hotspot)}
                <li>
                  <button class:active aria-pressed={active} onclick={() => choose(hotspot)}>
                    <span class="position num">{index + 1}</span>
                    <span class="body">
                      <span class="name">{stretchName(hotspot)}</span>
                      <span class="fine">{length(hotspot.length_m, app.units)} · {hotspot.routes.length === 1 ? 'route' : 'routes'} {routeList(hotspot.routes, 5)}</span>
                    </span>
                    <span class="figure num">
                      {#if sort === 'worst'}
                        <strong>{speed(worstOf(hotspot).speed, app.units)}</strong> <span class="fine">{unit}, {hourLabel(worstOf(hotspot).hour)}</span>
                      {:else if sort === 'hours'}
                        <strong>{hotspot.bus_hours_per_day.toFixed(1)}</strong> <span class="fine">hours a day</span>
                      {:else}
                        <strong>{hotspot.delay_hours_per_day.toFixed(1)}</strong> <span class="fine">hours lost a day</span>
                      {/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="note">No stretch shows time lost in this selection. Streets need measurements in at least three hours before they can be compared with their own freest conditions.</p>
          {/if}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>The {hotspots.length} stretches losing the most time</h2>
          <p class="note">Runs of adjoining street segments, named by the stops nearest each end and up to about a mile long. Choose a row to outline it on the map. Where routes share a street they are pooled, so time lost isn't counted twice.</p>
        </div>
      </div>
      <div class="compact-heads">
      <DataTable
        {columns}
        rows={hotspots}
        caption="Delay hotspots ranked by time lost. Choose a row to outline it on the map."
        defaultSort="delay"
        defaultDescending
        filename="hotspots.csv"
        search={h => `${stretchName(h)} ${h.routes.join(' ')}`}
        placeholder="Find a street or route…"
        onrow={choose}
        limit={25}
        maxHeight="72vh"
      />
      </div>
      <p class="note">Freest means the 85th percentile of a stretch's hourly speeds, so a street that is slow all day loses little by this measure. Look for it under worst speed instead. Time lost shows where running time could be recovered. It doesn't say why, which could be traffic, signals, stops or turns. It covers the whole service day, and these are vehicle hours, not rider hours, because the archive has no ridership.</p>
    </section>
  {:else if !failure}
    <p class="empty">Calculating…</p>
  {/if}
</div>

<style>
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
  .map-col { display: grid; gap: 10px; min-width: 0; position: sticky; top: 72px; }
  .ranked { display: grid; gap: 10px; min-width: 0; }
  .ranked-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; }
  .list { list-style: none; display: grid; }
  .list li { border-top: 1px solid var(--rule); }
  .list li:last-child { border-bottom: 1px solid var(--rule); }
  .list button {
    width: 100%; display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 6px;
    border: 0; background: none; text-align: left; transition: background-color 120ms ease-out;
  }
  .list button:hover { background: var(--surface); }
  .list button.active { background: var(--surface-2); }
  .position { color: var(--muted); font-size: 12.5px; line-height: 1.45; }
  .body { display: grid; gap: 1px; min-width: 0; }
  .name { font-size: 13px; font-weight: 600; line-height: 1.35; text-wrap: pretty; }
  .figure { display: grid; justify-items: end; text-align: right; gap: 0; max-width: 84px; }
  .figure strong { font-size: 15px; font-weight: 650; line-height: 1.3; }
  .figure .fine { line-height: 1.25; font-size: 11px; }
  .compact-heads { display: grid; gap: 12px; min-width: 0; }
  .compact-heads :global(table.data th) { white-space: normal; min-width: 52px; line-height: 1.25; }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .map-col { position: static; }
  }
</style>
