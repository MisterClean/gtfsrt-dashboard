import type {NetworkMap} from '../engine/types';
import {downloadFile} from './download';
import {toDisplaySpeed} from './format';
import type {app as appState} from './state.svelte';

/** The current map as GeoJSON, for QGIS or ArcGIS. Speeds use the chosen units. */
export function download(network: NetworkMap, app: typeof appState) {
  const round = (value: number | null) => (value === null ? null : Number(toDisplaySpeed(value, app.units).toFixed(2)));
  const unit = app.units === 'imperial' ? 'mph' : 'kmh';
  const collection = {
    type: 'FeatureCollection',
    features: network.features.map(feature => {
      const properties: Record<string, unknown> = {
        routes: feature.routes.join(' '),
        length_m: Math.round(feature.length_m),
        measurements: feature.measurements,
        [`all_day_${unit}`]: round(feature.all_day),
        [`am_${unit}`]: round(feature.am),
        [`midday_${unit}`]: round(feature.mid),
        [`pm_${unit}`]: round(feature.pm),
      };
      feature.speeds.forEach((value, hour) => {
        if (value !== null) properties[`h${String(hour).padStart(2, '0')}_${unit}`] = round(value);
      });
      return {type: 'Feature', properties, geometry: {type: 'LineString', coordinates: feature.path}};
    }),
  };
  downloadFile('speed-map.geojson', JSON.stringify(collection), 'application/geo+json');
}
