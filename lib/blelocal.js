// ─── BRMesh lights straight from the server's Bluetooth (TP-Link UB500) ──────
//
// Sends FastCon adverts with raw HCI legacy advertising through `hcitool`
// (given cap_net_raw/cap_net_admin once with setcap; README "Bluetooth
// lights"). Proven 2026-11-15: an ESP32 without its antenna didn't reach the
// lights; this adapter does.
//
// Sequence numbers: a light ignores a message unless its sequence number is
// "newer" (mod 256) than the last one it accepted, and the BRMesh app uses
// the same counter space. So every command goes out twice, at seq s and
// s+128: whatever the light last saw, one copy is newer. The counter is saved.
//
// One advert at a time (the adapter has one legacy advertising set), ~150 ms
// each. Only the newest wish per light is kept: no backlog.

'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { command } = require('../tools/fastcon');

const ADV_MS = 150;

function createBleLocal({ adapter = '58:D8:12:36:D0:B5', key, seqFile, log = console.log } = {}) {
  const keyBytes = String(key || '').match(/../g)?.map(h => parseInt(h, 16)) || [];
  let seq = 0;
  try { seq = JSON.parse(fs.readFileSync(seqFile, 'utf8')).seq | 0; } catch (_) {}
  const wishes = new Map();     // light id (number) -> light data bytes
  const sentAt = {};            // light id -> ms of last send
  let order = [], hci = null, ready = false, busy = false, err = null, lastOk = null;

  const run = (args) => new Promise((resolve, reject) =>
    execFile('hcitool', ['-i', hci, ...args], { timeout: 3000 }, (e, out) => (e ? reject(e) : resolve(out))));
  const cmd = (ocf, ...bytes) => run(['cmd', '0x08', ocf, ...bytes]);

  async function init() {
    if (keyBytes.length !== 4) { err = 'no mesh key (deploy/secrets.yaml brmesh_mesh_key)'; log(`Bluetooth: ${err}`); return; }
    try {
      const out = await new Promise((resolve, reject) => execFile('hciconfig', (e, o) => (e ? reject(e) : resolve(o))));
      let cur = null;
      for (const line of out.split('\n')) { const m = /^(hci\d+):/.exec(line); if (m) cur = m[1]; if (line.includes(adapter)) { hci = cur; break; } }
      if (!hci) throw new Error(`adapter ${adapter} not found`);
      await cmd('0x000A', '00');                                                   // advertising off
      await cmd('0x0006', '20', '00', '20', '00', '03', '00', '00', '00', '00', '00', '00', '00', '00', '07', '00');   // 20 ms, non-connectable, all channels
      ready = true; err = null;
      log(`Bluetooth: sending to BRMesh lights from ${hci}`);
    } catch (e) { err = e.message; log(`Bluetooth: ${e.message}`); setTimeout(init, 30000); }
  }
  init();

  let saveTimer = null;
  const saveSeq = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(seqFile, JSON.stringify({ seq })); } catch (_) {} }, 1000); };

  async function advertise(lightId, data) {
    for (const s of [seq, (seq + 128) & 0xff]) {
      const p = command(keyBytes, lightId, data, s).adv;
      const adv = [0x02, 0x01, 0x06, p.length + 3, 0xff, 0xf0, 0xff, ...p];
      while (adv.length < 31) adv.push(0);
      await cmd('0x000A', '00');
      await cmd('0x0008', '1f', ...adv.map(b => b.toString(16).padStart(2, '0')));
      await cmd('0x000A', '01');
      await new Promise(r => setTimeout(r, ADV_MS));
    }
    seq = (seq + 1) & 0xff; saveSeq();
  }

  // Round-robin over lights with a pending wish, newest wish only.
  async function pump() {
    if (busy || !ready || !wishes.size) return;
    busy = true;
    try {
      while (wishes.size) {
        const id = order.find(i => wishes.has(i)) ?? [...wishes.keys()][0];
        order = [...order.filter(i => i !== id), id];
        const data = wishes.get(id); wishes.delete(id);
        try { await advertise(id, data); sentAt[id] = lastOk = Date.now(); err = null; }
        catch (e) { if (err !== e.message) log(`Bluetooth: ${e.message}`); err = e.message; }
      }
      await cmd('0x000A', '00').catch(() => {});
    } finally { busy = false; }
  }

  // FastCon light data: [0x80 + brightness 0-127, B, R, G, warm, cold] or [0x00] = off.
  function data({ r, g, b }) {
    const max = Math.max(r, g, b);
    if (!max) return [0x00];
    const k = (v) => Math.round(v * 255 / max);
    return [0x80 + Math.max(1, Math.round(max / 255 * 127)), k(b), k(r), k(g), 0, 0];
  }

  return {
    // lightId: the light's number in the BRMesh app (1, 2...).
    color(lightId, rgb) { wishes.set(lightId, data(rgb)); pump(); },
    off(lightId) { wishes.set(lightId, [0x00]); pump(); },
    // Always ready: a newer wish just replaces a pending one.
    ready: () => true,
    status: () => ({ ready, adapter: hci, error: err, lastOk }),
    lastSeen: () => lastOk,
  };
}

module.exports = { createBleLocal };
