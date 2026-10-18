// Day and night: a thin dark shell over the night side of the globe, and the
// Sun's direction in globe coordinates (shared with the dot shader, which
// dims objects inside Earth's shadow).
import * as THREE from 'three';
import { sunDirection, gstime, toGlobeXYZ, GLOBE_RADIUS } from './orbit.js';
import { sunUniform } from './pointLayer.js';

const DEG = 180 / Math.PI;

export function createNightShade(scene) {
  const material = new THREE.ShaderMaterial({
    uniforms: { sunDir: sunUniform },
    vertexShader: `
      varying vec3 vN;
      void main() {
        vN = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    // Soft twilight band around the terminator, darkest on the far side.
    fragmentShader: `
      uniform vec3 sunDir;
      varying vec3 vN;
      void main() {
        float a = smoothstep(0.1, -0.25, dot(vN, sunDir)) * 0.62;
        gl_FragColor = vec4(0.0, 0.015, 0.05, a);
      }`,
    transparent: true,
    depthWrite: false,
    // Don't depth-test against the Earth: the imagery tiles sit at almost the
    // same height, and fighting them made the night side flicker in patches.
    // Front faces only, so it just covers the visible half of the globe.
    depthTest: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_RADIUS * 1.001, 96, 64), material);
  mesh.renderOrder = 1; // after the Earth, before the dots
  scene.add(mesh);
  return mesh;
}

// Point the shared uniform at the Sun for this moment.
export function updateSun(date) {
  const s = sunDirection(date); // inertial frame
  const t = gstime(date); // rotate into the Earth-fixed frame
  const x = s.x * Math.cos(t) + s.y * Math.sin(t);
  const y = -s.x * Math.sin(t) + s.y * Math.cos(t);
  const p = toGlobeXYZ(Math.asin(s.z) * DEG, Math.atan2(y, x) * DEG, 0);
  sunUniform.value.set(p.x, p.y, p.z).normalize();
}
