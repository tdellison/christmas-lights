// ─── Effects and palettes ─────────────────────────────────────────────────────
//
// Every effect is a pure-ish function of time: fx(ctx) -> {r,g,b} (0-255,
// before brightness). The engine calls it 10x/s for each light and only sends
// what changed. ctx:
//   t       ms since the engine started
//   i, n    this light's place among the lights running the SAME effect
//           (yard order), so chases/waves travel across the yard
//   pos     i / n  (0..1)
//   palette [{r,g,b}, ...]  at least one colour
//   speed   0.25..4  (1 = normal)
//   mem     a per-light object the effect can keep state in
//   music   null, or { level 0..1, beats (count), bpm } while music is feeding in
//
// Music-aware effects step on the beat when music is present and fall back to
// their own clock when it isn't, so nothing breaks with music off.

'use strict';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => ({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
const scale = (c, k) => ({ r: c.r * k, g: c.g * k, b: c.b * k });
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }; };

const PALETTES = {
  classic:   { name: 'Classic Christmas', colors: ['#ff0000', '#00c000', '#ffffff'] },
  candycane: { name: 'Candy Cane',        colors: ['#ff0000', '#ffffff'] },
  grinch:    { name: 'Grinch',            colors: ['#40ff00', '#ff0000'] },
  icy:       { name: 'Icy Blue',          colors: ['#00a0ff', '#ffffff', '#00ffff'] },
  northpole: { name: 'North Pole',        colors: ['#0030ff', '#ffffff', '#c0c0ff'] },
  warm:      { name: 'Warm White',        colors: ['#ffb46b', '#ff9a40'] },
  gold:      { name: 'Gold & Red',        colors: ['#ffb000', '#ff0000'] },
  hanukkah:  { name: 'Blue & White',      colors: ['#0040ff', '#ffffff'] },
  winter:    { name: 'Winter Night',      colors: ['#2000ff', '#8000ff', '#00a0ff'] },
  rainbow:   { name: 'Rainbow',           colors: ['#ff0000', '#ff8000', '#ffff00', '#00ff00', '#0000ff', '#8000ff'] },
};

// Step counter: beats when music is on, otherwise every `periodMs / speed`.
function steps(ctx, periodMs) {
  if (ctx.music && ctx.music.beats != null) return ctx.music.beats;
  return Math.floor(ctx.t * ctx.speed / periodMs);
}
const pick = (pal, k) => pal[((k % pal.length) + pal.length) % pal.length];

const EFFECTS = {
  solid: {
    name: 'Solid', desc: 'One steady colour',
    fx: (c) => c.palette[0],
  },
  breathe: {
    name: 'Breathe', desc: 'Slow glow up and down',
    fx: (c) => scale(c.palette[0], 0.2 + 0.8 * smooth(0.5 + 0.5 * Math.sin(c.t * c.speed / 1600))),
  },
  fade: {
    name: 'Colour Fade', desc: 'Whole yard melts through the palette together',
    fx: (c) => {
      const x = c.t * c.speed / 4000, k = Math.floor(x);
      return mix(pick(c.palette, k), pick(c.palette, k + 1), smooth(x - k));
    },
  },
  wave: {
    name: 'Wave', desc: 'Colours roll across the yard',
    fx: (c) => {
      const x = c.t * c.speed / 3000 - c.pos * 1.5, k = Math.floor(x);
      return mix(pick(c.palette, k), pick(c.palette, k + 1), smooth(x - k));
    },
  },
  chase: {
    name: 'Chase', desc: 'Colours hop light to light (on the beat with music)',
    fx: (c) => pick(c.palette, c.i - steps(c, 900)),
  },
  candycane: {
    name: 'Candy Cane', desc: 'Stripes slide across the yard',
    fx: (c) => {
      const x = c.t * c.speed / 1200 - c.i, k = Math.floor(x);
      const f = x - k, edge = f < 0.8 ? 0 : smooth((f - 0.8) / 0.2);
      return mix(pick(c.palette, k), pick(c.palette, k + 1), edge);
    },
  },
  alternate: {
    name: 'Alternate', desc: 'Neighbours swap colours (on the beat with music)',
    fx: (c) => pick(c.palette, c.i + steps(c, 1500)),
  },
  twinkle: {
    name: 'Twinkle', desc: 'Dim base with sparkles of the other colours',
    fx: (c) => {
      const m = c.mem, now = c.t;
      if (!m.next || now >= m.next) {
        m.from = now; m.dur = rand(500, 1100) / c.speed; m.next = now + rand(900, 3500) / c.speed;
        m.col = c.palette.length > 1 ? pick(c.palette, 1 + Math.floor(Math.random() * (c.palette.length - 1))) : WHITE;
      }
      const base = scale(c.palette[0], 0.45);
      const p = (now - m.from) / m.dur;
      if (p < 0 || p > 1) return base;
      return mix(base, m.col, Math.sin(Math.PI * p));
    },
  },
  snowfall: {
    name: 'Snowfall', desc: 'Cold dim blue, lights catch drifting snow',
    fx: (c) => {
      const m = c.mem, now = c.t;
      if (!m.next || now >= m.next) { m.from = now; m.dur = rand(1800, 3200) / c.speed; m.next = now + rand(2500, 6000) / c.speed; }
      const base = scale(c.palette[0], 0.3);
      const p = (now - m.from) / m.dur;
      const hi = c.palette[1] || WHITE;
      return p >= 0 && p <= 1 ? mix(base, hi, Math.sin(Math.PI * p)) : base;
    },
  },
  sparkle: {
    name: 'Sparkle', desc: 'Quick bright pops of colour (pops on beats with music)',
    fx: (c) => {
      const m = c.mem, now = c.t;
      const beat = c.music && c.music.beats != null ? c.music.beats : null;
      if (beat != null) {
        if (m.beat !== beat) { m.beat = beat; if (Math.random() < 0.6) { m.from = now; m.col = pick(c.palette, Math.floor(Math.random() * 99)); } }
      } else if (!m.next || now >= m.next) {
        m.from = now; m.next = now + rand(400, 2500) / c.speed; m.col = pick(c.palette, Math.floor(Math.random() * 99));
      }
      const p = m.from == null ? 9 : (now - m.from) / 350;
      return p <= 1 ? scale(m.col, 1 - p) : scale(c.palette[0], 0.08);
    },
  },
  hearth: {
    name: 'Hearth Glow', desc: 'Warm fireplace flicker',
    fx: (c) => {
      const m = c.mem, now = c.t;
      const FIRE = c.palette.length > 1 ? c.palette : [hex('#ff5000'), hex('#ff2800'), hex('#ff7800'), hex('#ffa014')];
      if (!m.to || now >= m.until) { m.fromC = m.to || FIRE[0]; m.to = pick(FIRE, Math.floor(Math.random() * 99)); m.start = now; m.until = now + rand(120, 420) / c.speed; m.lvl0 = m.lvl1 || 0.8; m.lvl1 = rand(0.55, 1); }
      const p = smooth((now - m.start) / (m.until - m.start));
      return scale(mix(m.fromC, m.to, p), lerp(m.lvl0, m.lvl1, p));
    },
  },
  rainbow: {
    name: 'Rainbow', desc: 'Full hue wheel, offset across the yard',
    fx: (c) => {
      const h = ((c.t * c.speed / 8000 + c.pos) % 1) * 6, k = Math.floor(h), f = h - k;
      const q = 1 - f;
      const [r, g, b] = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][k % 6];
      return { r: r * 255, g: g * 255, b: b * 255 };
    },
  },
  musicpulse: {
    name: 'Music Pulse', desc: 'Brightness follows the music, colour moves on beats (breathes without music)',
    fx: (c) => {
      if (!c.music) return EFFECTS.breathe.fx(c);
      const col = pick(c.palette, (c.music.beats || 0) + c.i);
      return scale(col, 0.08 + 0.92 * clamp01(c.music.level));
    },
  },
};

module.exports = { EFFECTS, PALETTES, hex, mix, scale, clamp01, BLACK, WHITE };
