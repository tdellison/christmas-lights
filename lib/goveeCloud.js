// ─── Govee cloud: the scenes and DIYs that live in the Govee app ──────────────
//
// Govee's own scenes ("Christmas-A", "Sled", ...) and DIYs saved from the app's
// Share Space can't be sent over the LAN; they're played through Govee's
// Platform API (openapi.api.govee.com, key from the Govee app). The scene then
// runs on the light itself, so the engine stops streaming while one is on.
//
// The key lives in secrets.json (git-ignored) and never goes to the browser.

'use strict';

const fs = require('fs');
const crypto = require('crypto');

const BASE = 'https://openapi.api.govee.com/router/api/v1';
const DEFAULT_FAVS = ['Christmas-A', 'Christmas-B', 'Christmas Tree', 'Sled', 'Christmas Gift', 'Winter', 'Glacier', 'Star', 'Aurora', 'Fireworks'];

function createGoveeCloud({ file, log = console.log, onChange = () => {} }) {
  let sec = {};
  try { sec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  sec.favorites = sec.favorites || DEFAULT_FAVS;
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(sec, null, 2), { mode: 0o600 }); } catch (e) { log(`secrets save failed: ${e.message}`); } };

  let devices = [];           // { sku, device, name }
  let scenes = [];            // { key, name, kind: 'scene'|'diy', value, skus:Set }
  let lastError = null, loadedAt = null;

  async function req(method, path, payload) {
    if (!sec.goveeApiKey) throw new Error('No Govee API key (Setup → Govee account)');
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Govee-API-Key': sec.goveeApiKey, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify({ requestId: crypto.randomUUID(), payload }) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.code && j.code !== 200)) throw new Error(`Govee: ${j.msg || j.message || r.status}`);
    return j;
  }

  async function refresh() {
    try {
      const d = await req('GET', '/user/devices');
      devices = (d.data || []).filter(x => (x.capabilities || []).some(c => c.instance === 'lightScene' || c.instance === 'diyScene'))
        .map(x => ({ sku: x.sku, device: x.device, name: x.deviceName || x.sku }));
      const byKey = new Map();
      for (const dev of devices) {
        for (const [path, kind] of [['/device/scenes', 'scene'], ['/device/diy-scenes', 'diy']]) {
          const j = await req('POST', path, { sku: dev.sku, device: dev.device });
          for (const c of (j.payload && j.payload.capabilities) || []) {
            for (const o of (c.parameters && c.parameters.options) || []) {
              const key = `${kind}:${o.name}`;
              const s = byKey.get(key) || { key, name: o.name, kind, values: {} };
              s.values[dev.device] = { instance: c.instance, type: c.type, value: o.value };
              byKey.set(key, s);
            }
          }
        }
      }
      scenes = [...byKey.values()];
      lastError = null; loadedAt = Date.now();
      log(`Govee account: ${devices.length} light${devices.length === 1 ? '' : 's'}, ${scenes.filter(s => s.kind === 'scene').length} scenes, ${scenes.filter(s => s.kind === 'diy').length} DIYs`);
    } catch (e) { lastError = e.message; log(`Govee account: ${e.message}`); }
    onChange();
  }

  async function play(key) {
    const s = scenes.find(x => x.key === key);
    if (!s) throw new Error(`No Govee scene "${key}"`);
    const results = await Promise.allSettled(Object.entries(s.values).map(([device, v]) => {
      const dev = devices.find(d => d.device === device);
      return req('POST', '/device/control', { sku: dev.sku, device, capability: { type: v.type, instance: v.instance, value: v.value } });
    }));
    const bad = results.filter(r => r.status === 'rejected');
    if (bad.length === results.length) throw bad[0].reason;
    if (bad.length) log(`Govee scene ${s.name}: ${bad.length} light(s) didn't answer`);
  }

  async function power(on) {
    await Promise.allSettled(devices.map(d => req('POST', '/device/control', {
      sku: d.sku, device: d.device, capability: { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: on ? 1 : 0 },
    })));
  }

  if (sec.goveeApiKey) refresh();
  // DIYs saved in the app show up within the hour.
  setInterval(() => { if (sec.goveeApiKey) refresh(); }, 60 * 60000);

  return {
    refresh, play, power,
    get enabled() { return !!sec.goveeApiKey; },
    // Looks offered to the engine: favourite scenes + every DIY.
    looks() {
      return scenes.filter(s => s.kind === 'diy' || sec.favorites.includes(s.name))
        .map(s => ({ id: `govee:${s.key}`, name: s.name, govee: s.kind }));
    },
    setKey(key) {
      key = String(key || '').trim();
      if (key && !/^[0-9a-f-]{20,64}$/i.test(key)) throw new Error("That doesn't look like a Govee API key");
      sec.goveeApiKey = key || undefined; save();
      devices = []; scenes = [];
      if (key) return refresh();
      onChange();
    },
    setFavorites(list) {
      if (!Array.isArray(list)) throw new Error('favorites must be a list of scene names');
      sec.favorites = list.map(String); save(); onChange();
    },
    status() {
      return {
        enabled: !!sec.goveeApiKey, keyHint: sec.goveeApiKey ? `…${sec.goveeApiKey.slice(-4)}` : null,
        devices: devices.map(d => ({ sku: d.sku, device: d.device, name: d.name })),
        scenes: scenes.map(s => ({ key: s.key, name: s.name, kind: s.kind, fav: s.kind === 'diy' || sec.favorites.includes(s.name) })),
        lastError, loadedAt,
      };
    },
  };
}

module.exports = { createGoveeCloud };
