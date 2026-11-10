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
`;

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
Pick${opts.back ? ' front and back' : ' the front'}.` },
    ], { format: { type: 'object', required: [...areas, 'why'], additionalProperties: false, properties: { ...props, why: { type: 'string' } } }, maxTokens: 120, temperature: 0.7 });
    const j = JSON.parse(out.text);
    return { picks: Object.fromEntries(areas.map(a => [a, opts[a].find(l => l.id === j[a])])), why: String(j.why || '').slice(0, 160), ms: out.ms };
  }

  // The colours of a show, as words, so Qwen can judge what goes with it.
  const NAMES = { red: [220, 30, 30], green: [30, 190, 40], blue: [30, 70, 240], 'light blue': [60, 160, 255], white: [245, 245, 245], 'warm white': [255, 180, 107],
    gold: [255, 176, 0], yellow: [255, 240, 0], orange: [255, 128, 0], purple: [128, 0, 255], pink: [255, 64, 160], cyan: [0, 230, 230] };
  const word = (h) => { const n = parseInt(String(h).replace('#', ''), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
    return Object.entries(NAMES).sort((a, b) => a[1].reduce((t, v, i) => t + (v - c[i]) ** 2, 0) - b[1].reduce((t, v, i) => t + (v - c[i]) ** 2, 0))[0][0]; };
  function showColours(look) {
    const { PALETTES } = require('./effects');
    const e = catalog.all()[look.id];
    let hexes = [];
    if (e && e.flavor && e.flavor.colours) hexes = e.flavor.colours.map(c => c.hex);
    else if (look.palette && PALETTES[look.palette]) hexes = PALETTES[look.palette].colors;
    else { const saved = engine.savedLooks().find(l => l.id === look.id); if (saved) hexes = Object.values(saved.lights).flatMap(L => L.palette || []); }
    const words = [...new Set(hexes.map(word))];
    return words.length ? words.join(', ') : 'unknown colours';
  }

  // Hours of show left tonight (to the schedule's off time, else ~5 h).
  function hoursLeft() {
    const sc = engine.status().schedule;
    if (!sc.enabled) return 5;
    const now = new Date(), [h, m] = String(sc.off).split(':').map(Number);
    let mins = (h * 60 + m) - (now.getHours() * 60 + now.getMinutes());
    if (mins <= 0) mins += 24 * 60;
    return Math.max(0.5, Math.min(12, mins / 60));
  }

  // Step two: with the chosen shows' colours in front of him, Qwen decides
  // each smart plug (on/off, blink).
  async function askPlugs(chosen) {
    const st = engine.status();
    const plugs = st.lights.filter(l => l.plug);
    if (!plugs.length || !llama) return [];
    const shows = chosen.map(c => `${c.area === 'front' ? 'Front yard' : 'Backyard'}: "${c.look.name}" in ${showColours(c.look)}`).join('; ');
    // "fit" comes first so he judges the colours before deciding on/off.
    const props = Object.fromEntries(plugs.map((_, i) => [`p${i + 1}`, { type: 'object', additionalProperties: false, required: ['fit', 'on', 'blink'],
      properties: { fit: { type: 'string', enum: ['plain light, fits anything', 'its colours fit this show', 'its colours clash with this show'] }, on: { type: 'boolean' }, blink: { type: 'integer' } } }]));
    const out = await llama.chat([
      { role: 'system', content: `You decide the smart plugs for a Christmas light show. A plug powers something that is only on or off. For each plug decide "on" and "blink" (0 = steady, otherwise seconds per on/off step, at least 10) for the show now playing.
First judge "fit": does what the plug powers fit the colours of the show now playing?
- Something with its own colours, like a laser projector of red and green dots: its colours fit red/green or multicolour shows; they clash with blue, white, icy, purple or gold shows. Fit = on. Clash = off.
- Plain light strings (like multicolour C9s): plain light, fits anything: on, steady; blink slowly only when it suits the show.
Blinking costs clicks: blinking every N seconds uses 3600/N clicks an hour (every 10 s = 360/hour, every 60 s = 60/hour). Stay within the hourly allowance shown for each plug; most shows should be steady, and blinking is for shows where it really adds something.
Answer JSON {"p1": {"fit": ..., "on": ..., "blink": ...}, ...}.` },
      { role: 'user', content: `Now playing: ${shows}.\nPlugs:\n${plugs.map((l, i) => `p${i + 1} = ${l.name}${l.about ? ` (${l.about})` : ''}: now ${l.on ? (l.blink ? `on, blinking every ${l.blink}s` : 'on') : 'off'}, ${l.clicksLeft ?? '?'} clicks left tonight = about ${Math.floor((l.clicksLeft ?? 0) / hoursLeft())} an hour for the rest of the show`).join('\n')}` },
    ], { format: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props }, maxTokens: 30 + 40 * plugs.length, temperature: 0.2 });
    const j = JSON.parse(out.text);
    log(`Director: plugs for ${shows}: ${plugs.map((l, i) => `${l.name} ${(j[`p${i + 1}`] || {}).fit}`).join('; ')}`);
    // His "fit" call decides on/off (an 8B model judges the colours right but
    // then sometimes leaves the switch as it was); blink stays his choice.
    return plugs.map((l, i) => {
      const p = j[`p${i + 1}`] || {};
      const on = /clash/.test(p.fit || '') ? false : /fit/.test(p.fit || '') ? true : p.on;
      // Blink is his call; how fast is paced so tonight's clicks last to the
      // end of the show (hard rule, like the budget itself).
      const pace = Math.ceil(3600 / Math.max(1, (l.clicksLeft ?? 0) / hoursLeft()));
      const blink = on && p.blink > 0 ? Math.max(p.blink, 10, pace) : 0;
      return { id: l.id, name: l.name, fit: p.fit, on, blink };
    }).filter(p => typeof p.on === 'boolean');
  }

  let busy = false;
  async function direct(reason = 'timer') {
    if (!cfg.enabled || !engine.running || isWatching() || busy) return;
    busy = true;
    nextAt = Date.now() + cfg.minutes * 60000;   // the current show keeps playing while he thinks
    try { await directNow(); } finally { busy = false; onChange(); }
  }
  async function directNow() {
    const started = Date.now();
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
    // Qwen's call on each smart plug for this show: on/off and blink (the
    // engine enforces the 10 s minimum and tonight's click budget). Looks
    // don't change plug lights, so it's set here.
    const chosen = recent.filter(r => r.at >= started).map(r => ({ area: r.area, look: engine.status().looks.find(l => l.id === r.id) })).filter(c => c.look);
    let plugCalls = [];
    if (chosen.length) { try { plugCalls = await askPlugs(chosen); } catch (e) { log(`Director: plugs: ${e.message}`); } }
    for (const p of plugCalls) {
      try {
        engine.setLights([p.id], { on: p.on, blink: p.blink || 0 });
        const what = !p.on ? 'off' : p.blink > 0 ? `on, blinking every ${Math.max(10, p.blink)} s` : 'on, steady';
        log(`Director (Qwen): ${p.name} ${what}`);
        if (recent.length) (recent[recent.length - 1].plugs = recent[recent.length - 1].plugs || []).push(`${p.name} ${what}`);
      } catch (e) { log(`Director: ${p.name}: ${e.message}`); }
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
