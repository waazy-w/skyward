import Globe from 'globe.gl';
import * as THREE from 'three';
import {
  CATEGORIES, classify, tleInfo, orbitRegime, makeSatrec, stateAt, eciToLatLngAlt,
  orbitPath, observerGeo, lookAnglesFromLatLngAlt, predictPasses, compass, gstime,
  EARTH_RADIUS_KM, GLOBE_RADIUS, toGlobeXYZ,
} from './orbit.js';
import { createPointLayer, hexToRgb } from './pointLayer.js';
import { KesslerSim } from './kessler.js';
import { Flashes } from './fx.js';
import * as sfx from './sound.js';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const DEFAULT_OBSERVER = { lat: 43.7286, lng: -79.6066, label: 'Humber College, Toronto' };
const OVERVIEW_POV = { altitude: 3.2 };
// High-res satellite imagery that streams in sharper tiles as you zoom.
const TILE_URL = (x, y, l) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`;
const TILE_FADE_MS = 450;
const FOCUS_FLY_MS = 1600;
const MAX_KESSLER_JUMP_SEC = 6 * 3600; // bigger time jumps reset the crash sim
const ISS_RE = /^ISS \(ZARYA\)/;
// Friendly names people search for that differ from the catalog names.
const SEARCH_ALIASES = { HUBBLE: 'HST', 'SPACE STATION': 'ISS (ZARYA)', ISS: 'ISS (ZARYA)', TIANGONG: 'CSS (TIANHE)' };

// --- App state -------------------------------------------------------------
const state = {
  sats: [], // { name, cat, l1, l2 }
  geo: null, // Float32Array lat,lng,altKm per sat (latest from worker)
  simTime: Date.now(),
  speed: 1,
  live: true, // locked to the real clock (until the user pauses or fast-forwards)
  autoSpeed: false, // the crash sim sped up time on its own
  mode: 'home',
  selected: null,
  selectedRec: null,
  solo: null, // when set, only this category is shown
  destroyed: new Set(),
  observer: null,
  above: [], // indices above the observer's horizon
  aboveList: [],
  chain: true,
  crashSite: null, // index of the smashed object the camera tracks in Kessler mode
  crashRec: null,
};

const isHidden = (cat) => state.solo !== null && cat !== state.solo;

// --- Globe -------------------------------------------------------------------
const globe = new Globe($('globe'))
  .globeImageUrl(`${BASE}earth-blue-marble.jpg`)
  .bumpImageUrl(`${BASE}earth-topology.png`)
  .backgroundImageUrl(`${BASE}night-sky.png`)
  .atmosphereColor('#4da3ff')
  .atmosphereAltitude(0.18)
  .pathPoints((d) => d.pts)
  .pathPointLat((p) => p[0])
  .pathPointLng((p) => p[1])
  .pathPointAlt((p) => p[2])
  .pathColor((d) => d.color)
  .pathStroke(1.5)
  .pathTransitionDuration(0)
  .ringColor((d) => (t) => `rgba(${d.rgb},${1 - t})`)
  .ringMaxRadius((d) => d.radius)
  .ringPropagationSpeed((d) => d.speed ?? 4)
  .ringRepeatPeriod((d) => d.repeat ?? 600)
  .htmlElement((d) => (d.kind === 'sat' ? satMarker(d) : observerPin()))
  .htmlAltitude((d) => d.alt ?? 0.003)
  .htmlTransitionDuration(0)
  // Hide labels when their object is behind the Earth.
  .htmlElementVisibilityModifier((el, visible) => { el.style.opacity = visible ? 1 : 0; })
  .pointOfView({ lat: 25, lng: -60, altitude: 4.2 });

// Use streamed tiles if the tile server answers; otherwise keep the bundled image.
fetch(TILE_URL(0, 0, 0), { mode: 'cors' })
  .then((r) => {
    if (!r.ok) return;
    globe.globeTileEngineUrl(TILE_URL).globeTileEngineMaxLevel(17);
    tuneTileEngine();
  })
  .catch(() => {});

// The tile engine swaps in sharper imagery as you zoom. Out of the box it waits
// too long and pops tiles in abruptly, so: switch levels earlier, fade each new
// tile in over the old one, and use anisotropic filtering for oblique views.
let tileEngine = null;
const fadingTiles = new Set();
function tuneTileEngine() {
  globe.scene().traverse((o) => {
    if (!tileEngine && Array.isArray(o.thresholds) && typeof o.updatePov === 'function') tileEngine = o;
  });
  if (!tileEngine) return;
  const bias = 2 * Math.min(window.devicePixelRatio || 1, 1.5);
  tileEngine.thresholds = tileEngine.thresholds.map((t) => t * bias);
  const maxAniso = globe.renderer().capabilities.getMaxAnisotropy();
  const add = tileEngine.add.bind(tileEngine);
  tileEngine.add = (...objs) => {
    for (const o of objs) {
      const m = o.material;
      if (!m?.map) continue;
      m.map.anisotropy = maxAniso;
      m.transparent = true;
      m.opacity = 0;
      m.needsUpdate = true;
      o.userData.fadeStart = performance.now();
      fadingTiles.add(o);
    }
    return add(...objs);
  };
}

function fadeTiles(now) {
  for (const o of fadingTiles) {
    const t = Math.min(1, (now - o.userData.fadeStart) / TILE_FADE_MS);
    if (!o.parent || t >= 1) {
      if (o.material) { o.material.opacity = 1; o.material.transparent = false; o.material.needsUpdate = true; }
      fadingTiles.delete(o);
    } else {
      o.material.opacity = t * t * (3 - 2 * t);
    }
  }
}

// A map-pin shape (not a dot) so "you" never looks like a satellite.
function observerPin() {
  const el = document.createElement('div');
  el.className = 'observer-pin';
  el.innerHTML = `<span class="pulse"></span>
    <svg viewBox="0 0 28 38" aria-hidden="true"><path d="M14 1C6.8 1 1 6.7 1 13.8 1 23.5 14 37 14 37s13-13.5 13-23.2C27 6.7 21.2 1 14 1z"/><circle cx="14" cy="13.5" r="5"/></svg>
    <span class="label">You are here</span>`;
  return el;
}

function satMarker(d) {
  const el = document.createElement('div');
  el.className = `sat-marker${d.danger ? ' danger' : ''}`;
  el.innerHTML = `<span class="ring"></span><span class="label">${esc(d.name)}</span>`;
  return el;
}

// On phones the info panel covers the bottom of the screen, so the globe is
// drawn in the space above it (keeping whatever we follow in view).
function layoutGlobe() {
  const phone = innerWidth <= 860;
  globe.width(innerWidth).height(phone ? Math.round(innerHeight * 0.58) : innerHeight);
}
layoutGlobe();
window.addEventListener('resize', layoutGlobe);

const controls = globe.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = GLOBE_RADIUS * 1.1;
controls.maxDistance = GLOBE_RADIUS * 20;
controls.addEventListener('start', () => { controls.autoRotate = false; });

const satLayer = createPointLayer(1);
const kessler = new KesslerSim();
globe.scene().add(kessler.layer.points);
const flashes = new Flashes(globe.scene());

// --- Load data -------------------------------------------------------------
const worker = new Worker(new URL('./propagator.worker.js', import.meta.url), { type: 'module' });
let workerBusy = true;
let lastPostedTime = null;
let fetchedAt = null;
let issIndex = -1;

async function init() {
  const res = await fetch(`${BASE}data/tle.json`);
  const data = await res.json();
  fetchedAt = new Date(data.fetched);
  state.sats = data.sats.map((s) => ({ name: s.n, cat: classify(s.n, s.k), l1: s.l1, l2: s.l2 }));
  issIndex = state.sats.findIndex((s) => ISS_RE.test(s.name));
  $('loading-text').textContent = `Computing orbits for ${fmt(state.sats.length)} objects…`;

  const layer = createPointLayer(state.sats.length);
  Object.assign(satLayer, layer);
  globe.scene().add(satLayer.points);
  restyle();
  buildLegend();

  worker.postMessage({ type: 'init', sats: state.sats.map(({ l1, l2 }) => ({ l1, l2 })) });
}

// The worker only refreshes positions a few times a second. To keep motion
// smooth, every frame we extrapolate each dot along its latest movement.
const track = { prev: null, prevT: 0, cur: null, curT: 0 };

function renderPositions() {
  const { prev, cur } = track;
  if (!prev || !cur) return;
  const span = track.curT - track.prevT;
  let k = span > 0 ? (state.simTime - track.curT) / span : 0;
  if (!(k > 0) || k > 3) k = Math.max(0, Math.min(k || 0, 3));
  const out = satLayer.position.array;
  for (let j = 0; j < cur.length; j += 3) {
    // Objects that failed to propagate in either sample sit at (0,0,0):
    // don't extrapolate those or they'd shoot off into space.
    const bad = (cur[j] === 0 && cur[j + 1] === 0 && cur[j + 2] === 0) || (prev[j] === 0 && prev[j + 1] === 0 && prev[j + 2] === 0);
    const kk = bad ? 0 : k;
    out[j] = cur[j] + (cur[j] - prev[j]) * kk;
    out[j + 1] = cur[j + 1] + (cur[j + 1] - prev[j + 1]) * kk;
    out[j + 2] = cur[j + 2] + (cur[j + 2] - prev[j + 2]) * kk;
  }
  satLayer.position.needsUpdate = true;
}

// After a big time jump, extrapolating from old samples is meaningless:
// show the newest sample as-is until fresh positions arrive.
function resyncPositions() {
  if (track.cur) { satLayer.position.array.set(track.cur); satLayer.position.needsUpdate = true; }
  track.prev = null;
  lastPostedTime = null;
}

// The object the camera is following gets its exact orbit position every
// frame (one SGP4 call), so the follow-cam glides instead of stepping.
const pinned = {};
function pinExact(i, rec) {
  if (i === null || !rec || !satLayer.position) return;
  const date = new Date(state.simTime);
  const pv = stateAt(rec, date);
  if (!pv) return;
  const g = eciToLatLngAlt(pv.position, gstime(date));
  toGlobeXYZ(g.lat, g.lng, g.alt, pinned);
  const a = satLayer.position.array;
  a[i * 3] = pinned.x; a[i * 3 + 1] = pinned.y; a[i * 3 + 2] = pinned.z;
  satLayer.position.needsUpdate = true;
}

// Lat/lng/alt of a dot exactly where it's drawn this frame.
function renderedLatLngAlt(i) {
  if (i === null || !latLngAlt(i)) return null;
  const a = satLayer.position.array;
  const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
  const r = Math.hypot(x, y, z);
  if (!r) return null;
  let lng = 90 - (Math.atan2(z, x) * 180) / Math.PI;
  if (lng > 180) lng -= 360;
  return { lat: 90 - (Math.acos(y / r) * 180) / Math.PI, lng, alt: (r / GLOBE_RADIUS - 1) * EARTH_RADIUS_KM };
}

worker.onmessage = ({ data }) => {
  if (data.type === 'ready') {
    workerBusy = false;
    return;
  }
  if (data.type === 'positions') {
    track.prev = track.cur; track.prevT = track.curT;
    track.cur = data.xyz; track.curT = data.time;
    if (!track.prev) { satLayer.position.array.set(data.xyz); satLayer.position.needsUpdate = true; }
    satLayer.geometry.setDrawRange(0, state.sats.length);
    state.geo = data.geo;
    workerBusy = false;
    if (!$('loading').classList.contains('done')) {
      $('loading').classList.add('done');
      renderPanel();
    }
  }
};

// --- Camera director ---------------------------------------------------------
// One place that moves the camera while tracking something: it flies from the
// current view to a moving target, then keeps it centred every frame.
const cam = { target: null, kind: null, anim: null, dragging: false };

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Fly to `getTarget()` (re-evaluated every frame, so moving targets are fine)
// ending at altitude `toAlt` (or the current altitude), then keep following.
function follow(getTarget, kind, toAlt = null, ms = FOCUS_FLY_MS) {
  controls.autoRotate = false;
  const from = globe.pointOfView();
  cam.target = getTarget;
  cam.kind = kind;
  cam.anim = { from, toAlt: toAlt ?? from.altitude, start: performance.now(), ms, moveLatLng: true };
  refreshFollowButtons();
}

// Change only the zoom while continuing to follow.
function zoomTo(toAlt, ms) {
  if (!cam.target) return;
  cam.anim = { from: globe.pointOfView(), toAlt, start: performance.now(), ms, moveLatLng: false };
}

function stopFollow() {
  cam.target = null;
  cam.kind = null;
  cam.anim = null;
  refreshFollowButtons();
}

const isFollowing = (kind) => cam.target !== null && cam.kind === kind;

function updateCamera(now) {
  if (!cam.target || cam.dragging) return;
  const t = cam.target();
  if (!t) return;
  let { lat, lng } = t;
  let altitude = globe.pointOfView().altitude;
  if (cam.anim) {
    const a = cam.anim;
    const p = ease(Math.min(1, (now - a.start) / a.ms));
    if (a.moveLatLng) {
      const dLng = ((t.lng - a.from.lng + 540) % 360) - 180;
      lat = a.from.lat + (t.lat - a.from.lat) * p;
      lng = a.from.lng + dLng * p;
    }
    altitude = a.from.altitude + (a.toAlt - a.from.altitude) * p;
    if (p >= 1) cam.anim = null;
  }
  globe.pointOfView({ lat, lng, altitude });
}

// --- Styling of the satellite dots ------------------------------------------
const catRgb = Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, hexToRgb(c.color)]));

function restyle() {
  const { color, size } = satLayer;
  if (!color) return;
  const aboveSet = state.mode === 'above' ? new Set(state.above) : null;
  const focused = state.mode === 'sat' && state.selected !== null;
  // During a crash, fade everything else so the red junk stands out.
  const crashView = state.mode === 'kessler' && (kessler.count > 0 || state.crashSite !== null);
  document.body.classList.toggle('focused', focused || crashView);
  for (let i = 0; i < state.sats.length; i++) {
    const s = state.sats[i];
    let rgb = catRgb[s.cat];
    let sz = CATEGORIES[s.cat].size;
    if (state.solo === s.cat) sz = Math.max(sz * 3, 6); // big enough to see from far out
    if (isHidden(s.cat) || state.destroyed.has(i)) sz = 0;
    else if (i === state.selected || (i === state.crashSite && !state.destroyed.has(i))) { rgb = [1, 1, 1]; sz = 10; }
    else if (focused) { rgb = rgb.map((v) => v * 0.22); sz *= 0.8; }
    else if (crashView) { rgb = rgb.map((v) => v * 0.3); sz *= 0.8; }
    else if (aboveSet) {
      if (aboveSet.has(i)) sz = Math.max(sz * 1.8, 3.5);
      else rgb = rgb.map((v) => v * 0.25);
    }
    color.array.set(rgb, i * 3);
    size.array[i] = sz;
  }
  color.needsUpdate = size.needsUpdate = true;
}

// --- Legend (category filter) -----------------------------------------------
function buildLegend() {
  const counts = {};
  for (const s of state.sats) counts[s.cat] = (counts[s.cat] || 0) + 1;
  $('total').textContent = fmt(state.sats.length);
  $('legend-list').innerHTML = Object.entries(CATEGORIES)
    .map(([k, c]) => `<li data-cat="${k}" role="button" tabindex="0" aria-pressed="${state.solo === k}" class="${isHidden(k) ? 'off' : ''}${state.solo === k ? ' solo' : ''}" style="--c:${c.color}"><span class="dot"></span>${c.label}<span class="count">${fmt(counts[k] || 0)}</span></li>`)
    .join('');
  $('legend-list').querySelectorAll('li').forEach((li) => {
    activate(li, () => setSolo(state.solo === li.dataset.cat ? null : li.dataset.cat));
  });
  $('legend-hint').innerHTML = state.solo
    ? `Showing only ${CATEGORIES[state.solo].label}. <button class="link" id="show-all">Show all</button>`
    : 'Click a category to show only that type.';
  if ($('show-all')) $('show-all').onclick = () => setSolo(null);
  const hrs = Math.round((Date.now() - fetchedAt) / 3600000);
  $('data-age').textContent = `Orbit data updated ${hrs < 1 ? 'under an hour' : hrs + 'h'} ago.`;
}

// Show only one category, and zoom out far enough to see its whole shell
// (GPS orbits ~20,000 km up, geostationary ~36,000 km).
function setSolo(cat) {
  sfx.click();
  state.solo = cat;
  buildLegend();
  restyle();
  if (state.mode === 'above') { computeAbove(); refreshAbovePanel(); }
  if (state.mode !== 'home' || !state.geo) return;
  let altitude = OVERVIEW_POV.altitude;
  if (cat) {
    const alts = [];
    for (let i = 0; i < state.sats.length; i++) if (state.sats[i].cat === cat && !Number.isNaN(state.geo[i * 3])) alts.push(state.geo[i * 3 + 2]);
    alts.sort((a, b) => a - b);
    const shell = 1 + (alts[Math.floor(alts.length * 0.9)] || 0) / EARTH_RADIUS_KM; // 90th percentile radius
    altitude = Math.min(14, Math.max(2.4, shell * 2 - 1));
  }
  globe.pointOfView({ ...globe.pointOfView(), altitude }, 1400);
}

// Make a non-button element clickable with mouse and keyboard.
function activate(el, fn) {
  el.onclick = fn;
  el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

// --- Picking (hover + click) -------------------------------------------------
const raycaster = new THREE.Raycaster();
const globeSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_RADIUS);
const tmpVec = new THREE.Vector3();

function pick(clientX, clientY) {
  if (!satLayer.points || !state.geo) return null;
  const canvas = globe.renderer().domElement;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const camera = globe.camera();
  raycaster.setFromCamera(ndc, camera);
  // Pick tolerance shrinks as you zoom in, so crowded areas stay clickable.
  raycaster.params.Points.threshold = Math.max(0.15, (camera.position.length() - GLOBE_RADIUS) * 0.01);
  const limit = raycaster.ray.intersectSphere(globeSphere, tmpVec) ? raycaster.ray.origin.distanceTo(tmpVec) : Infinity;
  let best = null;
  for (const h of raycaster.intersectObject(satLayer.points)) {
    if (h.distance > limit || satLayer.size.array[h.index] === 0) continue;
    // Prefer the dot closest to the cursor; stations win ties since they matter most.
    const score = h.distanceToRay - (state.sats[h.index].cat === 'station' ? 1 : 0);
    if (!best || score < best.score) best = { index: h.index, score };
  }
  return best ? best.index : null;
}

const canvasEl = () => globe.renderer().domElement;
let downAt = null;
let hoverQueued = false;
window.addEventListener('pointerdown', (e) => {
  sfx.unlockAudio();
  if (e.target !== canvasEl()) return;
  downAt = [e.clientX, e.clientY];
  cam.dragging = true; // let the user grab the camera while following
});
window.addEventListener('pointerup', (e) => {
  cam.dragging = false;
  if (!downAt || e.target !== canvasEl()) { downAt = null; return; }
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) {
    // Dragging the globe takes the camera back from the follow-cam.
    if (cam.target) stopFollow();
    return;
  }
  const i = pick(e.clientX, e.clientY);
  if (i !== null) select(i);
});
// A drag can end outside the page; never leave the follow-cam frozen.
const endDrag = () => { cam.dragging = false; downAt = null; };
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);
window.addEventListener('pointermove', (e) => {
  if (hoverQueued || e.target !== canvasEl()) {
    if (e.target !== canvasEl()) $('tooltip').hidden = true;
    return;
  }
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    const i = pick(e.clientX, e.clientY);
    const tip = $('tooltip');
    canvasEl().style.cursor = i !== null ? 'pointer' : '';
    if (i === null || i === state.selected) { tip.hidden = true; return; }
    const s = state.sats[i];
    tip.innerHTML = `<span class="dot" style="--c:${CATEGORIES[s.cat].color};display:inline-block;margin-right:6px"></span>${esc(s.name)}`;
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY + 14}px`;
    tip.hidden = false;
  });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.mode === 'sat') setMode('home');
});

// Coming back to the tab after a while: positions are stale, so resync.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lastFrame = performance.now();
    resyncPositions();
  }
});

// --- Selection & focus ------------------------------------------------------
function select(i) {
  if (cinematic) return;
  const s = state.sats[i];
  if (!latLngAlt(i)) { toast(`Can't locate ${esc(s.name)} right now.`); return; }
  state.selected = i;
  state.selectedRec = makeSatrec(s.l1, s.l2);
  s.info ??= tleInfo(s.l1, s.l2);
  satPasses = null;
  sfx.chime();
  if (state.mode === 'kessler') {
    renderPanel();
  } else {
    setMode('sat');
    focusOn(i);
  }
  updateOrbitPath();
  updateSatMarker();
  restyle();
}

// Fly the camera in close to the object, then keep following it.
function focusOn(i) {
  const g = latLngAlt(i);
  if (!g) return;
  sfx.whoosh(1.2);
  follow(() => renderedLatLngAlt(i), 'sat', g.alt / EARTH_RADIUS_KM + (g.alt > 5000 ? 1.2 : 0.45));
}

function latLngAlt(i) {
  if (i === null || !state.geo || Number.isNaN(state.geo[i * 3])) return null;
  return { lat: state.geo[i * 3], lng: state.geo[i * 3 + 1], alt: state.geo[i * 3 + 2] };
}

// The orbit line covers one lap from `pathFrom`; redraw when time leaves that window.
let pathFrom = 0;
let lastPathAt = 0;
function updateOrbitPath() {
  lastPathAt = performance.now();
  if (state.selected === null || !state.selectedRec || state.destroyed.has(state.selected)) {
    globe.pathsData([]);
    return;
  }
  const s = state.sats[state.selected];
  pathFrom = state.simTime;
  const pts = orbitPath(state.selectedRec, new Date(state.simTime), s.info.periodMin);
  globe.pathsData([{ pts, color: ['rgba(255,255,255,0.9)', 'rgba(90,200,250,0.15)'] }]);
}

function orbitPathStale() {
  if (state.selected === null) return false;
  const period = state.sats[state.selected].info.periodMin * 60000;
  return state.simTime < pathFrom || state.simTime > pathFrom + period * 0.5;
}

// The labelled ring around the selected object, plus the observer pin.
// Data objects are reused between frames so globe.gl just moves the element.
let marker = null;
let observerDatum = null;
function updateSatMarker() {
  const items = [];
  if (state.mode === 'above' && state.observer) {
    if (observerDatum?.lat !== state.observer.lat || observerDatum?.lng !== state.observer.lng)
      observerDatum = { kind: 'obs', lat: state.observer.lat, lng: state.observer.lng };
    items.push(observerDatum);
  }
  // In Kessler mode the marker rides with the debris cloud (the smashed
  // object's orbit, which the worker keeps computing).
  const crash = state.mode === 'kessler' && state.crashSite !== null;
  const i = crash ? state.crashSite : state.selected;
  const g = i !== null && (crash || !state.destroyed.has(i)) ? renderedLatLngAlt(i) : null;
  if (g) {
    const hit = crash && state.destroyed.has(i);
    const name = crash ? (hit ? `💥 Debris from ${state.sats[i].name}` : `🎯 ${state.sats[i].name}`) : state.sats[i].name;
    if (marker?.i !== i || marker.name !== name) marker = { kind: 'sat', i, name, danger: crash };
    Object.assign(marker, { lat: g.lat, lng: g.lng, alt: g.alt / EARTH_RADIUS_KM });
    items.push(marker);
  } else {
    marker = null;
  }
  globe.htmlElementsData(items);
}

function deselect() {
  state.selected = null;
  state.selectedRec = null;
  if (isFollowing('sat')) stopFollow();
  globe.pathsData([]);
  updateSatMarker();
  restyle();
}

// --- Search ------------------------------------------------------------------
function searchHits(query) {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return null;
  const alias = SEARCH_ALIASES[q];
  const scored = [];
  for (let i = 0; i < state.sats.length; i++) {
    const n = state.sats[i].name.toUpperCase();
    const score = n === alias ? 0 : n === q ? 1 : n.startsWith(q) ? 2 : n.includes(q) ? 3 : -1;
    if (score >= 0) scored.push([score, i]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, 8).map(([, i]) => i);
}

function pickSearchResult(i) {
  $('search-results').hidden = true;
  $('search').value = '';
  $('search').blur();
  if (isHidden(state.sats[i].cat)) setSolo(null);
  select(i);
}

$('search').addEventListener('input', (e) => {
  const hits = searchHits(e.target.value);
  const box = $('search-results');
  if (!hits) { box.hidden = true; return; }
  box.innerHTML = hits.length
    ? hits.map((i) => `<li data-i="${i}" tabindex="0" role="option"><span class="dot" style="--c:${CATEGORIES[state.sats[i].cat].color}"></span>${esc(state.sats[i].name)}</li>`).join('')
    : '<li class="muted">No matches</li>';
  box.hidden = false;
  box.querySelectorAll('li[data-i]').forEach((li) => activate(li, () => pickSearchResult(+li.dataset.i)));
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = searchHits(e.target.value)?.[0];
    if (first !== undefined) pickSearchResult(first);
  } else if (e.key === 'Escape') {
    e.target.value = '';
    $('search-results').hidden = true;
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('search-results').hidden = true; });

// --- Modes & panels ---------------------------------------------------------
document.querySelectorAll('.modes button').forEach((b) => {
  b.onclick = () => { sfx.click(); setMode(b.dataset.mode); };
});

function setMode(mode) {
  if (cinematic && mode !== 'kessler') cancelCinematic();
  const prev = state.mode;
  state.mode = mode;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode !== 'sat' && isFollowing('sat')) stopFollow();
  if (mode !== 'kessler' && isFollowing('crash')) stopFollow();
  if (prev === 'kessler' && mode !== 'kessler' && state.autoSpeed) goLive();
  if (mode === 'home' || mode === 'above') deselect();
  if (mode === 'home' && prev !== 'home') {
    // Back to the big picture: zoom out and let the Earth spin again.
    controls.autoRotate = true;
    globe.pointOfView({ ...globe.pointOfView(), ...OVERVIEW_POV }, 1200);
  }
  if (mode === 'above') startAbove();
  // Returning to the crash sim: pick the debris cloud back up.
  if (mode === 'kessler' && prev !== 'kessler' && state.crashSite !== null && state.destroyed.has(state.crashSite)) focusCrash();
  if (mode !== 'kessler' && kessler.count === 0) globe.ringsData([]);
  updateSatMarker();
  renderPanel();
  restyle();
}

function renderPanel() {
  const el = $('side');
  if (state.mode === 'sat' && state.selected !== null) el.innerHTML = satPanel();
  else if (state.mode === 'above') el.innerHTML = abovePanel();
  else if (state.mode === 'kessler') el.innerHTML = kesslerPanel();
  else el.innerHTML = homePanel();
  wirePanel(el);
}

function timeTag() {
  if (state.live) return '<span class="tag" style="--c:var(--danger)">● Live</span>';
  return `<span class="tag" style="--c:var(--accent)">${state.speed === 0 ? '⏸ Paused' : '⏩ Simulated time'}</span>`;
}

function homePanel() {
  const debris = state.sats.filter((s) => s.cat === 'debris').length;
  return `
    <span id="time-tag">${timeTag()}</span>
    <h2>${fmt(state.sats.length)} objects are orbiting Earth ${state.live ? 'right now' : 'at this moment'}</h2>
    <p>Every dot is real. Click any dot to zoom in on it.</p>
    <div class="stats">
      <div class="stat"><div class="k">Satellites</div><div class="v">${fmt(state.sats.length - debris)}</div></div>
      <div class="stat"><div class="k">Space junk</div><div class="v" style="color:var(--danger)">${fmt(debris)}</div></div>
    </div>
    <div class="btn-col">
      <button class="action" data-act="above"><span class="ico">🔭</span><span><b>What's above me?</b><small>See what's flying over your head</small></span></button>
      ${issIndex >= 0 ? '<button class="action" data-act="iss"><span class="ico">🧑‍🚀</span><span><b>Follow the ISS</b><small>Ride along with the space station</small></span></button>' : ''}
      <button class="action" data-act="kessler"><span class="ico">💥</span><span><b>Smash a satellite</b><small>Watch the space junk spread</small></span></button>
    </div>
    <p class="muted small">Drag to spin · scroll to zoom · speed up time below</p>`;
}

function satPanel() {
  const i = state.selected;
  const s = state.sats[i];
  const c = CATEGORIES[s.cat];
  const g = latLngAlt(i);
  const pv = stateAt(state.selectedRec, new Date(state.simTime));
  const speed = pv ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) * 3600 : null;
  const lost = state.destroyed.has(i);
  const sub = [s.info.launchYear && `${s.cat === 'debris' ? 'From a launch in' : 'Launched'} ${s.info.launchYear}`, orbitRegime(s.info.periodMin)].filter(Boolean).join(' · ');
  return `
    <button class="back" data-act="close">← Back to Earth</button>
    <span class="tag" style="--c:${c.color}">${c.label}</span>
    <div>
      <h2>${esc(s.name)}</h2>
      <p class="muted small">${sub}</p>
    </div>
    ${lost ? '<div class="callout" style="--c:var(--danger)">💥 Destroyed in the collision simulation.</div>' : ''}
    <div class="stats">
      <div class="stat"><div class="k">Height now</div><div class="v" id="live-alt">${g ? fmt(g.alt) + ' km' : '–'}</div></div>
      <div class="stat"><div class="k">Speed</div><div class="v" id="live-speed">${speed ? fmt(speed / 3600, 2) + ' km/s' : '–'}</div><div class="sub" id="live-speed-kmh">${speed ? fmt(speed) + ' km/h' : ''}</div></div>
      <div class="stat"><div class="k">Lowest point</div><div class="v">${fmt(s.info.perigeeKm)} km</div></div>
      <div class="stat"><div class="k">Highest point</div><div class="v">${fmt(s.info.apogeeKm)} km</div></div>
      <div class="stat"><div class="k">One lap of Earth</div><div class="v">${fmtPeriod(s.info.periodMin)}</div></div>
      <div class="stat"><div class="k">Laps per day</div><div class="v">${fmt(1440 / s.info.periodMin, 1)}</div></div>
    </div>
    ${lost ? '' : `<div id="sat-pass">${satPassCard()}</div>`}
    <div class="callout">${funFact(s)}</div>
    <div class="btn-row">
      <button class="btn" data-act="follow" id="follow-btn">${followLabel()}</button>
      ${lost ? '' : '<button class="btn danger" data-act="smash">💥 Smash it</button>'}
    </div>
    <details>
      <summary>More details</summary>
      <div class="kv">
        <span>Position</span><span id="live-pos">${g ? `${fmt(g.lat, 2)}°, ${fmt(g.lng, 2)}°` : '–'}</span>
        <span>Orbit tilt</span><span>${fmt(s.info.inclination, 1)}°</span>
        <span>NORAD ID</span><span>${s.info.norad}</span>
      </div>
    </details>
    <p class="muted small">Press Esc or “Back to Earth” to zoom out.</p>`;
}

// --- Next naked-eye pass of the selected object, from the observer's spot ---
let satPasses = null; // { forIndex, computedAt, obsKey, list, overhead }
const observerOrDefault = () => state.observer ?? { ...DEFAULT_OBSERVER, geo: observerGeo(DEFAULT_OBSERVER.lat, DEFAULT_OBSERVER.lng) };

function computeSatPasses() {
  const i = state.selected;
  if (i === null || !state.selectedRec) { satPasses = null; return; }
  const obs = observerOrDefault();
  const now = new Date(state.simTime);
  const list = predictPasses(state.selectedRec, obs.geo, now, { hours: 72, max: 30 });
  const g = latLngAlt(i);
  const overhead = g ? lookAnglesFromLatLngAlt(obs.geo, g.lat, g.lng, g.alt).el > 0 : false;
  satPasses = { forIndex: i, computedAt: state.simTime, obsKey: `${obs.lat},${obs.lng}`, list, overhead, label: obs.label };
}

function satPassesStale() {
  if (state.selected === null) return false;
  if (!satPasses || satPasses.forIndex !== state.selected) return true;
  const obs = observerOrDefault();
  if (satPasses.obsKey !== `${obs.lat},${obs.lng}`) return true;
  const next = satPasses.list.find((p) => p.visible);
  return state.simTime < satPasses.computedAt || (next && state.simTime > next.visEnd.getTime());
}

function countdown(ms) {
  if (ms <= 0) return 'Up there right now!';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `in ${h}h ${String(m % 60).padStart(2, '0')}m` : `in ${Math.round(h / 24)} days`;
}

function satPassCard() {
  if (!satPasses) computeSatPasses();
  const s = state.sats[state.selected];
  const where = `from ${esc(satPasses.label)}`;
  const next = satPasses.list.find((p) => p.visible && p.visEnd.getTime() >= state.simTime);
  if (next) {
    // "Sunlit over a dark sky" only means naked-eye visible for big, low objects.
    const high = s.info.perigeeKm > 2000;
    const eye = s.cat === 'station';
    const title = eye ? '👀 Next time you can see it' : high ? "🔭 Next time it's lit up in your night sky" : "✨ Next time it's lit up in your night sky";
    const note = eye ? ' It looks like a bright, steady star gliding across the sky.'
      : high ? " It's too far away to see with your eyes. You'd need a telescope."
      : ' It may be too faint to spot without binoculars.';
    return `<div class="hero-card">
      <div class="k">${title} ${where}</div>
      <div class="v" id="pass-countdown">${countdown(next.visStart - state.simTime)}</div>
      <p>${passTime(next.visStart)} · look <b>${compass(next.visStartAz)}</b>, up to <b>${Math.round(next.visMaxEl)}°</b> high.${note}</p>
    </div>`;
  }
  if (satPasses.list.length === 0 && satPasses.overhead)
    return `<div class="callout">Always above the horizon ${where}, hovering in the same part of the sky. Far too faint to see without a telescope.</div>`;
  if (satPasses.list.length === 0)
    return `<div class="callout">Never rises above the horizon ${where} in the next 3 days. Its orbit doesn't pass over that part of the world.</div>`;
  return `<div class="callout">It passes over ${where}, but only in daylight or while in Earth's shadow over the next 3 days, so you can't see it with your eyes.</div>`;
}

function fmtPeriod(min) {
  return min < 120 ? `${fmt(min)} min` : min < 2880 ? `${fmt(min / 60, 1)} hrs` : `${fmt(min / 1440, 1)} days`;
}

function followLabel() {
  return isFollowing('sat') ? '🎥 Following' : '🎯 Re-center';
}

function crashFollowLabel() {
  return isFollowing('crash') ? '🎥 Following the debris' : '🎯 Find the debris';
}

function refreshFollowButtons() {
  const b = $('follow-btn');
  if (b) { b.textContent = followLabel(); b.classList.toggle('on', isFollowing('sat')); }
  const c = $('crash-follow-btn');
  if (c) { c.textContent = crashFollowLabel(); c.classList.toggle('on', isFollowing('crash')); }
}

function funFact(s) {
  const n = s.name.toUpperCase();
  if (n.includes('COSMOS 2251 DEB') || n.includes('IRIDIUM 33 DEB'))
    return '🧨 Junk from the <b>2009 crash</b> between two satellites, Iridium 33 and Cosmos 2251: the first time two satellites ever collided.';
  if (n.includes('FENGYUN 1C DEB'))
    return "🧨 Junk from China's <b>Fengyun-1C</b> weather satellite, blown up by a missile test in 2007. It's the worst debris event in history.";
  if (n.includes('COSMOS 1408 DEB'))
    return '🧨 Junk from <b>Cosmos 1408</b>, blown up by a missile test in 2021. The ISS crew had to take shelter.';
  if (n === 'HST')
    return '🔭 This is the <b>Hubble Space Telescope</b>, launched in 1990. It has taken some of the most famous pictures of the universe.';
  if (s.cat === 'station')
    return `🧑‍🚀 <b>People live up here!</b> The crew sees about ${Math.round(1440 / s.info.periodMin) * 2} sunrises and sunsets every day.`;
  if (s.cat === 'starlink')
    return '📡 One of SpaceX\'s Starlink internet satellites. There are so many that they make the blue shell around Earth.';
  if (s.cat === 'nav')
    return '🧭 A navigation satellite. Your phone\'s GPS uses signals from 4 or more of these to find where you are.';
  if (s.info.periodMin > 1400 && s.info.periodMin < 1480)
    return '🛰️ It orbits once a day, at the same speed Earth spins, so it seems to hover over one spot. That\'s why satellite dishes never move.';
  if (s.cat === 'debris')
    return '🧨 A piece of space junk. Even a small piece hits as hard as a bullet at this speed.';
  return `🌍 It circles the Earth <b>${fmt(1440 / s.info.periodMin, 1)} times a day</b>.`;
}

// --- Above me ----------------------------------------------------------------
let passes = null;

function startAbove() {
  if (!state.observer) {
    setObserver(DEFAULT_OBSERVER.lat, DEFAULT_OBSERVER.lng, DEFAULT_OBSERVER.label, true);
    requestLocation(false);
  } else {
    computeAbove();
    computePasses();
    showObserver();
  }
}

function requestLocation(explicit = true) {
  if (!navigator.geolocation) {
    if (explicit) toast('Your browser can\'t share its location. Showing Toronto instead.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => setObserver(p.coords.latitude, p.coords.longitude, 'Your location'),
    () => { if (explicit) toast(`📍 Location is blocked in your browser. Still showing ${DEFAULT_OBSERVER.label}.`); },
    { timeout: 8000 },
  );
}

function setObserver(lat, lng, label, isDefault = false) {
  state.observer = { lat, lng, label, isDefault, geo: observerGeo(lat, lng) };
  passes = null;
  computeAbove();
  computePasses();
  // Location can arrive late; only move the camera if we're still on this screen.
  if (state.mode === 'above') {
    showObserver();
    renderPanel();
  }
}

function showObserver() {
  const { lat, lng } = state.observer;
  updateSatMarker();
  controls.autoRotate = false;
  globe.pointOfView({ lat, lng, altitude: 1.9 }, 1500);
}

function computeAbove() {
  if (!state.observer || !state.geo) return;
  const g = state.geo;
  const list = [];
  for (let i = 0; i < state.sats.length; i++) {
    if (Number.isNaN(g[i * 3]) || state.destroyed.has(i) || isHidden(state.sats[i].cat)) continue;
    const la = lookAnglesFromLatLngAlt(state.observer.geo, g[i * 3], g[i * 3 + 1], g[i * 3 + 2]);
    if (la.el > 0) list.push({ i, el: la.el, az: la.az });
  }
  list.sort((a, b) => b.el - a.el);
  state.aboveList = list;
  state.above = list.map((x) => x.i);
}

function computePasses() {
  if (issIndex < 0 || !state.observer) { passes = null; return; }
  const rec = makeSatrec(state.sats[issIndex].l1, state.sats[issIndex].l2);
  passes = predictPasses(rec, state.observer.geo, new Date(state.simTime), { hours: 96 });
}

const passTime = (d) => d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function aboveChips() {
  const byCat = {};
  for (const x of state.aboveList) byCat[state.sats[x.i].cat] = (byCat[state.sats[x.i].cat] || 0) + 1;
  return Object.keys(CATEGORIES).filter((k) => byCat[k]).map((k) => `<span class="tag" style="--c:${CATEGORIES[k].color}">${fmt(byCat[k])} ${CATEGORIES[k].label}</span>`).join('');
}

function aboveTopList() {
  return state.aboveList.slice(0, 5).map((x) => `
    <li class="click" data-sel="${x.i}" tabindex="0" role="button"><span class="dot" style="--c:${CATEGORIES[state.sats[x.i].cat].color}"></span>
    <span class="name">${esc(state.sats[x.i].name)}</span><span class="meta">${Math.round(x.el)}° up · ${compass(x.az)}</span></li>`).join('');
}

function abovePanel() {
  if (!state.observer) return '<p>Finding your location…</p>';
  const visible = (passes || []).find((p) => p.visible);
  let issCard;
  if (issIndex < 0) {
    issCard = '<div class="callout">ISS orbit data isn\'t available right now.</div>';
  } else if (visible) {
    const mins = Math.max(1, Math.round((visible.visEnd - visible.visStart) / 60000) + 1);
    issCard = `<div class="hero-card">
        <div class="k">👀 Next time you can see the ISS</div>
        <div class="v">${passTime(visible.visStart)}</div>
        <p>Look <b>${compass(visible.visStartAz)}</b>. It climbs to <b>${Math.round(visible.visMaxEl)}°</b> above the horizon and stays visible for about ${mins} minute${mins === 1 ? '' : 's'}. It looks like a bright star moving steadily, with no blinking.</p>
      </div>`;
  } else {
    issCard = '<div class="callout">No naked-eye ISS passes in the next 4 days. You can only see it when your sky is dark but the ISS is still in sunlight.</div>';
  }
  const passRows = (passes || []).slice(0, 8).map((p) => `
      <li><span class="name">${passTime(p.start)}</span>
      <span class="meta">${Math.round(p.maxEl)}° · ${compass(p.startAz)}→${compass(p.endAz)}</span>
      ${p.visible ? '<span class="badge">👀 visible</span>' : ''}</li>`).join('');
  return `
    <span class="tag" style="--c:var(--you)">📍 ${esc(state.observer.label)}</span>
    ${state.observer.isDefault ? `<div class="callout" style="--c:var(--you)">Showing the sky over <b>${esc(DEFAULT_OBSERVER.label)}</b>, home of Hack the Skies. <button class="link" data-act="locate">Share your location</button> to see what's over you.</div>` : ''}
    <h2>Above you ${state.live ? 'right now' : 'at this moment'}</h2>
    <div><span class="big-number good" id="above-count">${fmt(state.above.length)}</span> <span class="muted">objects in your sky</span></div>
    <div class="chips" id="above-chips">${aboveChips()}</div>
    <h3>Highest overhead</h3>
    <ul class="list" id="above-list">${aboveTopList()}</ul>
    <h3>🧑‍🚀 Spot the ISS</h3>
    ${issCard}
    <details>
      <summary>All upcoming ISS flyovers</summary>
      <ul class="list">${passRows || '<li class="muted">None in the next 4 days.</li>'}</ul>
      <p class="muted small">Degrees = how high above the horizon it gets (90° is straight up).</p>
    </details>
    <button class="btn" data-act="locate">📍 Use my exact location</button>`;
}

// Update only what changed, so clicks on the list aren't lost mid-refresh.
function refreshAbovePanel() {
  if (!$('above-count')) return;
  $('above-count').textContent = fmt(state.above.length);
  const chips = aboveChips();
  if ($('above-chips').innerHTML !== chips) $('above-chips').innerHTML = chips;
  const list = aboveTopList();
  if ($('above-list').dataset.html !== list) {
    $('above-list').dataset.html = list;
    $('above-list').innerHTML = list;
    $('above-list').querySelectorAll('[data-sel]').forEach((li) => activate(li, () => select(+li.dataset.sel)));
  }
}

// --- Kessler ----------------------------------------------------------------
function kesslerPanel() {
  const target = state.selected !== null && !state.destroyed.has(state.selected) ? state.sats[state.selected].name : null;
  const running = kessler.count > 0 || kessler.collisions.length > 0;
  const label = cinematic ? (state.destroyed.has(state.crashSite) ? 'Impact!' : 'Incoming…') : target ? `Smash ${esc(target)}` : running ? 'Smash another one' : 'Smash a satellite';
  return `
    <span class="tag" style="--c:var(--danger)">Simulation</span>
    <h2>The Kessler Syndrome</h2>
    <p>One crash makes junk. The junk causes more crashes, and those make even more junk. Scientists worry this could make parts of space unusable.</p>
    <div class="stats three">
      <div class="stat"><div class="k">Crashes</div><div class="v" id="k-coll">${kessler.collisions.length}</div></div>
      <div class="stat"><div class="k">Junk pieces</div><div class="v" id="k-frag">${fmt(kessler.count)}</div></div>
      <div class="stat"><div class="k">Time</div><div class="v" id="k-time">${kesslerElapsed()}</div></div>
    </div>
    <div class="btn-col">
      <button class="btn danger" data-act="smash" ${cinematic ? 'disabled' : ''}>💥 ${label}</button>
      <label class="toggle"><input type="checkbox" data-act="chain" ${state.chain ? 'checked' : ''}/> Let junk hit other satellites (chain reaction)</label>
      ${state.crashSite !== null && !cinematic ? `<button class="btn" data-act="crashfollow" id="crash-follow-btn">${crashFollowLabel()}</button>` : ''}
      ${running ? '<button class="btn" data-act="reset">↺ Reset</button>' : ''}
    </div>
    <p class="muted small">Tip: click any satellite first to choose what gets hit.</p>
    <details>
      <summary>Has this happened for real?</summary>
      <ul class="list small">
        <li><span class="name">2007 · Fengyun-1C missile test</span><span class="meta">3,500+ pieces</span></li>
        <li><span class="name">2009 · Iridium 33 × Cosmos 2251</span><span class="meta">2,300+ pieces</span></li>
        <li><span class="name">2021 · Cosmos 1408 missile test</span><span class="meta">1,500+ pieces</span></li>
      </ul>
      <p class="muted small">The red dots on the globe are what's left of these events today.</p>
    </details>
    <p class="muted small">Sped up and exaggerated so you can see it happen. A real cascade would take years.</p>`;
}

let kesslerStart = null;
function kesslerElapsed() {
  if (kesslerStart === null) return '–';
  const m = Math.max(0, (state.simTime - kesslerStart) / 60000);
  return m < 120 ? `${Math.round(m)} min` : m < 2880 ? `${fmt(m / 60, 1)} h` : `${fmt(m / 1440, 1)} d`;
}

// Follow the debris cloud (the smashed object's orbit) from a medium distance.
function focusCrash() {
  const g = latLngAlt(state.crashSite);
  if (!g) return;
  follow(() => renderedLatLngAlt(state.crashSite), 'crash', g.alt / EARTH_RADIUS_KM + 0.9);
}

let toastTimer = null;
function toast(html) {
  const el = $('toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// Full-screen flash + camera shake for the big moment.
function impactEffects(strength) {
  const flash = $('flash');
  flash.style.setProperty('--strength', strength);
  flash.classList.remove('go');
  void flash.offsetWidth; // restart the CSS animation
  flash.classList.add('go');
  const g = $('globe');
  g.classList.remove('shake', 'shake-small');
  void g.offsetWidth;
  g.classList.add(strength > 0.5 ? 'shake' : 'shake-small');
}

let warnedFull = false;
function smash(i, { chain = false } = {}) {
  const s = state.sats[i];
  const rec = makeSatrec(s.l1, s.l2);
  const date = new Date(state.simTime);
  const pv = stateAt(rec, date);
  if (!pv) return false;
  const pieces = s.cat === 'station' ? 900 : s.cat === 'debris' ? 80 : 350;
  kessler.explode(pv.position, pv.velocity, pieces);
  state.destroyed.add(i);
  const g = eciToLatLngAlt(pv.position, gstime(date));
  kessler.collisions.push({ i, time: state.simTime });
  if (kesslerStart === null) kesslerStart = state.simTime;

  // Shockwave rings on the ground below, and a fireball at the crash point.
  const big = !chain;
  const rings = globe.ringsData().slice(-6);
  const ring = { lat: g.lat, lng: g.lng, rgb: '255,120,80', radius: big ? 14 : 6, speed: big ? 7 : 4, repeat: big ? 350 : 600 };
  globe.ringsData([...rings, ring]);
  setTimeout(() => globe.ringsData(globe.ringsData().filter((r) => r !== ring)), big ? 3500 : 2500);
  flashes.spawn(toGlobeXYZ(g.lat, g.lng, g.alt), big ? 9 : 3.5, big ? 1800 : 1100);
  sfx.boom(big ? 1 : 0.35);
  if (big) impactEffects(1);

  if (chain) toast(`💥 <b>Chain reaction!</b> Junk hit ${esc(s.name)}. Crash #${kessler.collisions.length}`);
  if (kessler.full && !warnedFull) {
    warnedFull = true;
    toast('⚠️ Debris limit reached. New crashes can\'t add more pieces.');
  }
  restyle();
  return true;
}

function resetKessler() {
  cancelCinematic();
  kessler.reset();
  state.destroyed.clear();
  kesslerStart = null;
  warnedFull = false;
  state.crashSite = null;
  state.crashRec = null;
  if (isFollowing('crash')) stopFollow();
  globe.ringsData([]);
  updateSatMarker();
  restyle();
  if (state.mode === 'kessler') renderPanel();
}

// The crash "cinematic": swoop in close on the target, impact, a beat of
// slow motion, then pull back out to watch the debris spread.
let cinematic = null;
function cancelCinematic() {
  if (!cinematic) return;
  cinematic.timers.forEach(clearTimeout);
  cinematic = null;
  // Interrupted before impact: forget the target so it isn't left highlighted.
  if (state.crashSite !== null && !state.destroyed.has(state.crashSite)) {
    state.crashSite = null;
    state.crashRec = null;
  }
}

function startCollision() {
  if (cinematic) return;
  let i = state.selected;
  if (i === null || state.destroyed.has(i)) {
    // Default target: a random Starlink, the most crowded shell in orbit.
    const starlinks = [];
    state.sats.forEach((s, k) => { if (s.cat === 'starlink' && !state.destroyed.has(k) && latLngAlt(k)) starlinks.push(k); });
    i = starlinks[Math.floor(Math.random() * starlinks.length)];
  }
  const g = i === undefined ? null : latLngAlt(i);
  if (!g) { toast("Can't find that satellite's position right now. Try another one."); return; }

  if (state.mode !== 'kessler') setMode('kessler');
  deselect();
  state.crashSite = i;
  state.crashRec = makeSatrec(state.sats[i].l1, state.sats[i].l2);
  if (!state.live) setSpeed(1);
  const token = (cinematic = { timers: [] });
  const later = (ms, fn) => token.timers.push(setTimeout(() => { if (cinematic === token) fn(); }, ms));

  // 1. Swoop in close behind the target.
  sfx.whoosh(1.5);
  toast(`🎯 Target: <b>${esc(state.sats[i].name)}</b>`);
  follow(() => renderedLatLngAlt(i), 'crash', g.alt / EARTH_RADIUS_KM + 0.07, 1500);
  updateSatMarker();
  restyle();
  renderPanel();

  // 2. Impact, then a moment of slow motion as the fireball swells.
  later(1600, () => {
    if (!smash(i)) { cancelCinematic(); renderPanel(); return; }
    toast(`💥 <b>${esc(state.sats[i].name)}</b> was destroyed!`);
    setSpeed(15);
    renderPanel();
  });

  // 3. Pull back out and speed up time to watch the debris spread.
  later(3000, () => {
    zoomTo(g.alt / EARTH_RADIUS_KM + 0.9, 2400);
    setSpeed(60);
    state.autoSpeed = true;
  });
  later(3200, () => {
    cinematic = null;
    toast('Following the debris… Watch it spread around the planet.');
    renderPanel();
  });
}

// Chain reactions: now and then, check whether a random fragment passed close
// to a satellite. Odds are exaggerated so the cascade is watchable.
let chainClock = 0;
const CHECK_EVERY_SEC = 150;
const HIT_KM = 45;
const HIT_CHANCE = 0.4;

function chainReaction(dtSec) {
  if (!state.chain || cinematic || kessler.count === 0 || !state.geo || !satLayer.position) return;
  chainClock += dtSec;
  if (chainClock < CHECK_EVERY_SEC) return;
  chainClock = 0;
  const gmst = gstime(new Date(state.simTime));
  const pos = satLayer.position.array;
  const samples = Math.min(8, Math.ceil(kessler.count / 300));
  const p = {};
  for (let k = 0; k < samples; k++) {
    const f = kessler.latLngAlt(Math.floor(Math.random() * kessler.count), gmst);
    if (f.alt < 160) continue;
    toGlobeXYZ(f.lat, f.lng, f.alt, p);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < state.sats.length; i++) {
      if (state.destroyed.has(i)) continue;
      const dx = pos[i * 3] - p.x, dy = pos[i * 3 + 1] - p.y, dz = pos[i * 3 + 2] - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    const km = Math.sqrt(bestD) * (EARTH_RADIUS_KM / GLOBE_RADIUS);
    if (best >= 0 && km < HIT_KM && Math.random() < HIT_CHANCE) smash(best, { chain: true });
  }
}

// --- Panel buttons -------------------------------------------------------------
function wirePanel(el) {
  el.querySelectorAll('[data-act]').forEach((b) => {
    const act = b.dataset.act;
    const handler = {
      above: () => setMode('above'),
      kessler: () => setMode('kessler'),
      iss: () => { if (issIndex >= 0) select(issIndex); },
      follow: () => { if (isFollowing('sat')) stopFollow(); else focusOn(state.selected); },
      close: () => setMode('home'),
      smash: () => startCollision(),
      crashfollow: () => { if (isFollowing('crash')) stopFollow(); else focusCrash(); },
      reset: () => resetKessler(),
      chain: () => { state.chain = b.checked; },
      locate: () => requestLocation(true),
    }[act];
    if (act === 'chain') b.onchange = handler;
    else b.onclick = () => { sfx.click(); handler(); };
  });
  el.querySelectorAll('[data-sel]').forEach((li) => activate(li, () => select(+li.dataset.sel)));
  refreshFollowButtons();
}

// --- Sound toggle ----------------------------------------------------------------
function refreshSoundButton() {
  const b = $('sound-btn');
  const m = sfx.isMuted();
  b.textContent = m ? '🔇' : '🔊';
  b.setAttribute('aria-label', m ? 'Turn sound on' : 'Turn sound off');
  b.title = m ? 'Sound off' : 'Sound on';
}
$('sound-btn').onclick = () => { sfx.setMuted(!sfx.isMuted()); refreshSoundButton(); sfx.click(); };
refreshSoundButton();

// --- Time controls -------------------------------------------------------------
function setSpeed(speed) {
  if (speed !== state.speed) state.live = false;
  state.speed = speed;
  state.autoSpeed = false;
  document.querySelectorAll('#speeds [data-speed]').forEach((b) => b.classList.toggle('active', +b.dataset.speed === speed));
}

function goLive() {
  setSpeed(1);
  state.simTime = Date.now();
  state.live = true;
}

document.querySelectorAll('#speeds [data-speed]').forEach((b) => {
  b.onclick = () => { sfx.click(); setSpeed(+b.dataset.speed); };
});
$('now-btn').onclick = () => {
  sfx.click();
  goLive();
  if (state.mode === 'above') { computePasses(); renderPanel(); }
  if (state.selected !== null) updateOrbitPath();
};

// --- Main loop -----------------------------------------------------------------
let lastFrame = performance.now();
let lastUi = 0;

function frame(now) {
  const dtReal = Math.min(now - lastFrame, 100);
  lastFrame = now;
  const prevSim = state.simTime;
  // In live mode follow the real clock exactly, even if frames are slow.
  state.simTime = state.live ? Date.now() : prevSim + dtReal * state.speed;
  const dtSim = (state.simTime - prevSim) / 1000;
  // A jump much bigger than this frame's normal step (Now button, coming back
  // to the tab) makes the old samples useless for extrapolation.
  if (Math.abs(dtSim - (dtReal * state.speed) / 1000) > 60) resyncPositions();

  if (!workerBusy && state.sats.length && state.simTime !== lastPostedTime) {
    workerBusy = true;
    lastPostedTime = state.simTime;
    worker.postMessage({ type: 'tick', time: state.simTime });
  }

  renderPositions();
  if (state.mode === 'kessler' && state.crashSite !== null) pinExact(state.crashSite, state.crashRec);
  else if (state.selected !== null) pinExact(state.selected, state.selectedRec);

  // Debris moves with the clock in both directions; a huge jump resets it.
  if (kessler.count > 0 && dtSim !== 0) {
    if (Math.abs(dtSim) > MAX_KESSLER_JUMP_SEC) {
      resetKessler();
      toast('Time jumped a long way, so the crash simulation was reset.');
    } else {
      kessler.step(dtSim, gstime(new Date(state.simTime)));
      if (dtSim > 0) chainReaction(dtSim);
    }
  }

  updateCamera(now);
  if (state.selected !== null || state.crashSite !== null) updateSatMarker();
  flashes.update(now);
  fadeTiles(now);

  if (now - lastUi > 500) {
    lastUi = now;
    updateUi(now);
  }
  requestAnimationFrame(frame);
}

function updateUi(now) {
  const t = new Date(state.simTime);
  $('clock').textContent = t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('live-badge').textContent = state.live ? '● LIVE' : state.speed === 0 ? '⏸ PAUSED' : '⏩ SIMULATED';
  $('live-badge').classList.toggle('off', !state.live);
  if ($('time-tag')) $('time-tag').innerHTML = timeTag();

  if (state.mode === 'sat' && state.selected !== null) {
    const g = latLngAlt(state.selected);
    const pv = stateAt(state.selectedRec, t);
    if (g && $('live-alt')) {
      $('live-alt').textContent = `${fmt(g.alt)} km`;
      $('live-pos').textContent = `${fmt(g.lat, 2)}°, ${fmt(g.lng, 2)}°`;
    }
    if (pv && $('live-speed')) {
      const v = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
      $('live-speed').textContent = `${fmt(v, 2)} km/s`;
      $('live-speed-kmh').textContent = `${fmt(v * 3600)} km/h`;
    }
    if ($('sat-pass')) {
      if (satPassesStale()) { computeSatPasses(); $('sat-pass').innerHTML = satPassCard(); }
      const next = satPasses.list.find((p) => p.visible && p.visEnd.getTime() >= state.simTime);
      if (next && $('pass-countdown')) $('pass-countdown').textContent = countdown(next.visStart - state.simTime);
    }
  }
  if (state.selected !== null && (orbitPathStale() || (state.speed > 1 && now - lastPathAt > 2000))) updateOrbitPath();

  if (state.mode === 'above') {
    computeAbove();
    restyle();
    // Passes in the past are useless: recompute once the next one has ended.
    if (passes?.length && state.simTime > passes[0].end.getTime()) { computePasses(); renderPanel(); }
    else refreshAbovePanel();
  }
  if (state.mode === 'kessler' && $('k-frag')) {
    $('k-coll').textContent = kessler.collisions.length;
    $('k-frag').textContent = fmt(kessler.count);
    $('k-time').textContent = kesslerElapsed();
  }
}

init().catch((err) => {
  console.error(err);
  $('loading-text').textContent = 'Could not load orbit data. Please refresh.';
});
requestAnimationFrame(frame);
