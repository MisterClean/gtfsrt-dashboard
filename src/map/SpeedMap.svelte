<script lang="ts" module>
  export type MapPeriod = 'hour' | 'am' | 'mid' | 'pm' | 'all';
  export type MapMetric = 'speed' | 'versus';
  export const VERSUS_BREAKS = [0.7, 0.8, 0.9, 1.1, 1.2, 1.35];
</script>

<script lang="ts">
  // Every directional street cell, colored by speed. Hours are stored as feature
  // properties, so moving through the day only swaps a paint expression and stays
  // smooth even on large networks.
  import {LngLatBounds, Map as MapLibre, NavigationControl, ScaleControl, setWorkerUrl} from 'maplibre-gl';
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
    map.addLayer({
      id: 'speed-lines', type: 'line', source: 'speed',
      layout: {'line-cap': 'butt', 'line-join': 'round'},
      paint: {'line-color': colorExpression(propertyKey, colors, metric === 'versus' ? VERSUS_BREAKS : breaksMps(mode)), 'line-width': width, 'line-offset': offset},
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
    map.on('error', event => {
      // Missing tiles only cost the basemap. The data lines still draw.
      if (String(event.error?.message ?? '').includes('openfreemap') || (event as any).sourceId === 'map') tilesFailed = true;
    });
  }

  function valueOf(feature: MapFeature) {
    if (period === 'hour') return feature.speeds[hour] ?? null;
    if (period === 'all') return feature.all_day;
    return feature[period];
  }
  const periodName = () => ({am: 'Morning peak', mid: 'Midday', pm: 'Evening peak', all: 'All day', hour: ''})[period];

  function fit() {
    if (!map || fitted || !data?.bounds) return;
    const [west, south, east, north] = data.bounds;
    map.fitBounds(new LngLatBounds([west, south], [east, north]) as LngLatBoundsLike, {padding: 28, duration: 0, maxZoom: 15});
    fitted = true;
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
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.enable();
    instance.addControl(new NavigationControl({showCompass: false}), 'top-right');
    instance.addControl(new ScaleControl({unit: units === 'imperial' ? 'imperial' : 'metric', maxWidth: 90}), 'bottom-left');
    instance.on('load', () => {
      loaded = true;
      addLayers();
    });
    return () => {
      loaded = false;
      bound = false;
      fitted = false;
      map = undefined;
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
    map.setPaintProperty('speed-lines', 'line-color', colorExpression(key, classColors(), breaks));
  });

  $effect(() => {
    highlight;
    applyHighlight();
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
</style>
