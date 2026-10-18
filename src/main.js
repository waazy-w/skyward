import Globe from 'globe.gl';
import * as THREE from 'three';
import {
  CATEGORIES, classify, tleInfo, orbitRegime, makeSatrec, stateAt, eciToLatLngAlt,
  orbitPath, observerGeo, lookAnglesFromLatLngAlt, predictPasses, compass, gstime,
  EARTH_RADIUS_KM, GLOBE_RADIUS,
} from './orbit.js';
import { createPointLayer, hexToRgb } from './pointLayer.js';
import { KesslerSim } from './kessler.js';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const DEFAULT_OBSERVER = { lat: 43.7286, lng: -79.6066, label: 'Humber College, Toronto' };

// --- App state -------------------------------------------------------------
const state = {
  sats: [], // { name, cat, l1, l2 }
  geo: null, // Float32Array lat,lng,altKm per sat (latest from worker)
  simTime: Date.now(),
  speed: 1,
  mode: 'home',
  selected: null,
  selectedRec: null,
  follow: false,
  hidden: new Set(),
  destroyed: new Set(),
  observer: null,
  above: [], // indices above the observer's horizon
  chain: true,
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
  .htmlElement(() => {
    const el = document.createElement('div');
    el.className = 'observer-pin';
    el.title = 'You are here';
    return el;
  })
  .htmlAltitude(0.003)
  .pointOfView({ lat: 25, lng: -60, altitude: 4.2 });

const controls = globe.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = GLOBE_RADIUS * 1.15;
controls.maxDistance = GLOBE_RADIUS * 12;
controls.addEventListener('start', () => { controls.autoRotate = false; state.follow = false; });

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

worker.onmessage = ({ data }) => {
  if (data.type === 'ready') {
    workerBusy = false;
    return;
  }
  if (data.type === 'positions') {
    satLayer.position.array.set(data.xyz);
    satLayer.position.needsUpdate = true;
    satLayer.geometry.setDrawRange(0, state.sats.length);
    state.geo = data.geo;
    workerBusy = false;
    if ($('loading').classList.contains('done') === false) {
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
  for (let i = 0; i < state.sats.length; i++) {
    const s = state.sats[i];
    const cat = CATEGORIES[s.cat];
    let rgb = catRgb[s.cat];
    let sz = cat.size;
    if (state.hidden.has(s.cat) || state.destroyed.has(i)) sz = 0;
    else if (aboveSet) {
      if (aboveSet.has(i)) sz = Math.max(sz * 1.8, 3.5);
      else rgb = rgb.map((v) => v * 0.25);
    }
    if (i === state.selected && sz > 0) { rgb = [1, 1, 1]; sz = 9; }
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
    .map(([k, c]) => `<li data-cat="${k}" style="--c:${c.color}"><span class="dot"></span>${c.label}<span class="count">${fmt(counts[k] || 0)}</span></li>`)
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
  $('data-age').textContent = `Orbit data from CelesTrak, updated ${hrs < 1 ? 'less than an hour' : hrs + 'h'} ago.`;
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
  raycaster.params.Points.threshold = camera.position.length() * 0.008;
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
  if (moved > 5) return;
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
    if (i === null) { tip.hidden = true; return; }
    const s = state.sats[i];
    tip.innerHTML = `<span class="dot" style="--c:${CATEGORIES[s.cat].color};display:inline-block;margin-right:6px"></span>${esc(s.name)}`;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
    tip.hidden = false;
  });
});

// --- Selection -------------------------------------------------------------
function select(i, { fly = true } = {}) {
  state.selected = i;
  const s = state.sats[i];
  state.selectedRec = makeSatrec(s.l1, s.l2);
  s.info ??= tleInfo(s.l1, s.l2);
  if (state.mode === 'kessler') {
    renderPanel();
  } else {
    setMode('sat');
  }
  updateOrbitPath();
  restyle();
  if (fly) flyTo(i);
}

function flyTo(i, ms = 1200) {
  const g = latLngAlt(i);
  if (!g) return;
  controls.autoRotate = false;
  globe.pointOfView({ lat: g.lat, lng: g.lng, altitude: Math.max(1.6, g.alt / EARTH_RADIUS_KM + 1.4) }, ms);
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

function deselect() {
  state.selected = null;
  state.selectedRec = null;
  state.follow = false;
  globe.pathsData([]);
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
  if ((mode === 'home' && prev !== 'home') || mode === 'above') deselect();
  if (mode === 'above') startAbove();
  else globe.htmlElementsData([]);
  if (mode !== 'kessler' && kessler.count === 0) globe.ringsData([]);
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
    <span class="tag" style="--c:var(--accent)">Live right now</span>
    <h2>${fmt(state.sats.length)} human-made objects are circling Earth at this moment.</h2>
    <p>Every dot is real. Each one is tracked by radar and published as orbital data by CelesTrak. Your browser predicts where each one is, second by second, using the SGP4 orbit model.</p>
    <div class="callout" style="--c:var(--danger)"><b>${fmt(debris)}</b> of them are tracked <b>debris</b>: fragments of satellites that were smashed apart. Each piece travels at about 27,000 km/h, more than 7 km every second.</div>
    <h3>Explore</h3>
    <div class="btn-col">
      <button class="btn primary" data-act="above">🔭 What's flying above me right now?</button>
      <button class="btn" data-act="iss">🛰️ Follow the International Space Station</button>
      <button class="btn" data-act="kessler">💥 What happens if two satellites collide?</button>
    </div>
    <p class="muted small">Tip: drag to spin the Earth, scroll to zoom, click any dot to inspect it. Use the time controls below to fast-forward.</p>`;
}

function satPanel() {
  const i = state.selected;
  const s = state.sats[i];
  const c = CATEGORIES[s.cat];
  const g = latLngAlt(i);
  const pv = stateAt(state.selectedRec, new Date(state.simTime));
  const speed = pv ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) * 3600 : null;
  const lost = state.destroyed.has(i);
  return `
    <span class="tag" style="--c:${c.color}">${c.label}</span>
    <h2>${esc(s.name)}</h2>
    ${lost ? '<div class="callout" style="--c:var(--danger)">💥 Destroyed in the collision simulation.</div>' : ''}
    <div class="stats">
      <div class="stat"><div class="k">Altitude</div><div class="v" id="live-alt">${g ? fmt(g.alt) + ' km' : '–'}</div></div>
      <div class="stat"><div class="k">Speed</div><div class="v" id="live-speed">${speed ? fmt(speed) + ' km/h' : '–'}</div></div>
      <div class="stat"><div class="k">Latitude</div><div class="v" id="live-lat">${g ? fmt(g.lat, 2) + '°' : '–'}</div></div>
      <div class="stat"><div class="k">Longitude</div><div class="v" id="live-lng">${g ? fmt(g.lng, 2) + '°' : '–'}</div></div>
      <div class="stat"><div class="k">One orbit</div><div class="v">${fmt(s.info.periodMin, 0)} min</div></div>
      <div class="stat"><div class="k">Inclination</div><div class="v">${fmt(s.info.inclination, 1)}°</div></div>
      <div class="stat"><div class="k">NORAD ID</div><div class="v">${s.info.norad}</div></div>
      <div class="stat"><div class="k">${s.cat === 'debris' ? 'Parent launched' : 'Launched'}</div><div class="v">${s.info.launchYear ?? '–'}</div></div>
      <div class="stat wide"><div class="k">Orbit type</div><div class="v" style="font-size:15px">${orbitRegime(s.info.periodMin)}</div></div>
    </div>
    <div class="callout">${funFact(s)}</div>
    <div class="btn-row">
      <button class="btn" data-act="follow">${state.follow ? '⏹ Stop following' : '🎥 Follow'}</button>
      ${lost ? '' : '<button class="btn danger" data-act="smash">💥 Simulate a collision here</button>'}
      <button class="btn" data-act="close">✕ Close</button>
    </div>`;
}

function funFact(s) {
  const n = s.name.toUpperCase();
  if (n.includes('COSMOS 2251 DEB') || n.includes('IRIDIUM 33 DEB'))
    return '🧨 A piece of the <b>2009 Iridium 33 / Cosmos 2251 collision</b>, the first time two whole satellites ever crashed into each other. It created about 2,300 trackable fragments.';
  if (n.includes('FENGYUN 1C DEB'))
    return "🧨 A piece of China's <b>Fengyun-1C</b> weather satellite, destroyed by an anti-satellite missile test in 2007. It made more than 3,500 fragments, the worst debris event in history.";
  if (n.includes('COSMOS 1408 DEB'))
    return '🧨 A piece of <b>Cosmos 1408</b>, destroyed by a Russian anti-satellite test in 2021. The ISS crew had to shelter in their spacecraft.';
  if (s.cat === 'station')
    return `🧑‍🚀 People live up here! It circles the Earth <b>${fmt(1440 / s.info.periodMin, 1)} times a day</b>, so the crew sees about ${Math.round(1440 / s.info.periodMin) * 2} sunrises and sunsets daily.`;
  if (s.cat === 'starlink')
    return '📡 Part of SpaceX\'s Starlink internet constellation, the biggest group of satellites ever launched. That\'s why the blue shell around Earth is so dense.';
  if (s.cat === 'nav')
    return '🧭 A navigation satellite. Your phone\'s GPS works by timing signals from 4 or more satellites like this one.';
  if (s.info.periodMin > 1400 && s.info.periodMin < 1480)
    return '🛰️ Geostationary: it orbits once per day, so it seems to hover over one spot. That\'s why satellite dishes can point at a fixed spot in the sky.';
  return `🌍 It goes around the Earth <b>${fmt(1440 / s.info.periodMin, 1)} times a day</b>.`;
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
    (p) => setObserver(p.coords.latitude, p.coords.longitude, 'your location'),
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
}

function showObserver() {
  const { lat, lng } = state.observer;
  globe.htmlElementsData([{ lat, lng }]);
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

function abovePanel() {
  if (!state.observer) return '<p>Finding your location…</p>';
  const list = state.aboveList || [];
  const byCat = {};
  for (const x of list) byCat[state.sats[x.i].cat] = (byCat[state.sats[x.i].cat] || 0) + 1;
  const timeFmt = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  const visible = (passes || []).filter((p) => p.visible);
  const issRows = (passes || []).slice(0, 6).map((p) => `
      <li>
        <span class="name">${p.start.toLocaleString(undefined, timeFmt)}</span>
        <span class="meta">${Math.round((p.end - p.start) / 60000) + 1} min · ${Math.round(p.maxEl)}° · ${compass(p.startAz)}→${compass(p.endAz)}</span>
        ${p.visible ? '<span class="badge">👀 visible</span>' : ''}
      </li>`).join('');
  return `
    <span class="tag" style="--c:var(--good)">📍 ${esc(state.observer.label)}</span>
    <h2>Above your horizon right now</h2>
    <div class="big-number good" id="above-count">${fmt(list.length)}</div>
    <p>objects are in your sky at this moment. The bright dots are the ones you could point at.</p>
    <div class="btn-row small">${Object.entries(byCat).map(([k, n]) => `<span class="tag" style="--c:${CATEGORIES[k].color}">${fmt(n)} ${CATEGORIES[k].label}</span>`).join('')}</div>
    <h3>Highest in your sky</h3>
    <ul class="list">${list.slice(0, 6).map((x) => `
      <li class="click" data-sel="${x.i}"><span class="dot" style="--c:${CATEGORIES[state.sats[x.i].cat].color}"></span>
      <span class="name">${esc(state.sats[x.i].name)}</span><span class="meta">${Math.round(x.el)}° up, ${compass(x.az)}</span></li>`).join('')}
    </ul>
    <h3>🛰️ Next ISS flyovers</h3>
    ${visible.length ? `<div class="callout" style="--c:var(--gold)">Next one you can see with your own eyes: <b>${visible[0].start.toLocaleString(undefined, timeFmt)}</b>. Look ${compass(visible[0].startAz)}. It looks like a bright star moving steadily, with no blinking.</div>` : ''}
    <ul class="list">${issRows || '<li class="muted">No passes in the next 4 days.</li>'}</ul>
    <p class="muted small">“Visible” means the ISS is lit by the Sun while your sky is dark, so you can see it without a telescope. Degrees = how high above the horizon it gets.</p>
    <button class="btn" data-act="locate">📍 Use my exact location</button>`;
}

// --- Kessler ----------------------------------------------------------------
function kesslerPanel() {
  const target = state.selected !== null && !state.destroyed.has(state.selected) ? state.sats[state.selected].name : null;
  const running = kessler.count > 0 || kessler.collisions.length > 0;
  return `
    <span class="tag" style="--c:var(--danger)">Simulation</span>
    <h2>The Kessler Syndrome</h2>
    <p>In 1978, NASA scientist Donald Kessler warned that if orbits get crowded enough, one collision could trigger a <b>chain reaction</b>. Debris smashes more satellites, which make more debris, until parts of space become unusable for generations.</p>
    <div class="stats">
      <div class="stat"><div class="k">Collisions</div><div class="v" id="k-coll">${kessler.collisions.length}</div></div>
      <div class="stat"><div class="k">Fragments</div><div class="v" id="k-frag">${fmt(kessler.count)}</div></div>
      <div class="stat wide"><div class="k">Simulated time since first impact</div><div class="v" id="k-time">${kesslerElapsed()}</div></div>
    </div>
    <div class="btn-col">
      <button class="btn danger" data-act="smash">💥 ${target ? `Smash ${esc(target)}` : running ? 'Trigger another collision' : 'Trigger a collision'}</button>
      <label class="toggle"><input type="checkbox" data-act="chain" ${state.chain ? 'checked' : ''}/> Allow chain reactions</label>
      ${running ? '<button class="btn" data-act="reset">↺ Reset simulation</button>' : ''}
    </div>
    <p class="muted small">Tip: click any satellite first to choose what gets hit. Speed up time to watch the debris spread into a ring around the planet.</p>
    <h3>This has really happened</h3>
    <ul class="list small">
      <li><span class="name">2007 · Fengyun-1C missile test</span><span class="meta">3,500+ pieces</span></li>
      <li><span class="name">2009 · Iridium 33 × Cosmos 2251</span><span class="meta">2,300+ pieces</span></li>
      <li><span class="name">2021 · Cosmos 1408 missile test</span><span class="meta">1,500+ pieces</span></li>
    </ul>
    <p class="muted small">The red “Debris” dots on the globe are what's still left of these events today. This simulation speeds things up and exaggerates collision odds so you can see a cascade in minutes. A real one would take years or decades.</p>`;
}

let kesslerStart = null;
function kesslerElapsed() {
  if (kesslerStart === null) return '–';
  const m = Math.max(0, (state.simTime - kesslerStart) / 60000);
  return m < 120 ? `${Math.round(m)} min` : m < 2880 ? `${fmt(m / 60, 1)} hours` : `${fmt(m / 1440, 1)} days`;
}

function smash(i) {
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
  state.selected = null;
  globe.pathsData([]);
  restyle();
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
    if (best >= 0 && km < HIT_KM && Math.random() < HIT_CHANCE) smash(best);
  }
}

// --- Panel buttons -------------------------------------------------------------
function wirePanel(el) {
  el.querySelectorAll('[data-act]').forEach((b) => {
    const act = b.dataset.act;
    const handler = {
      above: () => setMode('above'),
      kessler: () => setMode('kessler'),
      iss: () => { const i = findSat(/^ISS \(ZARYA\)/); if (i >= 0) { select(i); state.follow = true; renderPanel(); } },
      follow: () => { state.follow = !state.follow; controls.autoRotate = false; renderPanel(); },
      close: () => setMode('home'),
      smash: () => startCollision(),
      reset: () => { kessler.reset(); state.destroyed.clear(); kesslerStart = null; globe.ringsData([]); restyle(); renderPanel(); },
      chain: () => { state.chain = b.checked; },
      locate: () => requestLocation(),
    }[act];
    if (act === 'chain') b.onchange = handler;
    else b.onclick = handler;
  });
  el.querySelectorAll('[data-sel]').forEach((li) => { li.onclick = () => select(+li.dataset.sel); });
}

// --- Time controls -------------------------------------------------------------
function setSpeed(speed) {
  state.speed = speed;
  document.querySelectorAll('#speeds [data-speed]').forEach((b) => b.classList.toggle('active', +b.dataset.speed === speed));
}
document.querySelectorAll('#speeds [data-speed]').forEach((b) => { b.onclick = () => setSpeed(+b.dataset.speed); });
$('now-btn').onclick = () => {
  state.simTime = Date.now();
  setSpeed(1);
  if (state.mode === 'above') computePasses();
};

// --- Main loop -----------------------------------------------------------------
let lastFrame = performance.now();
let lastUi = 0;

function frame(now) {
  const dtReal = Math.min(now - lastFrame, 100);
  lastFrame = now;
  const dtSim = (dtReal / 1000) * state.speed;
  state.simTime += dtSim * 1000;

  if (!workerBusy && state.sats.length) {
    workerBusy = true;
    worker.postMessage({ type: 'tick', time: state.simTime });
  }

  if (kessler.count > 0 && dtSim > 0) {
    kessler.step(dtSim, gstime(new Date(state.simTime)));
    chainReaction(dtSim);
  }

  if (state.follow && state.selected !== null) {
    const g = latLngAlt(state.selected);
    if (g) globe.pointOfView({ lat: g.lat, lng: g.lng, altitude: globe.pointOfView().altitude });
  }

  if (now - lastUi > 500) {
    lastUi = now;
    updateUi(now);
  }
  requestAnimationFrame(frame);
}

function updateUi(now) {
  const t = new Date(state.simTime);
  $('clock').textContent = t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const live = state.speed === 1 && Math.abs(state.simTime - Date.now()) < 5000;
  $('live-badge').textContent = live ? '● LIVE' : state.speed === 0 ? '⏸ PAUSED' : '⏩ SIMULATED';
  $('live-badge').classList.toggle('off', !live);

  if (state.mode === 'sat' && state.selected !== null) {
    const g = latLngAlt(state.selected);
    const pv = stateAt(state.selectedRec, t);
    if (g && $('live-alt')) {
      $('live-alt').textContent = `${fmt(g.alt)} km`;
      $('live-lat').textContent = `${fmt(g.lat, 2)}°`;
      $('live-lng').textContent = `${fmt(g.lng, 2)}°`;
    }
    if (pv && $('live-speed')) $('live-speed').textContent = `${fmt(Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) * 3600)} km/h`;
  }
  if (state.selected !== null && Math.abs(state.speed) > 1 && now - lastPathAt > 2000) updateOrbitPath();

  if (state.mode === 'above') {
    computeAbove();
    restyle();
    if (now - (updateUi.lastAbovePanel || 0) > 3000) {
      updateUi.lastAbovePanel = now;
      renderPanel();
    } else if ($('above-count')) {
      $('above-count').textContent = fmt(state.above.length);
    }
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
