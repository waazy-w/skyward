// Explosion flashes: glowing billboards that swell and fade at a crash point.
import * as THREE from 'three';

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,240,200,0.95)');
  grad.addColorStop(0.4, 'rgba(255,140,60,0.55)');
  grad.addColorStop(1, 'rgba(255,60,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Flashes {
  constructor(scene) {
    this.scene = scene;
    this.texture = glowTexture();
    this.active = [];
  }

  // pos: globe scene coordinates; size: max diameter in scene units; ms: lifetime.
  spawn(pos, size = 8, ms = 1400) {
    const mat = new THREE.SpriteMaterial({
      map: this.texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(pos.x, pos.y, pos.z);
    sprite.scale.setScalar(0.01);
    this.scene.add(sprite);
    this.active.push({ sprite, size, ms, start: performance.now() });
  }

  update(now) {
    this.active = this.active.filter((f) => {
      const t = (now - f.start) / f.ms;
      if (t >= 1) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        return false;
      }
      // Fast swell, slow fade.
      f.sprite.scale.setScalar(f.size * (1 - (1 - Math.min(1, t * 3)) ** 3));
      f.sprite.material.opacity = (1 - t) ** 1.5;
      return true;
    });
  }
}
