import Globe from 'globe.gl';
import * as THREE from 'three';
import {
  CATEGORIES, classify, tleInfo, orbitRegime, makeSatrec, stateAt, eciToLatLngAlt,
  orbitPath, observerGeo, lookAnglesFromLatLngAlt, predictPasses, compass, gstime,
  EARTH_RADIUS_KM, GLOBE_RADIUS, toGlobeXYZ,
} from './orbit.js';
import { createPointLayer, hexToRgb } from './pointLayer.js';
import { KesslerSim } from './kessler.js';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const DEFAULT_OBSERVER = { lat: 43.7286, lng: -79.6066, label: 'Humber College, Toronto' };
const OVERVIEW_POV = { altitude: 3.2 };
// High-res satellite imagery that streams in sharper tiles as you zoom.
const TILE_URL = (x, y, l) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`;
const FOCUS_FLY_MS = 1600;

// --- App state -------------------------------------------------------------
const state = {
  sats: [], // { name, cat, l1, l2 }
  geo: null, // Float32Array lat,lng,altKm per sat (latest from worker)
  simTime: Date.now(),
  speed: 1,
  live: true, // locked to the real clock (until the user pauses or fast-forwards)
  mode: 'home',
  selected: null,
  selectedRec: null,
  follow: false,
  hidden: new Set(),
  destroyed: new Set(),
  observer: null,
  above: [], // indices above the observer's horizon
  chain: true,
  crashSite: null, // index of the smashed object the camera tracks in Kessler mode
  followCrash: false,
};

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
  .ringPropagationSpeed(4)
  .ringRepeatPeriod(600)
  .htmlElement((d) => (d.kind === 'sat' ? satMarker(d) : observerPin()))
  .htmlAltitude((d) => d.alt ?? 0.003)
  .htmlTransitionDuration(0)
  .pointOfView({ lat: 25, lng: -60, altitude: 4.2 });

// Use streamed tiles if the tile server answers; otherwise keep the bundled image.
fetch(TILE_URL(0, 0, 0), { mode: 'cors' })
  .then((r) => { if (r.ok) globe.globeTileEngineUrl(TILE_URL).globeTileEngineMaxLevel(17); })
  .catch(() => {});

function observerPin() {
  const el = document.createElement('div');
  el.className = 'observer-pin';
  el.title = 'You are here';
  return el;
}

function satMarker(d) {
  const el = document.createElement('div');
  el.className = 'sat-marker';
  el.innerHTML = `<span class="ring"></span><span class="label">${esc(d.name)}</span>`;
  return el;
}

const controls = globe.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = GLOBE_RADIUS * 1.1;
controls.maxDistance = GLOBE_RADIUS * 12;
controls.addEventListener('start', () => { controls.autoRotate = false; });

const satLayer = createPointLayer(1);
const kessler = new KesslerSim();
globe.scene().add(kessler.layer.points);

// --- Load data -------------------------------------------------------------
const worker = new Worker(new URL('./propagator.worker.js', import.meta.url), { type: 'module' });
let workerBusy = true;
let fetchedAt = null;

async function init() {
  const res = await fetch(`${BASE}data/tle.json`);
  const data = await res.json();
  fetchedAt = new Date(data.fetched);
  state.sats = data.sats.map((s) => ({ name: s.n, cat: classify(s.n, s.k), l1: s.l1, l2: s.l2 }));
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
  for (let j = 0; j < cur.length; j++) out[j] = cur[j] + (cur[j] - prev[j]) * k;
  satLayer.position.needsUpdate = true;
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
  if (!latLngAlt(i)) return null;
  const a = satLayer.position.array;
  const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
  const r = Math.hypot(x, y, z);
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

// --- Styling of the satellite dots ------------------------------------------
const catRgb = Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, hexToRgb(c.color)]));

function restyle() {
  const { color, size } = satLayer;
  if (!color) return;
  const aboveSet = state.mode === 'above' ? new Set(state.above) : null;
  const focused = state.mode === 'sat' && state.selected !== null;
  // During a crash, fade everything else so the red junk stands out.
  const crashView = state.mode === 'kessler' && kessler.count > 0;
  document.body.classList.toggle('focused', focused || crashView);
  for (let i = 0; i < state.sats.length; i++) {
    const s = state.sats[i];
    let rgb = catRgb[s.cat];
    let sz = CATEGORIES[s.cat].size;
    if (state.hidden.has(s.cat) || state.destroyed.has(i)) sz = 0;
    else if (i === state.selected) { rgb = [1, 1, 1]; sz = 10; }
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

// --- Legend ----------------------------------------------------------------
function buildLegend() {
  const counts = {};
  for (const s of state.sats) counts[s.cat] = (counts[s.cat] || 0) + 1;
  $('total').textContent = fmt(state.sats.length);
  $('legend-list').innerHTML = Object.entries(CATEGORIES)
    .map(([k, c]) => `<li data-cat="${k}" class="${state.hidden.has(k) ? 'off' : ''}" style="--c:${c.color}"><span class="dot"></span>${c.label}<span class="count">${fmt(counts[k] || 0)}</span></li>`)
    .join('');
  $('legend-list').querySelectorAll('li').forEach((li) => {
    li.onclick = () => {
      const k = li.dataset.cat;
      state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
      li.classList.toggle('off', state.hidden.has(k));
      restyle();
    };
  });
  const hrs = Math.round((Date.now() - fetchedAt) / 3600000);
  $('data-age').textContent = `Click a category to hide it. Data updated ${hrs < 1 ? 'under an hour' : hrs + 'h'} ago.`;
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
window.addEventListener('pointerdown', (e) => { if (e.target === canvasEl()) downAt = [e.clientX, e.clientY]; });
window.addEventListener('pointerup', (e) => {
  if (!downAt || e.target !== canvasEl()) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) {
    // Dragging the globe takes the camera back from the follow-cam.
    if (state.follow) { state.follow = false; refreshFollowButton(); }
    if (state.followCrash) { state.followCrash = false; refreshCrashButton(); }
    return;
  }
  const i = pick(e.clientX, e.clientY);
  if (i !== null) select(i);
});
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
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
    tip.hidden = false;
  });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.mode === 'sat') setMode('home');
});

// --- Selection & focus ------------------------------------------------------
let followTimer = null;

function select(i) {
  state.selected = i;
  const s = state.sats[i];
  state.selectedRec = makeSatrec(s.l1, s.l2);
  s.info ??= tleInfo(s.l1, s.l2);
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

// Fly the camera in close to the object, then lock on and follow it.
function focusOn(i) {
  const g = latLngAlt(i);
  if (!g) return;
  controls.autoRotate = false;
  state.follow = false;
  clearTimeout(followTimer);
  const altitude = g.alt / EARTH_RADIUS_KM + (g.alt > 5000 ? 1.2 : 0.45);
  globe.pointOfView({ lat: g.lat, lng: g.lng, altitude }, FOCUS_FLY_MS);
  followTimer = setTimeout(() => {
    if (state.selected === i && state.mode === 'sat') { state.follow = true; refreshFollowButton(); }
  }, FOCUS_FLY_MS + 50);
}

function latLngAlt(i) {
  if (!state.geo || Number.isNaN(state.geo[i * 3])) return null;
  return { lat: state.geo[i * 3], lng: state.geo[i * 3 + 1], alt: state.geo[i * 3 + 2] };
}

let lastPathAt = 0;
function updateOrbitPath() {
  lastPathAt = performance.now();
  if (state.selected === null || !state.selectedRec || state.destroyed.has(state.selected)) {
    globe.pathsData([]);
    return;
  }
  const s = state.sats[state.selected];
  const pts = orbitPath(state.selectedRec, new Date(state.simTime), s.info.periodMin);
  globe.pathsData([{ pts, color: ['rgba(255,255,255,0.9)', 'rgba(90,200,250,0.15)'] }]);
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
    const name = crash ? `💥 Debris from ${state.sats[i].name}` : state.sats[i].name;
    if (marker?.i !== i || marker.name !== name) marker = { kind: 'sat', i, name };
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
  state.follow = false;
  clearTimeout(followTimer);
  globe.pathsData([]);
  updateSatMarker();
  restyle();
}

// --- Search ------------------------------------------------------------------
$('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toUpperCase();
  const box = $('search-results');
  if (q.length < 2) { box.hidden = true; return; }
  const hits = [];
  for (let i = 0; i < state.sats.length && hits.length < 8; i++) {
    if (state.sats[i].name.toUpperCase().includes(q)) hits.push(i);
  }
  box.innerHTML = hits.length
    ? hits.map((i) => `<li data-i="${i}"><span class="dot" style="--c:${CATEGORIES[state.sats[i].cat].color}"></span>${esc(state.sats[i].name)}</li>`).join('')
    : '<li class="muted">No matches</li>';
  box.hidden = false;
  box.querySelectorAll('li[data-i]').forEach((li) => {
    li.onclick = () => {
      box.hidden = true;
      $('search').value = '';
      state.hidden.delete(state.sats[+li.dataset.i].cat);
      buildLegend();
      select(+li.dataset.i);
    };
  });
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('search-results').hidden = true; });

function findSat(re) {
  return state.sats.findIndex((s) => re.test(s.name));
}

// --- Modes & panels ---------------------------------------------------------
document.querySelectorAll('.modes button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

function setMode(mode) {
  const prev = state.mode;
  state.mode = mode;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode !== 'sat') state.follow = false;
  if (mode !== 'kessler') state.followCrash = false;
  if (prev === 'sat' && mode === 'home') {
    deselect();
    controls.autoRotate = true;
    globe.pointOfView({ ...globe.pointOfView(), ...OVERVIEW_POV }, 1200);
  } else if (mode === 'home' && prev !== 'home') {
    deselect();
  }
  if (mode === 'above') { deselect(); startAbove(); }
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

function homePanel() {
  const debris = state.sats.filter((s) => s.cat === 'debris').length;
  return `
    <span class="tag" style="--c:var(--danger)">● Live</span>
    <h2>${fmt(state.sats.length)} objects are orbiting Earth right now</h2>
    <p>Every dot is real. Click any dot to zoom in on it.</p>
    <div class="stats">
      <div class="stat"><div class="k">Satellites</div><div class="v">${fmt(state.sats.length - debris)}</div></div>
      <div class="stat"><div class="k">Space junk</div><div class="v" style="color:var(--danger)">${fmt(debris)}</div></div>
    </div>
    <div class="btn-col">
      <button class="action" data-act="above"><span class="ico">🔭</span><span><b>What's above me?</b><small>See what's flying over your head</small></span></button>
      <button class="action" data-act="iss"><span class="ico">🧑‍🚀</span><span><b>Follow the ISS</b><small>Ride along with the space station</small></span></button>
      <button class="action" data-act="kessler"><span class="ico">💥</span><span><b>Crash two satellites</b><small>Watch space junk spread</small></span></button>
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
      <div class="stat"><div class="k">Height</div><div class="v" id="live-alt">${g ? fmt(g.alt) + ' km' : '–'}</div></div>
      <div class="stat"><div class="k">Speed</div><div class="v" id="live-speed">${speed ? fmt(speed) + ' km/h' : '–'}</div></div>
      <div class="stat"><div class="k">One lap of Earth</div><div class="v">${fmtPeriod(s.info.periodMin)}</div></div>
      <div class="stat"><div class="k">Laps per day</div><div class="v">${fmt(1440 / s.info.periodMin, 1)}</div></div>
    </div>
    <div class="callout">${funFact(s)}</div>
    <div class="btn-row">
      <button class="btn" data-act="follow" id="follow-btn">${followLabel()}</button>
      ${lost ? '' : '<button class="btn danger" data-act="smash">💥 Crash it</button>'}
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

function fmtPeriod(min) {
  return min < 120 ? `${fmt(min)} min` : min < 2880 ? `${fmt(min / 60, 1)} hrs` : `${fmt(min / 1440, 1)} days`;
}

function followLabel() {
  return state.follow ? '🎥 Following' : '🎯 Re-center';
}

function refreshFollowButton() {
  const b = $('follow-btn');
  if (b) { b.textContent = followLabel(); b.classList.toggle('on', state.follow); }
}

function funFact(s) {
  const n = s.name.toUpperCase();
  if (n.includes('COSMOS 2251 DEB') || n.includes('IRIDIUM 33 DEB'))
    return '🧨 Junk from the <b>2009 crash</b> between two satellites, Iridium 33 and Cosmos 2251: the first time two satellites ever collided.';
  if (n.includes('FENGYUN 1C DEB'))
    return "🧨 Junk from China's <b>Fengyun-1C</b> weather satellite, blown up by a missile test in 2007. It's the worst debris event in history.";
  if (n.includes('COSMOS 1408 DEB'))
    return '🧨 Junk from <b>Cosmos 1408</b>, blown up by a missile test in 2021. The ISS crew had to take shelter.';
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
    setObserver(DEFAULT_OBSERVER.lat, DEFAULT_OBSERVER.lng, DEFAULT_OBSERVER.label);
    requestLocation();
  } else {
    showObserver();
  }
}

function requestLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => setObserver(p.coords.latitude, p.coords.longitude, 'Your location'),
    () => {},
    { timeout: 8000 },
  );
}

function setObserver(lat, lng, label) {
  state.observer = { lat, lng, label, geo: observerGeo(lat, lng) };
  passes = null;
  showObserver();
  computeAbove();
  computePasses();
  if (state.mode === 'above') renderPanel();
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
    if (Number.isNaN(g[i * 3]) || state.destroyed.has(i) || state.hidden.has(state.sats[i].cat)) continue;
    const la = lookAnglesFromLatLngAlt(state.observer.geo, g[i * 3], g[i * 3 + 1], g[i * 3 + 2]);
    if (la.el > 0) list.push({ i, el: la.el, az: la.az });
  }
  list.sort((a, b) => b.el - a.el);
  state.aboveList = list;
  state.above = list.map((x) => x.i);
}

function computePasses() {
  const iss = findSat(/^ISS \(ZARYA\)/);
  if (iss < 0 || !state.observer) return;
  const rec = makeSatrec(state.sats[iss].l1, state.sats[iss].l2);
  passes = predictPasses(rec, state.observer.geo, new Date(state.simTime), { hours: 96, max: 8 });
}

const passTime = (d) => d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function aboveChips() {
  const byCat = {};
  for (const x of state.aboveList || []) byCat[state.sats[x.i].cat] = (byCat[state.sats[x.i].cat] || 0) + 1;
  return Object.entries(byCat).map(([k, n]) => `<span class="tag" style="--c:${CATEGORIES[k].color}">${fmt(n)} ${CATEGORIES[k].label}</span>`).join('');
}

function aboveTopList() {
  return (state.aboveList || []).slice(0, 5).map((x) => `
    <li class="click" data-sel="${x.i}"><span class="dot" style="--c:${CATEGORIES[state.sats[x.i].cat].color}"></span>
    <span class="name">${esc(state.sats[x.i].name)}</span><span class="meta">${Math.round(x.el)}° up · ${compass(x.az)}</span></li>`).join('');
}

function abovePanel() {
  if (!state.observer) return '<p>Finding your location…</p>';
  const visible = (passes || []).find((p) => p.visible);
  const issCard = visible
    ? `<div class="hero-card">
        <div class="k">👀 Next time you can see the ISS</div>
        <div class="v">${passTime(visible.start)}</div>
        <p>Look <b>${compass(visible.startAz)}</b>. It rises to <b>${Math.round(visible.maxEl)}°</b> and is visible for about ${Math.round((visible.end - visible.start) / 60000) + 1} minutes. It looks like a bright star moving steadily, with no blinking.</p>
      </div>`
    : '<div class="callout">No naked-eye ISS passes in the next 4 days. It needs your sky to be dark while the ISS is still in sunlight.</div>';
  const passRows = (passes || []).slice(0, 6).map((p) => `
      <li><span class="name">${passTime(p.start)}</span>
      <span class="meta">${Math.round(p.maxEl)}° · ${compass(p.startAz)}→${compass(p.endAz)}</span>
      ${p.visible ? '<span class="badge">👀 visible</span>' : ''}</li>`).join('');
  return `
    <span class="tag" style="--c:var(--good)">📍 ${esc(state.observer.label)}</span>
    <h2>Above you right now</h2>
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

function refreshAbovePanel() {
  if (!$('above-count')) return;
  $('above-count').textContent = fmt(state.above.length);
  $('above-chips').innerHTML = aboveChips();
  $('above-list').innerHTML = aboveTopList();
  $('above-list').querySelectorAll('[data-sel]').forEach((li) => { li.onclick = () => select(+li.dataset.sel); });
}

// --- Kessler ----------------------------------------------------------------
function kesslerPanel() {
  const target = state.selected !== null && !state.destroyed.has(state.selected) ? state.sats[state.selected].name : null;
  const running = kessler.count > 0 || kessler.collisions.length > 0;
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
      <button class="btn danger" data-act="smash">💥 ${target ? `Crash ${esc(target)}` : running ? 'Crash another one' : 'Start a crash'}</button>
      <label class="toggle"><input type="checkbox" data-act="chain" ${state.chain ? 'checked' : ''}/> Let junk hit other satellites (chain reaction)</label>
      ${state.crashSite !== null ? `<button class="btn" data-act="crashfollow" id="crash-follow-btn">${crashFollowLabel()}</button>` : ''}
      ${running ? '<button class="btn" data-act="reset">↺ Reset</button>' : ''}
    </div>
    <p class="muted small">Tip: click a satellite first to choose what gets hit.</p>
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

function crashFollowLabel() {
  return state.followCrash ? '🎥 Following the debris' : '🎯 Find the debris';
}

function refreshCrashButton() {
  const b = $('crash-follow-btn');
  if (b) { b.textContent = crashFollowLabel(); b.classList.toggle('on', state.followCrash); }
}

// Fly to the debris cloud, then keep the camera locked on it as it orbits.
let crashFollowTimer = null;
function focusCrash() {
  const g = latLngAlt(state.crashSite);
  if (!g) return;
  controls.autoRotate = false;
  state.followCrash = false;
  clearTimeout(crashFollowTimer);
  globe.pointOfView({ lat: g.lat, lng: g.lng, altitude: g.alt / EARTH_RADIUS_KM + 0.9 }, FOCUS_FLY_MS);
  crashFollowTimer = setTimeout(() => {
    if (state.crashSite !== null && state.mode === 'kessler') { state.followCrash = true; refreshCrashButton(); }
  }, FOCUS_FLY_MS + 50);
  refreshCrashButton();
}

let toastTimer = null;
function toast(html) {
  const el = $('toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

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
  const rings = globe.ringsData().slice(-6);
  globe.ringsData([...rings, { lat: g.lat, lng: g.lng, rgb: '255,120,80', radius: 8 }]);
  setTimeout(() => globe.ringsData(globe.ringsData().filter((r) => r.lat !== g.lat)), 4000);
  if (chain) toast(`💥 <b>Chain reaction!</b> Junk hit ${esc(s.name)}. Crash #${kessler.collisions.length}`);
  restyle();
  return true;
}

function startCollision() {
  let i = state.selected;
  if (i === null || state.destroyed.has(i)) {
    // Default target: a random Starlink, the most crowded shell in orbit.
    const starlinks = [];
    state.sats.forEach((s, k) => { if (s.cat === 'starlink' && !state.destroyed.has(k) && latLngAlt(k)) starlinks.push(k); });
    i = starlinks[Math.floor(Math.random() * starlinks.length)];
  }
  if (i === undefined || !smash(i)) return;
  if (state.mode !== 'kessler') setMode('kessler');
  deselect();
  state.crashSite = i;
  state.crashRec = makeSatrec(state.sats[i].l1, state.sats[i].l2);
  toast(`💥 <b>${esc(state.sats[i].name)}</b> was destroyed. Following the debris…`);
  focusCrash();
  updateSatMarker();
  if (state.speed < 60) setSpeed(60);
  renderPanel();
}

// Chain reactions: now and then, check whether a random fragment passed close
// to a satellite. Odds are exaggerated so the cascade is watchable.
let chainClock = 0;
const CHECK_EVERY_SEC = 150;
const HIT_KM = 45;
const HIT_CHANCE = 0.4;

function chainReaction(dtSec) {
  if (!state.chain || kessler.count === 0 || !state.geo || !satLayer.position) return;
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
    const r = GLOBE_RADIUS * (1 + f.alt / EARTH_RADIUS_KM);
    const phi = (90 - f.lat) * Math.PI / 180, th = (90 - f.lng) * Math.PI / 180;
    p.x = r * Math.sin(phi) * Math.cos(th); p.y = r * Math.cos(phi); p.z = r * Math.sin(phi) * Math.sin(th);
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
      iss: () => { const i = findSat(/^ISS \(ZARYA\)/); if (i >= 0) select(i); },
      follow: () => {
        if (state.follow) { state.follow = false; refreshFollowButton(); } else focusOn(state.selected);
      },
      close: () => setMode('home'),
      smash: () => startCollision(),
      crashfollow: () => {
        if (state.followCrash) { state.followCrash = false; refreshCrashButton(); } else focusCrash();
      },
      reset: () => {
        kessler.reset(); state.destroyed.clear(); kesslerStart = null;
        state.crashSite = null; state.followCrash = false; clearTimeout(crashFollowTimer);
        globe.ringsData([]); updateSatMarker(); restyle(); renderPanel();
      },
      chain: () => { state.chain = b.checked; },
      locate: () => requestLocation(),
    }[act];
    if (act === 'chain') b.onchange = handler;
    else b.onclick = handler;
  });
  el.querySelectorAll('[data-sel]').forEach((li) => { li.onclick = () => select(+li.dataset.sel); });
  refreshFollowButton();
  refreshCrashButton();
}

// --- Time controls -------------------------------------------------------------
function setSpeed(speed) {
  if (speed !== state.speed) state.live = false;
  state.speed = speed;
  document.querySelectorAll('#speeds [data-speed]').forEach((b) => b.classList.toggle('active', +b.dataset.speed === speed));
}
document.querySelectorAll('#speeds [data-speed]').forEach((b) => { b.onclick = () => setSpeed(+b.dataset.speed); });
$('now-btn').onclick = () => {
  setSpeed(1);
  state.simTime = Date.now();
  state.live = true;
  if (state.mode === 'above') { computePasses(); renderPanel(); }
};

// --- Main loop -----------------------------------------------------------------
let lastFrame = performance.now();
let lastUi = 0;

function frame(now) {
  const dtReal = Math.min(now - lastFrame, 100);
  lastFrame = now;
  const dtSim = (dtReal / 1000) * state.speed;
  // In live mode follow the real clock exactly, even if frames are slow.
  state.simTime = state.live ? Date.now() : state.simTime + dtSim * 1000;

  if (!workerBusy && state.sats.length) {
    workerBusy = true;
    worker.postMessage({ type: 'tick', time: state.simTime });
  }

  if (kessler.count > 0 && dtSim > 0) {
    kessler.step(dtSim, gstime(new Date(state.simTime)));
    chainReaction(dtSim);
  }

  renderPositions();
  if (state.mode === 'kessler' && state.crashSite !== null) pinExact(state.crashSite, state.crashRec);
  else if (state.selected !== null) pinExact(state.selected, state.selectedRec);

  if (state.selected !== null) {
    const g = renderedLatLngAlt(state.selected);
    if (g && state.follow) globe.pointOfView({ lat: g.lat, lng: g.lng, altitude: globe.pointOfView().altitude });
  }
  if (state.mode === 'kessler' && state.crashSite !== null) {
    const g = renderedLatLngAlt(state.crashSite);
    if (g && state.followCrash) globe.pointOfView({ lat: g.lat, lng: g.lng, altitude: globe.pointOfView().altitude });
  }
  if (state.selected !== null || state.crashSite !== null) updateSatMarker();

  if (now - lastUi > 500) {
    lastUi = now;
    updateUi(now);
  }
  requestAnimationFrame(frame);
}

function updateUi(now) {
  const t = new Date(state.simTime);
  $('clock').textContent = t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const live = state.live;
  $('live-badge').textContent = live ? '● LIVE' : state.speed === 0 ? '⏸ PAUSED' : '⏩ SIMULATED';
  $('live-badge').classList.toggle('off', !live);

  if (state.mode === 'sat' && state.selected !== null) {
    const g = latLngAlt(state.selected);
    const pv = stateAt(state.selectedRec, t);
    if (g && $('live-alt')) {
      $('live-alt').textContent = `${fmt(g.alt)} km`;
      $('live-pos').textContent = `${fmt(g.lat, 2)}°, ${fmt(g.lng, 2)}°`;
    }
    if (pv && $('live-speed')) $('live-speed').textContent = `${fmt(Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) * 3600)} km/h`;
  }
  if (state.selected !== null && Math.abs(state.speed) > 1 && now - lastPathAt > 2000) updateOrbitPath();

  if (state.mode === 'above') {
    computeAbove();
    restyle();
    refreshAbovePanel();
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
