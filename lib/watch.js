// ─── Watch mode: play every show in turn so the owner can rate it ─────────────
//
// Plays each look / Govee show for N minutes on the real lights (or one zone),
// while the app shows 👍/👎, tags and a note box for the one playing. Auto-
// rotate is paused while watching and put back afterwards.
//
// While a Govee show plays it also sniffs it: asks a spotlight its colour ~4
// times a second and saves the show's colours and pace to the catalog (and
// data/sniff/), so one pass teaches both what's liked and what it looks like.

'use strict';

const fs = require('fs');
const path = require('path');
const { summarize } = require('./flavor');

// which: 'all' = everything; 'mine' = our looks + saved + DIYs + Christmas
// scenes (the default, skips the 59 other Govee scenes); 'unrated' = 'mine'
// minus shows already rated or tagged; 'govee' = DIYs + Christmas scenes.
function pickShows(looks, catalog, which) {
  const mine = looks.filter(l => !l.govee || l.group === 'diy' || l.group === 'xmas');
  if (which === 'all') return looks;
  if (which === 'govee') return looks.filter(l => l.group === 'diy' || l.group === 'xmas');
  if (which === 'unrated') { const c = catalog.all(); return mine.filter(l => !c[l.id] || (!c[l.id].up && !c[l.id].down && !c[l.id].tags.length)); }
  return mine;
}

function createWatch({ engine, catalog, sniffDir = null, log = console.log, onChange = () => {} }) {
  let st = null;     // { list: [{id, name}], i, minutes, zone, endsAt, rotateWas }
  let timer = null;
  let sniff = null;  // { show, samples, devs, di, fails, timer, t0 }

  const SNIFF_EVERY = 250, SETTLE = 2500;
  function startSniff(show) {
    stopSniff();
    if (!show.govee) return;
    const inZone = (z) => !st.zone || (st.zone === 'front' ? String(z).startsWith('front') : z === st.zone);
    const devs = engine.status().devices.filter(d => (!d.kind || d.kind === 'govee') && d.ip && inZone(d.zone));
    if (!devs.length) return;
    sniff = { show, samples: [], devs, di: 0, fails: 0, t0: Date.now() + SETTLE, timer: null };
    const loop = async () => {
      const me = sniff; if (!me) return;
      if (Date.now() >= me.t0) {
        const t = Date.now() - me.t0;
        try {
          const r = await engine.probeDevice(me.devs[me.di].id);
          const c = r && r.ok && r.status;
          if (c && c.color) { me.samples.push({ t, color: c.color, brightness: c.brightness }); me.fails = 0; }
          else throw new Error('no answer');
        } catch (_) {
          // This spotlight isn't answering; try the next one.
          if (++me.fails >= 4) { me.fails = 0; me.di = (me.di + 1) % me.devs.length; }
        }
      }
      if (sniff === me) me.timer = setTimeout(loop, SNIFF_EVERY);
    };
    sniff.timer = setTimeout(loop, 0);
  }
  function stopSniff() {
    const me = sniff; sniff = null;
    if (!me) return;
    clearTimeout(me.timer);
    if (me.samples.length < 8) return;   // too short to say anything
    const summary = summarize(me.samples);
    catalog.setFlavor(me.show.id, me.show.name, summary);
    if (sniffDir) {
      try {
        fs.mkdirSync(sniffDir, { recursive: true });
        const file = path.join(sniffDir, me.show.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '_') + '.json');
        fs.writeFileSync(file, JSON.stringify({ show: me.show.name, id: me.show.id, at: new Date().toISOString(), from: 'watch', summary, samples: me.samples }, null, 2));
      } catch (e) { log(`Watch: couldn't save sniff: ${e.message}`); }
    }
    log(`Sniffed ${me.show.name}: ${summary.stuck ? 'light hides show colours' : summary.colours.map(c => c.hex).join(', ')}`);
  }

  function play() {
    clearTimeout(timer);
    stopSniff();
    const show = st.list[st.i];
    try {
      if (!engine.running) engine.start();
      engine.applyLook(show.id, st.zone || undefined);
      catalog.watched(show.id, show.name);
    } catch (e) { log(`Watch: ${show.name}: ${e.message}`); }
    st.endsAt = Date.now() + st.minutes * 60000;
    timer = setTimeout(() => step(1), st.minutes * 60000);
    startSniff(show);
    onChange();
  }
  function step(d) {
    if (!st) return;
    if (d > 0 && st.i >= st.list.length - 1) return stop('done');
    st.i = Math.max(0, Math.min(st.list.length - 1, st.i + d));
    play();
  }
  function stop(why = 'stopped') {
    if (!st) return;
    clearTimeout(timer);
    stopSniff();
    if (st.rotateWas) engine.setRotate({ enabled: true });
    log(`Watch mode ${why} (${st.i + 1} of ${st.list.length} shows)`);
    st = null; onChange();
  }

  return {
    start({ minutes = 2, which = 'mine', zone = null } = {}) {
      if (st) stop('restarted');
      minutes = Math.max(0.25, Math.min(30, Number(minutes) || 2));
      const s = engine.status();
      const list = pickShows(s.looks, catalog, which).map(l => ({ id: l.id, name: l.name, govee: l.govee || null }));
      if (!list.length) throw new Error(which === 'unrated' ? 'Every show is already rated' : 'No shows to watch');
      const rotateWas = s.rotate.enabled;
      if (rotateWas) engine.setRotate({ enabled: false });
      st = { list, i: 0, minutes, zone: zone || null, which, rotateWas, startedAt: Date.now(), endsAt: 0 };
      log(`Watch mode: ${list.length} shows, ${minutes} min each${zone ? ` on ${zone}` : ''}`);
      play();
    },
    next: () => step(1),
    prev: () => step(-1),
    stop: () => stop(),
    // Extend the current show (more time to decide).
    more() { if (!st) return; clearTimeout(timer); st.endsAt += 60000; timer = setTimeout(() => step(1), st.endsAt - Date.now()); onChange(); },
    current: () => (st ? st.list[st.i] : null),
    status() {
      if (!st) return { running: false };
      const show = st.list[st.i];
      return { running: true, i: st.i, total: st.list.length, minutes: st.minutes, zone: st.zone, which: st.which, endsAt: st.endsAt,
        show, next: st.list[st.i + 1] || null, entry: catalog.all()[show.id] || null,
        sniffing: sniff ? { samples: sniff.samples.length, settling: Date.now() < sniff.t0 } : null };
    },
  };
}

module.exports = { createWatch, pickShows };
