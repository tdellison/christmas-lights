// ─── BRMesh (FastCon BLE) lights through an ESP32 bridge ──────────────────────
//
// BRMesh lights only speak Bluetooth advertisements, so an ESP32 running
// ESPHome + the fastcon component (deploy/esp32-brmesh.yaml) sends them. We
// talk to the ESP32 over ESPHome's web_server REST API:
//   POST http://<esp>/light/<name>/turn_on?r=&g=&b=&brightness=&transition=0
//   POST http://<esp>/light/<name>/turn_off
//
// BLE adverts drop if spammed, so each light gets at most one command per
// MIN_GAP_MS, only when its colour changed, and never more than one in flight.
// A light still busy just skips the tick (newest colour wins, no backlog).

'use strict';

const MIN_GAP_MS = 250;

function createBrmesh({ log = console.log } = {}) {
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
      (e) => { if (s.err !== e.message) log(`BRMesh: ${e.message}`); s.err = e.message; },
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

  return {
    // Ready for another command: nothing in flight and the gap has passed.
    ready(host, name) {
      const s = st[`${host}/${name}`];
      return !s || (!s.busy && Date.now() - s.at >= MIN_GAP_MS);
    },
    color, off,
    async probe(host, names) {
      const out = {};
      for (const n of names) {
        try {
          const r = await fetch(`http://${host}/light/${encodeURIComponent(n)}`, { signal: AbortSignal.timeout(2500) });
          out[n] = r.ok ? await r.json() : { error: `HTTP ${r.status}` };
          if (r.ok) lastSeen[host] = Date.now();
        } catch (e) { out[n] = { error: e.message }; }
      }
      return out;
    },
    lastSeen: (host) => lastSeen[host] || null,
  };
}

module.exports = { createBrmesh };
