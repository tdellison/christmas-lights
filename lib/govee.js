// ─── Govee LAN API (UDP) ──────────────────────────────────────────────────────
//
// Discovery: send {scan} to multicast 239.255.255.250:4001, lights answer on
// :4002. Control: JSON to <ip>:4003. Status: {devStatus} -> answer on :4002.
//
// A controller drops packets when hit faster than ~20/s, so every send goes
// through a per-IP queue with a 50 ms minimum gap. Lower priority number =
// sent first (0 = urgent, 2 = effect frames). Effect frames for a light that
// still has one waiting are dropped by the engine (latest look wins).
//
// Per-segment colour ("ptReal"): undocumented but widely used (govee2mqtt,
// govee-lan-bridge). The controller's own 20-byte Bluetooth-style frame,
// base64'd: 33 05 15 01 RR GG BB 00 00 00 00 00 <mask lo> <mask hi> ... byte 20
// = XOR of the first 19. Mask bit n = segment n+1. On a Spotlight 2 two-pack,
// segment 1 / 2 = light 1 / 2 (confirmed on haunt-ctrl, Oct 2026).

'use strict';

const dgram = require('dgram');

const CMD_PORT = 4003;
const LISTEN_PORT = 4002;
const SCAN_PORT = 4001;
const MULTICAST = '239.255.255.250';
const MIN_GAP_MS = 50;

function segmentFrame(rgb, mask) {
  const b = Buffer.alloc(20);
  b.set([0x33, 0x05, 0x15, 0x01, rgb.r, rgb.g, rgb.b, 0, 0, 0, 0, 0, mask & 0xff, (mask >> 8) & 0xff]);
  let x = 0; for (let i = 0; i < 19; i++) x ^= b[i];
  b[19] = x;
  return b.toString('base64');
}

function createGovee({ log = console.log, onFound = () => {}, onStatus = () => {}, cmdPort = CMD_PORT, listenPort = LISTEN_PORT } = {}) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const queues = {};          // ip -> { q, busy, lastSent }
  const waiters = new Map();  // ip -> [resolve] for status probes
  const lastSeen = {};        // ip -> ms

  sock.on('error', (e) => log(`govee socket: ${e.message}`));
  sock.bind(listenPort, () => {
    try { sock.addMembership(MULTICAST); } catch (_) {}
    log(`Govee LAN listening on :${listenPort}`);
  });
  sock.on('message', (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf.toString()).msg; } catch (_) { return; }
    if (!m) return;
    const ip = (m.data && m.data.ip) || rinfo.address;
    lastSeen[ip] = Date.now();
    if (m.cmd === 'scan') onFound({ ip, sku: m.data?.sku || '', device: m.data?.device || '' });
    if (m.cmd === 'devStatus') {
      onStatus(ip, m.data || {});
      const w = waiters.get(ip);
      if (w) { waiters.delete(ip); w.forEach(r => r(m.data || {})); }
    }
  });

  function raw(ip, msg) {
    return new Promise((resolve, reject) => {
      const p = Buffer.from(JSON.stringify({ msg }));
      sock.send(p, 0, p.length, cmdPort, ip, (e) => e ? reject(e) : resolve());
    });
  }
  function q(ip) { return queues[ip] || (queues[ip] = { q: [], busy: false, lastSent: 0 }); }
  function drain(ip) {
    const s = q(ip);
    if (s.busy || !s.q.length) return;
    s.busy = true;
    setTimeout(async () => {
      const it = s.q.shift();
      s.lastSent = Date.now();
      try { await raw(ip, it.msg); it.resolve(); } catch (e) { it.resolve(); }
      s.busy = false;
      drain(ip);
    }, Math.max(0, s.lastSent + MIN_GAP_MS - Date.now()));
  }
  function send(ip, msg, priority = 2) {
    if (!ip) return Promise.resolve();
    return new Promise((resolve) => {
      const s = q(ip);
      let i = s.q.length;
      while (i > 0 && s.q[i - 1].priority > priority) i--;
      s.q.splice(i, 0, { msg, priority, resolve });
      drain(ip);
    });
  }

  const api = {
    send,
    pending: (ip) => (queues[ip] ? queues[ip].q.length + (queues[ip].busy ? 1 : 0) : 0),
    dropEffects(ip) {
      const s = queues[ip]; if (!s) return;
      for (const it of s.q) if (it.priority >= 2) it.resolve();
      s.q = s.q.filter(it => it.priority < 2);
    },
    turn: (ip, on, pr = 1) => send(ip, { cmd: 'turn', data: { value: on ? 1 : 0 } }, pr),
    brightness: (ip, v, pr = 1) => send(ip, { cmd: 'brightness', data: { value: Math.max(1, Math.min(100, Math.round(v))) } }, pr),
    color: (ip, rgb, pr = 2) => send(ip, { cmd: 'colorwc', data: { color: rgb, colorTemInKelvin: 0 } }, pr),
    // segs: [{ mask, rgb }] -> one packet carrying every frame.
    segments: (ip, segs, pr = 2) => send(ip, { cmd: 'ptReal', data: { command: segs.map(s => segmentFrame(s.rgb, s.mask)) } }, pr),

    scan() {
      const p = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
      sock.send(p, 0, p.length, SCAN_PORT, MULTICAST, () => {});
      try {
        sock.setBroadcast(true);
        sock.send(p, 0, p.length, SCAN_PORT, '255.255.255.255', () => { try { sock.setBroadcast(false); } catch (_) {} });
      } catch (_) {}
    },
    // Ask one light for its status; resolves with data, or null after timeout.
    probe(ip, ms = 1500) {
      return new Promise((resolve) => {
        const list = waiters.get(ip) || []; waiters.set(ip, list);
        const done = (d) => { clearTimeout(t); resolve(d); };
        list.push(done);
        const t = setTimeout(() => {
          const l = waiters.get(ip) || []; const i = l.indexOf(done); if (i >= 0) l.splice(i, 1);
          resolve(null);
        }, ms);
        raw(ip, { cmd: 'devStatus', data: {} }).catch(() => {});
      });
    },
    lastSeen: (ip) => lastSeen[ip] || null,
    close: () => { try { sock.close(); } catch (_) {} },
  };
  return api;
}

module.exports = { createGovee, segmentFrame };
