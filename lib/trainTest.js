// ─── The elves' scored test ───────────────────────────────────────────────────
//
// 14 typical requests on a throwaway yard (nothing real is touched), each
// checked for the right result. Uses whatever the owner has taught, so it
// shows whether training helped. Takes a few minutes; the live elves wait
// their turn behind it.

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createEngine } = require('./engine');
const { createAssistant } = require('./assistant');

const SHOWS = ['🍬 Santa Sleigh', 'Sleigh Ride', 'The Grinch 4', 'Sparkling Snow', 'Christmas Eve'];
const rgb = (c) => { const n = parseInt(String(c).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const reddish = (c) => { const [r, g, b] = rgb(c); return r > 150 && g < 120 && b < 120; };
const greenish = (c) => { const [r, g, b] = rgb(c); return g > 120 && r < 150 && b < 150; };
const blueish = (c) => { const [r, , b] = rgb(c); return b > 150 && r < 150; };
const goldish = (c) => { const [r, g, b] = rgb(c); return r > 180 && g > 120 && b < 100; };

function createTrainTest({ llama, training, log = console.log, onChange = () => {} }) {
  let state = { running: false, results: [], startedAt: null, finishedAt: null, pass: 0, total: 0 };

  async function run() {
    if (state.running) throw new Error('The test is already running');
    const file = path.join(os.tmpdir(), `elves-test-${process.pid}.json`);
    try { fs.unlinkSync(file); } catch (_) {}
    const nogo = { turn() {}, brightness() {}, color() {}, segments() {}, pending: () => 0, dropEffects() {}, lastSeen: () => null, probe: async () => null };
    const ext = { looks: () => SHOWS.map(n => ({ id: `govee:diy:${n}`, name: n, govee: 'diy', group: 'diy' })), play: async () => {}, power: async () => {} };
    const engine = createEngine({ file, govee: nogo, log: () => {}, external: ext, auto: false });
    engine.addDevice({ kind: 'brmesh' });
    const a = createAssistant({ engine, llama, training, log: () => {} });
    const S = () => engine.status();
    const zl = (z) => S().lights.filter(l => l.zone === z);
    const pal = (l) => l.palette;
    const live = () => JSON.stringify(S().lights.map(l => [l.effect, l.palette, l.speed, l.on]));
    const saved = (r) => r.saved && engine.savedLooks().find(l => l.id === r.saved.id);
    const days = (() => { const n = new Date(); return Math.ceil((new Date(n.getFullYear(), 11, 25) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5); })();
    const TESTS = [
      ['red and green chase on front left', 'Front Left chases red & green; Front Right untouched', () => zl('front-left').every(l => l.effect === 'chase' && pal(l).some(reddish) && pal(l).some(greenish)) && zl('front-right')[0].palette.length === 3],
      ['something cozy', 'a cozy look (Cozy Hearth or Warm Twinkle)', () => ['hearth', 'twinkle-warm'].includes(S().current)],
      ['candy cane out front, warm twinkle out back', 'front zones Candy Cane Lane, Backyard Warm Twinkle', () => ['front-left', 'front-right'].every(z => S().zones.find(x => x.id === z).current === 'candy-cane') && S().zones.find(x => x.id === 'back').current === 'twinkle-warm'],
      ['turn off the backyard', 'Backyard off', () => S().zones.find(z => z.id === 'back').off === true],
      ['turn the backyard back on', 'Backyard on', () => S().zones.find(z => z.id === 'back').off === false],
      ['brighter', 'master 70% -> 90%', () => S().master === 90],
      ['come on at 5pm and go off at 10:30', 'schedule 17:00-22:30', () => S().schedule.on === '17:00' && S().schedule.off === '22:30' && S().schedule.enabled],
      ['make the odd ones gold', 'lights 1, 3, 5... gold; 2 not', () => [0, 2, 4, 6, 8, 10].every(i => goldish(S().lights[i].palette[0])) && !goldish(S().lights[1].palette[0])],
      ['blue and white twinkle on lights 7 to 12', 'lights 7-12 blue twinkle; light 1 not blue', () => S().lights.slice(6, 12).every(l => l.effect === 'twinkle' && pal(l).some(blueish)) && !pal(S().lights[0]).some(blueish)],
      ['slower', 'last-changed lights at half speed', () => S().lights[6].speed === 0.5],
      ['surprise me', 'a new saved look with 2+ different parts; live yard untouched', (r, before) => saved(r) && live() === before && new Set(Object.values(saved(r).lights).map(L => L.effect + L.palette.join())).size >= 2],
      ['design a grinch themed show called Mean One', 'saved "Mean One" with green; live yard untouched', (r, before) => saved(r) && r.saved.name === 'Mean One' && live() === before && Object.values(saved(r).lights).some(L => L.palette.some(greenish))],
      ['more red', '"Mean One" updated with red; live yard untouched', (r, before) => saved(r) && r.saved.name === 'Mean One' && live() === before && Object.values(saved(r).lights).some(L => L.palette.some(reddish))],
      ['how many days until christmas?', `says ${days}`, (r) => String(r.reply).includes(String(days))],
    ];
    state = { running: true, results: [], startedAt: Date.now(), finishedAt: null, pass: 0, total: TESTS.length };
    onChange(); log('Elves test started');
    try {
      engine.start(); engine.applyLook('classic-chase'); engine.setMaster(70);
      for (const [request, expect, check] of TESTS) {
        const before = live(); let r = {}, ok = false;
        try { r = await a.ask(request); ok = !!check(r, before); } catch (e) { r = { reply: `Error: ${e.message}` }; }
        state.results.push({ request, expect, ok, reply: String(r.reply || ''), ms: r.ms || 0 });
        if (ok) state.pass++;
        onChange();
      }
    } finally {
      state.running = false; state.finishedAt = Date.now();
      try { fs.unlinkSync(file); } catch (_) {}
      onChange(); log(`Elves test: ${state.pass}/${state.total} passed`);
    }
  }

  return { run: () => { run().catch(e => log(`Elves test: ${e.message}`)); }, status: () => state };
}

module.exports = { createTrainTest };
