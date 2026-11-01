// christmas-lights — Christmas yard light controller for Govee LAN lights.
// Open http://<server-ip>:3100 on your phone.

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createGovee } = require('./lib/govee');
const { createEngine } = require('./lib/engine');

const PORT = Number(process.env.PORT) || 3100;
const DATA = process.env.CHRISTMAS_LIGHTS_CONFIG || path.join(__dirname, 'config.json');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const logs = [];
function log(msg) {
  const line = { at: Date.now(), msg };
  logs.push(line); if (logs.length > 200) logs.shift();
  console.log(`[${new Date().toISOString()}] ${msg}`);
  broadcast({ type: 'log', data: line });
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

const found = new Map();   // ip -> { ip, sku, device, at }
const govee = createGovee({
  log,
  onFound: (d) => { const isNew = !found.has(d.ip); found.set(d.ip, { ...d, at: Date.now() }); if (isNew) log(`Found ${d.sku || 'Govee light'} at ${d.ip}`); broadcast({ type: 'found', data: [...found.values()] }); },
});
const engine = createEngine({ file: DATA, govee, log, onChange: () => broadcast({ type: 'status', data: engine.status() }) });

// Live colours to the phone, 5x/s, only while someone's watching and it's on.
setInterval(() => { if (wss.clients.size && engine.running) broadcast({ type: 'preview', data: engine.preview() }); }, 200);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', data: engine.status() }));
  ws.send(JSON.stringify({ type: 'found', data: [...found.values()] }));
  ws.send(JSON.stringify({ type: 'logs', data: logs }));
});

const route = (fn) => async (req, res) => {
  try { res.json({ ok: true, status: await fn(req.body || {}, req) }); }
  catch (e) { res.status(409).json({ ok: false, error: e.message }); }
};

app.get('/api/status', (req, res) => res.json({ ok: true, status: engine.status() }));
app.post('/api/start', route(() => engine.start()));
app.post('/api/stop', route(() => engine.stop()));
app.post('/api/master', route(({ value }) => engine.setMaster(value)));

app.post('/api/scan', route(() => { govee.scan(); setTimeout(() => govee.scan(), 1500); return engine.status(); }));
app.get('/api/found', (req, res) => res.json({ ok: true, found: [...found.values()] }));
app.post('/api/devices', route((b) => engine.addDevice(b)));
app.post('/api/devices/:id', route((b, req) => engine.updateDevice(req.params.id, b)));
app.delete('/api/devices/:id', route((b, req) => engine.removeDevice(req.params.id)));
app.post('/api/devices/:id/probe', route((b, req) => engine.probeDevice(req.params.id)));

// { ids: [..] | 'all', on, effect, palette, color, bri, speed, name }
app.post('/api/lights', route(({ ids, ...patch }) => engine.setLights(ids, patch)));
app.post('/api/lights/order', route(({ order }) => engine.setOrder(order)));
app.post('/api/lights/identify', route(({ id }) => engine.identify(id)));

app.post('/api/looks/apply', route(({ id }) => engine.applyLook(id)));
app.post('/api/looks/save', route(({ name }) => engine.saveLook(name)));
app.post('/api/looks/delete', route(({ id }) => engine.deleteLook(id)));
app.post('/api/looks/next', route(() => engine.nextLook()));
app.post('/api/rotate', route((b) => engine.setRotate(b)));
app.post('/api/schedule', route((b) => engine.setSchedule(b)));

// Music: enable/disable, and the feed itself ({ level, beat, bpm }).
app.post('/api/music/enable', route(({ enabled }) => engine.setMusic({ enabled })));
app.post('/api/music', (req, res) => { engine.music(req.body || {}); res.json({ ok: true }); });

server.listen(PORT, () => log(`christmas-lights on http://0.0.0.0:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { govee.close(); process.exit(0); });
