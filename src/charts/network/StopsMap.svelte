<script lang="ts">
  // Every stop in use, with those closest to a neighbouring stop picked out.
  import {LngLatBounds, Map as MapLibre, NavigationControl, ScaleControl, setWorkerUrl} from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
  import type {GeoJSONSource, LngLatBoundsLike} from 'maplibre-gl';
  import type {StopRow} from '../../engine/types';
  import {shortLength, type Units} from '../../lib/format';
  import {app} from '../../lib/state.svelte';
  import {tooltip} from '../../lib/tooltip.svelte';
  import {labelLayers, mapStyle} from '../../map/style';

  setWorkerUrl(workerUrl);

  interface Props {
    stops: StopRow[];
    thresholdM: number;
    units: Units;
    height?: string;
  }
  let {stops, thresholdM, units, height = '420px'}: Props = $props();

  let container = $state<HTMLDivElement>();
  let map: MapLibre | undefined;
  let loaded = $state(false);
  let unavailable = $state(false);
  let fitted = false;

  const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function toGeoJson(rows: StopRow[]): any {
    return {
      type: 'FeatureCollection',
      features: rows
        .filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && !(stop.lat === 0 && stop.lon === 0))
        .map(stop => ({
          type: 'Feature',
          properties: {
            name: stop.name,
            routes: stop.routes.join(', '),
            nearest: stop.nearest_stop_m,
            close: stop.nearest_stop_m !== null && stop.nearest_stop_m < thresholdM,
          },
          geometry: {type: 'Point', coordinates: [stop.lon, stop.lat]},
        })),
    };
  }

  function fit(rows: StopRow[]) {
    if (!map || fitted || !rows.length) return;
    const usable = rows.filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && !(stop.lat === 0 && stop.lon === 0));
    if (!usable.length) return;
    const first = usable[0];
    const bounds = new LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
    for (const stop of usable) bounds.extend([stop.lon, stop.lat]);
    map.fitBounds(bounds as LngLatBoundsLike, {padding: 28, duration: 0, maxZoom: 14});
    fitted = true;
  }

  function addLayers() {
    if (!map) return;
    map.addSource('stops', {type: 'geojson', data: toGeoJson(stops)});
    map.addLayer({
      id: 'stops', type: 'circle', source: 'stops',
      layout: {'circle-sort-key': ['case', ['get', 'close'], 1, 0]},
      paint: {
        'circle-color': ['case', ['get', 'close'], token('--orange'), token('--gray-series')] as any,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.8, 15, 6, 17, 9] as any,
        'circle-stroke-color': token('--paper'),
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0, 13, 1] as any,
      },
    });
    if (app.basemap) {
      for (const layer of labelLayers(app.darkActive)) map.addLayer(layer);
    }
    map.on('mousemove', 'stops', event => {
      const feature = event.features?.[0];
      if (!feature || !map) return;
      map.getCanvas().style.cursor = 'pointer';
      const {name, routes, nearest} = feature.properties;
      tooltip.show(event.originalEvent, [
        {title: String(name)},
        {label: 'Routes', value: String(routes)},
        ...(nearest === null || nearest === undefined ? [] : [{label: 'Nearest stop', value: shortLength(Number(nearest), units)}]),
      ]);
    });
    map.on('mouseleave', 'stops', () => {
      if (!map) return;
      map.getCanvas().style.cursor = '';
      tooltip.hide();
    });
    fit(stops);
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
      unavailable = true;
      return;
    }
    map = instance;
    instance.touchZoomRotate.disableRotation();
    instance.addControl(new NavigationControl({showCompass: false}), 'top-right');
    instance.addControl(new ScaleControl({unit: units === 'imperial' ? 'imperial' : 'metric', maxWidth: 90}), 'bottom-left');
    instance.on('load', () => {
      loaded = true;
      addLayers();
    });
    return () => {
      loaded = false;
      fitted = false;
      map = undefined;
      tooltip.hide();
      instance.remove();
    };
  });

  $effect(() => {
    const rows = stops;
    if (!map || !loaded) return;
    (map.getSource('stops') as GeoJSONSource | undefined)?.setData(toGeoJson(rows));
    fit(rows);
  });
</script>

<div class="map-frame" style:height={height}>
  <div class="map" bind:this={container} role="application" aria-label="Map of stops, with closely spaced stops highlighted"></div>
  {#if unavailable}
    <p class="unavailable">This map needs WebGL2, which this browser or device has turned off. Every stop is listed in the table below.</p>
  {/if}
</div>

<style>
  .map-frame { position: relative; min-height: 280px; border: 1px solid var(--rule); border-radius: 4px; overflow: hidden; background: var(--surface); }
  .map { position: absolute; inset: 0; }
  .unavailable { position: absolute; inset: 0; display: grid; place-items: center; padding: 32px; text-align: center; color: var(--muted); max-width: 52ch; margin: auto; }
</style>
