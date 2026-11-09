// ─── Watch mode: play every show in turn so the owner can rate it ─────────────
//
// Plays each look / Govee show for N minutes on the real lights (or one zone),
// while the app shows 👍/👎, tags and a note box for the one playing. Auto-
// rotate is paused while watching and put back afterwards.

'use strict';

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

function createWatch({ engine, catalog, log = console.log, onChange = () => {} }) {
  let st = null;     // { list: [{id, name}], i, minutes, zone, endsAt, rotateWas }
  let timer = null;

  function play() {
    clearTimeout(timer);
    const show = st.list[st.i];
    try {
      if (!engine.running) engine.start();
      engine.applyLook(show.id, st.zone || undefined);
      catalog.watched(show.id, show.name);
    } catch (e) { log(`Watch: ${show.name}: ${e.message}`); }
    st.endsAt = Date.now() + st.minutes * 60000;
    timer = setTimeout(() => step(1), st.minutes * 60000);
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
        show, next: st.list[st.i + 1] || null, entry: catalog.all()[show.id] || null };
    },
  };
}

module.exports = { createWatch, pickShows };
