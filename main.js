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
  url: './data/countries_1000.geojson',
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
// includes antartica logic to 'stitch' the shape to the map boundaries (Antimeridian)
function buildTrueSizeGeometry(offsets, originalGeomLL, newCenterLL) {
  const centerLatRad = newCenterLL[1] * DEG;
  const centerLonRad = newCenterLL[0] * DEG;
  const sinCenterLat = Math.sin(centerLatRad);
  const cosCenterLat = Math.cos(centerLatRad);
  
  let offsetPointer = 0;

  const processCoordinates = (ring) => {
    const projectedPoints = [];
    let prevLon = null;
    let firstLon = null;
    let firstLat = null;
    let lastLat = null;

    for (let i = 0; i < ring.length; i++) {
      // 1. Calculate destination point using geodesic offsets
      const distance = offsets[offsetPointer++];
      const bearing = offsets[offsetPointer++];
      const angularDist = distance / EARTH_R;

      const latRad = Math.asin(
        sinCenterLat * Math.cos(angularDist) + 
        cosCenterLat * Math.sin(angularDist) * Math.cos(bearing)
      );
      const lonRad = centerLonRad + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDist) * cosCenterLat,
        Math.cos(angularDist) - sinCenterLat * Math.sin(latRad)
      );

      const lonDeg = lonRad / DEG;
      const latDeg = Math.max(-85, Math.min(85, latRad / DEG)); // Clamp to Mercator limits

      if (firstLon === null) { 
        firstLon = lonDeg; 
        firstLat = latDeg; 
      }

      // 2. Detect if the segment crosses the Antimeridian (180/-180 jump)
      if (prevLon !== null && Math.abs(lonDeg - prevLon) > 180) {
        addBoundaryStitch(projectedPoints, prevLon, lonDeg, latDeg);
      }

      projectedPoints.push([lonDeg, latDeg]);
      prevLon = lonDeg;
      lastLat = latDeg;
    }

    // 3. Close the loop: Check if the return path to the first vertex crosses the map edge
    if (prevLon !== null && Math.abs(prevLon - firstLon) > 180) {
      addBoundaryStitch(projectedPoints, prevLon, firstLon, firstLat);
    }

    return projectedPoints;
  };

  /**
   * Forces the polygon path to follow the map boundary (Down -> Across -> Up).
   * This prevents the renderer from drawing "shortcuts" across the center of the map.
   */
  function addBoundaryStitch(targetArray, startLon, endLon, targetLat) {
    const isWrappingRight = (endLon - startLon) < 0;
    const edgeLon = isWrappingRight ? 180 : -180;
    const oppositeEdgeLon = isWrappingRight ? -180 : 180;
    
    // Use -85 for Southern Hemisphere (Antarctica) or 85 for Northern Hemisphere
    const boundaryLat = targetLat < 0 ? -85 : 85;

    targetArray.push([startLon, boundaryLat]);        // Drop vertically to boundary
    targetArray.push([edgeLon, boundaryLat]);         // Slide to the edge of the map
    targetArray.push([oppositeEdgeLon, boundaryLat]);   // Teleport to the opposite edge
    targetArray.push([endLon, boundaryLat]);          // Slide to the target longitude
  }

  const geomType = originalGeomLL.getType();
  const rawCoords = originalGeomLL.getCoordinates();
  
  const transformedCoords = (geomType === 'Polygon') 
    ? rawCoords.map(processCoordinates) 
    : rawCoords.map(polygon => polygon.map(processCoordinates));

  // Rebuild the geometry in Web Mercator (EPSG:3857) for display
  const resultGeom = originalGeomLL.clone();
  resultGeom.setCoordinates(transformedCoords);
  resultGeom.transform('EPSG:4326', 'EPSG:3857');
  
  return resultGeom;
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