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
const { createTuya } = require('./lib/tuya');
const { createBleLocal } = require('./lib/blelocal');
const { createAssistant } = require('./lib/assistant');
const { createTraining } = require('./lib/training');
const { createDirector } = require('./lib/director');
const { createHealth } = require('./lib/health');
const { createOccasion } = require('./lib/occasion');
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
// Govee cloud scenes/DIYs only when config.json has goveeCloud: true (off by
// default: they were made for roofline lights). Off = no Govee cloud calls.
const GOVEE_CLOUD = (() => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).goveeCloud === true; } catch (_) { return false; } })();
const cloud = GOVEE_CLOUD ? createGoveeCloud({ file: SECRETS, log, onChange: () => { sendStatus(); broadcast({ type: 'cloud', data: cloud.status() }); } }) : null;
const cloudStatus = () => (cloud ? cloud.status() : { off: true });
const tuya = createTuya({ log });
// BRMesh lights from the server's TP-Link Bluetooth; mesh key from deploy/secrets.yaml.
const meshKey = (() => { try { return (/^brmesh_mesh_key:\s*"?([0-9a-fA-F]{8})/m.exec(fs.readFileSync(path.join(__dirname, 'deploy', 'secrets.yaml'), 'utf8')) || [])[1]; } catch (_) { return null; } })();
const bleLocal = createBleLocal({ key: meshKey, seqFile: path.join(__dirname, 'ble-seq.json'), log });
engine = createEngine({ file: DATA, govee, tuya, bleLocal, log, onChange: sendStatus, external: cloud && { looks: () => cloud.looks(), play: (k, macs) => cloud.play(k, macs), power: (on) => cloud.power(on) } });

// Ask the elves: plain-English commands through local Qwen.
const aiState = () => ({ ...llama.status(), history: assistant.history() });
const sendAi = () => broadcast({ type: 'ai', data: aiState() });
const llama = createLlama({ log, onChange: sendAi });
const training = createTraining({ file: path.join(__dirname, 'training.json'), log, onChange: () => { sendAi(); sendTrain(); } });
const { PALETTES } = require('./lib/effects');
// "Your Favourites" palette: the colours of the owner's 9 built-in looks (their
// scheme; Rainbow Wheel left out), at most 8. The elves and Director design with it.
function updateFavourites() {
  const cols = [...new Set(engine.status().looks.filter(l => l.builtin && !l.govee && l.palette && l.palette !== 'rainbow' && l.palette !== 'favourites')
    .flatMap(l => (PALETTES[l.palette] || { colors: [] }).colors))].slice(0, 8);
  const had = JSON.stringify(PALETTES.favourites && PALETTES.favourites.colors);
  if (cols.length >= 2) PALETTES.favourites = { name: 'Your Favourites', colors: cols };
  else delete PALETTES.favourites;
  if (JSON.stringify(PALETTES.favourites && PALETTES.favourites.colors) !== had) sendStatus();
}
setTimeout(updateFavourites, 5000);
const dirState = () => ({ director: director ? director.status() : null, tonight: typeof occasion !== 'undefined' ? occasion.now() : null });
function sendDir() { broadcast({ type: 'director', data: dirState() }); }
const assistant = createAssistant({ engine, llama, training, log, onChange: sendAi });
// Qwen as show director (lib/director.js), special nights + weather for him,
// and light health alerts.
const occasion = createOccasion({ engine, log, onChange: () => sendDir() });
const health = createHealth({ engine, log, onChange: () => broadcast({ type: 'alerts', data: health.alerts() }) });
const director = createDirector({ file: path.join(__dirname, 'director.json'), engine, llama, occasion, log, onChange: () => sendDir() });

// ── Training sandbox ── a copy of the yard the elves can practise on. It has
// no drivers, so nothing it does reaches a real light; only the app shows it.
let trainTimer = null;   // coalesce bursts of training changes into one message
const nogo = { turn() {}, brightness() {}, color() {}, segments() {}, pending: () => 0, dropEffects() {}, lastSeen: () => null, probe: async () => null };
const sandbox = createEngine({ file: path.join(__dirname, 'sandbox.json'), govee: nogo, log: () => {}, auto: false, onChange: () => sendTrain(),
  external: cloud && { looks: () => cloud.looks(), play: async () => {}, power: async () => {} } });
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
  ws.send(JSON.stringify({ type: 'cloud', data: cloudStatus() }));
  ws.send(JSON.stringify({ type: 'train', data: trainState() }));
  ws.send(JSON.stringify({ type: 'director', data: dirState() }));
  ws.send(JSON.stringify({ type: 'alerts', data: health.alerts() }));
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
app.post('/api/rotate', route((b) => { if (b.enabled) director.set({ enabled: false }); return engine.setRotate(b); }));
app.post('/api/schedule', route((b) => engine.setSchedule(b)));

// Music: enable/disable, and the feed itself ({ level, beat, bpm }).
app.post('/api/music/enable', route(({ enabled }) => engine.setMusic({ enabled })));
app.post('/api/music', (req, res) => { engine.music(req.body || {}); res.json({ ok: true }); });

// Govee account (cloud scenes + DIYs from the Govee app).
const cloudRoute = (fn) => async (req, res) => {
  try { if (!cloud) throw new Error('Govee cloud is off (goveeCloud in config.json)'); await fn(req.body || {}); res.json({ ok: true, cloud: cloud.status(), status: engine.status() }); }
  catch (e) { res.status(409).json({ ok: false, error: e.message }); }
};
app.get('/api/govee', (req, res) => res.json({ ok: true, cloud: cloudStatus() }));
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

// Director: Qwen picks the next show.
const dirRoute = (fn) => async (req, res) => {
  try { const r = await fn(req.body || {}); res.json({ ok: true, ...(r || {}), ...dirState() }); }
  catch (e) { res.status(409).json({ ok: false, error: e.message }); }
};
app.post('/api/alerts/dismiss', (req, res) => { health.dismiss((req.body || {}).id); res.json({ ok: true, alerts: health.alerts() }); });
app.post('/api/alerts/check', async (req, res) => { await health.check(); res.json({ ok: true, alerts: health.alerts() }); });
app.post('/api/location', route((b) => { const st = engine.setLocation(b); occasion.refresh(); return st; }));
app.get('/api/director', (req, res) => res.json({ ok: true, ...dirState() }));
app.post('/api/director', dirRoute(({ enabled, minutes }) => { director.set({ enabled, minutes }); }));
app.post('/api/director/now', dirRoute(() => { director.now(); }));

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
