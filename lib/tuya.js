// ─── Tuya smart plugs (Enbrighten, Smart Life ...) over the LAN ───────────────
//
// Needs the plug's device id and local key (one-time setup, README "Smart
// plug"). After that it's local: no Tuya cloud.
//
// A plug is a mechanical relay (~100k clicks in its life), so it only ever
// switches for real on/off changes (show, zone, schedule), never for effects,
// and never sooner than MIN_GAP_MS after its last switch. A change asked for
// sooner waits, and only the newest wish is sent.

'use strict';

const TuyAPI = require('tuyapi');

const MIN_GAP_MS = 4000;
// Relay wear: ~100k clicks in a plug's life. 600 a night is about three
// seasons of nightly shows. Blinking stops (steady on) once tonight's are used.
const NIGHTLY_CLICKS = 600;

function createTuya({ log = console.log } = {}) {
  const plugs = {};   // device id -> { dev, sig, want, state, last, busy, timer, seen, err }
  const clicks = {};  // device id -> { day: 'YYYY-MM-DD', n }
  // The show night runs noon to noon, so a late night counts as one.
  const night = () => new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 10);
  const used = (id) => { const c = clicks[id]; return c && c.day === night() ? c.n : 0; };

  function plug(d) {
    const sig = `${d.ip}|${d.tuyaId}|${d.tuyaKey}|${d.tuyaVersion}`;
    let p = plugs[d.id];
    if (p && p.sig !== sig) { try { p.dev.disconnect(); } catch (_) {} clearTimeout(p.timer); p = null; }
    if (!p) {
      const dev = new TuyAPI({ id: d.tuyaId, key: d.tuyaKey, ip: d.ip, version: String(d.tuyaVersion || '3.3'), issueGetOnConnect: false });
      p = plugs[d.id] = { id: d.id, dev, sig, want: null, state: null, last: 0, busy: false, timer: null, seen: null, err: null, name: d.name };
      dev.on('data', () => { p.seen = Date.now(); });
      dev.on('error', (e) => { if (p.err !== e.message) log(`Plug ${p.name}: ${e.message}`); p.err = e.message; });
      dev.on('disconnected', () => {});
    }
    return p;
  }

  async function connect(p) {
    if (p.dev.isConnected()) return;
    await p.dev.connect();
  }

  async function pump(p) {
    if (p.busy || p.want === null || p.want === p.state) return;
    const wait = MIN_GAP_MS - (Date.now() - p.last);
    if (wait > 0) { clearTimeout(p.timer); p.timer = setTimeout(() => pump(p), wait); return; }
    p.busy = true;
    const want = p.want;
    try {
      await connect(p);
      await p.dev.set({ dps: 1, set: want });
      p.state = want; p.last = Date.now(); p.seen = Date.now(); p.err = null;
      const c = clicks[p.id] = clicks[p.id] && clicks[p.id].day === night() ? clicks[p.id] : { day: night(), n: 0 };
      c.n++;
    } catch (e) {
      if (p.err !== e.message) log(`Plug ${p.name}: ${e.message}`);
      p.err = e.message;
      try { p.dev.disconnect(); } catch (_) {}
      clearTimeout(p.timer); p.timer = setTimeout(() => pump(p), 10000);   // try again shortly
    } finally { p.busy = false; }
    if (p.want !== p.state) pump(p);
  }

  const ready = (d) => d && d.ip && d.tuyaId && d.tuyaKey;

  return {
    ready,
    // Ask for on/off; sent when allowed (see MIN_GAP_MS).
    set(d, on) {
      if (!ready(d)) return;
      const p = plug(d);
      p.want = !!on; pump(p);
    },
    async probe(d) {
      if (!ready(d)) throw new Error('Give it an IP, device ID and local key first');
      const p = plug(d);
      await connect(p);
      const r = await p.dev.get({ schema: true });
      p.seen = Date.now();
      return { on: r && r.dps ? r.dps['1'] : null, dps: r && r.dps };
    },
    // Switches left tonight before blinking stops.
    clicksLeft: (d) => Math.max(0, NIGHTLY_CLICKS - used(d.id)),
    NIGHTLY_CLICKS, MIN_GAP_MS,
    lastSeen: (d) => (plugs[d.id] && plugs[d.id].seen) || null,
    forget(d) { const p = plugs[d.id]; if (p) { try { p.dev.disconnect(); } catch (_) {} clearTimeout(p.timer); delete plugs[d.id]; } },
  };
}

module.exports = { createTuya };
