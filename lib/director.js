// ─── Director: Qwen picks the next show ──────────────────────────────────────
//
// Every N minutes while the show is on, Qwen chooses a show for the front yard
// and one for the backyard from the owner's catalog (ratings, tags, notes,
// sniffed colours), the time of night and what he played lately, and says
// why. Code only holds him to the owner's hard rules: never a 👎 show,
// front-only / back-only respected, no Govee shows out back (no Govee lights
// there), no repeats of the last few. If he breaks one, or can't be reached,
// a weighted pick from the same catalog covers that one turn, so the yard
// never stalls. Replaces auto-rotate while it's on.

'use strict';

const fs = require('fs');
const { pickShows } = require('./watch');

function createDirector({ file, engine, catalog, llama = null, isWatching = () => false, log = console.log, onChange = () => {} }) {
  let cfg = { enabled: false, minutes: 8 };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) { log(`director save failed: ${e.message}`); } onChange(); };
  let nextAt = null;
  const recent = [];      // last picks, newest last: { area, id, name, why, at }

  function hourNow() {
    const tz = engine.status().schedule.tz;
    try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date())); }
    catch (_) { return new Date().getHours(); }
  }

  // Areas whose Govee lights the app can address by hardware id (from Scan →
  // Use); a Govee show can only play in one area if it can.
  function goveeAreas() {
    const out = new Set();
    for (const d of engine.status().devices) if ((!d.kind || d.kind === 'govee') && d.mac) out.add(String(d.zone).startsWith('front') ? 'front' : 'back');
    return out;
  }

  // Weight of one show for one area right now (0 = never).
  function weigh(look, area, hour) {
    const e = catalog.all()[look.id] || { up: 0, down: 0, tags: [] };
    const net = e.up - e.down;
    if (net < 0) return [0, 'disliked'];
    if (area === 'back' && e.tags.includes('front-only')) return [0, 'front-only'];
    if (area === 'front' && e.tags.includes('back-only')) return [0, 'back-only'];
    if (look.govee && !goveeAreas().has(area)) return [0, `no identified Govee lights ${area === 'back' ? 'out back' : 'out front'}`];
    if (recent.slice(-6).some(r => r.id === look.id)) return [0, 'played recently'];
    let w = net > 0 ? 1 + 2 * net : 1, why = net > 0 ? `liked (+${net})` : 'not rated yet';
    const tag = (t, f, label) => { if (e.tags.includes(t)) { w *= f; if (f > 1) why += `, ${label}`; } };
    if (hour < 19) { tag('kids', 2, 'kids time'); tag('late night', 0.3); }
    else if (hour < 21) { tag('energetic', 1.6, 'prime time'); tag('kids', 1.3, 'kids'); }
    else { tag('cozy', 2, 'late & cozy'); tag('late night', 2.2, 'late night'); tag('energetic', 0.5); tag('kids', 0.6); }
    return [w, why];
  }

  function pick(area, hour) {
    const looks = pickShows(engine.status().looks, catalog, 'mine');
    const scored = looks.map(l => { const [w, why] = weigh(l, area, hour); return { l, w, why }; }).filter(x => x.w > 0);
    if (!scored.length) return null;
    let r = Math.random() * scored.reduce((t, x) => t + x.w, 0);
    for (const x of scored) { r -= x.w; if (r <= 0) return x; }
    return scored[scored.length - 1];
  }

  // Fixed instructions (cached by Ollama); everything that changes goes in the
  // last message.
  const SYSTEM = `You are the show director for a Christmas yard light show. Every few minutes you choose what plays next in the front yard and the backyard.
Choose shows the owner will enjoy right now: favour shows they liked (+), never pick disliked ones (-), give unrated shows an occasional turn so they get rated, match the time of night (kids and energetic shows early, cozy and late-night shows late), keep variety (don't repeat recent picks, mix colours and moods). The backyard is a separate space with its own show: pick it on its own merits, it does not need to match the front, and follow the owner's notes.
Answer JSON: {"front": "<look id>", "back": "<look id>", "why": "<one short sentence for the owner>"}.
If the yard has C9 plug lights (plain strings on a smart plug, on/off only), also give "plugBlink": seconds per on/off step (0 = steady, at least 10). Each blink wears the plug and the night has a click budget (shown), so blink sparingly, slowly and when it suits the show, and plan the budget across the whole evening.`;

  async function askQwen(areas, hour) {
    const st = engine.status();
    const looks = pickShows(st.looks, catalog, 'mine');
    const allowed = (area) => looks.filter(l => weigh(l, area, hour)[0] > 0);
    const opts = Object.fromEntries(areas.map(a => [a, allowed(a)]));
    if (areas.some(a => !opts[a].length)) return null;
    const list = (a) => opts[a].map(l => l.id).join(' ');
    const when = new Date().toLocaleString('en-US', { timeZone: st.schedule.tz, weekday: 'long', hour: 'numeric', minute: '2-digit' });
    const notes = catalog.compact(looks, 40) || '(no ratings yet)';
    const fav = st.palettes.find(p => p.id === 'favourites');
    const plugs = st.lights.filter(l => l.plug);
    const props = Object.fromEntries(areas.map(a => [a, { type: 'string', enum: opts[a].map(l => l.id) }]));
    const out = await llama.chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Now: ${when}.
Played lately (newest last): ${recent.slice(-6).map(r => `${r.area} ${r.name}`).join('; ') || 'nothing yet'}.
Owner's show notes:
${notes}
${fav ? `Owner's favourite colours: ${fav.colors.join(' ')}.
` : ''}Allowed for the front: ${list('front')}${opts.back ? `
Allowed for the back: ${list('back')}` : ''}
${plugs.length ? `C9 plug lights: ${plugs.map(l => `${l.name} ${l.blink ? `blinking every ${l.blink}s` : 'steady'}, ${l.clicksLeft ?? '?'} clicks left tonight (each blink step uses 1)`).join('; ')}. The show runs until about ${st.schedule.enabled ? st.schedule.off : 'late'}.
` : ''}Pick${opts.back ? ' front and back' : ' the front'}.` },
    ], { format: { type: 'object', required: [...areas, 'why', ...(plugs.length ? ['plugBlink'] : [])], additionalProperties: false, properties: { ...props, why: { type: 'string' }, ...(plugs.length ? { plugBlink: { type: 'integer' } } : {}) } }, maxTokens: 140, temperature: 0.7 });
    const j = JSON.parse(out.text);
    return { picks: Object.fromEntries(areas.map(a => [a, opts[a].find(l => l.id === j[a])])), why: String(j.why || '').slice(0, 160), ms: out.ms, plugBlink: j.plugBlink };
  }

  let busy = false;
  async function direct(reason = 'timer') {
    if (!cfg.enabled || !engine.running || isWatching() || busy) return;
    busy = true;
    nextAt = Date.now() + cfg.minutes * 60000;   // the current show keeps playing while he thinks
    try { await directNow(); } finally { busy = false; onChange(); }
  }
  async function directNow() {
    const st = engine.status(), hour = hourNow();
    const hasBack = st.lights.some(l => l.zone === 'back');
    const areas = hasBack ? ['front', 'back'] : ['front'];
    let q = null;
    if (llama) {
      try { q = await askQwen(areas, hour); }
      catch (e) { log(`Director: Qwen unavailable (${e.message}), picking from ratings this time`); }
    }
    if (!cfg.enabled || !engine.running || isWatching()) return;   // things changed while he thought
    for (const area of areas) {
      const fromQwen = q && q.picks[area] && weigh(q.picks[area], area, hour)[0] > 0;
      const p = fromQwen ? { l: q.picks[area], why: q.why, by: 'Qwen' } : { ...pick(area, hour), by: 'ratings' };
      if (!p.l) { log(`Director: nothing suitable for the ${area}`); continue; }
      try {
        engine.applyLook(p.l.id, area === 'front' && !hasBack ? undefined : area);
        recent.push({ area, id: p.l.id, name: p.l.name, why: p.why, by: p.by, at: Date.now() });
        if (recent.length > 20) recent.shift();
        log(`Director (${p.by}): ${p.l.name} ${area === 'back' ? 'out back' : 'out front'}: ${p.why}`);
      } catch (e) { log(`Director: ${p.l.name}: ${e.message}`); }
    }
    // Qwen's call on the C9 plug blink (the engine enforces the minimum and
    // tonight's click budget). Looks don't change plug lights, so set it here.
    const plugIds = engine.status().lights.filter(l => l.plug).map(l => l.id);
    if (q && plugIds.length && Number.isFinite(q.plugBlink)) {
      try {
        engine.setLights(plugIds, { blink: q.plugBlink, on: true });
        log(`Director (Qwen): C9s ${q.plugBlink > 0 ? `blink every ${Math.max(10, q.plugBlink)} s` : 'steady'}`);
        if (recent.length) recent[recent.length - 1].plug = q.plugBlink;
      } catch (e) { log(`Director: C9 blink: ${e.message}`); }
    }
  }

  setInterval(() => {
    if (!cfg.enabled || !engine.running || isWatching()) { nextAt = null; return; }
    if (!nextAt || Date.now() >= nextAt) direct();
  }, 5000);

  return {
    set({ enabled, minutes } = {}) {
      if (minutes !== undefined) cfg.minutes = Math.max(1, Math.min(120, Math.round(Number(minutes) || 8)));
      if (enabled !== undefined) {
        cfg.enabled = !!enabled; nextAt = null;
        if (cfg.enabled && engine.status().rotate.enabled) engine.setRotate({ enabled: false });   // one picker at a time
        log(`Director ${cfg.enabled ? 'on' : 'off'}`);
      }
      save();
      if (cfg.enabled) direct('turned on');
    },
    now: () => { nextAt = null; direct('now'); },
    status: () => ({ ...cfg, nextAt, thinking: busy, recent: recent.slice(-4).reverse() }),
    // For tests: what it would weigh each show at, for an area and hour.
    weights: (area, hour) => pickShows(engine.status().looks, catalog, 'mine').map(l => ({ name: l.name, w: weigh(l, area, hour) })),
  };
}

module.exports = { createDirector };
