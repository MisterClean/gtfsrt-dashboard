<script lang="ts" module>
  export type MapPeriod = 'hour' | 'am' | 'mid' | 'pm' | 'all';
  export type MapMetric = 'speed' | 'versus';
  export const VERSUS_BREAKS = [0.7, 0.8, 0.9, 1.1, 1.2, 1.35];
</script>

<script lang="ts">
  // Every directional street cell, colored by speed. Hours are stored as feature
  // properties, so moving through the day only swaps a paint expression and stays
  // smooth even on large networks.
  import {LngLatBounds, Map as MapLibre, Marker, NavigationControl, ScaleControl, setWorkerUrl} from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
  import type {GeoJSONSource, LngLatBoundsLike} from 'maplibre-gl';
  import type {MapFeature, Mode, NetworkMap} from '../engine/types';
  import {hourRange, int, speedWithUnit, pct, type Units} from '../lib/format';
  import {app} from '../lib/state.svelte';
  import {breaksMps, classColors} from '../lib/speed-scale';
  import {tooltip} from '../lib/tooltip.svelte';
  import {labelLayers, mapStyle} from './style';

  setWorkerUrl(workerUrl);


  interface Props {
    data: NetworkMap | null;
    hour: number;
    period?: MapPeriod;
    metric?: MapMetric;
    mode: Mode;
    units: Units;
    height?: string;
    highlight?: [number, number][] | null;
    /** Stretches to outline and number, matching a ranked list beside the map. */
    ranked?: {path: [number, number][]; rank: number; label: string}[];
    onrank?: (rank: number) => void;
    onselect?: (feature: MapFeature | null) => void;
    label?: string;
  }
  let {
    data,
    hour,
    period = 'hour',
    metric = 'speed',
    mode,
    units,
    height = '520px',
    highlight = null,
    ranked = [],
    onrank,
    onselect,
    label = 'Map of average speed on each street',
  }: Props = $props();

  let container = $state<HTMLDivElement>();
  let map: MapLibre | undefined;
  let loaded = $state(false);
  let tilesFailed = $state(false);
  let unavailable = $state(false);
  let fitted = false;
  let featuresById = new Map<number, MapFeature>();
  let markers: Marker[] = [];
  let zoomedToHighlight = false;

  const propertyKey = $derived(period === 'hour' ? `h${hour}` : period);

  function colorExpression(key: string, colors: string[], breaks: number[]) {
    const steps: unknown[] = [colors[0]];
    breaks.forEach((value, i) => steps.push(value, colors[i + 1]));
    const measured =
      metric === 'versus'
        ? ['step', ['case', ['all', ['has', 'mid'], ['>', ['get', 'mid'], 0]], ['/', ['get', key], ['get', 'mid']], 1], ...steps]
        : ['step', ['get', key], ...steps];
    return ['case', ['has', key], measured, 'rgba(0,0,0,0)'] as any;
  }

  /** Slow streets stay opaque in the emphasis layer, and everything else drops out. */
  function slowOpacity(key: string, breaks: number[]) {
    const below =
      metric === 'versus'
        ? ['<', ['case', ['all', ['has', 'mid'], ['>', ['get', 'mid'], 0]], ['/', ['get', key], ['get', 'mid']], 1], breaks[2]]
        : ['<', ['get', key], breaks[2]];
    return ['case', ['all', ['has', key], below], 1, 0] as any;
  }

  function toGeoJson(network: NetworkMap): any {
    featuresById = new Map(network.features.map(f => [f.id, f]));
    return {
      type: 'FeatureCollection',
      features: network.features.map(feature => {
        const properties: Record<string, unknown> = {
          id: feature.id,
          routes: feature.routes.join(', '),
          measurements: feature.measurements,
        };
        if (feature.all_day !== null) properties.all = feature.all_day;
        if (feature.am !== null) properties.am = feature.am;
        if (feature.mid !== null) properties.mid = feature.mid;
        if (feature.pm !== null) properties.pm = feature.pm;
        feature.speeds.forEach((value, h) => {
          if (value !== null) properties[`h${h}`] = value;
        });
        return {type: 'Feature', id: feature.id, properties, geometry: {type: 'LineString', coordinates: feature.path}};
      }),
    };
  }

  function addLayers() {
    if (!map) return;
    const colors = classColors();
    map.addSource('speed', {type: 'geojson', data: data ? toGeoJson(data) : {type: 'FeatureCollection', features: []}, tolerance: 0.3});
    map.addSource('highlight', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    map.addSource('ranked', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    const width = ['interpolate', ['linear'], ['zoom'], 9, 1.4, 11, 2.4, 13, 3.6, 15, 6, 17, 10] as any;
    const offset = ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 1.6, 15, 3.2, 17, 6] as any;
    // The whole network in a quiet line, so streets with no measurement this hour
    // read as "no data" rather than as holes in the map.
    map.addLayer({
      id: 'speed-base', type: 'line', source: 'speed',
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': getComputedStyle(document.documentElement).getPropertyValue('--rule-strong').trim(), 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 13, 2, 17, 5] as any, 'line-offset': offset},
    });
    map.addLayer({
      id: 'speed-hover', type: 'line', source: 'speed', filter: ['==', ['get', 'id'], -1],
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(), 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4.4, 11, 5.4, 13, 6.6, 15, 9, 17, 13] as any, 'line-offset': offset},
    });
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    map.addLayer({
      id: 'ranked-casing', type: 'line', source: 'ranked',
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 11, 6.5, 13, 8.5, 15, 12, 17, 16] as any, 'line-offset': offset},
    });
    const breaks = metric === 'versus' ? VERSUS_BREAKS : breaksMps(mode);
    map.addLayer({
      id: 'speed-lines', type: 'line', source: 'speed',
      layout: {'line-cap': 'butt', 'line-join': 'round'},
      paint: {'line-color': colorExpression(propertyKey, colors, breaks), 'line-width': width, 'line-offset': offset},
    });
    // Slow streets are the point of the map. They draw wider and on top, and because this
    // only changes paint, moving through the hours stays smooth on large networks.
    map.addLayer({
      id: 'speed-slow', type: 'line', source: 'speed',
      layout: {'line-cap': 'butt', 'line-join': 'round'},
      paint: {
        'line-color': colorExpression(propertyKey, colors, breaks),
        'line-opacity': slowOpacity(propertyKey, breaks),
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.4, 11, 3.6, 13, 5.2, 15, 8, 17, 12] as any,
        'line-offset': offset,
      },
    });
    map.addLayer({
      id: 'highlight-casing', type: 'line', source: 'highlight',
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 12] as any},
    });
    map.addLayer({
      id: 'highlight-line', type: 'line', source: 'highlight',
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 7] as any},
    });
    if (app.basemap) {
      for (const layer of labelLayers(app.darkActive)) map.addLayer(layer);
    }
    bindInteractions();
    applyHighlight();
    applyRanked();
    fit();
  }

  let bound = false;
  function bindInteractions() {
    if (!map || bound) return;
    bound = true;
    map.on('mousemove', 'speed-lines', event => {
      const feature = event.features?.[0];
      if (!feature || !map) return;
      map.getCanvas().style.cursor = 'pointer';
      const id = Number(feature.properties.id);
      map.setFilter('speed-hover', ['==', ['get', 'id'], id]);
      const full = featuresById.get(id);
      if (!full) return;
      const value = valueOf(full);
      tooltip.show(event.originalEvent, [
        {title: value === null ? 'No measured service' : speedWithUnit(value, units)},
        {note: period === 'hour' ? hourRange(hour) : periodName()},
        ...(metric === 'versus' && value !== null && full.mid ? [{label: 'Compared with midday', value: pct(value / full.mid - 1)}] : []),
        {label: full.routes.length === 1 ? 'Route' : 'Routes', value: full.routes.slice(0, 8).join(', ') + (full.routes.length > 8 ? '…' : '')},
        {label: 'Measurements', value: int(full.measurements)},
      ]);
    });
    map.on('mouseleave', 'speed-lines', () => {
      if (!map) return;
      map.getCanvas().style.cursor = '';
      map.setFilter('speed-hover', ['==', ['get', 'id'], -1]);
      tooltip.hide();
    });
    map.on('click', 'speed-lines', event => {
      const feature = event.features?.[0];
      if (feature) onselect?.(featuresById.get(Number(feature.properties.id)) ?? null);
    });
  }

  function valueOf(feature: MapFeature) {
    if (period === 'hour') return feature.speeds[hour] ?? null;
    if (period === 'all') return feature.all_day;
    return feature[period];
  }
  const periodName = () => ({am: 'Morning peak', mid: 'Midday', pm: 'Evening peak', all: 'All day', hour: ''})[period];

  /** The middle 98% of the network, so a few long outlying lines don't shrink the rest. */
  function coreBounds(network: NetworkMap): [number, number, number, number] | null {
    const middles = network.features.map(f => f.path[Math.floor(f.path.length / 2)]).filter(Boolean);
    if (middles.length < 50) return network.bounds;
    const lons = middles.map(p => p[0]).sort((a, b) => a - b);
    const lats = middles.map(p => p[1]).sort((a, b) => a - b);
    const at = (values: number[], share: number) => values[Math.floor(values.length * share)];
    return [at(lons, 0.01), at(lats, 0.01), at(lons, 0.99), at(lats, 0.99)];
  }

  /** Ranked stretches are what the map is showing, when it has them. Otherwise the network. */
  function frame(duration: number) {
    if (!map || !data?.bounds) return false;
    const focus = ranked.flatMap(item => item.path);
    if (focus.length) {
      const bounds = new LngLatBounds(focus[0], focus[0]);
      for (const point of focus) bounds.extend(point);
      map.fitBounds(bounds, {padding: 56, duration, maxZoom: 15});
      return true;
    }
    const core = coreBounds(data);
    if (!core) return false;
    const [west, south, east, north] = core;
    map.fitBounds(new LngLatBounds([west, south], [east, north]) as LngLatBoundsLike, {padding: 28, duration, maxZoom: 15});
    return true;
  }

  function fit() {
    if (!fitted && frame(0)) fitted = true;
  }

  function applyHighlight() {
    if (!map || !loaded) return;
    const source = map.getSource('highlight') as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: highlight?.length ? [{type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: highlight}}] : [],
    });
    if (highlight?.length) {
      const bounds = new LngLatBounds(highlight[0], highlight[0]);
      for (const point of highlight) bounds.extend(point);
      map.fitBounds(bounds, {padding: 120, maxZoom: 15.5, duration: 500});
      zoomedToHighlight = true;
    } else if (zoomedToHighlight) {
      zoomedToHighlight = false;
      if (ranked.length) frame(500);
    }
  }

  function applyRanked() {
    for (const marker of markers) marker.remove();
    markers = [];
    if (!map || !loaded) return;
    const source = map.getSource('ranked') as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: ranked.map(item => ({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: item.path}})),
    });
    for (const item of ranked) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'rank-marker';
      element.textContent = String(item.rank);
      element.setAttribute('aria-label', item.label);
      element.addEventListener('click', event => {
        event.stopPropagation();
        onrank?.(item.rank);
      });
      markers.push(new Marker({element}).setLngLat(item.path[Math.floor(item.path.length / 2)]).addTo(map));
    }
  }

  $effect(() => {
    if (!container) return;
    const dark = app.darkActive;
    const basemap = app.basemap;
    let instance: MapLibre;
    try {
      instance = new MapLibre({
        container,
        style: mapStyle(dark, basemap),
        center: [0, 30],
        zoom: 2,
        attributionControl: {compact: true},
        dragRotate: false,
        pitchWithRotate: false,
        maxPitch: 0,
      });
    } catch {
      // Every other report still works without graphics acceleration.
      unavailable = true;
      return;
    }
    map = instance;
    // Bound first, because a failed tile source reports before the map finishes loading.
    // Missing tiles only cost the basemap. The data lines still draw.
    instance.on('error', event => {
      if (String(event.error?.message ?? '').includes('openfreemap') || (event as any).sourceId === 'map') tilesFailed = true;
    });
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.enable();
    instance.addControl(new NavigationControl({showCompass: false}), 'top-right');
    instance.addControl(new ScaleControl({unit: units === 'imperial' ? 'imperial' : 'metric', maxWidth: 90}), 'bottom-left');
    instance.on('load', () => {
      loaded = true;
      addLayers();
      // Open, the attribution covers the scale bar on a phone. It's one tap away.
      if (matchMedia('(max-width: 480px)').matches) {
        container?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      }
    });
    return () => {
      loaded = false;
      bound = false;
      fitted = false;
      map = undefined;
      tooltip.hide();
      instance.remove();
    };
  });

  // New results.
  $effect(() => {
    const network = data;
    if (!map || !loaded || !network) return;
    (map.getSource('speed') as GeoJSONSource | undefined)?.setData(toGeoJson(network));
    fit();
  });

  // Moving through the hours.
  $effect(() => {
    const key = propertyKey;
    const breaks = metric === 'versus' ? VERSUS_BREAKS : breaksMps(mode);
    if (!map || !loaded || !map.getLayer('speed-lines')) return;
    const colors = colorExpression(key, classColors(), breaks);
    map.setPaintProperty('speed-lines', 'line-color', colors);
    map.setPaintProperty('speed-slow', 'line-color', colors);
    map.setPaintProperty('speed-slow', 'line-opacity', slowOpacity(key, breaks));
  });

  $effect(() => {
    highlight;
    applyHighlight();
  });

  $effect(() => {
    ranked;
    applyRanked();
  });
</script>

<div class="map-frame" style:height={height}>
  <div class="map" bind:this={container} role="application" aria-label={label}></div>
  {#if unavailable}
    <p class="unavailable">This map needs WebGL2, which this browser or device has turned off. Every number on the page is still available in the tables and downloads.</p>
  {/if}
  {#if tilesFailed && app.basemap}
    <p class="tile-note fine">The street basemap could not load. Speeds still draw.</p>
  {/if}
</div>

<style>
  .map-frame { position: relative; min-height: 280px; border: 1px solid var(--rule); border-radius: 4px; overflow: hidden; background: var(--surface); }
  .map { position: absolute; inset: 0; }
  .unavailable { position: absolute; inset: 0; display: grid; place-items: center; padding: 32px; text-align: center; color: var(--muted); max-width: 52ch; margin: auto; }
  .tile-note { position: absolute; left: 8px; top: 8px; background: var(--paper); padding: 3px 8px; border-radius: 3px; }
  :global(.rank-marker) {
    width: 20px; height: 20px; padding: 0; border: 1.5px solid var(--paper); border-radius: 50%; background: var(--ink); color: var(--paper);
    font: 650 11px/1 var(--font-body, inherit); font-variant-numeric: tabular-nums; cursor: pointer;
  }
  /* A bigger touch target than the number it carries. */
  :global(.rank-marker::after) { content: ''; position: absolute; inset: -12px; }
  :global(.rank-marker:hover) { background: var(--copper); }
  :global(.rank-marker:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
