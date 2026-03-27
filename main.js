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

// GeoJSON (map countries) layer --------------------------------
const vectorLayer = new VectorLayer({
  source: new VectorSource({
    url: './data/countries.geojson',
    format: new GeoJSON(),
  }),
  style: function (feature) {
    if (feature.get('moved')) return movedStyle;
    return defaultStyle;
  },
});

// Styles -------------------------------------------------------
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

// Select interaction -------------------------------------------
const select = new Select({ condition: click, style: highlightStyle });

// Popup --------------------------------------------------------
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

// True-size geometry builder -----------------------------------
//
// "True size" means preserving physical (km) distances, not degree offsets.
//
// In Mercator, 1° of longitude = R·cos(lat) km.
// So the same east-west physical distance spans MORE degrees at high latitudes
// (where cos is small) and FEWER degrees near the equator.
//
// When we move a country from origCenterLat to newCenterLat we must
// rescale every longitude offset by:
//   scaleFactor = cos(origCenterLat) / cos(newCenterLat)
//
// Latitude offsets stay unchanged (1° of lat ≈ constant km everywhere).
//
// origGeomLL : geometry in lon/lat (EPSG:4326) — never mutated
// newCenterLL: [lon, lat] of the desired new center
//
// origCenterLL is passed in explicitly — computed from Mercator extent
// so it is correct even for antimeridian-crossing countries like Russia.
// (getExtent() on a lon/lat geometry for Russia returns ~[-180,_,180,_]
//  giving center 0° — the Atlantic — which makes every dLon wrong.)
function buildTrueSizeGeometry(origGeomLL, origCenterLL, newCenterLL) {
  const newGeom = origGeomLL.clone();
  newGeom.applyTransform((coords, output, stride) => {
    stride = stride || 2;
    for (let i = 0; i < coords.length; i += stride) {
      // Normalize vertex lon to within ±180° of the true center.
      let vertexLon = coords[i];
      while (vertexLon - origCenterLL[0] >  180) vertexLon -= 360;
      while (vertexLon - origCenterLL[0] < -180) vertexLon += 360;

      const dLon = vertexLon     - origCenterLL[0];
      const dLat = coords[i + 1] - origCenterLL[1];

      // Per-vertex cosine scaling to preserve physical east-west distance.
      const origVertexLat = origCenterLL[1] + dLat;
      const newVertexLat  = newCenterLL[1]  + dLat;
      const cosOrig  = Math.cos(origVertexLat * Math.PI / 180);
      const cosNew   = Math.cos(newVertexLat  * Math.PI / 180);
      const lonScale = cosOrig / Math.max(Math.abs(cosNew), 0.001);

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

// Per-feature state --------------------------------------------
//
// FIX 2: Store geometry in lon/lat (never mutated after first save),
// plus a separate "current center in lon/lat" that is updated after
// every translateend. This prevents the snap-back glitch on second drag.
//
const originalGeometriesLL = new Map(); // lon/lat geometry, never changed
const originalCentersLL    = new Map(); // original center in lon/lat, never changed
const currentCentersLL     = new Map(); // current center in lon/lat, updated each drag

// clickCoordMerc: the Mercator coordinate where the user clicked.
// Using the click point as anchor completely avoids getExtent() which
// returns wrong results for antimeridian-crossing countries like Russia.
function ensureStored(feature, clickCoordMerc) {
  if (originalGeometriesLL.has(feature)) return;

  const centerLL = toLonLat(clickCoordMerc);  // click point = anchor

  const geomLL = feature.getGeometry().clone();
  geomLL.transform('EPSG:3857', 'EPSG:4326');
  originalGeometriesLL.set(feature, geomLL);
  originalCentersLL.set(feature, [...centerLL]);  // fixed original anchor
  currentCentersLL.set(feature, [...centerLL]);   // will shift each drag
}

// Select handler -----------------------------------------------
select.on('select', function (e) {
  const feature = e.selected[0];
  if (feature) {
    ensureStored(feature, e.mapBrowserEvent.coordinate);  // pass click coord as anchor
    content.innerHTML = `<b>${feature.get('name') || 'Unknown'}</b>`;
    popup.setPosition(e.mapBrowserEvent.coordinate);
  } else {
    popup.setPosition(undefined);
  }
});

// Translate interaction ----------------------------------------
const translate = new Translate({ features: select.getFeatures() });

let dragStartMerc = null; // pointer position (Mercator) when drag began

translate.on('translatestart', function (e) {
  popup.setPosition(undefined);
  dragStartMerc = e.coordinate;
  e.features.forEach((f) => ensureStored(f, e.coordinate));
});

translate.on('translating', function (e) {
  if (!dragStartMerc) return;

  const startLL   = toLonLat(dragStartMerc);
  const currentLL = toLonLat(e.coordinate);
  const dLon = currentLL[0] - startLL[0];
  const dLat = currentLL[1] - startLL[1];

  e.features.forEach((feature) => {
    const origGeomLL   = originalGeometriesLL.get(feature);
    const origCenterLL = originalCentersLL.get(feature);
    const savedCenter  = currentCentersLL.get(feature);
    if (!origGeomLL || !origCenterLL || !savedCenter) return;

    const newCenterLL = [
      savedCenter[0] + dLon,
      savedCenter[1] + dLat,
    ];

    feature.setGeometry(buildTrueSizeGeometry(origGeomLL, origCenterLL, newCenterLL));
    feature.set('moved', true);
  });

  vectorLayer.getSource().changed();
});

translate.on('translateend', function (e) {
  if (!dragStartMerc) return;

  // Commit the drag delta into currentCentersLL so the next drag
  // starts from the correct (already-moved) position.
  const startLL = toLonLat(dragStartMerc);
  const finalLL = toLonLat(e.coordinate);
  const dLon = finalLL[0] - startLL[0];
  const dLat = finalLL[1] - startLL[1];

  e.features.forEach((feature) => {
    const savedCenter = currentCentersLL.get(feature);
    if (!savedCenter) return;
    currentCentersLL.set(feature, [
      savedCenter[0] + dLon,
      savedCenter[1] + dLat,
    ]);
  });

  dragStartMerc = null;
});

// Reset button -------------------------------------------------
const resetBtn = document.getElementById('reset-btn');
resetBtn.onclick = function () {
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

// Map ----------------------------------------------------------
const map = new OLMap({
  target: 'map',
  layers: [
    new TileLayer({ source: new OSM() }),
    vectorLayer,
  ],
  overlays: [popup],
  view: new View({ center: [0, 0], zoom: 2 }),
});

map.addInteraction(select);
map.addInteraction(translate);
map.addOverlay(popup);