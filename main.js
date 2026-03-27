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
const select = new Select({ condition: click, style: highlightStyle });

// --- Popup ----------------------------------------------------------
const container = document.getElementById('popup');
const content   = document.getElementById('popup-content');
const closer    = document.getElementById('popup-closer');

const popup = new Overlay({
  element: container,
  positioning: 'bottom-center',
  autoPan: { animation: { duration: 250 } },
});

closer.onclick = function () { // close popup
  popup.setPosition(undefined);
  select.getFeatures().clear();
  closer.blur();
  return false;
};

// --- True-size geometry builder ------------------------------------------------
// Redraws a country centered on newCenterLL, preserving physical size
// origCenterLL comes from the click point (not getExtent) to avoid antimeridian bugs
function buildTrueSizeGeometry(origGeomLL, origCenterLL, newCenterLL) {
  const newGeom = origGeomLL.clone();
  newGeom.applyTransform((coords, output, stride) => {
    stride = stride || 2;
    for (let i = 0; i < coords.length; i += stride) {

      // Wrap vertex lon to +-180 (fixes antimeridian countries like Russia)
      let vertexLon = coords[i];
      while (vertexLon - origCenterLL[0] >  180) vertexLon -= 360;
      while (vertexLon - origCenterLL[0] < -180) vertexLon += 360;

      const dLon = vertexLon     - origCenterLL[0]; // signed lon offset 
      const dLat = coords[i + 1] - origCenterLL[1]; // signed lat offset 

      // cos ratio per vertex: 1deg lon = cos(lat)*R km -> scale lon to keep physical width
      const cosOrig  = Math.cos((origCenterLL[1] + dLat) * Math.PI / 180); // cos at original lat
      const cosNew   = Math.cos((newCenterLL[1]  + dLat) * Math.PI / 180); // cos at destination lat
      const lonScale = cosOrig / Math.max(Math.abs(cosNew), 0.001); // clamped to avoid div0 near poles

      const projected = fromLonLat([
        newCenterLL[0] + dLon * lonScale, // lon scaled to preserve physical width
        newCenterLL[1] + dLat,            // lat offset unchanged (1deg lat = constant km)
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

// Saves feature state on first interaction, using click point as anchor
// getExtent() is avoided: gives wrong centers for antimeridian countries
function ensureStored(feature, clickCoordMerc) {
  if (originalGeometriesLL.has(feature)) return;

  const centerLL = toLonLat(clickCoordMerc); // click coord -> lon/lat anchor

  const geomLL = feature.getGeometry().clone();
  geomLL.transform('EPSG:3857', 'EPSG:4326'); // convert Mercator -> lon/lat
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

let dragStartMerc = null; // Mercator position where drag began

translate.on('translatestart', function (e) {
  popup.setPosition(undefined);
  dragStartMerc = e.coordinate;
  e.features.forEach((f) => ensureStored(f, e.coordinate));
});

translate.on('translating', function (e) {
  if (!dragStartMerc) return;

  // Delta in lon/lat from drag start to current pointer position
  const startLL   = toLonLat(dragStartMerc);
  const currentLL = toLonLat(e.coordinate);
  const dLon = currentLL[0] - startLL[0];
  const dLat = currentLL[1] - startLL[1];

  e.features.forEach((feature) => {
    const origGeomLL   = originalGeometriesLL.get(feature);
    const origCenterLL = originalCentersLL.get(feature);
    const savedCenter  = currentCentersLL.get(feature);
    if (!origGeomLL || !origCenterLL || !savedCenter) return;

    const newCenterLL = [savedCenter[0] + dLon, savedCenter[1] + dLat];
    feature.setGeometry(buildTrueSizeGeometry(origGeomLL, origCenterLL, newCenterLL));
    feature.set('moved', true);
  });

  vectorLayer.getSource().changed();
});

translate.on('translateend', function (e) {
  if (!dragStartMerc) return;

  // Commit delta into currentCentersLL so next drag starts from current position
  const startLL = toLonLat(dragStartMerc);
  const finalLL = toLonLat(e.coordinate);
  const dLon = finalLL[0] - startLL[0];
  const dLat = finalLL[1] - startLL[1];

  e.features.forEach((feature) => {
    const savedCenter = currentCentersLL.get(feature);
    if (!savedCenter) return;
    currentCentersLL.set(feature, [savedCenter[0] + dLon, savedCenter[1] + dLat]);
  });

  dragStartMerc = null;
});

// --- Reset -----------------------------------------------------------------------
const resetBtn = document.getElementById('reset-btn');
resetBtn.onclick = function () {
  originalGeometriesLL.forEach((geomLL, feature) => {
    const origMerc = geomLL.clone();
    origMerc.transform('EPSG:4326', 'EPSG:3857'); // lon/lat -> Mercator for OL
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
});

map.addInteraction(select);
map.addInteraction(translate);
map.addOverlay(popup);