// A quiet basemap in the notebook's palette: enough streets and names to locate
// a stretch, with the data as the loudest thing on the page. Tiles come from
// OpenFreeMap, which needs no key or account. See docs/packaging-security.md.
import type {StyleSpecification} from 'maplibre-gl';

const SOURCE = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const LIGHT = {
  background: '#f6f4ee', water: '#d9e3e6', park: '#e9ecdf', building: '#ecebe3', minor: '#e8e6dd', major: '#dddad0',
  highway: '#d3cfc2', rail: '#d6d4cb', label: '#6b6d64', labelStrong: '#42463f', halo: '#f6f4ee', waterLabel: '#6f8791',
};
const DARK = {
  background: '#1a1a18', water: '#141b20', park: '#1d211b', building: '#22221f', minor: '#272724', major: '#31312d',
  highway: '#3b3b36', rail: '#2d2d29', label: '#8f8e85', labelStrong: '#c2c1b6', halo: '#1a1a18', waterLabel: '#5e7682',
};

export function mapStyle(dark: boolean, basemap: boolean): StyleSpecification {
  const c = dark ? DARK : LIGHT;
  const layers: StyleSpecification['layers'] = [{id: 'background', type: 'background', paint: {'background-color': c.background}}];
  if (!basemap) return {version: 8, sources: {}, layers};
  layers.push(
    {id: 'park', type: 'fill', source: 'map', 'source-layer': 'park', paint: {'fill-color': c.park}},
    {id: 'water', type: 'fill', source: 'map', 'source-layer': 'water', paint: {'fill-color': c.water}},
    {id: 'building', type: 'fill', source: 'map', 'source-layer': 'building', minzoom: 14, paint: {'fill-color': c.building}},
    {
      id: 'road-minor', type: 'line', source: 'map', 'source-layer': 'transportation', minzoom: 11,
      filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': c.minor, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 1.4, 17, 6]},
    },
    {
      id: 'road-major', type: 'line', source: 'map', 'source-layer': 'transportation', minzoom: 8,
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk']]],
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': c.major, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 1.2, 15, 4, 17, 9]},
    },
    {
      id: 'road-highway', type: 'line', source: 'map', 'source-layer': 'transportation', minzoom: 6,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': c.highway, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 1.8, 16, 7]},
    },
    {
      id: 'rail', type: 'line', source: 'map', 'source-layer': 'transportation', minzoom: 11,
      filter: ['==', ['get', 'class'], 'rail'],
      paint: {'line-color': c.rail, 'line-width': 1},
    },
  );
  return {
    version: 8,
    sources: {map: {type: 'vector', url: SOURCE}},
    glyphs: GLYPHS,
    layers,
  };
}

/** Labels go above the data so street names stay readable through it. */
export function labelLayers(dark: boolean): StyleSpecification['layers'] {
  const c = dark ? DARK : LIGHT;
  return [
    {
      id: 'label-water', type: 'symbol', source: 'map', 'source-layer': 'water_name',
      layout: {'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Italic'], 'text-size': 12},
      paint: {'text-color': c.waterLabel, 'text-halo-color': c.halo, 'text-halo-width': 1},
    },
    {
      id: 'label-street', type: 'symbol', source: 'map', 'source-layer': 'transportation_name', minzoom: 13,
      layout: {
        'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12.5], 'symbol-spacing': 320,
      },
      paint: {'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.4},
    },
    {
      id: 'label-place', type: 'symbol', source: 'map', 'source-layer': 'place', minzoom: 8,
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'neighbourhood', 'village']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Bold'],
        'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 13, 11], 'text-padding': 8,
      },
      paint: {'text-color': c.labelStrong, 'text-halo-color': c.halo, 'text-halo-width': 1.6},
    },
  ];
}
