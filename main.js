import './style.css';
import OLMap from 'ol/Map.js';
import OSM from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';

import GeoJSON from 'ol/format/GeoJSON.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';

import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';

import Select from 'ol/interaction/Select.js';
import { click } from 'ol/events/condition.js';

import Overlay from 'ol/Overlay.js';
import Translate from 'ol/interaction/Translate.js';

import { fromLonLat, toLonLat } from 'ol/proj.js';

// --- Styles ---------------------------------------------------------------
const defaultStyle = new Style({
  stroke: new Stroke({ color: '#2d4257', width: 1.5 }),
  fill: new Fill({ color: 'rgba(52, 152, 219, 0.12)' }),
});
const highlightStyle = new Style({
  stroke: new Stroke({ color: '#e45545', width: 2 }),
  fill: new Fill({ color: 'rgba(231,76,60,0.3)' }),
});
const movedStyle = new Style({
  stroke: new Stroke({ color: '#8e44ad', width: 1.8 }),
  fill: new Fill({ color: 'rgba(155, 89, 182, 0.25)' }),
});

// ---------------------------------------------------------------------------
// TWO-LAYER ARCHITECTURE
// staticLayer — all countries, frozen during drag
// dragLayer   — 1 clone of the dragged feature, repaints every rAF
// ---------------------------------------------------------------------------
const staticSource = new VectorSource({
  url: './data/countries.geojson',
  format: new GeoJSON(),
});

const staticLayer = new VectorLayer({
  source: staticSource,
  style: (feature) => feature.get('moved') ? movedStyle : defaultStyle,
  updateWhileInteracting: false,
  updateWhileAnimating: false,
});

const dragSource = new VectorSource();
const dragLayer = new VectorLayer({
  source: dragSource,
  style: highlightStyle,
  updateWhileInteracting: true,
  updateWhileAnimating: true,
  zIndex: 10,
});

const dragClones = new Map();

// --- Select ---------------------------------------------------------------
const select = new Select({
  condition: click,
  style: highlightStyle,
  layers: [staticLayer],
  hitTolerance: 4,
});

// --- Popup ----------------------------------------------------------------
const container = document.getElementById('popup');
const content   = document.getElementById('popup-content');
const closer    = document.getElementById('popup-closer');

const popup = new Overlay({
  element: container,
  positioning: 'bottom-center',
  autoPan: { animation: { duration: 250 } },
});

closer.onclick = () => {
  popup.setPosition(undefined);
  select.getFeatures().clear();
  closer.blur();
  return false;
};

// ---------------------------------------------------------------------------
// GEODESIC OFFSET REPROJECTION
// store (distance_m, bearing_rad) from the polygon CENTROID to each vertex.

const EARTH_R = 6371000;
const DEG     = Math.PI / 180;

// Compute polygon centroid from flat lon/lat coords.
// Longitudes are unwrapped relative to the first vertex to handle antimeridian
// countries (Russia etc.) correctly.
function computeCentroid(geomLL) {
  const coords = geomLL.getFlatCoordinates();
  if (coords.length < 2) return [0, 0];

  const lon0 = coords[0];
  let sumLon = lon0, sumLat = coords[1], n = 1;

  for (let i = 2; i < coords.length; i += 2) {
    let lon = coords[i];
    // unwrap relative to first vertex so antimeridian crossings average correctly
    while (lon - lon0 >  180) lon -= 360;
    while (lon - lon0 < -180) lon += 360;
    sumLon += lon;
    sumLat += coords[i + 1];
    n++;
  }
  return [sumLon / n, sumLat / n];
}

// Precompute [distance_m, bearing_rad] for every vertex relative to centroid.
function toGeodesicOffsets(geomLL, centroid) {
  const coords  = geomLL.getFlatCoordinates();
  const out     = new Float64Array(coords.length);
  const lat1    = centroid[1] * DEG;
  const lon1    = centroid[0] * DEG;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);

  for (let i = 0; i < coords.length; i += 2) {
    const lat2 = coords[i + 1] * DEG;
    const lon2 = coords[i]     * DEG;
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;

    // Haversine distance
    const a    = Math.sin(dLat / 2) ** 2 + cosLat1 * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const dist = EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    // Initial bearing (clockwise from north)
    const y       = Math.sin(dLon) * Math.cos(lat2);
    const x       = cosLat1 * Math.sin(lat2) - sinLat1 * Math.cos(lat2) * Math.cos(dLon);
    const bearing = Math.atan2(y, x);

    out[i]     = dist;
    out[i + 1] = bearing;
  }
  return out;
}

// Reproject stored geodesic offsets from newCenterLL (spherical destination-point formula).
function buildTrueSizeGeometry(offsets, origGeomLL, newCenterLL) {
  const newGeom = origGeomLL.clone();
  const lat1    = newCenterLL[1] * DEG;
  const lon1    = newCenterLL[0] * DEG;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);

  newGeom.applyTransform((coords, output, stride = 2) => {
    for (let i = 0; i < coords.length; i += stride) {
      const dist    = offsets[i];
      const bearing = offsets[i + 1];
      const angDist = dist / EARTH_R;
      const sinAng  = Math.sin(angDist);
      const cosAng  = Math.cos(angDist);

      const lat2 = Math.asin(
        sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(bearing)
      );
      const lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * sinAng * cosLat1,
        cosAng - sinLat1 * Math.sin(lat2)
      );

      const p = fromLonLat([
        lon2 / DEG,
        Math.max(-85, Math.min(85, lat2 / DEG)),
      ]);
      output[i]     = p[0];
      output[i + 1] = p[1];
    }
    return output;
  });

  return newGeom;
}

// --- Per-feature state ----------------------------------------------------
const originalGeometriesLL = new Map();
const currentCentersLL     = new Map(); // centroid, moves with each drag
const featureOffsets       = new Map(); // geodesic offsets from centroid

const LAT_LIMIT = 80;
const clampLat  = (lat) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, lat));

function ensureStored(feature, clickCoordMerc) {
  if (originalGeometriesLL.has(feature)) return;

  const geomLL   = feature.getGeometry().clone();
  geomLL.transform('EPSG:3857', 'EPSG:4326');

  // Use centroid as geodesic anchor — keeps all angular distances small and stable.
  // The click point only determines drag delta; the centroid is what actually moves.
  const centroid = computeCentroid(geomLL);

  originalGeometriesLL.set(feature, geomLL);
  currentCentersLL.set(feature, [...centroid]);
  featureOffsets.set(feature, toGeodesicOffsets(geomLL, centroid));
}

// --- Select handler -------------------------------------------------------
select.on('select', (e) => {
  const feature = e.selected[0];
  if (feature) {
    ensureStored(feature, e.mapBrowserEvent.coordinate);
    content.innerHTML = `<b>${feature.get('name') || 'Unknown'}</b>`;
    popup.setPosition(e.mapBrowserEvent.coordinate);
  } else {
    popup.setPosition(undefined);
  }
});

// --- Translate ------------------------------------------------------------
const translate = new Translate({ features: select.getFeatures() });

let dragStartMerc = null;
let rafId         = null;
let pendingEvent  = null;

translate.on('translatestart', (e) => {
  popup.setPosition(undefined);
  dragStartMerc = e.coordinate;

  e.features.forEach((feature) => {
    ensureStored(feature, e.coordinate);

    // Clone → dragLayer (only thing repainting every frame)
    const clone = new Feature({ geometry: feature.getGeometry().clone() });
    dragClones.set(feature, clone);
    dragSource.addFeature(clone);

    // Remove original synchronously — no ghost at original position
    staticSource.removeFeature(feature);

    // Block OL's Translate from calling geometry.translate() on the original
    const geom = feature.getGeometry();
    geom._origTranslate = geom.translate.bind(geom);
    geom.translate = () => {};
  });
});

translate.on('translating', (e) => {
  pendingEvent = e;
  if (rafId !== null) return;

  rafId = requestAnimationFrame(() => {
    rafId = null;
    const ev = pendingEvent;
    pendingEvent = null;
    if (!ev || !dragStartMerc) return;

    const startLL   = toLonLat(dragStartMerc);
    const currentLL = toLonLat(ev.coordinate);
    const dLon = currentLL[0] - startLL[0];
    const dLat = currentLL[1] - startLL[1];

    ev.features.forEach((feature) => {
      const origGeomLL  = originalGeometriesLL.get(feature);
      const savedCenter = currentCentersLL.get(feature);
      const offsets     = featureOffsets.get(feature);
      if (!origGeomLL || !savedCenter || !offsets) return;

      const newCenterLL = [savedCenter[0] + dLon, clampLat(savedCenter[1] + dLat)];

      const clone = dragClones.get(feature);
      if (clone) {
        clone.setGeometry(buildTrueSizeGeometry(offsets, origGeomLL, newCenterLL));
      }
    });
  });
});

translate.on('translateend', (e) => {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; pendingEvent = null; }
  if (!dragStartMerc) return;

  const startLL = toLonLat(dragStartMerc);
  const finalLL = toLonLat(e.coordinate);
  const dLon = finalLL[0] - startLL[0];
  const dLat = finalLL[1] - startLL[1];

  e.features.forEach((feature) => {
    // Restore geometry.translate
    const geom = feature.getGeometry();
    if (geom._origTranslate) {
      geom.translate = geom._origTranslate;
      delete geom._origTranslate;
    }

    const savedCenter = currentCentersLL.get(feature);
    const offsets     = featureOffsets.get(feature);
    const origGeomLL  = originalGeometriesLL.get(feature);

    if (savedCenter && offsets && origGeomLL) {
      const newCenter = [savedCenter[0] + dLon, clampLat(savedCenter[1] + dLat)];
      currentCentersLL.set(feature, newCenter);

      const clone = dragClones.get(feature);
      if (clone) {
        feature.setGeometry(clone.getGeometry().clone());
        feature.set('moved', true);
        dragSource.removeFeature(clone);
        dragClones.delete(feature);
      }
    }

    staticSource.addFeature(feature);
  });

  dragStartMerc = null;
});

// --- Reset ----------------------------------------------------------------
document.getElementById('reset-btn').onclick = () => {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; pendingEvent = null; }

  dragClones.forEach((clone, feature) => {
    const geom = feature.getGeometry();
    if (geom._origTranslate) {
      geom.translate = geom._origTranslate;
      delete geom._origTranslate;
    }
    dragSource.removeFeature(clone);
    if (!staticSource.hasFeature(feature)) staticSource.addFeature(feature);
  });
  dragClones.clear();

  originalGeometriesLL.forEach((geomLL, feature) => {
    const origMerc = geomLL.clone();
    origMerc.transform('EPSG:4326', 'EPSG:3857');
    feature.setGeometry(origMerc);
    feature.set('moved', false);
  });
  originalGeometriesLL.clear();
  currentCentersLL.clear();
  featureOffsets.clear();

  select.getFeatures().clear();
  popup.setPosition(undefined);
};

// --- Map ------------------------------------------------------------------
const map = new OLMap({
  target: 'map',
  layers: [
    new TileLayer({ source: new OSM() }),
    staticLayer,
    dragLayer,
  ],
  overlays: [popup],
  view: new View({ center: [0, 0], zoom: 2 }),
  updateWhileInteracting: false,
  updateWhileAnimating: false,
});

map.addInteraction(select);
map.addInteraction(translate);
map.addOverlay(popup);