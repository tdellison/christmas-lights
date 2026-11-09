// ─── Show flavor: colours and pace, from sniffed samples or a look's palette ─
//
// summarize(): what the sniffer saw while a Govee show played (shared by
// tools/sniff-govee.js and Watch mode). favourites(): the owner's favourite
// colours, from every show they 👍'd, weighted by how much they liked it.

'use strict';

const hex = ({ r, g, b }) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const rgb = (h) => { const n = parseInt(String(h).replace('#', ''), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }; };
const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

// Group close colours; weights add up.
function cluster(items, near = 60) {
  const groups = [];
  for (const { c, w } of items) {
    const g = groups.find(x => dist(x.c, c) < near);
    if (g) { const t = g.w + w; g.c = { r: (g.c.r * g.w + c.r * w) / t, g: (g.c.g * g.w + c.g * w) / t, b: (g.c.b * g.w + c.b * w) / t }; g.w = t; }
    else groups.push({ c: { ...c }, w });
  }
  return groups.sort((a, b) => b.w - a.w);
}

// samples: [{ t ms, color {r,g,b} | null, brightness }]
function summarize(samples) {
  const ok = samples.filter(s => s.color);
  if (!ok.length) return { answered: 0, of: samples.length };
  const groups = cluster(ok.map(s => ({ c: s.color, w: 1 })));
  let changes = 0;
  for (let i = 1; i < ok.length; i++) if (dist(ok[i].color, ok[i - 1].color) > 40) changes++;
  const secs = (ok[ok.length - 1].t - ok[0].t) / 1000 || 1;
  const bri = ok.map(s => s.brightness).filter(v => v != null);
  return {
    answered: ok.length, of: samples.length,
    stuck: groups.length === 1 && changes === 0,          // light only reports one colour: can't see inside this show
    colours: groups.slice(0, 6).map(g => ({ hex: hex(g.c), share: Math.round(100 * g.w / ok.length) })),
    changesPerSecond: Math.round(10 * changes / secs) / 10,
    brightness: bri.length ? { min: Math.min(...bri), max: Math.max(...bri) } : null,
  };
}

// The owner's favourite colours: sniffed colours of liked Govee shows (by
// share) plus palette colours of liked app looks, weighted by net 👍.
// looks: engine status looks; palettes: effects PALETTES.
function favourites(catalog, looks, palettes, max = 5) {
  const items = [];
  for (const [id, e] of Object.entries(catalog)) {
    const net = (e.up || 0) - (e.down || 0);
    if (net <= 0) continue;
    if (e.flavor && e.flavor.colours) for (const c of e.flavor.colours) items.push({ c: rgb(c.hex), w: net * (c.share || 20) / 100 });
    const look = looks.find(l => l.id === id);
    const pal = look && look.palette && palettes[look.palette];
    if (pal) for (const h of pal.colors) items.push({ c: rgb(h), w: net / pal.colors.length });
  }
  // Very dark samples are the gaps between flashes, not a colour anyone likes.
  const real = items.filter(x => Math.max(x.c.r, x.c.g, x.c.b) > 60);
  return cluster(real).slice(0, max).map(g => hex(g.c));
}

module.exports = { summarize, favourites, hex, rgb };
