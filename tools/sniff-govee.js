#!/usr/bin/env node
// ─── Govee show sniffer ───────────────────────────────────────────────────────
//
// Plays Govee shows (scenes / your DIYs) on the lights and asks one spotlight
// "what colour are you?" several times a second, to learn each show's flavor:
// its main colours and how fast it changes. Govee won't hand out the shows
// themselves, so this is the only way to see inside them.
//
// Works through the running app (it owns the Govee LAN port), so the app must
// be up and the spotlight online.
//
//   node tools/sniff-govee.js 192.168.1.209 "Sleigh Ride"      one show
//   node tools/sniff-govee.js 192.168.1.209 --all              every DIY + Christmas scene
//   options: --seconds 20  --rate 4  --app http://localhost:3100
//
// Results: data/sniff/<show>.json (raw samples + summary) and a line each on screen.
// First thing to check: if every sample is the same colour, the light only
// reports its last solid colour during shows and sniffing can't work.

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : def; };
const APP = opt('app', 'http://localhost:3100');
const SECONDS = Number(opt('seconds', 20));
const RATE = Number(opt('rate', 4));
const all = args.includes('--all'); if (all) args.splice(args.indexOf('--all'), 1);
const [ip, showName] = args;
if (!ip || (!showName && !all)) { console.log('usage: node tools/sniff-govee.js <spotlight ip> "<show name>" | --all'); process.exit(1); }

const OUT = path.join(__dirname, '..', 'data', 'sniff');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(APP + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!j.ok) throw new Error(j.error || `${p} failed`); return j;
}
const { summarize } = require('../lib/flavor');

async function sniff(device, look) {
  await api('/api/looks/apply', { id: look.id });
  await sleep(2500);                                       // let the cloud command land
  const samples = [], t0 = Date.now(), gap = 1000 / RATE;
  while (Date.now() - t0 < SECONDS * 1000) {
    const t = Date.now();
    try {
      const r = await api(`/api/devices/${device.id}/probe`);
      const st = r.status && r.status.status;
      samples.push({ t: t - t0, color: st && st.color ? st.color : null, brightness: st ? st.brightness : null, on: st ? st.onOff : null });
    } catch (e) { samples.push({ t: t - t0, error: e.message }); }
    await sleep(Math.max(0, gap - (Date.now() - t)));
  }
  const summary = summarize(samples);
  const file = path.join(OUT, look.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '_') + '.json');
  fs.writeFileSync(file, JSON.stringify({ show: look.name, id: look.id, ip, at: new Date().toISOString(), seconds: SECONDS, rate: RATE, summary, samples }, null, 2));
  return summary;
}

(async () => {
  const { status } = await api('/api/status');
  const device = status.devices.find(d => d.ip === ip);
  if (!device) throw new Error(`No device with IP ${ip} in the app (Setup)`);
  const govee = status.looks.filter(l => l.govee);
  const want = all ? govee.filter(l => l.group === 'diy' || l.group === 'xmas')
    : govee.filter(l => l.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === showName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  if (!want.length) throw new Error(`No Govee show called "${showName}"`);
  const test = await api(`/api/devices/${device.id}/probe`).catch(e => ({ status: { ok: false }, err: e.message }));
  if (!test.status || !test.status.ok) throw new Error(`${ip} isn't answering. Is it plugged in, on Wi-Fi, with LAN Control on?`);
  const wasRunning = status.running;
  if (!wasRunning) await api('/api/start');
  console.log(`Sniffing ${want.length} show(s) on ${ip}, ${SECONDS}s each at ${RATE}/s ...`);
  try {
    for (const look of want) {
      const s = await sniff(device, look);
      const line = !s.answered ? 'no answers'
        : s.stuck ? `STUCK on ${s.colours[0].hex} (light doesn't report show colours)`
        : `${s.colours.map(c => `${c.hex} ${c.share}%`).join(', ')} · ${s.changesPerSecond} changes/s`;
      console.log(`  ${look.name}: ${line}`);
    }
  } finally { if (!wasRunning) await api('/api/stop').catch(() => {}); }
  console.log(`Saved in ${OUT}`);
})().catch(e => { console.error('Sniffer:', e.message); process.exit(1); });
