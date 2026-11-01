// ─── Light engine ─────────────────────────────────────────────────────────────
//
// Devices are Govee controllers (one IP each). A device has 1..N segments; each
// segment is a LIGHT you control on its own (a Spotlight 2 two-pack = 1 device,
// 2 lights). Every light has: on, effect, palette, brightness, speed.
//
// 10 ticks/s. Each tick, every light's effect is sampled, scaled by its
// brightness and the master, and sent only if it changed: one packet per device
// per tick at most (multi-segment devices get all their segments in one ptReal
// packet). A device that still has a packet waiting skips the tick — the
// newest look always wins, no backlog.
//
// Looks: built-in (every light gets one effect + palette) or saved snapshots of
// every light's settings. Auto-rotate cycles a playlist of looks. Schedule
// turns the show on/off at set times each day.
//
// Music: an optional feed (POST /api/music) of { level, beat }. While it's
// fresh, beat-aware effects step on the beat. Nothing needs it.

'use strict';

const fs = require('fs');
const { EFFECTS, PALETTES, hex, scale, clamp01 } = require('./effects');

const TICK_MS = 100;
const MUSIC_STALE_MS = 2000;

const BUILTIN_LOOKS = [
  { id: 'classic-chase',  name: 'Classic Chase',      effect: 'chase',     palette: 'classic' },
  { id: 'candy-cane',     name: 'Candy Cane Lane',    effect: 'candycane', palette: 'candycane' },
  { id: 'twinkle-warm',   name: 'Warm Twinkle',       effect: 'twinkle',   palette: 'warm' },
  { id: 'red-green-fade', name: 'Red & Green Fade',   effect: 'fade',      palette: 'classic' },
  { id: 'snowfall',       name: 'Snowfall',           effect: 'snowfall',  palette: 'icy' },
  { id: 'north-pole',     name: 'North Pole Wave',    effect: 'wave',      palette: 'northpole' },
  { id: 'grinch',         name: 'Grinch Alternate',   effect: 'alternate', palette: 'grinch' },
  { id: 'hearth',         name: 'Cozy Hearth',        effect: 'hearth',    palette: 'warm' },
  { id: 'sparkle',        name: 'Festive Sparkle',    effect: 'sparkle',   palette: 'classic' },
  { id: 'rainbow',        name: 'Rainbow Wheel',      effect: 'rainbow',   palette: 'rainbow' },
];

const DEFAULT_LIGHT = { on: true, effect: 'solid', palette: ['#ff0000', '#00c000', '#ffffff'], bri: 80, speed: 1 };

const DEFAULTS = {
  devices: [],           // { id, ip, sku, name, segments }
  lights: {},            // id -> { name, on, effect, palette[], bri, speed }
  order: [],             // light ids, left -> right across the yard
  master: 100,
  running: false,        // remembered so a restart picks up where it left off
  looks: [],             // saved: { id, name, lights: { id: settings } }
  current: null,         // id of the look last applied
  rotate: { enabled: false, minutes: 10, list: BUILTIN_LOOKS.map(l => l.id), index: 0 },
  schedule: { enabled: false, on: '16:30', off: '23:00', tz: 'America/Denver' },
  music: { enabled: false },
};

const okTime = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t));
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return (h % 24) * 60 + (m || 0); };
function localMinutes(tz, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  return get('hour') * 60 + get('minute');
}
const inWindow = (now, on, off) => on <= off ? now >= on && now < off : now >= on || now < off;

function normColor(c) {
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c.trim())) return '#' + c.trim().replace('#', '').toLowerCase();
  if (c && typeof c === 'object') {
    const v = (x) => Math.max(0, Math.min(255, Math.round(Number(x) || 0))).toString(16).padStart(2, '0');
    return `#${v(c.r)}${v(c.g)}${v(c.b)}`;
  }
  throw new Error(`Bad colour "${c}" — use #rrggbb`);
}
function normPalette(p) {
  if (typeof p === 'string') {
    if (!PALETTES[p]) throw new Error(`Unknown palette "${p}"`);
    return [...PALETTES[p].colors];
  }
  if (!Array.isArray(p) || !p.length) throw new Error('palette must be a palette name or a list of colours');
  return p.slice(0, 8).map(normColor);
}

function createEngine({ file, govee, log = console.log, onChange = () => {} }) {
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg = { ...cfg, ...s, rotate: { ...cfg.rotate, ...s.rotate }, schedule: { ...cfg.schedule, ...s.schedule }, music: { ...cfg.music, ...s.music } };
  } catch (_) {}
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) { log(`save failed: ${e.message}`); } }, 300);
  };
  const changed = () => { save(); onChange(); };

  let running = false, timer = null;
  const t0 = Date.now();
  const sent = {};        // ip -> { on, bri, color }
  const mem = {};         // light id -> effect state
  const overrides = {};   // light id -> { until, fx(t) } (identify blink)
  const music = { level: 0, beats: 0, bpm: null, at: 0 };

  // ── Devices and lights ────────────────────────────────────────────────────
  const devById = (id) => cfg.devices.find(d => d.id === id);
  const lightIdsFor = (d) => Array.from({ length: d.segments }, (_, s) => `${d.id}:${s}`);
  function syncLights() {
    const want = cfg.devices.flatMap(lightIdsFor);
    for (const id of want) if (!cfg.lights[id]) {
      const [devId, seg] = id.split(':');
      const d = devById(devId);
      cfg.lights[id] = { ...DEFAULT_LIGHT, palette: [...DEFAULT_LIGHT.palette], name: d.segments > 1 ? `${d.name} ${Number(seg) + 1}` : d.name };
    }
    for (const id of Object.keys(cfg.lights)) if (!want.includes(id)) delete cfg.lights[id];
    cfg.order = [...cfg.order.filter(id => want.includes(id)), ...want.filter(id => !cfg.order.includes(id))];
  }
  syncLights();

  function addDevice({ ip, sku = '', name, segments = 1 }) {
    ip = String(ip || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('IP must look like 192.168.1.50');
    if (cfg.devices.some(d => d.ip === ip)) throw new Error(`${ip} is already added`);
    const n = Math.max(1, Math.min(15, Math.round(Number(segments) || 1)));
    const d = { id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`, ip, sku, name: String(name || sku || `Light ${cfg.devices.length + 1}`).slice(0, 40), segments: n };
    cfg.devices.push(d);
    syncLights(); changed();
    log(`Added ${d.name} (${ip}, ${n} light${n > 1 ? 's' : ''})`);
    return d;
  }
  function updateDevice(id, { ip, name, segments }) {
    const d = devById(id); if (!d) throw new Error('No such device');
    if (ip !== undefined) {
      ip = String(ip).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('IP must look like 192.168.1.50');
      if (cfg.devices.some(x => x.ip === ip && x.id !== id)) throw new Error(`${ip} is already used`);
      if (sent[d.ip]) delete sent[d.ip];
      d.ip = ip;
    }
    if (name !== undefined) d.name = String(name).slice(0, 40) || d.name;
    if (segments !== undefined) d.segments = Math.max(1, Math.min(15, Math.round(Number(segments) || 1)));
    syncLights(); delete sent[d.ip]; changed();
  }
  function removeDevice(id) {
    const d = devById(id); if (!d) throw new Error('No such device');
    if (running) govee.turn(d.ip, false);
    cfg.devices = cfg.devices.filter(x => x.id !== id);
    delete sent[d.ip];
    syncLights(); changed();
    log(`Removed ${d.name}`);
  }

  function patchLight(id, p) {
    const L = cfg.lights[id]; if (!L) throw new Error(`No light "${id}"`);
    if (p.on !== undefined) L.on = !!p.on;
    if (p.effect !== undefined) { if (!EFFECTS[p.effect]) throw new Error(`Unknown effect "${p.effect}"`); L.effect = p.effect; delete mem[id]; }
    if (p.palette !== undefined) L.palette = normPalette(p.palette);
    if (p.color !== undefined) L.palette = [normColor(p.color), ...L.palette.slice(1)];
    if (p.bri !== undefined) L.bri = Math.max(0, Math.min(100, Math.round(Number(p.bri) || 0)));
    if (p.speed !== undefined) L.speed = Math.max(0.25, Math.min(4, Number(p.speed) || 1));
    if (p.name !== undefined) L.name = String(p.name).slice(0, 40) || L.name;
  }

  // ── Output ────────────────────────────────────────────────────────────────
  function setPower(ip, on) {
    const s = sent[ip] = sent[ip] || {};
    if (s.on === on) return;
    s.on = on; govee.turn(ip, on);
  }
  function setBri(ip, v) {
    const s = sent[ip] = sent[ip] || {};
    if (s.bri === v) return;
    s.bri = v; govee.brightness(ip, v);
  }

  function frame(t) {
    const musicOn = cfg.music.enabled && Date.now() - music.at < MUSIC_STALE_MS;
    const m = musicOn ? { level: music.level, beats: music.beats, bpm: music.bpm } : null;
    // Lights running the same effect form a group in yard order.
    const groups = {};
    for (const id of cfg.order) { const L = cfg.lights[id]; if (L && L.on) (groups[L.effect] = groups[L.effect] || []).push(id); }
    const out = {};
    for (const id of cfg.order) {
      const L = cfg.lights[id]; if (!L) continue;
      let rgb;
      const ov = overrides[id];
      if (ov && Date.now() < ov.until) rgb = ov.fx(Date.now());
      else {
        if (ov) delete overrides[id];
        if (!L.on || L.bri === 0) rgb = { r: 0, g: 0, b: 0 };
        else {
          const g = groups[L.effect], i = g.indexOf(id), n = g.length;
          const ctx = { t, i, n, pos: n > 1 ? i / n : 0, palette: L.palette.map(hex), speed: L.speed, mem: mem[id] = mem[id] || {}, music: m };
          let c;
          try { c = EFFECTS[L.effect].fx(ctx); } catch (_) { c = ctx.palette[0]; }
          rgb = scale(c, clamp01(L.bri / 100));
        }
      }
      out[id] = { r: Math.round(clamp01(rgb.r / 255) * 255), g: Math.round(clamp01(rgb.g / 255) * 255), b: Math.round(clamp01(rgb.b / 255) * 255) };
    }
    return out;
  }

  function tick() {
    if (!running) return;
    const colors = frame(Date.now() - t0);
    for (const d of cfg.devices) {
      const ids = lightIdsFor(d);
      const lit = ids.some(id => {
        const c = colors[id]; return (c && (c.r || c.g || c.b)) || (overrides[id] && Date.now() < overrides[id].until);
      });
      const anyOn = ids.some(id => cfg.lights[id] && cfg.lights[id].on) || ids.some(id => overrides[id]);
      if (!anyOn && !lit) { setPower(d.ip, false); continue; }
      setPower(d.ip, true);
      setBri(d.ip, Math.max(1, cfg.master));
      if (govee.pending(d.ip) > 0) continue;
      const s = sent[d.ip];
      if (d.segments === 1) {
        const c = colors[ids[0]];
        const key = `${c.r},${c.g},${c.b}`;
        if (s.color === key) continue;
        s.color = key; govee.color(d.ip, c);
      } else {
        // Same colour on several segments -> one frame with a combined mask.
        const byColor = {};
        ids.forEach((id, seg) => { const c = colors[id]; const k = `${c.r},${c.g},${c.b}`; (byColor[k] = byColor[k] || { rgb: c, mask: 0 }).mask |= 1 << seg; });
        const key = ids.map(id => { const c = colors[id]; return `${c.r},${c.g},${c.b}`; }).join('|');
        if (s.color === key) continue;
        s.color = key; govee.segments(d.ip, Object.values(byColor));
      }
    }
    timer = setTimeout(tick, TICK_MS);
  }

  function start(reason = '') {
    if (running) return;
    if (!cfg.devices.length) throw new Error('Add a light first (Setup)');
    running = true; cfg.running = true;
    for (const k of Object.keys(sent)) delete sent[k];
    tick(); changed();
    log(`Show ON${reason ? ` (${reason})` : ''}`);
  }
  function stop(reason = '') {
    if (!running) { cfg.running = false; changed(); return; }
    running = false; cfg.running = false;
    clearTimeout(timer); timer = null;
    for (const d of cfg.devices) { govee.dropEffects(d.ip); govee.turn(d.ip, false, 0); }
    for (const k of Object.keys(sent)) delete sent[k];
    changed();
    log(`Show OFF${reason ? ` (${reason})` : ''}`);
  }

  // ── Looks ─────────────────────────────────────────────────────────────────
  const allLooks = () => [
    ...BUILTIN_LOOKS.map(l => ({ id: l.id, name: l.name, builtin: true, effect: l.effect, palette: l.palette })),
    ...cfg.looks.map(l => ({ id: l.id, name: l.name, builtin: false })),
  ];
  function applyLook(id, { quiet = false } = {}) {
    const b = BUILTIN_LOOKS.find(l => l.id === id);
    if (b) {
      for (const lid of cfg.order) patchLight(lid, { on: true, effect: b.effect, palette: b.palette });
    } else {
      const s = cfg.looks.find(l => l.id === id);
      if (!s) throw new Error(`No look "${id}"`);
      for (const [lid, set] of Object.entries(s.lights)) if (cfg.lights[lid]) { const { name, ...rest } = set; patchLight(lid, rest); }
    }
    cfg.current = id;
    for (const k of Object.keys(mem)) delete mem[k];
    changed();
    if (!quiet) log(`Look: ${allLooks().find(l => l.id === id).name}`);
  }
  function saveLook(name) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw new Error('Give the look a name');
    const lights = {};
    for (const [id, L] of Object.entries(cfg.lights)) { const { name: _n, ...rest } = L; lights[id] = JSON.parse(JSON.stringify(rest)); }
    const existing = cfg.looks.find(l => l.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.lights = lights;
    else cfg.looks.push({ id: `my-${Date.now().toString(36)}`, name, lights });
    const look = existing || cfg.looks[cfg.looks.length - 1];
    if (!existing && !cfg.rotate.list.includes(look.id)) cfg.rotate.list.push(look.id);
    cfg.current = look.id;
    changed(); log(`Saved look "${name}"`);
  }
  function deleteLook(id) {
    if (BUILTIN_LOOKS.some(l => l.id === id)) throw new Error("Built-in looks can't be deleted (take them out of the playlist instead)");
    cfg.looks = cfg.looks.filter(l => l.id !== id);
    cfg.rotate.list = cfg.rotate.list.filter(x => x !== id);
    if (cfg.current === id) cfg.current = null;
    changed();
  }

  // ── Auto-rotate ───────────────────────────────────────────────────────────
  let nextRotateAt = null;
  function rotateList() { const ids = allLooks().map(l => l.id); return cfg.rotate.list.filter(id => ids.includes(id)); }
  function rotateCheck() {
    const r = cfg.rotate, list = rotateList();
    if (!running || !r.enabled || !list.length) { nextRotateAt = null; return; }
    if (!nextRotateAt) {
      // Starting: keep the look that's already showing if it's in the playlist.
      const cur = list.indexOf(cfg.current);
      if (cur >= 0) r.index = cur; else { r.index %= list.length; applyLook(list[r.index]); }
      nextRotateAt = Date.now() + r.minutes * 60000; onChange(); return; }
    if (Date.now() >= nextRotateAt) {
      r.index = (r.index + 1) % list.length;
      applyLook(list[r.index]);
      nextRotateAt = Date.now() + r.minutes * 60000;
      onChange();
    }
  }
  setInterval(rotateCheck, 5000);

  // ── Schedule ──────────────────────────────────────────────────────────────
  // Acts only when the clock crosses on/off, so a manual OFF mid-evening holds
  // until tomorrow. Booting inside the window turns the show on.
  let lastInside = null;
  function scheduleCheck() {
    const sc = cfg.schedule;
    if (!sc.enabled) { lastInside = null; return; }
    let inside;
    try { inside = inWindow(localMinutes(sc.tz), toMin(sc.on), toMin(sc.off)); } catch (e) { log(`schedule: ${e.message}`); return; }
    if (inside && lastInside !== true && !running) { try { start('schedule'); } catch (e) { log(`schedule: ${e.message}`); } }
    else if (!inside && lastInside === true && running) stop('schedule');
    lastInside = inside;
  }
  setInterval(scheduleCheck, 30000);
  setTimeout(() => {
    scheduleCheck();
    // Was running before a restart (and the schedule didn't decide)? Resume.
    if (cfg.running && !running && cfg.devices.length) { try { start('resumed after restart'); } catch (_) {} }
  }, 3000);

  // ── Public API ────────────────────────────────────────────────────────────
  const api = {
    get running() { return running; },
    start: () => { start('manual'); return api.status(); },
    stop: () => { stop('manual'); return api.status(); },

    addDevice: (b) => { addDevice(b); return api.status(); },
    updateDevice: (id, b) => { updateDevice(id, b); return api.status(); },
    removeDevice: (id) => { removeDevice(id); return api.status(); },
    async probeDevice(id) {
      const d = devById(id); if (!d) throw new Error('No such device');
      const r = await govee.probe(d.ip);
      return { ok: !!r, status: r };
    },

    // ids: [lightId] or 'all'
    setLights(ids, patch) {
      const list = ids === 'all' ? [...cfg.order] : ids;
      if (!Array.isArray(list) || !list.length) throw new Error('Pick at least one light');
      for (const id of list) patchLight(id, patch);
      if (patch.effect !== undefined || patch.palette !== undefined || patch.color !== undefined) cfg.current = null;
      changed(); return api.status();
    },
    setOrder(order) {
      if (!Array.isArray(order) || order.length !== cfg.order.length || !order.every(id => cfg.order.includes(id))) throw new Error('order must list every light once');
      cfg.order = order; changed(); return api.status();
    },
    setMaster(v) { cfg.master = Math.max(1, Math.min(100, Math.round(Number(v) || 1))); changed(); return api.status(); },

    // Blink one light white so you can find it in the yard.
    identify(id) {
      if (!cfg.lights[id]) throw new Error(`No light "${id}"`);
      if (!running) throw new Error('Turn the show on first');
      const end = Date.now() + 4000;
      overrides[id] = { until: end, fx: (now) => (Math.floor(now / 300) % 2 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }) };
      return api.status();
    },

    applyLook: (id) => { applyLook(id); if (cfg.rotate.enabled) { const i = rotateList().indexOf(id); if (i >= 0) { cfg.rotate.index = i; nextRotateAt = Date.now() + cfg.rotate.minutes * 60000; } } return api.status(); },
    saveLook: (name) => { saveLook(name); return api.status(); },
    deleteLook: (id) => { deleteLook(id); return api.status(); },

    setRotate({ enabled, minutes, list } = {}) {
      if (minutes !== undefined) cfg.rotate.minutes = Math.max(1, Math.min(240, Math.round(Number(minutes) || 10)));
      if (list !== undefined) {
        const ids = allLooks().map(l => l.id);
        if (!Array.isArray(list) || !list.every(x => ids.includes(x))) throw new Error('list must be look ids');
        cfg.rotate.list = list; cfg.rotate.index = 0;
      }
      if (enabled !== undefined) { cfg.rotate.enabled = !!enabled; nextRotateAt = null; }
      changed(); rotateCheck(); return api.status();
    },
    nextLook() {
      const list = rotateList(); if (!list.length) throw new Error('Playlist is empty');
      cfg.rotate.index = (cfg.rotate.index + 1) % list.length;
      applyLook(list[cfg.rotate.index]);
      if (nextRotateAt) nextRotateAt = Date.now() + cfg.rotate.minutes * 60000;
      return api.status();
    },
    setSchedule({ enabled, on, off, tz } = {}) {
      if (on !== undefined) { if (!okTime(on)) throw new Error('On time must be HH:MM'); cfg.schedule.on = on; }
      if (off !== undefined) { if (!okTime(off)) throw new Error('Off time must be HH:MM'); cfg.schedule.off = off; }
      if (tz !== undefined) { try { localMinutes(tz); } catch (_) { throw new Error(`Unknown time zone "${tz}"`); } cfg.schedule.tz = tz; }
      if (enabled !== undefined) cfg.schedule.enabled = !!enabled;
      lastInside = null; changed(); scheduleCheck(); return api.status();
    },

    // Music feed: { level 0..1, beat true|false, bpm? }. Anything can POST it
    // (a beat detector, a player script). Ignored unless music is enabled.
    music(frame = {}) {
      if (frame.level !== undefined) music.level = clamp01(Number(frame.level) || 0);
      if (frame.beat) music.beats++;
      if (frame.bpm !== undefined) music.bpm = Number(frame.bpm) || null;
      music.at = Date.now();
    },
    setMusic({ enabled }) { cfg.music.enabled = !!enabled; changed(); return api.status(); },

    // Live colours for the UI preview.
    preview() { return running ? frame(Date.now() - t0) : {}; },

    status() {
      return {
        running, master: cfg.master,
        devices: cfg.devices.map(d => ({ ...d, lastSeen: govee.lastSeen(d.ip) })),
        lights: cfg.order.map(id => ({ id, device: id.split(':')[0], ...cfg.lights[id] })),
        looks: allLooks(), current: cfg.current,
        rotate: { ...cfg.rotate, nextAt: nextRotateAt },
        schedule: cfg.schedule,
        music: { ...cfg.music, live: cfg.music.enabled && Date.now() - music.at < MUSIC_STALE_MS },
        effects: Object.entries(EFFECTS).map(([id, e]) => ({ id, name: e.name, desc: e.desc })),
        palettes: Object.entries(PALETTES).map(([id, p]) => ({ id, ...p })),
      };
    },
  };
  return api;
}

module.exports = { createEngine, BUILTIN_LOOKS };
