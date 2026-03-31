import './style.css';
import OLMap from 'ol/Map.js';
import OSM from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Collection from 'ol/Collection.js';

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
  fill:   new Fill({ color: 'rgba(52, 152, 219, 0.12)' }),
});
const highlightStyle = new Style({
  stroke: new Stroke({ color: '#e45545', width: 2 }),
  fill:   new Fill({ color: 'rgba(231,76,60,0.3)' }),
});
const movedStyle = new Style({
  stroke: new Stroke({ color: '#8e44ad', width: 1.8 }),
  fill:   new Fill({ color: 'rgba(155, 89, 182, 0.25)' }),
});

// ---------------------------------------------------------------------------
// LAYERS
//
// staticLayer  — all countries (All Countries mode)
// searchLayer  — only user-added countries (Search mode)
// dragLayer    — 1 clone during drag (both modes)
// ---------------------------------------------------------------------------

// All-countries source (also used as the feature name index)
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

// Search mode source — starts empty, features added via search
const searchSource = new VectorSource();

const searchLayer = new VectorLayer({
  source: searchSource,
  style: (feature) => feature.get('moved') ? movedStyle : defaultStyle,
  updateWhileInteracting: false,
  updateWhileAnimating: false,
  visible: false, // hidden until search mode is activated
});

// Drag layer — always on top
const dragSource = new VectorSource();
const dragLayer  = new VectorLayer({
  source: dragSource,
  style: highlightStyle,
  updateWhileInteracting: true,
  updateWhileAnimating: true,
  zIndex: 10,
});

const dragClones = new Map(); // maps original features (clone in drag layer)

// --- Select & Translate ---------------------------------------------------
const select = new Select({
  condition: click,
  style: highlightStyle,
  layers: [staticLayer, searchLayer], // works on the layer being visible
  hitTolerance: 2,
});

// Separate Collection so we can clear select's features without stopping drag
const translateFeatures = new Collection();
const translate = new Translate({ features: translateFeatures, hitTolerance: 2 });

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
  translateFeatures.clear();
  closer.blur();
  return false;
};

// ---------------------------------------------------------------------------
// GEODESIC OFFSET REPROJECTION
// Store (distance_m, bearing_rad) from the polygon CENTROID to each vertex.

const EARTH_R = 6371000;
const DEG     = Math.PI / 180;

function computeCentroid(geomLL) {
  const coords = geomLL.getFlatCoordinates();
  if (coords.length < 2) return [0, 0];
  const lon0 = coords[0];
  let sumLon = lon0, sumLat = coords[1], n = 1;
  for (let i = 2; i < coords.length; i += 2) {
    let lon = coords[i];
    // unwrapp lons to solve antimeridian problem (so doesn't become average of lon = 0)
    while (lon - lon0 >  180) lon -= 360;
    while (lon - lon0 < -180) lon += 360;
    sumLon += lon;
    sumLat += coords[i + 1];
    n++;
  }
  return [sumLon / n, sumLat / n];
}

// pre-compute distance and bearing per vertex 
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
    // harversine distance
    const a    = Math.sin(dLat / 2) ** 2 + cosLat1 * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const dist = EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    //initial bearing clockwise from north
    const y       = Math.sin(dLon) * Math.cos(lat2);
    const x       = cosLat1 * Math.sin(lat2) - sinLat1 * Math.cos(lat2) * Math.cos(dLon);
    out[i]     = dist;
    out[i + 1] = Math.atan2(y, x);
  }
  return out;
}

// re-project each vertex to the new center using the spherical destination-point formula
function buildTrueSizeGeometry(offsets, originalGeomLL, newCenterLL) {
  const centerLatRad = newCenterLL[1] * DEG;
  const centerLonRad = newCenterLL[0] * DEG;
  const sinCenterLat = Math.sin(centerLatRad);
  const cosCenterLat = Math.cos(centerLatRad);
  let offsetPointer  = 0;

  const processCoordinates = (ring) => {
    const pts = [];
    let prevLon = null, firstLon = null, firstLat = null;
    for (let i = 0; i < ring.length; i++) {
      const distance    = offsets[offsetPointer++];
      const bearing     = offsets[offsetPointer++];
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
      const latDeg = Math.max(-85, Math.min(85, latRad / DEG)); // clamp to Mercator limits
      if (firstLon === null) { firstLon = lonDeg; firstLat = latDeg; }
      if (prevLon !== null && Math.abs(lonDeg - prevLon) > 180) { // if the segment jumps >180° we crossed the antimeridian — stitch it
        addBoundaryStitch(pts, prevLon, lonDeg, latDeg);
      }
      pts.push([lonDeg, latDeg]);
      prevLon = lonDeg;
    }
    if (prevLon !== null && Math.abs(prevLon - firstLon) > 180) { // check the closing segment back to the first vertex
      addBoundaryStitch(pts, prevLon, firstLon, firstLat);
    }
    return pts;
  };

  // Reroutes the path along the map boundary instead of cutting across the middle
  function addBoundaryStitch(arr, startLon, endLon, targetLat) {
    const wrap  = (endLon - startLon) < 0;
    const edge  = wrap ?  180 : -180;
    const opp   = wrap ? -180 :  180;
    const bLat  = targetLat < 0 ? -85 : 85; // bottom edge for SH, top for NH
    arr.push([startLon, bLat], [edge, bLat], [opp, bLat], [endLon, bLat]);
  }

  const type   = originalGeomLL.getType();
  const raw    = originalGeomLL.getCoordinates();
  const result = type === 'Polygon'
    ? raw.map(processCoordinates)
    : raw.map(poly => poly.map(processCoordinates));

  const geom = originalGeomLL.clone();
  geom.setCoordinates(result);
  geom.transform('EPSG:4326', 'EPSG:3857');
  return geom;
}

// --- Per-feature state ----------------------------------------------------
const originalGeometriesLL = new Map(); // lon/lat geom snapshot - never mutated
const currentCentersLL     = new Map(); // centroid, updated after each drag
const featureOffsets       = new Map(); // geodesic offsets - computed once, reused every frame

const LAT_LIMIT = 80;
const clampLat  = (lat) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, lat));

// Called on first interaction with a feature - stores everything needed for reprojection
function ensureStored(feature, clickCoordMerc) {
  if (originalGeometriesLL.has(feature)) return;
  const geomLL   = feature.getGeometry().clone();
  geomLL.transform('EPSG:3857', 'EPSG:4326');
  const centroid = computeCentroid(geomLL);
  originalGeometriesLL.set(feature, geomLL);
  currentCentersLL.set(feature, [...centroid]);
  featureOffsets.set(feature, toGeodesicOffsets(geomLL, centroid));
}

// --- Select handler -------------------------------------------------------
select.on('select', (e) => {
  translateFeatures.clear();
  const feature = e.selected[0];
  if (feature) {
    ensureStored(feature, e.mapBrowserEvent.coordinate);
    translateFeatures.push(feature); // mirror into translate collection
    content.innerHTML = `<b>${feature.get('name') || 'Unknown'}</b>`;
    popup.setPosition(e.mapBrowserEvent.coordinate);
  } else {
    popup.setPosition(undefined);
  }
});

// --- Translate ------------------------------------------------------------
let dragStartMerc = null;
let rafId         = null;
let pendingEvent  = null;

// Which source is active right now
function activeSource() {
  return currentMode === 'all' ? staticSource : searchSource;
}

translate.on('translatestart', (e) => {
  popup.setPosition(undefined);
  dragStartMerc = e.coordinate;

  // clear select's highlight and stop its pointermove hit-detection
  select.getFeatures().clear();
  map.removeInteraction(select);

  e.features.forEach((feature) => {
    ensureStored(feature, e.coordinate);
    const clone = new Feature({ geometry: feature.getGeometry().clone() }); // put a clone in dragLayer
    dragClones.set(feature, clone);
    dragSource.addFeature(clone);
    activeSource().removeFeature(feature);  // remove the original
    const geom = feature.getGeometry();
    geom._origTranslate = geom.translate.bind(geom); // block it so the original stays frozen while the clone moves
    geom.translate = () => {};
  });
});

translate.on('translating', (e) => {
  pendingEvent = e; // buffer the latest event and skip if a frame is already queued
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
      if (clone) clone.setGeometry(buildTrueSizeGeometry(offsets, origGeomLL, newCenterLL));
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
    const geom = feature.getGeometry(); // restore the real geom.translate blocked earlier
    if (geom._origTranslate) { geom.translate = geom._origTranslate; delete geom._origTranslate; }

    const savedCenter = currentCentersLL.get(feature);
    const offsets     = featureOffsets.get(feature);
    const origGeomLL  = originalGeometriesLL.get(feature);

    if (savedCenter && offsets && origGeomLL) {
      const newCenter = [savedCenter[0] + dLon, clampLat(savedCenter[1] + dLat)];
      currentCentersLL.set(feature, newCenter); // record where the centroid ended
      const clone = dragClones.get(feature);
      if (clone) {
        feature.setGeometry(clone.getGeometry().clone()); // copy final geometry back to original
        feature.set('moved', true);
        dragSource.removeFeature(clone);
        dragClones.delete(feature);
      }
    }
    activeSource().addFeature(feature); // put original back in its layer
  });

  dragStartMerc = null;
  translateFeatures.clear();
  map.addInteraction(select);  // re-enable click selection
});

// --- Reset ----------------------------------------------------------------
function resetMap() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; pendingEvent = null; }

  dragClones.forEach((clone, feature) => { // clean up any in-progress drag
    const geom = feature.getGeometry();
    if (geom._origTranslate) { geom.translate = geom._origTranslate; delete geom._origTranslate; }
    dragSource.removeFeature(clone);
    const src = activeSource();
    if (!src.hasFeature(feature)) src.addFeature(feature);
  });
  dragClones.clear();

  originalGeometriesLL.forEach((geomLL, feature) => { // restore all features to their original geometries
    const origMerc = geomLL.clone();
    origMerc.transform('EPSG:4326', 'EPSG:3857');
    feature.setGeometry(origMerc);
    feature.set('moved', false);
  });
  originalGeometriesLL.clear();
  currentCentersLL.clear();
  featureOffsets.clear();
  translateFeatures.clear();

  // In search mode, clear the search layer but keep name index intact
  if (currentMode === 'search') {
    searchSource.clear();
    addedCountries.clear();
    renderDropdown(searchInput.value.trim());
  }

  select.getFeatures().clear();
  popup.setPosition(undefined);
}

document.getElementById('reset-btn').onclick = resetMap;

// ---------------------------------------------------------------------------
// MODE SWITCHING
// ---------------------------------------------------------------------------
let currentMode = 'all'; // 'all' | 'search'

const btnAll    = document.getElementById('btn-all');
const btnSearch = document.getElementById('btn-search');
const searchBox = document.getElementById('search-box');

btnAll.onclick = () => {
  if (currentMode === 'all') return;
  currentMode = 'all';
  btnAll.classList.add('active');
  btnSearch.classList.remove('active');
  searchBox.classList.add('hidden');

  // Clear search layer, restore all-countries layer
  searchSource.clear();
  addedCountries.clear();
  staticLayer.setVisible(true);
  searchLayer.setVisible(false);

  // Clear any drag/select state
  select.getFeatures().clear();
  translateFeatures.clear();
  popup.setPosition(undefined);
  originalGeometriesLL.clear();
  currentCentersLL.clear();
  featureOffsets.clear();
};

btnSearch.onclick = () => {
  if (currentMode === 'search') return;
  currentMode = 'search';
  btnSearch.classList.add('active');
  btnAll.classList.remove('active');
  searchBox.classList.remove('hidden');

  staticLayer.setVisible(false);
  searchLayer.setVisible(true);

  select.getFeatures().clear();
  translateFeatures.clear();
  popup.setPosition(undefined);
  originalGeometriesLL.clear();
  currentCentersLL.clear();
  featureOffsets.clear();

  searchInput.focus();
};

// ---------------------------------------------------------------------------
// SEARCH — name index built once staticSource finishes loading
// ---------------------------------------------------------------------------
const featuresByName = new Map(); // lowercase name -> Feature
const addedCountries = new Set(); // names currently in searchSource

staticSource.on('featuresloadend', () => {
  staticSource.getFeatures().forEach(f => {
    const name = f.get('name');
    if (name) featuresByName.set(name.toLowerCase(), f);
  });
});

const searchInput    = document.getElementById('search-input');
const searchClear    = document.getElementById('search-clear');
const searchDropdown = document.getElementById('search-dropdown');

let activeIdx = -1; // keyboard navigation index

function renderDropdown(query) {
  searchDropdown.innerHTML = '';
  activeIdx = -1;

  if (!query) {
    searchDropdown.classList.add('hidden');
    return;
  }

  const q       = query.toLowerCase();
  const matches = [...featuresByName.keys()]
    .filter(k => k.includes(q))
    .sort((a, b) => {
      // exact starts-with first
      const aStart = a.startsWith(q);
      const bStart = b.startsWith(q);
      if (aStart && !bStart) return -1;
      if (!aStart && bStart) return 1;
      return a.localeCompare(b);
    })
    .slice(0, 12);

  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'no-results';
    li.textContent = 'No countries found';
    searchDropdown.appendChild(li);
  } else {
    matches.forEach((key) => {
      const li      = document.createElement('li');
      const feature = featuresByName.get(key);
      const name    = feature.get('name');
      const added   = addedCountries.has(key);

      li.textContent = name;
      if (added) {
        li.classList.add('added');
        const check = document.createElement('span');
        check.className = 'check';
        check.textContent = '✓ added';
        li.appendChild(check);
      }

      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur input
        addCountryToSearch(key);
      });

      searchDropdown.appendChild(li);
    });
  }

  searchDropdown.classList.remove('hidden');
}

function addCountryToSearch(nameKey) {
  if (addedCountries.has(nameKey)) return;
  const sourceFeature = featuresByName.get(nameKey);
  if (!sourceFeature) return;

  // Clone so we don't mutate the index feature
  const clone = sourceFeature.clone();
  clone.set('name', sourceFeature.get('name'));
  clone.set('moved', false);
  searchSource.addFeature(clone);
  addedCountries.add(nameKey);

  // Update dropdown to show
  renderDropdown(searchInput.value.trim());

  // Optionally zoom to the added feature
  const extent = clone.getGeometry().getExtent();
  map.getView().fit(extent, { padding: [80, 80, 80, 80], maxZoom: 6, duration: 500 });
}

searchInput.addEventListener('input', () => {
  const val = searchInput.value.trim();
  searchClear.classList.toggle('hidden', !val);
  renderDropdown(val);
});

searchInput.addEventListener('keydown', (e) => {
  const items = [...searchDropdown.querySelectorAll('li:not(.no-results)')];
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = (activeIdx + 1) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = (activeIdx - 1 + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  } else if (e.key === 'Enter' && activeIdx >= 0) {
    e.preventDefault();
    const keys = [...featuresByName.keys()]
      .filter(k => k.includes(searchInput.value.toLowerCase()))
      .sort((a, b) => {
        const q = searchInput.value.toLowerCase();
        return (a.startsWith(q) ? -1 : 0) - (b.startsWith(q) ? -1 : 0) || a.localeCompare(b);
      })
      .slice(0, 12);
    if (keys[activeIdx]) addCountryToSearch(keys[activeIdx]);
  } else if (e.key === 'Escape') {
    searchDropdown.classList.add('hidden');
    searchInput.blur();
  }
});

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) renderDropdown(searchInput.value.trim());
});

searchInput.addEventListener('blur', () => {
  // Small delay so mousedown on dropdown item fires first
  setTimeout(() => searchDropdown.classList.add('hidden'), 150);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  searchDropdown.classList.add('hidden');
  searchInput.focus();
});

// --- Map ------------------------------------------------------------------
const map = new OLMap({
  target: 'map',
  layers: [
    new TileLayer({ source: new OSM() }),
    staticLayer,
    searchLayer,
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