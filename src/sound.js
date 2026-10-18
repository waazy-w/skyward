// Sound effects, synthesized with the Web Audio API (no audio files needed).
// Browsers only allow audio after a user gesture, so the context is created
// lazily on the first click/tap.

const STORAGE_KEY = 'skyward-muted';
let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;
try { muted = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* storage blocked */ }

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    master.connect(ctx.destination);
    // Two seconds of white noise, reused by explosions and whooshes.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = dur > 2;
  return src;
}

function envelope(gainNode, t, peak, attack, decay) {
  gainNode.gain.setValueAtTime(0.0001, t);
  gainNode.gain.exponentialRampToValueAtTime(peak, t + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(freq, endFreq, dur, type = 'sine', peak = 0.15, delay = 0) {
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  envelope(g, t, peak, 0.005, dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

export function unlockAudio() { audio(); }

export function isMuted() { return muted; }

export function setMuted(m) {
  muted = m;
  try { localStorage.setItem(STORAGE_KEY, m ? '1' : '0'); } catch { /* storage blocked */ }
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.7, ctx.currentTime, 0.05);
}

// Soft tick for buttons.
export function click() {
  if (!audio()) return;
  tone(1200, 800, 0.05, 'sine', 0.05);
}

// Two-note chime when locking onto an object.
export function chime() {
  if (!audio()) return;
  tone(660, 660, 0.25, 'triangle', 0.08);
  tone(990, 990, 0.35, 'triangle', 0.07, 0.09);
}

// Rising air rush for camera fly-ins.
export function whoosh(dur = 1.4) {
  if (!audio()) return;
  const t = ctx.currentTime;
  const src = noise(dur);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(250, t);
  bp.frequency.exponentialRampToValueAtTime(2200, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

// Explosion: a low sub-bass thump, a filtered noise blast and crackle.
// `size` 1 = main crash, smaller values for chain-reaction hits.
let lastBoom = 0;
export function boom(size = 1) {
  if (!audio()) return;
  const now = ctx.currentTime;
  if (size < 1 && now - lastBoom < 0.2) return; // don't stack dozens of chain booms
  lastBoom = now;
  const t = now;
  const dur = 0.6 + 1.6 * size;
  const pitch = 0.85 + Math.random() * 0.3;

  // Sub thump
  const osc = ctx.createOscillator();
  const og = ctx.createGain();
  osc.frequency.setValueAtTime(110 * pitch, t);
  osc.frequency.exponentialRampToValueAtTime(28, t + 0.9 * size + 0.2);
  envelope(og, t, 0.9 * size, 0.005, 0.9 * size + 0.3);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + dur);

  // Noise blast, filter closing as it fades
  const src = noise(dur);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3000 * pitch, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + dur);
  const ng = ctx.createGain();
  envelope(ng, t, 0.8 * size + 0.15, 0.01, dur);
  src.connect(lp).connect(ng).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);

  // Crackle: a few short high-passed bursts
  const crackles = Math.round(3 + 5 * size);
  for (let i = 0; i < crackles; i++) {
    const ct = t + 0.05 + Math.random() * 0.6 * (0.5 + size);
    const c = noise(0.1);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500 + Math.random() * 3000;
    const cg = ctx.createGain();
    envelope(cg, ct, 0.12 * (0.4 + size * 0.6), 0.002, 0.05 + Math.random() * 0.08);
    c.connect(hp).connect(cg).connect(master);
    c.start(ct, Math.random());
    c.stop(ct + 0.2);
  }
}
