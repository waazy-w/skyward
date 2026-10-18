// Kessler syndrome simulation: a collision shatters a satellite into fragments.
// Each fragment flies its own orbit (two-body gravity, integrated in ECI).
// Fragments that drift close to other satellites can cause new collisions.
import { MU, EARTH_RADIUS_KM, toGlobeXYZ } from './orbit.js';
import { createPointLayer } from './pointLayer.js';

const MAX_STEP_SEC = 5;
const REENTRY_ALT_KM = 120;

export class KesslerSim {
  constructor(capacity = 12000) {
    this.capacity = capacity;
    this.layer = createPointLayer(capacity);
    this.r = new Float64Array(capacity * 3);
    this.v = new Float64Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.count = 0;
    this.collisions = [];
    this.reentered = 0;
  }

  reset() {
    this.count = 0;
    this.collisions = [];
    this.reentered = 0;
    this.layer.geometry.setDrawRange(0, 0);
  }

  // r, v: ECI position (km) and velocity (km/s) of the object that broke up.
  explode(r, v, pieces) {
    const n = Math.min(pieces, this.capacity - this.count);
    for (let k = 0; k < n; k++) {
      const i = this.count++;
      // Random direction, mostly small kicks with a long tail of fast pieces.
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const dv = 0.02 + -Math.log(1 - Math.random() * 0.999) * 0.12; // km/s
      this.r[i * 3] = r.x; this.r[i * 3 + 1] = r.y; this.r[i * 3 + 2] = r.z;
      this.v[i * 3] = v.x + dv * s * Math.cos(th);
      this.v[i * 3 + 1] = v.y + dv * s * Math.sin(th);
      this.v[i * 3 + 2] = v.z + dv * u;
      this.age[i] = 0;
    }
    return n;
  }

  // Advance every fragment by dtSec of simulated time, then redraw.
  step(dtSec, gmst) {
    const { r, v } = this;
    let remaining = Math.abs(dtSec);
    const dir = Math.sign(dtSec) || 1;
    while (remaining > 0) {
      const h = Math.min(MAX_STEP_SEC, remaining) * dir;
      remaining -= MAX_STEP_SEC;
      for (let i = 0; i < this.count; i++) {
        const o = i * 3;
        const x = r[o], y = r[o + 1], z = r[o + 2];
        const d2 = x * x + y * y + z * z;
        const f = -MU / (d2 * Math.sqrt(d2));
        // Semi-implicit Euler: stable enough for many orbits.
        v[o] += f * x * h; v[o + 1] += f * y * h; v[o + 2] += f * z * h;
        r[o] += v[o] * h; r[o + 1] += v[o + 1] * h; r[o + 2] += v[o + 2] * h;
      }
    }
    // Remove pieces that fell back into the atmosphere.
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      if (Math.hypot(r[o], r[o + 1], r[o + 2]) - EARTH_RADIUS_KM < REENTRY_ALT_KM) {
        this.removeAt(i--);
        this.reentered++;
      }
    }
    for (let i = 0; i < this.count; i++) this.age[i] += Math.abs(dtSec);
    this.redraw(gmst);
  }

  removeAt(i) {
    const last = --this.count;
    for (let a = 0; a < 3; a++) {
      this.r[i * 3 + a] = this.r[last * 3 + a];
      this.v[i * 3 + a] = this.v[last * 3 + a];
    }
    this.age[i] = this.age[last];
  }

  // Earth-fixed lat/lng/alt of fragment i.
  latLngAlt(i, gmst) {
    const o = i * 3;
    const c = Math.cos(gmst), s = Math.sin(gmst);
    const x = this.r[o] * c + this.r[o + 1] * s;
    const y = -this.r[o] * s + this.r[o + 1] * c;
    const z = this.r[o + 2];
    const d = Math.hypot(x, y, z);
    return {
      lat: (Math.asin(z / d) * 180) / Math.PI,
      lng: (Math.atan2(y, x) * 180) / Math.PI,
      alt: d - EARTH_RADIUS_KM,
    };
  }

  redraw(gmst) {
    const { position, color, size, geometry } = this.layer;
    const p = {};
    for (let i = 0; i < this.count; i++) {
      const g = this.latLngAlt(i, gmst);
      toGlobeXYZ(g.lat, g.lng, g.alt, p);
      position.array[i * 3] = p.x;
      position.array[i * 3 + 1] = p.y;
      position.array[i * 3 + 2] = p.z;
      // Fresh fragments glow white-hot, cooling to red over ~15 minutes.
      const heat = Math.max(0, 1 - this.age[i] / 900);
      color.array[i * 3] = 1;
      color.array[i * 3 + 1] = 0.25 + 0.75 * heat;
      color.array[i * 3 + 2] = 0.2 + 0.8 * heat;
      size.array[i] = 2.2 + 3 * heat;
    }
    position.needsUpdate = color.needsUpdate = size.needsUpdate = true;
    geometry.setDrawRange(0, this.count);
  }
}
