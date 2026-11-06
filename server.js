// christmas-lights — Christmas yard light controller for Govee LAN lights.
// Open http://<server-ip>:3100 on your phone.

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createGovee } = require('./lib/govee');
const { createEngine } = require('./lib/engine');
const { createLlama } = require('./lib/llama');
const { createGoveeCloud } = require('./lib/goveeCloud');
const { createEsphome } = require('./lib/esphome');
const { createTuya } = require('./lib/tuya');
const { createAssistant } = require('./lib/assistant');
const { createTraining } = require('./lib/training');
const { createTrainTest } = require('./lib/trainTest');

const PORT = Number(process.env.PORT) || 3100;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3101;
const TLS = path.join(__dirname, 'tls');
const DATA = process.env.CHRISTMAS_LIGHTS_CONFIG || path.join(__dirname, 'config.json');
const SECRETS = process.env.CHRISTMAS_LIGHTS_SECRETS || path.join(__dirname, 'secrets.json');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
// HTTPS twin (tls/, git-ignored): Android Chrome only installs the page as a
// full-screen app from a secure origin. tls/ca.crt is a local CA the tablet
// trusts once (README "Install as an app"); it signs cert.pem for this IP.
const secure = fs.existsSync(path.join(TLS, 'key.pem'))
  ? https.createServer({ key: fs.readFileSync(path.join(TLS, 'key.pem')), cert: fs.readFileSync(path.join(TLS, 'cert.pem')) }, app)
  : null;
const sockets = [server, secure].filter(Boolean).map(s => new WebSocketServer({ server: s }));
const clients = () => sockets.flatMap(w => [...w.clients]);

const logs = [];
function log(msg) {
  const line = { at: Date.now(), msg };
  logs.push(line); if (logs.length > 200) logs.shift();
  console.log(`[${new Date().toISOString()}] ${msg}`);
  broadcast({ type: 'log', data: line });
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients()) if (c.readyState === 1) c.send(s);
}

const found = new Map();   // ip -> { ip, sku, device, at }
const govee = createGovee({
  log,
  onFound: (d) => { const isNew = !found.has(d.ip); found.set(d.ip, { ...d, at: Date.now() }); if (isNew) log(`Found ${d.sku || 'Govee light'} at ${d.ip}`); broadcast({ type: 'found', data: [...found.values()] }); },
});
let engine = null;
const sendStatus = () => engine && broadcast({ type: 'status', data: engine.status() });
const cloud = createGoveeCloud({ file: SECRETS, log, onChange: () => { sendStatus(); broadcast({ type: 'cloud', data: cloud.status() }); } });
const esphome = createEsphome({ log });
const tuya = createTuya({ log });
engine = createEngine({ file: DATA, govee, esphome, tuya, log, onChange: sendStatus, external: { looks: () => cloud.looks(), play: (k, macs) => cloud.play(k, macs), power: (on) => cloud.power(on) } });

// Ask the elves: plain-English commands through local Llama.
const aiState = () => ({ ...llama.status(), history: assistant.history() });
const sendAi = () => broadcast({ type: 'ai', data: aiState() });
const llama = createLlama({ log, onChange: sendAi });
const training = createTraining({ file: path.join(__dirname, 'training.json'), log, onChange: () => { sendAi(); sendTrain(); } });
const assistant = createAssistant({ engine, llama, training, log, onChange: sendAi });

// ── Training sandbox ── a copy of the yard the elves can practise on. It has
// no drivers, so nothing it does reaches a real light; only the app shows it.
let trainTimer = null;   // coalesce bursts of training changes into one message
const nogo = { turn() {}, brightness() {}, color() {}, segments() {}, pending: () => 0, dropEffects() {}, lastSeen: () => null, probe: async () => null };
const sandbox = createEngine({ file: path.join(__dirname, 'sandbox.json'), govee: nogo, log: () => {}, auto: false, onChange: () => sendTrain(),
  external: { looks: () => cloud.looks(), play: async () => {}, power: async () => {} } });
const resetSandbox = () => { sandbox.loadConfig(engine.exportConfig()); try { sandbox.start(); } catch (_) {} };
resetSandbox();
const trainer = createAssistant({ engine: sandbox, llama, training, log: (m) => log(`[training] ${m}`), onChange: () => sendTrain() });
const trainTest = createTrainTest({ llama, training, log, onChange: () => sendTrain() });
const trainState = () => ({
  history: trainer.history(), notes: training.notes(), examples: training.examples(), test: trainTest.status(),
  yard: sandbox.status(),
});
function sendTrain() { if (trainTimer) return; trainTimer = setTimeout(() => { trainTimer = null; broadcast({ type: 'train', data: trainState() }); }, 100); }
llama.warm();
// Prime the elves once the Govee shows have loaded, and again if the list of
// shows changes (it's part of their instructions).
setTimeout(() => assistant.prime(), 30000);
setInterval(() => assistant.prime(), 15 * 60000);

// Live colours to the phone, 5x/s, only while someone's watching and it's on.
setInterval(() => { if (clients().length && engine.running) broadcast({ type: 'preview', data: engine.preview() }); }, 200);
setInterval(() => { if (clients().length && sandbox.running) broadcast({ type: 'sbpreview', data: sandbox.preview() }); }, 200);

const onConnect = (ws) => {
  ws.send(JSON.stringify({ type: 'status', data: engine.status() }));
  ws.send(JSON.stringify({ type: 'found', data: [...found.values()] }));
  ws.send(JSON.stringify({ type: 'logs', data: logs }));
  ws.send(JSON.stringify({ type: 'ai', data: aiState() }));
  ws.send(JSON.stringify({ type: 'cloud', data: cloud.status() }));
  ws.send(JSON.stringify({ type: 'train', data: trainState() }));
};
for (const w of sockets) w.on('connection', onConnect);

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

app.post('/api/looks/apply', route(({ id, zone }) => engine.applyLook(id, zone)));
// { name, off, schedule: { enabled, on, off } }
app.post('/api/zones/:id', route((b, req) => engine.setZone(req.params.id, b)));
app.post('/api/looks/save', route(({ name }) => engine.saveLook(name)));
app.post('/api/looks/delete', route(({ id }) => engine.deleteLook(id)));
app.post('/api/looks/next', route(() => engine.nextLook()));
app.post('/api/rotate', route((b) => engine.setRotate(b)));
app.post('/api/schedule', route((b) => engine.setSchedule(b)));

// Music: enable/disable, and the feed itself ({ level, beat, bpm }).
app.post('/api/music/enable', route(({ enabled }) => engine.setMusic({ enabled })));
app.post('/api/music', (req, res) => { engine.music(req.body || {}); res.json({ ok: true }); });

// Govee account (cloud scenes + DIYs from the Govee app).
const cloudRoute = (fn) => async (req, res) => {
  try { await fn(req.body || {}); res.json({ ok: true, cloud: cloud.status(), status: engine.status() }); }
  catch (e) { res.status(409).json({ ok: false, error: e.message }); }
};
app.get('/api/govee', (req, res) => res.json({ ok: true, cloud: cloud.status() }));
app.post('/api/govee/key', cloudRoute(({ key }) => cloud.setKey(key)));
app.post('/api/govee/refresh', cloudRoute(() => cloud.refresh()));
app.post('/api/govee/favorites', cloudRoute(({ favorites }) => cloud.setFavorites(favorites)));

// { text } -> { reply }
app.post('/api/ask', async (req, res) => {
  try { res.json({ ok: true, ...(await assistant.ask((req.body || {}).text)), status: engine.status() }); }
  catch (e) { res.status(409).json({ ok: false, error: e.message }); }
});
app.get('/api/ask', (req, res) => res.json({ ok: true, ai: aiState() }));
app.post('/api/ask/clear', (req, res) => { assistant.clear(); res.json({ ok: true }); });

// Training: same elves, practising on the sandbox yard.
const trainRoute = (fn) => async (req, res) => {
  try { const r = await fn(req.body || {}); res.json({ ok: true, ...(r || {}), train: trainState() }); }
  catch (e) { res.status(409).json({ ok: false, error: e.message }); }
};
app.get('/api/train', (req, res) => res.json({ ok: true, train: trainState() }));
app.post('/api/train/ask', trainRoute(({ text }) => trainer.ask(text)));
app.post('/api/train/good', trainRoute(({ id }) => trainer.good(id)));
app.post('/api/train/retry', trainRoute(({ id, hint }) => trainer.retry(id, hint)));
app.post('/api/train/reset', trainRoute(() => { resetSandbox(); trainer.clear(); }));
app.post('/api/train/play', trainRoute(({ id }) => { sandbox.applyLook(id); }));
app.post('/api/train/keep', trainRoute(({ id }) => {
  const look = sandbox.savedLooks().find(l => l.id === id);
  if (!look) throw new Error('That design is gone');
  return { kept: engine.importLook(look) };
}));
app.post('/api/train/note', trainRoute(({ text }) => { training.addNote(text); }));
app.post('/api/train/note/delete', trainRoute(({ id }) => { training.deleteNote(id); }));
app.post('/api/train/example/delete', trainRoute(({ id }) => { training.deleteExample(id); }));
app.post('/api/train/test', trainRoute(() => { trainTest.run(); }));

// The CA certificate (public half only) for the tablet to trust.
app.get('/ca.crt', (req, res) => {
  const f = path.join(TLS, 'ca.crt');
  if (!fs.existsSync(f)) return res.status(404).send('No certificate set up');
  res.type('application/x-x509-ca-cert').attachment('christmas-lights-ca.crt').send(fs.readFileSync(f));
});

server.listen(PORT, () => log(`christmas-lights on http://0.0.0.0:${PORT}`));
if (secure) secure.listen(HTTPS_PORT, () => log(`christmas-lights on https://0.0.0.0:${HTTPS_PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { govee.close(); process.exit(0); });
