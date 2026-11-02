// ─── ESP32s running ESPHome, over its web_server REST API ─────────────────────
//
// Two kinds of ESP32 in the yard:
//  - BRMesh bridge (deploy/esp32-brmesh.yaml): Bluetooth lights, as ESPHome
//    lights. POST /light/<name>/turn_on?r=&g=&b=&brightness=&transition=0
//  - C9 relay board (deploy/esp32-relays.yaml): plain strings on solid-state
//    relays, as ESPHome switches. POST /switch/<name>/turn_on | turn_off
//
// Each entity gets at most one command per gap, only when it changed, and
// never more than one in flight. A busy one just skips the tick (newest state
// wins, no backlog). BLE adverts drop if spammed, so lights get a longer gap.

'use strict';

const GAP_MS = { light: 250, switch: 100 };

function createEsphome({ log = console.log } = {}) {
  const st = {};          // `${host}/${name}` -> { busy, at, ok, err }
  const lastSeen = {};    // host -> ms

  async function post(host, path) {
    const r = await fetch(`http://${host}${path}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`${host} ${path.split('?')[0]}: HTTP ${r.status}`);
    lastSeen[host] = Date.now();
  }

  function send(host, name, path) {
    const k = `${host}/${name}`;
    const s = st[k] = st[k] || { busy: false, at: 0 };
    s.busy = true; s.at = Date.now();
    post(host, path).then(
      () => { s.err = null; },
      (e) => { if (s.err !== e.message) log(`ESP32: ${e.message}`); s.err = e.message; },
    ).finally(() => { s.busy = false; });
  }

  // ESPHome normalises rgb to full intensity, so the dimming goes in brightness.
  function color(host, name, { r, g, b }) {
    const max = Math.max(r, g, b);
    if (!max) return off(host, name);
    const k = (v) => Math.round(v * 255 / max);
    send(host, name, `/light/${encodeURIComponent(name)}/turn_on?r=${k(r)}&g=${k(g)}&b=${k(b)}&brightness=${max}&transition=0`);
  }
  function off(host, name) { send(host, name, `/light/${encodeURIComponent(name)}/turn_off?transition=0`); }
  function relay(host, name, on) { send(host, name, `/switch/${encodeURIComponent(name)}/${on ? 'turn_on' : 'turn_off'}`); }

  return {
    // Ready for another command: nothing in flight and the gap has passed.
    ready(host, name, domain = 'light') {
      const s = st[`${host}/${name}`];
      return !s || (!s.busy && Date.now() - s.at >= GAP_MS[domain]);
    },
    color, off, relay,
    async probe(host, names, domain = 'light') {
      const out = {};
      for (const n of names) {
        try {
          const r = await fetch(`http://${host}/${domain}/${encodeURIComponent(n)}`, { signal: AbortSignal.timeout(2500) });
          out[n] = r.ok ? await r.json() : { error: `HTTP ${r.status}` };
          if (r.ok) lastSeen[host] = Date.now();
        } catch (e) { out[n] = { error: e.message }; }
      }
      return out;
    },
    lastSeen: (host) => lastSeen[host] || null,
  };
}

module.exports = { createEsphome };
