// A fast "glowing dots" layer: one THREE.Points object drawing thousands of
// objects in a single draw call, with per-dot color and size.
import * as THREE from 'three';

// Shared by every point layer: direction to the Sun in globe coordinates.
export const sunUniform = { value: new THREE.Vector3(1, 0, 0) };

const vertexShader = `
  attribute vec3 color;
  attribute float size;
  uniform float pixelRatio;
  uniform vec3 sunDir;
  varying vec3 vColor;
  void main() {
    // Hidden dots (size 0) would still be drawn 1px wide by many GPUs:
    // move them outside the screen instead.
    if (size <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    // Inside Earth's (cylindrical) shadow? Then the object isn't lit: draw it dim.
    // Big dots (the selected object) always stay bright.
    float d = dot(position, sunDir);
    bool shadow = d < 0.0 && length(position - d * sunDir) < 100.0 && size < 9.5;
    vColor = shadow ? color * 0.38 : color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(size * pixelRatio * (600.0 / -mv.z), 0.0, 14.0 * pixelRatio);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.15, d);
    gl_FragColor = vec4(vColor, a);
  }
`;

export function createPointLayer(capacity) {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  const color = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  const size = new THREE.BufferAttribute(new Float32Array(capacity), 1);
  for (const a of [position, color, size]) a.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('color', color);
  geometry.setAttribute('size', size);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { pixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) }, sunDir: sunUniform },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2; // after the night shade
  return { points, geometry, position, color, size };
}

// Raw sRGB values (our shader writes colors straight to the screen).
export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
