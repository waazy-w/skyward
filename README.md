# 🛰️ OrbitWatch

**Every tracked object in Earth orbit, live on a 3D globe.** See what's flying over your head right now, and what would happen if two satellites collided.

Built solo at **Hack the Skies 2026**.

## What it does

- **Live 3D globe of ~18,600 objects:** every active satellite plus the major debris clouds, predicted second by second in your browser.
- **🔭 Above me:** uses your location to show every object above your horizon right now, the ones directly overhead, and the **next times the ISS flies over**. It also tells you which passes you can **see with your own eyes** (ISS in sunlight while your sky is dark).
- **💥 Kessler Syndrome simulator:** smash any satellite and watch the fragments spread into a ring around the planet. Turn on chain reactions and debris starts hitting other satellites, cascading the way NASA's Donald Kessler warned about in 1978.
- **Inspect anything:** click any dot to see its altitude, speed, orbit, launch year and its full orbit path. Debris from real events (Fengyun-1C, Iridium/Cosmos, Cosmos 1408) explains where it came from.
- **Time machine:** pause, or fast-forward up to 1 hour per second.

## How it works

| Piece | How |
|---|---|
| Orbit data | Two-line element sets (TLEs) from [CelesTrak](https://celestrak.org), fetched at build time |
| Orbit prediction | SGP4 via [satellite.js](https://github.com/shashwatak/satellite-js), run for all 18k objects in a **Web Worker** so the globe stays smooth |
| Rendering | [globe.gl](https://github.com/vasturiano/globe.gl) / three.js, plus a custom GPU shader that draws every object in **one draw call** |
| Collision sim | Each fragment gets a random velocity kick (random direction, long-tailed size) and is integrated with two-body gravity (semi-implicit Euler). Fragments that re-enter the atmosphere are removed. Chain reactions sample fragments and check for nearby satellites (odds exaggerated so it's watchable) |
| ISS passes | Look angles from the observer, Sun position (low-precision solar formula) plus an Earth-shadow test to decide naked-eye visibility |
| Fresh data | A GitHub Action rebuilds and redeploys every 6 hours with new orbit data |

## Run it locally

```bash
npm install
npm run fetch-data   # optional: download the latest orbit data
npm run dev
```

## Honest notes

- Positions are predictions from public orbital data, accurate to a few km for most objects. Good for exploring, not for mission planning.
- The Kessler simulation is **sped up and dramatized** to show the idea. Real cascades unfold over years or decades.
