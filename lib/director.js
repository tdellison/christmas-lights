// ─── Director: Qwen picks the next show ──────────────────────────────────────
//
// Every N minutes while the show is on, Qwen chooses the next show for the
// whole yard (Front Left + Front Right) from the owner's looks (he knows each
// one's effect and colours), the time of night and what he played lately, and
// says why. Code only holds him to the hard rules: no repeats of the last
// few, Govee shows only with identified Govee lights. If he breaks one, or
// can't be reached, a random allowed look covers that one turn, so the yard
// never stalls. Replaces auto-rotate while it's on.

'use strict';

const fs = require('fs');

// occasion: special nights + weather (lib/occasion.js), one line for the prompt.
function createDirector({ file, engine, llama = null, occasion = null, log = console.log, onChange = () => {} }) {
  let cfg = { enabled: false, minutes: 8 };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) { log(`director save failed: ${e.message}`); } onChange(); };
  let nextAt = null;
  const recent = [];      // last picks, newest last: { id, name, why, by, at }

  // A Govee show needs a Govee light the app can address by hardware id (from
  // Scan → Use).
  const goveeReady = () => engine.status().devices.some(d => (!d.kind || d.kind === 'govee') && d.mac);

  // The shows he can pick from: our looks and saved looks (+ Govee DIYs and
  // Christmas scenes if the Govee cloud is on).
  const shows = () => engine.status().looks.filter(l => !l.govee || l.group === 'diy' || l.group === 'xmas');
  // Can this show play now? (Every look gets its turn; no repeats of the last
  // few, fewer when there are only a few looks.)
  function weigh(look, n) {
    if (look.govee && !goveeReady()) return [0, 'no identified Govee lights'];
    const back = Math.max(0, Math.min(6, n - 3));
    if (back && recent.slice(-back).some(r => r.id === look.id)) return [0, 'played recently'];
    return [1, 'its turn'];
  }

  function pick() {
    const looks = shows();
    const ok = looks.filter(l => weigh(l, looks.length)[0] > 0);
    return ok.length ? { l: ok[Math.floor(Math.random() * ok.length)], why: 'its turn' } : { l: null };
  }

  // Fixed instructions (cached by Ollama); everything that changes goes in the
  // last message.
  const SYSTEM = `You are the show director for a Christmas yard light show. Every few minutes you choose what plays next across the front yard.
Choose what suits right now: match the time of night (fun and energetic shows early while kids are out, calmer ones late), keep variety (every look gets its turn, mix colours and moods, don't repeat recent picks), and make special nights and snowy weather count (shown on the "Now" line).
Answer JSON: {"show": "<look id>", "why": "<one short sentence for the owner>"}.
`;
  // What each built-in look is, once (fixed, so it stays in the cache).
  let style = null;
  const system = () => style || (style = SYSTEM + (() => {
    const st = engine.status();
    const looks = st.looks.filter(l => l.builtin && !l.govee && l.effect);
    return looks.length ? `The owner's looks: ${looks.map(l => `${l.id} (${l.name}) = ${l.effect} in ${showColours(l)}`).join('; ')}.\n` : '';
  })());

  async function askQwen() {
    const st = engine.status();
    const looks = shows();
    const opts = looks.filter(l => weigh(l, looks.length)[0] > 0);
    if (!opts.length) return null;
    const when = new Date().toLocaleString('en-US', { timeZone: st.schedule.tz, weekday: 'long', hour: 'numeric', minute: '2-digit' });
    const out = await llama.chat([
      { role: 'system', content: system() },
      { role: 'user', content: `Now: ${when}.${occasion && occasion.line() ? ' ' + occasion.line() : ''}
Played lately (newest last): ${recent.slice(-6).map(r => r.name).join('; ') || 'nothing yet'}.
Allowed: ${opts.map(l => l.id).join(' ')}
Pick the next show.` },
    ], { format: { type: 'object', required: ['show', 'why'], additionalProperties: false, properties: { show: { type: 'string', enum: opts.map(l => l.id) }, why: { type: 'string' } } }, maxTokens: 120, temperature: 0.7 });
    const j = JSON.parse(out.text);
    return { look: opts.find(l => l.id === j.show), why: String(j.why || '').slice(0, 160), ms: out.ms };
  }

  // The colours of a show, as words, so Qwen can judge what goes with it.
  const NAMES = { red: [220, 30, 30], green: [30, 190, 40], blue: [30, 70, 240], 'light blue': [60, 160, 255], white: [245, 245, 245], 'warm white': [255, 180, 107],
    gold: [255, 176, 0], yellow: [255, 240, 0], orange: [255, 128, 0], purple: [128, 0, 255], pink: [255, 64, 160], cyan: [0, 230, 230] };
  const word = (h) => { const n = parseInt(String(h).replace('#', ''), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
    return Object.entries(NAMES).sort((a, b) => a[1].reduce((t, v, i) => t + (v - c[i]) ** 2, 0) - b[1].reduce((t, v, i) => t + (v - c[i]) ** 2, 0))[0][0]; };
  function showColours(look) {
    const { PALETTES } = require('./effects');
    let hexes = [];
    if (look.palette && PALETTES[look.palette]) hexes = PALETTES[look.palette].colors;
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
  async function askPlugs(look) {
    const st = engine.status();
    const plugs = st.lights.filter(l => l.plug && l.ready);   // empty slots: nothing to decide
    if (!plugs.length || !llama) return [];
    const playing = `"${look.name}" in ${showColours(look)}`;
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
      { role: 'user', content: `Now playing: ${playing}.\nPlugs:\n${plugs.map((l, i) => `p${i + 1} = ${l.name}${l.about ? ` (${l.about})` : ''}: now ${l.on ? (l.blink ? `on, blinking every ${l.blink}s` : 'on') : 'off'}, ${l.clicksLeft ?? '?'} clicks left tonight = about ${Math.floor((l.clicksLeft ?? 0) / hoursLeft())} an hour for the rest of the show`).join('\n')}` },
    ], { format: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props }, maxTokens: 30 + 40 * plugs.length, temperature: 0.2 });
    const j = JSON.parse(out.text);
    log(`Director: plugs for ${playing}: ${plugs.map((l, i) => `${l.name} ${(j[`p${i + 1}`] || {}).fit}`).join('; ')}`);
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
    if (!cfg.enabled || !engine.running || busy) return;
    busy = true;
    nextAt = Date.now() + cfg.minutes * 60000;   // the current show keeps playing while he thinks
    try { await directNow(); } finally { busy = false; onChange(); }
  }
  async function directNow() {
    let q = null;
    if (llama) {
      try { q = await askQwen(); }
      catch (e) { log(`Director: Qwen unavailable (${e.message}), picking at random this time`); }
    }
    if (!cfg.enabled || !engine.running) return;   // things changed while he thought
    const fromQwen = q && q.look && weigh(q.look, shows().length)[0] > 0;
    const p = fromQwen ? { l: q.look, why: q.why, by: 'Qwen' } : { ...pick(), by: 'fallback' };
    if (!p.l) { log('Director: nothing suitable to play'); return; }
    try {
      engine.applyLook(p.l.id);
      recent.push({ id: p.l.id, name: p.l.name, why: p.why, by: p.by, at: Date.now() });
      if (recent.length > 20) recent.shift();
      log(`Director (${p.by}): ${p.l.name}: ${p.why}`);
    } catch (e) { log(`Director: ${p.l.name}: ${e.message}`); return; }
    // Qwen's call on each smart plug for this show: on/off and blink (the
    // engine enforces the 10 s minimum and tonight's click budget). Looks
    // don't change plug lights, so it's set here.
    let plugCalls = [];
    try { plugCalls = await askPlugs(p.l); } catch (e) { log(`Director: plugs: ${e.message}`); }
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
    if (!cfg.enabled || !engine.running) { nextAt = null; return; }
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
    // For tests: which shows could play now.
    weights: () => { const l = shows(); return l.map(x => ({ name: x.name, w: weigh(x, l.length) })); },
  };
}

module.exports = { createDirector };
