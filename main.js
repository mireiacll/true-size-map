import './style.css';
import Map from 'ol/Map.js';
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
import {click} from 'ol/events/condition.js';

import Overlay from 'ol/Overlay.js';

// GeoJSON (map countries) layer
const vectorLayer = new VectorLayer({
    source: new VectorSource({
        url:'./data/countries.geojson', 
        format: new GeoJSON(),
    }),
    style: new Style({
        stroke: new Stroke({
            color:'#2d4257',
            width: 1.5,
        }),
        fill: new Fill({
            color: 'rgba(52, 152, 219, 0.12)'
        }),
    }),
});

// styling of selected country
const highlightStyle = new Style({
    stroke: new Stroke({
        color: '#e45545',
        width: 2,
    }),
    fill: new Fill({
        color: 'rgba(231,76,60,0.3)'
    }),
});

// select event
const select = new Select({
    condition: click,
    style: highlightStyle,
})

// popup
const container = document.getElementById('popup');
const content = document.getElementById('popup-content');
const closer = document.getElementById('popup-closer');
const popup = new Overlay({
    element: container,
    positioning: 'bottom-center',
    // autoPan: {
    //     animation: {
    //     duration: 250,
    //     },
    // },
});

// close button logic
closer.onclick = function () {
  popup.setPosition(undefined);
  select.getFeatures().clear();   // ← this line was missing
  closer.blur();
  return false;
};

// popup and coordinates
select.on('select', function(e){
    const feature = e.selected[0];
    if (feature){
        const properties = feature.getProperties();
        const name = properties.name || 'Unknown';
        const coordinates = e.mapBrowserEvent.coordinate; // get click position
        content.innerHTML=`<b>${name}</b>`;
        popup.setPosition(coordinates);
    }else{
        popup.setPosition(undefined);
    }
})

// basic setting
const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new OSM(),
    }),
    vectorLayer,
  ],
  overlays:[popup],
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});

map.addInteraction(select);
map.addOverlay(popup);