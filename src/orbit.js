// Shared orbit math + helpers (used by the main thread and the worker).
import {
  twoline2satrec, propagate, gstime, eciToGeodetic, eciToEcf, ecfToEci,
  geodeticToEcf, ecfToLookAngles,
} from 'satellite.js';

export const EARTH_RADIUS_KM = 6371;
export const GLOBE_RADIUS = 100; // three-globe's internal radius
export const MU = 398600.4418; // Earth's gravitational parameter, km^3/s^2
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export const CATEGORIES = {
  station: { label: 'Space stations', color: '#ffd166', size: 7 },
  starlink: { label: 'Starlink', color: '#5ac8fa', size: 1.6 },
  nav: { label: 'Navigation (GPS)', color: '#c084fc', size: 2.6 },
  sat: { label: 'Other satellites', color: '#7ee787', size: 1.9 },
  debris: { label: 'Debris', color: '#ff6b6b', size: 1.7 },
};

export function classify(name, kind) {
  const n = name.toUpperCase();
  if (kind === 'debris' || /\bDEB\b/.test(n)) return 'debris';
  if (/^ISS \(|ZARYA|TIANHE|^CSS /.test(n)) return 'station';
  if (n.startsWith('STARLINK')) return 'starlink';
  if (/NAVSTAR|GPS |GLONASS|COSMOS 2[45]\d\d \(GLONASS|GALILEO|BEIDOU|IRNSS|QZS/.test(n)) return 'nav';
  return 'sat';
}

// Facts we can read straight out of the TLE text.
export function tleInfo(l1, l2) {
  const yy = parseInt(l1.slice(9, 11), 10);
  const meanMotion = parseFloat(l2.slice(52, 63)); // revolutions per day
  const ecc = parseFloat(`0.${l2.slice(26, 33).trim()}`);
  // Kepler's third law: semi-major axis from the orbital period.
  const n = (meanMotion * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n)); // km
  return {
    norad: parseInt(l1.slice(2, 7), 10),
    launchYear: Number.isNaN(yy) ? null : yy < 57 ? 2000 + yy : 1900 + yy,
    inclination: parseFloat(l2.slice(8, 16)),
    periodMin: 1440 / meanMotion,
    eccentricity: ecc,
    apogeeKm: a * (1 + ecc) - EARTH_RADIUS_KM, // highest point of the orbit
    perigeeKm: a * (1 - ecc) - EARTH_RADIUS_KM, // lowest point
  };
}

export function orbitRegime(periodMin) {
  if (periodMin < 128) return 'Low Earth Orbit (LEO)';
  if (periodMin > 1400 && periodMin < 1480) return 'Geostationary (GEO)';
  if (periodMin < 1400) return 'Medium Earth Orbit (MEO)';
  return 'High Earth Orbit';
}

export function makeSatrec(l1, l2) {
  try { return twoline2satrec(l1, l2); } catch { return null; }
}

// Same formula three-globe uses, so our dots line up with the globe.
export function toGlobeXYZ(latDeg, lngDeg, heightKm, out = {}) {
  const phi = (90 - latDeg) * RAD;
  const theta = (90 - lngDeg) * RAD;
  const r = GLOBE_RADIUS * (1 + heightKm / EARTH_RADIUS_KM);
  out.x = r * Math.sin(phi) * Math.cos(theta);
  out.y = r * Math.cos(phi);
  out.z = r * Math.sin(phi) * Math.sin(theta);
  return out;
}

export function eciToLatLngAlt(eci, gmst) {
  const g = eciToGeodetic(eci, gmst);
  return { lat: g.latitude * DEG, lng: g.longitude * DEG, alt: g.height };
}

// Position + velocity (ECI, km & km/s) or null if propagation failed.
export function stateAt(satrec, date) {
  if (!satrec) return null;
  const pv = propagate(satrec, date);
  if (!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
  return pv;
}

// One full orbit as [lat, lng, altitudeRatio] points for globe.gl's path layer.
export function orbitPath(satrec, date, periodMin, steps = 180) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = new Date(date.getTime() + (i / steps) * periodMin * 60000);
    const pv = stateAt(satrec, t);
    if (!pv) continue;
    const p = eciToLatLngAlt(pv.position, gstime(t));
    pts.push([p.lat, p.lng, p.alt / EARTH_RADIUS_KM]);
  }
  return pts;
}

// Lowest and highest height above the ground over the next lap, from SGP4.
// (Kepler's apogee/perigee assume a round Earth, so they can disagree with
// the live height by a few km; this always matches it.)
export function heightRange(satrec, date, periodMin, steps = 240) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = new Date(date.getTime() + (i / steps) * periodMin * 60000);
    const pv = stateAt(satrec, t);
    if (!pv) continue;
    const h = eciToLatLngAlt(pv.position, gstime(t)).alt;
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return lo <= hi ? { lo, hi } : null;
}

// --- Observer ("what's above me") ---------------------------------------

export function observerGeo(latDeg, lngDeg) {
  return { latitude: latDeg * RAD, longitude: lngDeg * RAD, height: 0.1 };
}

export function lookAnglesFromLatLngAlt(obsGeo, latDeg, lngDeg, altKm) {
  const ecf = geodeticToEcf({ latitude: latDeg * RAD, longitude: lngDeg * RAD, height: altKm });
  const la = ecfToLookAngles(obsGeo, ecf);
  return { el: la.elevation * DEG, az: la.azimuth * DEG, range: la.rangeSat };
}

// Low-precision Sun direction (unit vector, ECI). Good to ~0.01°.
export function sunDirection(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * RAD;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  return { x: Math.cos(lambda), y: Math.cos(eps) * Math.sin(lambda), z: Math.sin(eps) * Math.sin(lambda) };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

export function isSunlit(eci, sun) {
  const d = dot(eci, sun);
  if (d > 0) return true;
  const px = eci.x - d * sun.x, py = eci.y - d * sun.y, pz = eci.z - d * sun.z;
  return Math.hypot(px, py, pz) > EARTH_RADIUS_KM;
}

export function sunElevationAt(obsGeo, date, sun = sunDirection(date)) {
  const p = ecfToEci(geodeticToEcf(obsGeo), gstime(date));
  const r = Math.hypot(p.x, p.y, p.z);
  return Math.asin(dot(p, sun) / r) * DEG;
}

// Upcoming passes over an observer. "visible" = sat in sunlight while the
// observer's sky is dark, i.e. you can actually see it with your eyes.
// vis* fields describe just that naked-eye part of the pass.
export function predictPasses(satrec, obsGeo, start, { hours = 72, stepSec = 20, minEl = 10, max = 60 } = {}) {
  const passes = [];
  let cur = null;
  const end = start.getTime() + hours * 3600000;
  for (let t = start.getTime(); t < end && passes.length < max; t += stepSec * 1000) {
    const date = new Date(t);
    const pv = stateAt(satrec, date);
    if (!pv) continue;
    const gmst = gstime(date);
    const la = ecfToLookAngles(obsGeo, eciToEcf(pv.position, gmst));
    const el = la.elevation * DEG;
    const az = la.azimuth * DEG;
    if (el >= minEl) {
      if (!cur) cur = { start: date, startAz: az, maxEl: el, maxAt: date, visible: false };
      if (el >= cur.maxEl) { cur.maxEl = el; cur.maxAt = date; }
      const sun = sunDirection(date);
      if (isSunlit(pv.position, sun) && sunElevationAt(obsGeo, date, sun) < -6) {
        if (!cur.visible) Object.assign(cur, { visible: true, visStart: date, visStartAz: az, visMaxEl: el });
        cur.visEnd = date;
        cur.visMaxEl = Math.max(cur.visMaxEl, el);
      }
      cur.end = date; cur.endAz = az;
    } else if (cur) {
      passes.push(cur);
      cur = null;
    }
  }
  return passes;
}

export function compass(azDeg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

export { gstime };
