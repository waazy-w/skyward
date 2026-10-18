// Downloads the latest orbital elements (TLEs) from CelesTrak and saves them
// as one compact JSON file the app loads. CelesTrak doesn't allow browser
// requests (no CORS), so we fetch at build time instead.
import { writeFile, mkdir } from 'node:fs/promises';

const GROUPS = [
  { group: 'active', kind: 'sat' },
  { group: 'cosmos-2251-debris', kind: 'debris' },
  { group: 'iridium-33-debris', kind: 'debris' },
  { group: 'fengyun-1c-debris', kind: 'debris' },
  { group: 'cosmos-1408-debris', kind: 'debris' },
];

const OUT = new URL('../public/data/tle.json', import.meta.url);

function parseTle(text, kind) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    out.push({ n: name.trim(), k: kind, l1, l2 });
  }
  return out;
}

const seen = new Set();
const all = [];
for (const { group, kind } of GROUPS) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Skyward hackathon project' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sats = parseTle(await res.text(), kind);
    let added = 0;
    for (const s of sats) {
      const id = s.l1.slice(2, 7);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(s);
      added++;
    }
    console.log(`${group}: ${added} objects`);
  } catch (err) {
    console.warn(`${group}: failed (${err.message})`);
  }
}

if (all.length < 1000) {
  console.error(`Only got ${all.length} objects; keeping the existing data file.`);
  process.exit(process.env.CI ? 0 : 1);
}

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ fetched: new Date().toISOString(), sats: all }));
console.log(`Saved ${all.length} objects.`);
