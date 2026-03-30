import './style.css';
import OLMap from 'ol/Map.js';
import OSM from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import View from 'ol/View.js';

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

// --- Layer ---------------------------------------------------------------
const vectorLayer = new VectorLayer({
  source: new VectorSource({
    url: './data/countries.geojson',
    format: new GeoJSON(),
  }),
  style: (feature) => feature.get('moved') ? movedStyle : defaultStyle,
  // don't re-render the full layer on every pointer move frame
  updateWhileInteracting: false,
  updateWhileAnimating: false,
});

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

// --- Select -------------------------------------------------------------
const select = new Select({
  condition: click,
  style: highlightStyle,
  // A small hitTolerance avoids pixel reads for each pointer move event (improve performancxe)
  hitTolerance: 4,
});

// --- Popup ----------------------------------------------------------
const container = document.getElementById('popup');
const content   = document.getElementById('popup-content');
const closer    = document.getElementById('popup-closer');

const popup = new Overlay({
  element: container,
  positioning: 'bottom-center',
  autoPan: { animation: { duration: 250 } },
});

closer.onclick = function () {
  popup.setPosition(undefined);
  select.getFeatures().clear();
  closer.blur();
  return false;
};

// --- True-size geometry builder ------------------------------------------------
// Redraws a country centered on newCenterLL, preserving physical size.
// origCenterLL comes from the click point (not getExtent) to avoid antimeridian bugs.
function buildTrueSizeGeometry(origGeomLL, origCenterLL, newCenterLL, isCircumpolarFlag) {
  const newGeom = origGeomLL.clone();

  // In circumpolar countries (antartida) cos-ratio produces NaN/0 at poles and ±180° dLon extremes
  // A plain lat/lon shift preserves their (already Mercator-distorted) shape
  if (isCircumpolarFlag) {
    const dLon = newCenterLL[0] - origCenterLL[0];
    const dLat = newCenterLL[1] - origCenterLL[1];
    newGeom.applyTransform((coords, output, stride) => {
      stride = stride || 2;
      for (let i = 0; i < coords.length; i += stride) {
        const projected = fromLonLat([
          coords[i]     + dLon,
          Math.max(-85, Math.min(85, coords[i + 1] + dLat)),
        ]);
        output[i]     = projected[0];
        output[i + 1] = projected[1];
      }
      return output;
    });
    return newGeom;
  }

  newGeom.applyTransform((coords, output, stride) => {
    stride = stride || 2;
    for (let i = 0; i < coords.length; i += stride) {

      // Wrap vertex lon to +-180 relative to the anchor (fixes antimeridian countries like Russia)
      let vertexLon = coords[i];
      while (vertexLon - origCenterLL[0] >  180) vertexLon -= 360;
      while (vertexLon - origCenterLL[0] < -180) vertexLon += 360;

      const dLon = vertexLon     - origCenterLL[0];
      const dLat = coords[i + 1] - origCenterLL[1];

      const newVertexLat = Math.max(-85, Math.min(85, newCenterLL[1] + dLat));

      // (Antarctica / polar): clamp the latitudes so they never reach +-90° (cos = 0)
      const clampedOrigLat = Math.max(-80, Math.min(80, origCenterLL[1] + dLat));
      const clampedNewLat  = Math.max(-80, Math.min(80, newVertexLat));

      const cosOrig  = Math.cos(clampedOrigLat * Math.PI / 180);
      const cosNew   = Math.cos(clampedNewLat  * Math.PI / 180);
      const lonScale = Math.min(cosOrig / Math.max(Math.abs(cosNew), 0.001), 8);

      const projected = fromLonLat([
        newCenterLL[0] + dLon * lonScale,
        newCenterLL[1] + dLat,
      ]);
      output[i]     = projected[0];
      output[i + 1] = projected[1];
    }
    return output;
  });
  return newGeom;
}

// --- Per-feature state ----------------------------------------------------------
const originalGeometriesLL = new Map(); // lon/lat geometry, never mutated
const originalCentersLL    = new Map(); // anchor at first click, never mutated
const currentCentersLL     = new Map(); // updated after each drag ends

const LAT_LIMIT = 80;
function clampLat(lat) { return Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, lat)); }

function ensureStored(feature, clickCoordMerc) {
  if (originalGeometriesLL.has(feature)) return;

  const centerLL = toLonLat(clickCoordMerc);

  const geomLL = feature.getGeometry().clone();
  geomLL.transform('EPSG:3857', 'EPSG:4326');
  originalGeometriesLL.set(feature, geomLL);
  originalCentersLL.set(feature, [...centerLL]);
  currentCentersLL.set(feature, [...centerLL]);
}

// --- Select handler -----------------------------------------------------------
select.on('select', function (e) {
  const feature = e.selected[0];
  if (feature) {
    ensureStored(feature, e.mapBrowserEvent.coordinate);
    content.innerHTML = `<b>${feature.get('name') || 'Unknown'}</b>`;
    popup.setPosition(e.mapBrowserEvent.coordinate);
  } else {
    popup.setPosition(undefined);
  }
});

// --- Drag ---------------------------------------------------------------------
const translate = new Translate({ features: select.getFeatures() });

let dragStartMerc = null;
// the `translating` event fires on EVERY mousemove --> iterates every vertex each call --> expensive 
// Throttle to one geometry rebuild per animation frame (60fps) (IMPROVE PERFORMANCE)
let rafId = null;
let pendingTranslate = null;

translate.on('translatestart', function (e) {
  popup.setPosition(undefined);
  dragStartMerc = e.coordinate;
  e.features.forEach((f) => ensureStored(f, e.coordinate));
});

translate.on('translating', function (e) {
  // Snapshot the latest event; the rAF callback will pick up the most recent one
  pendingTranslate = e;
  if (rafId !== null) return; // already a frame queued -> don't pile up more work

  rafId = requestAnimationFrame(() => {
    rafId = null;
    const ev = pendingTranslate;
    pendingTranslate = null;
    if (!ev || !dragStartMerc) return;

    const startLL   = toLonLat(dragStartMerc);
    const currentLL = toLonLat(ev.coordinate);
    const dLon = currentLL[0] - startLL[0];
    const dLat = currentLL[1] - startLL[1];

    ev.features.forEach((feature) => {
      const origGeomLL   = originalGeometriesLL.get(feature);
      const origCenterLL = originalCentersLL.get(feature);
      const savedCenter  = currentCentersLL.get(feature);
      if (!origGeomLL || !origCenterLL || !savedCenter) return;

      const isCircumpolarFlag = feature.get('name') =="Antarctica";
      const newCenterLL = [savedCenter[0] + dLon, clampLat(savedCenter[1] + dLat)];
      feature.setGeometry(buildTrueSizeGeometry(origGeomLL, origCenterLL, newCenterLL,isCircumpolarFlag));
      feature.set('moved', true);
    });
  });
});

translate.on('translateend', function (e) {
  // Cancel any pending rAF so the end position is set cleanly on the next pick-up
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    pendingTranslate = null;
  }
  if (!dragStartMerc) return;

  const startLL = toLonLat(dragStartMerc);
  const finalLL = toLonLat(e.coordinate);
  const dLon = finalLL[0] - startLL[0];
  const dLat = finalLL[1] - startLL[1];

  e.features.forEach((feature) => {
    const savedCenter = currentCentersLL.get(feature);
    if (!savedCenter) return;
    currentCentersLL.set(feature, [savedCenter[0] + dLon, clampLat(savedCenter[1] + dLat)]);
  });
  dragStartMerc = null;
});

// --- Reset -----------------------------------------------------------------------
const resetBtn = document.getElementById('reset-btn');
resetBtn.onclick = function () {
  // Cancel any in-flight drag RAF before clearing state
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    pendingTranslate = null;
  }
  originalGeometriesLL.forEach((geomLL, feature) => {
    const origMerc = geomLL.clone();
    origMerc.transform('EPSG:4326', 'EPSG:3857');
    feature.setGeometry(origMerc);
    feature.set('moved', false);
  });
  originalGeometriesLL.clear();
  originalCentersLL.clear();
  currentCentersLL.clear();
  select.getFeatures().clear();
  popup.setPosition(undefined);
};

// --- Map ------------------------------------------------------------------------
const map = new OLMap({
  target: 'map',
  layers: [new TileLayer({ source: new OSM() }), vectorLayer],
  overlays: [popup],
  view: new View({ center: [0, 0], zoom: 2 }),
  updateWhileInteracting: false,
  updateWhileAnimating: false,
});

map.addInteraction(select);
map.addInteraction(translate);
map.addOverlay(popup);