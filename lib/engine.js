// ─── Light engine ─────────────────────────────────────────────────────────────
//
// Devices are Govee controllers (one IP each). A device has 1..N segments; each
// segment is a LIGHT you control on its own (a Spotlight 2 two-pack = 1 device,
// 2 lights). Every light has: on, effect, palette, brightness, speed.
//
// A fresh install starts with PAIR_SLOTS two-light slots and no IPs, so the
// yard (and its preview) is laid out before any hardware is hooked up. A slot
// with no IP is previewed but never sent to.
//
// 10 ticks/s. Each tick, every light's effect is sampled, scaled by its
// brightness and the master, and sent only if it changed: one packet per device
// per tick at most (multi-segment devices get all their segments in one ptReal
// packet). A device that still has a packet waiting skips the tick — the
// newest look always wins, no backlog.
//
// Zones: every device belongs to a zone (Front Left, Front Right, Backyard by
// default). Looks, power, auto-rotate and schedules can target one zone or the
// whole yard, and chases/waves run within a zone.
//
// Looks: built-in (every light gets one effect + palette) or saved snapshots of
// every light's settings. Auto-rotate cycles a playlist of looks. Schedule
// turns the show on/off at set times each day.
//
// Music: an optional feed (POST /api/music) of { level, beat }. While it's
// fresh, beat-aware effects step on the beat. Nothing needs it.

'use strict';

const fs = require('fs');
const { EFFECTS, PALETTES, hex, scale, clamp01, WHITE, BLACK } = require('./effects');

const TICK_MS = 100;
const MUSIC_STALE_MS = 2000;
const PAIR_SLOTS = 6;   // 6 pairs = 12 lights

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
  { id: 'grinch-run',     name: 'Grinch Run',         effect: 'runner',    palette: 'grinchrun' },
  { id: 'rainbow',        name: 'Rainbow Wheel',      effect: 'rainbow',   palette: 'rainbow' },
];

const DEFAULT_ZONES = [
  { id: 'front-left', name: 'Front Left' },
  { id: 'front-right', name: 'Front Right' },
  { id: 'back', name: 'Backyard' },
];

const DEFAULT_LIGHT = { on: true, effect: 'solid', palette: ['#ff0000', '#00c000', '#ffffff'], bri: 80, speed: 1 };

const DEFAULTS = {
  devices: [],           // { id, ip, sku, name, segments }
  lights: {},            // id -> { name, on, effect, palette[], bri, speed }
  order: [],             // light ids, left -> right across the yard
  master: 100,
  running: false,        // remembered so a restart picks up where it left off
  looks: [],             // saved: { id, name, lights: { id: settings } }
  current: null,         // (old single-zone field, migrated into zones[].current)
  rotate: { enabled: false, minutes: 10, list: BUILTIN_LOOKS.map(l => l.id), index: 0, zones: null },  // zones null = all
  schedule: { enabled: false, on: '16:30', off: '23:00', tz: 'America/Denver' },
  music: { enabled: false },
  zones: DEFAULT_ZONES,  // + per zone: off, current, schedule { enabled, on, off }
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

// esphome: optional driver for ESP32s running ESPHome (lib/esphome.js). Two
// device kinds use it, both with ip = the ESP32:
//  - 'brmesh': Bluetooth lights; ble = ESPHome light names, one per light.
//  - 'relay': C9 strings on solid-state relays; ch = ESPHome switch names, one
//    per string. On/off only: effects run on white/black and the string is on
//    when the effect is bright. Its light's `string` colour is just for the
//    preview.
// external: optional provider of looks that play on the lights themselves
// (Govee cloud scenes): { looks() -> [{id,name}], play(id), power(on) }.
// While one is on, the engine keeps running but sends nothing.
// auto: false for the training sandbox — no schedule, no auto-rotate, no
// resume-after-restart; it only does what it's told.
// tuya: optional driver for Tuya smart plugs (lib/tuya.js). A 'plug' device is
// one light (all the strings plugged into it) that is only ever on or off:
// it follows the show, its zone and its light's on switch, never effects.
function createEngine({ file, govee, esphome = null, tuya = null, log = console.log, onChange = () => {}, external = null, auto = true }) {
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let fresh = true;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg = { ...cfg, ...s, rotate: { ...cfg.rotate, ...s.rotate }, schedule: { ...cfg.schedule, ...s.schedule }, music: { ...cfg.music, ...s.music } };
    fresh = false;
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
  const externalOn = {};    // zone id -> external look playing there
  const isExternal = (id) => typeof id === 'string' && id.startsWith('govee:');
  function endExternal(zone) {
    if (!externalOn[zone]) return;
    delete externalOn[zone];
    // Resend that zone's Govee lights over LAN.
    for (const d of cfg.devices) if (d.zone === zone && d.ip && isGovee(d)) delete sent[d.ip];
  }

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

  const isBle = (d) => d.kind === 'brmesh';
  const isRelay = (d) => d.kind === 'relay';
  const isEsp = (d) => isBle(d) || isRelay(d);
  const isPlug = (d) => d.kind === 'plug';
  const isGovee = (d) => !d.kind || d.kind === 'govee';
  const onOffOnly = (d) => isRelay(d) || isPlug(d);
  const espNames = (d) => (isBle(d) ? d.ble : isRelay(d) ? d.ch : null) || [];
  const devOfLight = (lid) => devById(lid.split(':')[0]);

  // ── Zones ─────────────────────────────────────────────────────────────────
  const zoneIds = () => cfg.zones.map(z => z.id);
  const zoneById = (id) => cfg.zones.find(z => z.id === id);
  const devZone = (d) => (zoneById(d.zone) ? d.zone : cfg.zones[0].id);
  const lightZone = (lid) => { const d = devById(lid.split(':')[0]); return d ? devZone(d) : cfg.zones[0].id; };
  const lightsIn = (zones) => cfg.order.filter(id => zones.includes(lightZone(id)));
  // 'front' = every front-* zone together (the front yard, usually in sync).
  const frontZones = () => zoneIds().filter(z => z.startsWith('front'));
  function normZones(zone) {
    if (zone === undefined || zone === null || zone === '' || zone === 'all') return zoneIds();
    const list = [...new Set((Array.isArray(zone) ? zone : [zone]).flatMap(z => z === 'front' ? frontZones() : [z]))];
    for (const z of list) if (!zoneById(z)) throw new Error(`No zone "${z}"`);
    return list;
  }
  // Old configs: give devices zones (Bluetooth -> Backyard, Govee pairs split
  // front left / front right) and move the single current look into zones.
  (function migrateZones() {
    const govee = cfg.devices.filter(d => !isEsp(d));
    let touched = false;
    for (const d of cfg.devices) if (!zoneById(d.zone)) {
      d.zone = isBle(d) ? 'back' : isRelay(d) ? 'front-left' : govee.indexOf(d) < Math.ceil(govee.length / 2) ? 'front-left' : 'front-right';
      if (!zoneById(d.zone)) d.zone = cfg.zones[0].id;
      touched = true;
    }
    for (const z of cfg.zones) if (z.current === undefined) { z.current = cfg.current || null; touched = true; }
    if (touched) save();
  })();
  // The look on every zone, if they all agree.
  function yardLook() { const c = cfg.zones.map(z => z.current); return c.every(x => x && x === c[0]) ? c[0] : null; }
  // Next free ESPHome names (brmesh_1.. / relay_1..) across all ESP32 devices.
  const PREFIX = { brmesh: 'brmesh', relay: 'relay' };
  function nextEspNames(kind, n) {
    const used = new Set(cfg.devices.flatMap(espNames));
    const out = []; let i = 1;
    while (out.length < n) { const nm = `${PREFIX[kind]}_${i++}`; if (!used.has(nm)) out.push(nm); }
    return out;
  }
  function normNames(kind, list) {
    const max = kind === 'relay' ? 16 : 8;
    const names = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map(x => String(x).trim()).filter(Boolean)
      .map(x => /^\d+$/.test(x) ? `${PREFIX[kind]}_${x}` : x);
    if (!names.length || names.length > max) throw new Error(`List 1-${max} ESPHome names (e.g. ${PREFIX[kind]}_1, ${PREFIX[kind]}_2)`);
    if (names.some(n => !/^[a-z0-9_]+$/i.test(n))) throw new Error('Names: letters, numbers and _ only');
    return names;
  }
  const setEspNames = (d, names) => { if (isBle(d)) d.ble = names; else d.ch = names; d.segments = names.length; };
  // ESP32 devices may share an IP (one board, several groups); Govee controllers may not.
  function ipClash(ip, kind, selfId) {
    return cfg.devices.some(x => x.id !== selfId && x.ip === ip && !(kind !== 'govee' && isEsp(x)));
  }
  function espOff(d) {
    if (!esphome || !d.ip) return;
    for (const n of espNames(d)) { isRelay(d) ? esphome.relay(d.ip, n, false) : esphome.off(d.ip, n); delete sent[`${d.ip}/${n}`]; }
  }

  const okIp = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  const newId = () => `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  function nextLightName() {
    const used = new Set(Object.values(cfg.lights).map(L => L.name));
    let n = 1; while (used.has(`Light ${n}`)) n++;
    return `Light ${n}`;
  }
  function seedPairs() {
    for (let p = 1; p <= PAIR_SLOTS; p++) cfg.devices.push({ id: newId() + p, ip: '', sku: '', name: `Pair ${p}`, segments: 2, zone: p <= PAIR_SLOTS / 2 ? 'front-left' : 'front-right' });
    syncLights();
    cfg.order.forEach((id, i) => { cfg.lights[id].name = `Light ${i + 1}`; });
    save();
  }
  if (fresh) seedPairs();

  const KIND_NAME = { govee: 'Pair', brmesh: 'Bluetooth pair', relay: 'C9 relays', plug: 'C9 plug' };
  function addDevice({ ip = '', sku = '', name, segments = 2, kind = 'govee', ble, ch, zone, mac, tuyaId, tuyaKey, tuyaVersion }) {
    ip = String(ip || '').trim();
    kind = KIND_NAME[kind] ? kind : 'govee';
    if (ip && !okIp(ip)) throw new Error('IP must look like 192.168.1.50');
    if (ip && ipClash(ip, kind)) throw new Error(`${ip} is already added`);
    let n = Math.max(1, Math.min(15, Math.round(Number(segments) || 1)));
    const d = { id: newId(), ip, sku, name: String(name || `${KIND_NAME[kind]} ${cfg.devices.length + 1}`).slice(0, 40), segments: n };
    if (kind === 'plug') {
      d.kind = kind; d.segments = n = 1;
      d.tuyaId = String(tuyaId || '').trim(); d.tuyaKey = String(tuyaKey || '').trim(); d.tuyaVersion = String(tuyaVersion || '3.3');
    } else if (kind !== 'govee') {
      d.kind = kind;
      const given = kind === 'brmesh' ? ble : ch;
      setEspNames(d, given ? normNames(kind, given) : nextEspNames(kind, n));
      n = d.segments;
    }
    d.zone = zone && zoneById(zone) ? zone : kind === 'brmesh' && zoneById('back') ? 'back' : cfg.zones[0].id;
    if (mac) d.mac = String(mac).slice(0, 40);
    const before = new Set(Object.keys(cfg.lights));
    cfg.devices.push(d);
    syncLights();
    for (const id of cfg.order) if (!before.has(id)) {
      cfg.lights[id].name = isRelay(d) ? `C9 ${cfg.order.filter(x => isRelay(devOfLight(x))).indexOf(id) + 1}` : isPlug(d) ? d.name : nextLightName();
      if (onOffOnly(d)) cfg.lights[id].string = '#ffb46b';
    }
    changed();
    log(`Added ${d.name} (${ip || 'no IP yet'}, ${n} light${n > 1 ? 's' : ''})`);
    return d;
  }
  function updateDevice(id, { ip, sku, name, segments, ble, ch, zone, mac, tuyaId, tuyaKey, tuyaVersion }) {
    const d = devById(id); if (!d) throw new Error('No such device');
    if (isPlug(d)) {
      if (tuyaId !== undefined) d.tuyaId = String(tuyaId).trim();
      if (tuyaKey) d.tuyaKey = String(tuyaKey).trim();          // blank = keep the saved key
      if (tuyaVersion !== undefined) d.tuyaVersion = String(tuyaVersion);
      segments = undefined;
    }
    if (zone !== undefined) { if (!zoneById(zone)) throw new Error(`No zone "${zone}"`); d.zone = zone; }
    if (mac !== undefined) d.mac = String(mac).slice(0, 40) || undefined;
    const given = isBle(d) ? ble : isRelay(d) ? ch : undefined;
    if (given !== undefined) {
      const names = normNames(d.kind, given);
      if (running) espOff(d);
      setEspNames(d, names); segments = names.length;
    }
    if (ip !== undefined) {
      ip = String(ip).trim();
      if (ip && !okIp(ip)) throw new Error('IP must look like 192.168.1.50');
      if (ip && ipClash(ip, d.kind, id)) throw new Error(`${ip} is already used`);
      if (ip !== d.ip) {
        if (running && d.ip) isEsp(d) ? espOff(d) : isPlug(d) ? (tuya && tuya.set(d, false)) : govee.turn(d.ip, false);
        delete sent[d.ip];
        log(ip ? `${d.name} -> ${ip}` : `${d.name}: IP cleared`);
      }
      d.ip = ip;
    }
    if (sku !== undefined) d.sku = String(sku).slice(0, 40);
    if (name !== undefined) d.name = String(name).slice(0, 40) || d.name;
    const before = new Set(Object.keys(cfg.lights));
    if (segments !== undefined && isEsp(d) && given === undefined) {
      const cur = espNames(d), n = Math.max(1, Math.min(isRelay(d) ? 16 : 8, Math.round(Number(segments) || 1)));
      setEspNames(d, n > cur.length ? [...cur, ...nextEspNames(d.kind, n - cur.length)] : cur.slice(0, n));
      segments = n;
    }
    if (segments !== undefined) d.segments = Math.max(1, Math.min(15, Math.round(Number(segments) || 1)));
    syncLights();
    for (const lid of cfg.order) if (!before.has(lid)) {
      cfg.lights[lid].name = nextLightName();
      if (isRelay(d)) cfg.lights[lid].string = '#ffb46b';
    }
    delete sent[d.ip]; changed();
  }
  function removeDevice(id) {
    const d = devById(id); if (!d) throw new Error('No such device');
    if (running && d.ip) isEsp(d) ? espOff(d) : isPlug(d) ? (tuya && tuya.set(d, false)) : govee.turn(d.ip, false);
    if (isPlug(d) && tuya) tuya.forget(d);
    cfg.devices = cfg.devices.filter(x => x.id !== id);
    delete sent[d.ip];
    syncLights(); changed();
    log(`Removed ${d.name}`);
  }

  // Apply a patch to a light's settings object (live, or a look being designed).
  function applyPatch(L, p) {
    if (p.on !== undefined) L.on = !!p.on;
    if (p.effect !== undefined) { if (!EFFECTS[p.effect]) throw new Error(`Unknown effect "${p.effect}"`); L.effect = p.effect; }
    if (p.palette !== undefined) L.palette = normPalette(p.palette);
    if (p.color !== undefined) L.palette = [normColor(p.color), ...L.palette.slice(1)];
    if (p.bri !== undefined) L.bri = Math.max(0, Math.min(100, Math.round(Number(p.bri) || 0)));
    if (p.speed !== undefined) L.speed = Math.max(0.25, Math.min(4, Number(p.speed) || 1));
    if (p.name !== undefined) L.name = String(p.name).slice(0, 40) || L.name;
    if (p.string !== undefined) L.string = normColor(p.string);
  }
  function patchLight(id, p) {
    const L = cfg.lights[id]; if (!L) throw new Error(`No light "${id}"`);
    endExternal(lightZone(id));
    if (p.effect !== undefined) delete mem[id];
    applyPatch(L, p);
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

  // On/off strings run effects on white/black. Effects that sparkle "the other
  // colours" over a dim base get white/white, so the sparkles switch them on.
  const relayPalette = (effect) => ['twinkle', 'snowfall', 'sparkle'].includes(effect) ? [WHITE, WHITE] : effect === 'runner' ? [BLACK, WHITE] : [WHITE, BLACK];

  function frame(t) {
    const yardN = cfg.order.length;
    const musicOn = cfg.music.enabled && Date.now() - music.at < MUSIC_STALE_MS;
    const m = musicOn ? { level: music.level, beats: music.beats, bpm: music.bpm } : null;
    // Lights in one zone running the same effect form a group in yard order,
    // so chases and waves stay inside their zone.
    const zoneOff = new Set(cfg.zones.filter(z => z.off).map(z => z.id));
    const lit = (id) => { const L = cfg.lights[id]; return L && L.on && !zoneOff.has(lightZone(id)); };
    const groups = {}, gkey = (id) => `${lightZone(id)}|${cfg.lights[id].effect}`;
    for (const id of cfg.order) if (lit(id)) (groups[gkey(id)] = groups[gkey(id)] || []).push(id);
    const out = {};
    for (const id of cfg.order) {
      const L = cfg.lights[id]; if (!L) continue;
      let rgb;
      const ov = overrides[id];
      if (ov && Date.now() < ov.until) rgb = ov.fx(Date.now());
      else {
        if (ov) delete overrides[id];
        if (!lit(id) || L.bri === 0) rgb = { r: 0, g: 0, b: 0 };
        else {
          const g = groups[gkey(id)], i = g.indexOf(id), n = g.length;
          const dv = devOfLight(id);
          if (isPlug(dv)) { out[id] = hex(L.string || '#ffb46b'); continue; }   // on/off only, no effects
          const relay = isRelay(dv);
          const ctx = { t, i, n, pos: n > 1 ? i / n : 0, yard: yardN > 1 ? cfg.order.indexOf(id) / (yardN - 1) : 0, palette: relay ? relayPalette(L.effect) : L.palette.map(hex), speed: L.speed, mem: mem[id] = mem[id] || {}, music: m };
          let c;
          try { c = EFFECTS[L.effect].fx(ctx); } catch (_) { c = ctx.palette[0]; }
          // A C9 string is on when the effect is bright; it shows its own colour.
          rgb = relay ? (Math.max(c.r, c.g, c.b) >= 128 ? hex(L.string || '#ffb46b') : { r: 0, g: 0, b: 0 }) : scale(c, clamp01(L.bri / 100));
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
      if (!d.ip) continue;   // empty slot: preview only
      // A Govee cloud scene runs on the lights themselves; Bluetooth lights
      // can't play those, so they keep taking frames.
      if (externalOn[devZone(d)] && isGovee(d)) continue;
      const ids = lightIdsFor(d);
      if (isPlug(d)) {
        if (!tuya) continue;
        const c = colors[ids[0]], on = !!(c && (c.r || c.g || c.b));
        if (sent[d.ip] === on) continue;
        sent[d.ip] = on; tuya.set(d, on);
        continue;
      }
      if (isRelay(d)) {
        if (!esphome) continue;
        ids.forEach((id, i) => {
          const name = d.ch[i], c = colors[id]; if (!name || !c) return;
          const on = !!(c.r || c.g || c.b), sk = `${d.ip}/${name}`;
          if (sent[sk] === on || !esphome.ready(d.ip, name, 'switch')) return;
          sent[sk] = on; esphome.relay(d.ip, name, on);
        });
        continue;
      }
      if (isBle(d)) {
        if (!esphome) continue;
        // One command per light; master brightness folded into the colour.
        ids.forEach((id, i) => {
          const name = d.ble[i], c = colors[id]; if (!name || !c) return;
          const m = Math.max(1, cfg.master) / 100;
          const v = { r: Math.round(c.r * m), g: Math.round(c.g * m), b: Math.round(c.b * m) };
          const key = `${v.r},${v.g},${v.b}`, sk = `${d.ip}/${name}`;
          if (sent[sk] === key || !esphome.ready(d.ip, name)) return;
          sent[sk] = key; esphome.color(d.ip, name, v);
        });
        continue;
      }
      const lit = ids.some(id => {
        const c = colors[id]; return (c && (c.r || c.g || c.b)) || (overrides[id] && Date.now() < overrides[id].until);
      });
      const zOff = zoneById(devZone(d)).off;
      const anyOn = (!zOff && ids.some(id => cfg.lights[id] && cfg.lights[id].on)) || ids.some(id => overrides[id]);
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
    if (!cfg.devices.length) throw new Error('Add a pair first (Setup)');
    running = true; cfg.running = true;
    for (const k of Object.keys(sent)) delete sent[k];
    tick(); changed();
    log(`Show ON${reason ? ` (${reason})` : ''}`);
    for (const z of cfg.zones) if (isExternal(z.current)) { try { applyLook(z.current, { quiet: true, zone: z.id }); } catch (_) {} }
  }
  function stop(reason = '') {
    if (!running) { cfg.running = false; changed(); return; }
    running = false; cfg.running = false;
    clearTimeout(timer); timer = null;
    for (const d of cfg.devices) if (d.ip) { if (isEsp(d)) { espOff(d); continue; } if (isPlug(d)) { if (tuya) tuya.set(d, false); continue; } govee.dropEffects(d.ip); govee.turn(d.ip, false, 0); }
    if (Object.keys(externalOn).length) { external.power(false).catch(() => {}); for (const z of Object.keys(externalOn)) delete externalOn[z]; }
    for (const k of Object.keys(sent)) delete sent[k];
    changed();
    log(`Show OFF${reason ? ` (${reason})` : ''}`);
  }

  // ── Looks ─────────────────────────────────────────────────────────────────
  const allLooks = () => [
    ...BUILTIN_LOOKS.map(l => ({ id: l.id, name: l.name, builtin: true, effect: l.effect, palette: l.palette })),
    ...cfg.looks.map(l => ({ id: l.id, name: l.name, builtin: false })),
    ...(external ? external.looks().map(l => ({ ...l, builtin: true })) : []),
  ];
  // zone: a zone id, a list, or omitted for the whole yard.
  function applyLook(id, { quiet = false, zone } = {}) {
    const zones = normZones(zone);
    const look = allLooks().find(l => l.id === id);
    if (!look) throw new Error(`No look "${id}"`);
    const where = zones.length === cfg.zones.length ? '' : ` on ${zones.map(z => zoneById(z).name).join(', ')}`;
    if (isExternal(id)) {
      if (!external) throw new Error(`No look "${id}"`);
      // Which Govee lights: those in these zones we know the hardware id of.
      // Whole yard with none known -> every light on the account.
      const macs = cfg.devices.filter(d => isGovee(d) && zones.includes(devZone(d)) && d.mac).map(d => d.mac);
      if (!macs.length && zones.length !== cfg.zones.length) {
        throw new Error('To play a Govee scene in one zone, add its Govee lights with Scan → Use first, so the app knows which zone they are in');
      }
      for (const z of zones) zoneById(z).current = id;
      changed();
      if (!running) return;   // plays when the show starts
      for (const z of zones) externalOn[z] = id;
      external.play(id.slice('govee:'.length), macs.length ? macs : null).then(
        () => { if (!quiet) log(`Look: ${look.name} (Govee scene)${where}`); },
        (e) => { log(`Govee scene ${look.name}: ${e.message}`); for (const z of zones) if (externalOn[z] === id) endExternal(z); onChange(); });
      return;
    }
    for (const z of zones) endExternal(z);
    const ids = lightsIn(zones);
    const b = BUILTIN_LOOKS.find(l => l.id === id);
    if (b) {
      for (const lid of ids) patchLight(lid, { on: true, effect: b.effect, palette: b.palette });
    } else {
      const s = cfg.looks.find(l => l.id === id);
      for (const [lid, set] of Object.entries(s.lights)) if (cfg.lights[lid] && ids.includes(lid)) { const { name, ...rest } = set; patchLight(lid, rest); }
    }
    for (const z of zones) zoneById(z).current = id;
    for (const lid of ids) delete mem[lid];
    changed();
    if (!quiet) log(`Look: ${look.name}${where}`);
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
    for (const z of cfg.zones) z.current = look.id;
    changed(); log(`Saved look "${name}"`);
  }
  // Build a look without touching the lights that are playing: start from a
  // saved look (or the yard as it is), apply edits [{ ids, patch }], save it
  // under name. patch.speedx multiplies that light's speed.
  function designLook(name, edits, baseId) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw new Error('Give the look a name');
    const base = baseId && cfg.looks.find(l => l.id === baseId);
    const lights = {};
    for (const [id, L] of Object.entries(cfg.lights)) {
      const { name: _n, ...rest } = L;
      lights[id] = JSON.parse(JSON.stringify(base && base.lights[id] ? { ...rest, ...base.lights[id] } : rest));
    }
    for (const { ids, patch } of edits) {
      for (const id of ids === 'all' ? Object.keys(lights) : ids) {
        if (!lights[id]) continue;
        const { speedx, ...p } = patch;
        if (speedx !== undefined && p.speed === undefined) p.speed = lights[id].speed * speedx;
        applyPatch(lights[id], p);
      }
    }
    const existing = cfg.looks.find(l => l.name.toLowerCase() === name.toLowerCase()) || base;
    if (existing) { existing.lights = lights; existing.name = name; }
    else cfg.looks.push({ id: `my-${Date.now().toString(36)}`, name, lights });
    const look = existing || cfg.looks[cfg.looks.length - 1];
    if (!cfg.rotate.list.includes(look.id)) cfg.rotate.list.push(look.id);
    changed(); log(`Designed look "${name}"`);
    return { id: look.id, name: look.name };
  }
  function deleteLook(id) {
    if (BUILTIN_LOOKS.some(l => l.id === id)) throw new Error("Built-in looks can't be deleted (take them out of the playlist instead)");
    cfg.looks = cfg.looks.filter(l => l.id !== id);
    cfg.rotate.list = cfg.rotate.list.filter(x => x !== id);
    for (const z of cfg.zones) if (z.current === id) z.current = null;
    changed();
  }

  // ── Auto-rotate ───────────────────────────────────────────────────────────
  let nextRotateAt = null;
  const rotateZones = () => (cfg.rotate.zones || zoneIds()).filter(z => zoneById(z));
  function rotateList() { const ids = allLooks().map(l => l.id); return cfg.rotate.list.filter(id => ids.includes(id)); }
  function rotateCheck() {
    const r = cfg.rotate, list = rotateList();
    if (!running || !r.enabled || !list.length) { nextRotateAt = null; return; }
    if (!nextRotateAt) {
      // Starting: keep the look that's already showing if it's in the playlist.
      const rz = rotateZones(); if (!rz.length) { nextRotateAt = null; return; }
      const cur = list.indexOf(zoneById(rz[0]).current);
      if (cur >= 0) r.index = cur; else { r.index %= list.length; rotateApply(list[r.index]); }
      nextRotateAt = Date.now() + r.minutes * 60000; onChange(); return; }
    if (Date.now() >= nextRotateAt) {
      r.index = (r.index + 1) % list.length;
      rotateApply(list[r.index]);
      nextRotateAt = Date.now() + r.minutes * 60000;
      onChange();
    }
  }
  function rotateApply(id) {
    try { applyLook(id, { zone: rotateZones() }); }
    catch (e) { log(`Auto-rotate: ${e.message}`); }
  }
  if (auto) setInterval(rotateCheck, 5000);

  // ── Schedule ──────────────────────────────────────────────────────────────
  // Acts only when the clock crosses on/off, so a manual OFF mid-evening holds
  // until tomorrow. Booting inside the window turns the show on.
  // A zone can have its own times (e.g. Backyard off at 9): crossing them
  // turns just that zone on or off. Zones without their own times follow the
  // yard schedule.
  let lastInside = null;
  const lastZoneInside = {};
  function scheduleCheck() {
    const sc = cfg.schedule;
    let now;
    try { now = localMinutes(sc.tz); } catch (e) { log(`schedule: ${e.message}`); return; }
    for (const z of cfg.zones) {
      const zs = z.schedule;
      if (!zs || !zs.enabled) { delete lastZoneInside[z.id]; continue; }
      const inside = inWindow(now, toMin(zs.on), toMin(zs.off));
      if (inside !== lastZoneInside[z.id]) {
        const was = lastZoneInside[z.id];
        lastZoneInside[z.id] = inside;
        if (!!z.off === !inside) continue;
        z.off = !inside; changed();
        if (was !== undefined) log(`${z.name} ${inside ? 'on' : 'off'} (schedule)`);
        if (inside && !running) { try { start('schedule'); } catch (e) { log(`schedule: ${e.message}`); } }
      }
    }
    if (!sc.enabled) { lastInside = null; return; }
    const inside = inWindow(now, toMin(sc.on), toMin(sc.off));
    if (inside && lastInside !== true && !running) { try { start('schedule'); } catch (e) { log(`schedule: ${e.message}`); } }
    else if (!inside && lastInside === true && running) stop('schedule');
    lastInside = inside;
  }
  if (auto) setInterval(scheduleCheck, 30000);
  if (auto) setTimeout(() => {
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
      if (!d.ip) throw new Error('Give it an IP first');
      if (isPlug(d)) {
        if (!tuya) throw new Error('Smart plug support is off');
        const r = await tuya.probe(d);
        return { ok: true, plug: r };
      }
      if (isEsp(d)) {
        if (!esphome) throw new Error('ESP32 support is off');
        const r = await esphome.probe(d.ip, espNames(d), isRelay(d) ? 'switch' : 'light');
        const bad = Object.entries(r).filter(([, v]) => v.error);
        return { ok: !bad.length, esp: r, error: bad.length ? `${bad.map(([n, v]) => `${n}: ${v.error}`).join('; ')}` : null };
      }
      const r = await govee.probe(d.ip);
      return { ok: !!r, status: r };
    },

    // ids: [lightId] or 'all'
    setLights(ids, patch) {
      const list = ids === 'all' ? [...cfg.order] : ids;
      if (!Array.isArray(list) || !list.length) throw new Error('Pick at least one light');
      for (const id of list) patchLight(id, patch);
      if (patch.effect !== undefined || patch.palette !== undefined || patch.color !== undefined) {
        for (const z of new Set(list.map(lightZone))) zoneById(z).current = null;
      }
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

    applyLook: (id, zone) => { applyLook(id, { zone }); if (cfg.rotate.enabled) { const i = rotateList().indexOf(id); if (i >= 0) { cfg.rotate.index = i; nextRotateAt = Date.now() + cfg.rotate.minutes * 60000; } } return api.status(); },
    saveLook: (name) => { saveLook(name); return api.status(); },
    designLook: (name, edits, baseId) => designLook(name, edits, baseId),
    savedLooks: () => cfg.looks,
    // Whole settings, for copying the yard into the training sandbox.
    exportConfig: () => JSON.parse(JSON.stringify(cfg)),
    loadConfig(c) {
      cfg = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...JSON.parse(JSON.stringify(c)) };
      for (const k of Object.keys(sent)) delete sent[k];
      for (const k of Object.keys(mem)) delete mem[k];
      for (const k of Object.keys(externalOn)) delete externalOn[k];
      syncLights(); changed(); return api.status();
    },
    // Add a look designed elsewhere (the sandbox) to this yard's saved looks.
    importLook({ name, lights }) {
      name = String(name || '').trim().slice(0, 40) || 'Elf Special';
      const existing = cfg.looks.find(l => l.name.toLowerCase() === name.toLowerCase());
      if (existing) existing.lights = JSON.parse(JSON.stringify(lights));
      else cfg.looks.push({ id: `my-${Date.now().toString(36)}`, name, lights: JSON.parse(JSON.stringify(lights)) });
      const look = existing || cfg.looks[cfg.looks.length - 1];
      if (!cfg.rotate.list.includes(look.id)) cfg.rotate.list.push(look.id);
      changed(); log(`Kept look "${name}" from training`);
      return { id: look.id, name: look.name };
    },
    deleteLook: (id) => { deleteLook(id); return api.status(); },

    setRotate({ enabled, minutes, list, zones } = {}) {
      if (zones !== undefined) { cfg.rotate.zones = zones === null || zones === 'all' ? null : normZones(zones); nextRotateAt = null; }
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
      applyLook(list[cfg.rotate.index], { zone: rotateZones() });
      if (nextRotateAt) nextRotateAt = Date.now() + cfg.rotate.minutes * 60000;
      return api.status();
    },
    // Zone power, name, and its own schedule ({ enabled, on, off }).
    setZone(id, patch = {}) {
      if (id === 'front') { for (const z of frontZones()) api.setZone(z, { ...patch, name: undefined }); return api.status(); }
      const { name, off, schedule } = patch;
      const z = zoneById(id); if (!z) throw new Error(`No zone "${id}"`);
      if (name !== undefined) z.name = String(name).trim().slice(0, 30) || z.name;
      if (off !== undefined) {
        z.off = !!off;
        if (!z.off && !running) start('manual');
        log(`${z.name} ${z.off ? 'off' : 'on'}`);
      }
      if (schedule !== undefined) {
        const zs = z.schedule = { enabled: false, on: cfg.schedule.on, off: cfg.schedule.off, ...z.schedule };
        if (schedule.on !== undefined) { if (!okTime(schedule.on)) throw new Error('On time must be HH:MM'); zs.on = schedule.on; }
        if (schedule.off !== undefined) { if (!okTime(schedule.off)) throw new Error('Off time must be HH:MM'); zs.off = schedule.off; }
        if (schedule.enabled !== undefined) zs.enabled = !!schedule.enabled;
        delete lastZoneInside[id]; scheduleCheck();
      }
      changed(); return api.status();
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
    // Lights in a zone playing a Govee scene aren't previewed (we can't see it).
    preview() {
      if (!running) return {};
      const out = frame(Date.now() - t0);
      for (const id of Object.keys(out)) if (externalOn[lightZone(id)] && isGovee(devOfLight(id))) delete out[id];
      return out;
    },

    status() {
      return {
        running, master: cfg.master, external: { ...externalOn },
        groups: frontZones().length > 1 ? [{ id: 'front', name: 'Front yard', zones: frontZones() }] : [],
        zones: cfg.zones.map(z => ({ id: z.id, name: z.name, off: !!z.off, current: z.current || null, schedule: z.schedule || null })),
        // A plug's local key never leaves the server.
        devices: cfg.devices.map(({ tuyaKey, ...d }) => ({ ...d, ...(isPlug(d) ? { hasKey: !!tuyaKey } : {}), zone: devZone(d), kind: d.kind || 'govee',
          lastSeen: !d.ip ? null : isEsp(d) ? (esphome ? esphome.lastSeen(d.ip) : null) : isPlug(d) ? (tuya ? tuya.lastSeen(d) : null) : govee.lastSeen(d.ip) })),
        lights: cfg.order.map(id => ({ id, device: id.split(':')[0], zone: lightZone(id), relay: isRelay(devOfLight(id)) || undefined, plug: isPlug(devOfLight(id)) || undefined, ...cfg.lights[id] })),
        looks: allLooks(), current: yardLook(),
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

module.exports = { createEngine, BUILTIN_LOOKS, DEFAULT_ZONES };
