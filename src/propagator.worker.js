// Runs SGP4 for every tracked object off the main thread so the globe stays smooth.
import { makeSatrec, stateAt, eciToLatLngAlt, toGlobeXYZ, gstime } from './orbit.js';

let recs = [];

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    recs = data.sats.map((s) => makeSatrec(s.l1, s.l2));
    self.postMessage({ type: 'ready' });
    return;
  }

  if (data.type === 'tick') {
    const date = new Date(data.time);
    const gmst = gstime(date);
    const n = recs.length;
    const xyz = new Float32Array(n * 3); // globe scene coordinates
    const geo = new Float32Array(n * 3); // lat, lng, altitude km (NaN = no fix)
    const p = {};
    for (let i = 0; i < n; i++) {
      const pv = stateAt(recs[i], date);
      if (!pv) {
        geo[i * 3] = NaN;
        continue;
      }
      const g = eciToLatLngAlt(pv.position, gmst);
      geo[i * 3] = g.lat;
      geo[i * 3 + 1] = g.lng;
      geo[i * 3 + 2] = g.alt;
      toGlobeXYZ(g.lat, g.lng, g.alt, p);
      xyz[i * 3] = p.x;
      xyz[i * 3 + 1] = p.y;
      xyz[i * 3 + 2] = p.z;
    }
    self.postMessage({ type: 'positions', time: data.time, xyz, geo }, [xyz.buffer, geo.buffer]);
  }
};
