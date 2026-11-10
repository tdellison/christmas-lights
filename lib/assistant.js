// ─── Ask the elves: a chat that runs and designs the show (local Llama) ──────
//
// "candy cane, slower" -> Llama returns { actions[] } (JSON, schema enforced
// by Ollama) -> each action is checked and run through the engine, and the
// reply is written from what actually ran. Llama never touches the lights
// directly; the engine stays in charge of timing.
//
// It's a conversation: the last few turns go back to Llama so follow-ups work
// ("slower", "no, more red", "do that out back"). It can also create (set
// each zone, then save it as a named look), find shows by name ("what grinch
// shows do I have?") and say a short line. Exact matches ("on", "off", a
// show's name) skip Llama entirely.

'use strict';

const COLOR_NAMES = {
  red: '#ff0000', green: '#00c000', white: '#ffffff', 'warm white': '#ffb46b', gold: '#ffb000', yellow: '#ffff00',
  orange: '#ff8000', blue: '#0040ff', 'light blue': '#00a0ff', 'ice blue': '#00a0ff', cyan: '#00ffff', teal: '#00c0a0',
  purple: '#8000ff', violet: '#8000ff', pink: '#ff40a0', magenta: '#ff00ff', silver: '#c0c0ff',
};

// One shape per action, no extra fields, so Llama can't pad an action with
// defaults (and every token saved is ~0.15 s on this CPU).
const act = (name, props = {}, required = []) => ({
  type: 'object', additionalProperties: false, required: ['do', ...required],
  properties: { do: { const: name }, ...props },
});
const int = { type: 'integer' }, bool = { type: 'boolean' }, str = { type: 'string' };
const schema = (st) => {
  const ids = (list) => ({ type: 'string', enum: list.map(x => x.id) });
  const look = ids(st.looks), effect = ids(st.effects), palette = ids(st.palettes), zone = ids([...st.groups, ...st.zones]);
  return {
  type: 'object', additionalProperties: false, required: ['actions'],
  properties: {
    actions: {
      type: 'array', maxItems: 7,
      items: {
        anyOf: [
          act('power', { on: bool, zone }, ['on']),
          act('look', { look, zone }, ['look']),
          act('set', { zone, lights: { type: 'array', items: int }, effect, palette, colors: { type: 'array', items: str }, bri: int, speed: { type: 'number' }, speedx: { type: 'number' }, blink: int, trim: int, on: bool }, ['lights']),
          act('master', { value: int }, ['value']),
          act('next'),
          act('rotate', { enabled: bool, minutes: int }),
          act('schedule', { enabled: bool, start: str, stop: str }),
          act('save', { name: str }, ['name']),
          act('find', { query: str }, ['query']),
          act('say', { text: str }, ['text']),
        ],
      },
    },
  },
  };
};

// One line per effect, so designs pick the right one ("a flash runs across" =
// runner). Short on purpose: it's read on every request (cached).
const EFFECT_HINTS = {
  solid: 'one steady colour', breathe: 'slow glow up and down', fade: 'whole yard melts through the colours together',
  wave: 'colours roll smoothly across', chase: 'colours hop light to light', candycane: 'stripes slide across',
  alternate: 'neighbours swap colours', twinkle: 'dim base, twinkles of the other colours', snowfall: 'cold dim base, lights catch drifting snow',
  sparkle: 'quick bright pops', hearth: 'warm fire flicker', rainbow: 'full rainbow wheel',
  musicpulse: 'pulses with music (breathes without)', runner: 'a flash shoots across the whole yard left or right over a background; LAST colour is the flash (e.g. grinch running = red/white then green)',
};

function systemPrompt(st) {
  // Kept short and identical between requests: on this CPU Llama reads about
  // 60 tokens a second, so every line here costs time on every request.
  return `You are the elves who run a Christmas yard light show, chatting with its owner. Output JSON {"actions":[...]} with ONLY what the user asked for, usually one action.
zone: ${[...st.groups, ...st.zones].map(z => `${z.id} (${z.name})`).join(', ')}. Leave zone out for the whole yard.
power {on, zone}
look {look: id, zone}
set {zone, lights: [numbers] ([] = all in the zone, or the whole yard), effect, palette, colors: [hex], bri 0-100, speed 0.25-4, speedx (multiply speed), blink, on} - ONLY fields that change
trim = a light's permanent spot brightness 5-100 (for where it stands, e.g. "keep the sidewalk trees dimmer"); it stays across every show. Use bri for this show only.
blink = seconds per on/off step for C9 plug lights only (0 = steady, 10+ = blink). Every blink wears the plug and the night has a click budget, so prefer slow (30-60) and use it sparingly.
master {value 1-100}
next
rotate {enabled, minutes}
schedule {start "HH:MM", stop "HH:MM"} - 24h
save {name} - save the yard as it is now as a named look
find {query} - search the shows by a word in their name; use for "what/which ... shows do I have", "show me ..."
say {text} - one short friendly sentence; only for questions or chat, or to name a creation
effects (what they look like):
${st.effects.map(e => `${e.id}: ${EFFECT_HINTS[e.id] || e.name}`).join('\n')}
palettes: ${st.palettes.map(p => p.id).join(' ')}
looks: ${st.looks.filter(l => l.builtin).map(l => l.id).join(' ')} (plus "Your saved looks" below)
A mood (cozy, fun, calm) = one look. slower = speedx 0.5, faster = speedx 2. dimmer/brighter = master -/+ 20.
Create, design, invent or "surprise me" = one set per zone (front-left, front-right, back) with your own effect and colours that suit the request, then save with a short festive name (use the user's name if they gave one). It is built aside, not shown until played.
Follow-ups ("more red", "slower", "do that out back") change what was just done (a design still being drafted, or the yard).
Not about the lights = one say.`;
}

// Worked examples, sent as earlier turns. They teach the short answer style
// (the slow part on this CPU is writing, ~0.2 s a token) and never change, so
// Ollama keeps them cached.
const Z = 'Zones: front-left custom, front-right custom, back custom.';
const EXAMPLES = [
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: something cozy`, '{"actions":[{"do":"look","look":"hearth"}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: candy cane out front, warm twinkle in the backyard`, '{"actions":[{"do":"look","look":"candy-cane","zone":"front"},{"do":"look","look":"twinkle-warm","zone":"back"}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: red and white chase on the front right`, '{"actions":[{"do":"set","zone":"front-right","lights":[],"effect":"chase","colors":["#ff0000","#ffffff"]}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: blue and white twinkle on 7 to 12, a bit slower`, '{"actions":[{"do":"set","lights":[7,8,9,10,11,12],"effect":"twinkle","colors":["#0040ff","#ffffff"],"speedx":0.5}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: turn off the backyard`, '{"actions":[{"do":"power","on":false,"zone":"back"}]}'],
  [`Now: show on, 14 lights, master 70. ${Z}\nRequest: brighter`, '{"actions":[{"do":"master","value":90}]}'],
  [`Now: show off, 14 lights, master 100. ${Z}\nRequest: come on at 5pm and go off at 10:30`, '{"actions":[{"do":"schedule","start":"17:00","stop":"22:30"}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: surprise me`, '{"actions":[{"do":"set","zone":"front-left","lights":[],"effect":"wave","colors":["#00a0ff","#ffffff"]},{"do":"set","zone":"front-right","lights":[],"effect":"wave","colors":["#ffffff","#00a0ff"]},{"do":"set","zone":"back","lights":[],"effect":"twinkle","colors":["#ffb46b","#ffffff"]},{"do":"save","name":"Frosty Porch"}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: design a candy show called Sugar Rush`, '{"actions":[{"do":"set","zone":"front","lights":[],"effect":"candycane","colors":["#ff0000","#ffffff","#ff40a0"]},{"do":"set","zone":"back","lights":[],"effect":"sparkle","colors":["#ff40a0","#ffffff"]},{"do":"save","name":"Sugar Rush"}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: what snow shows do I have`, '{"actions":[{"do":"find","query":"snow"}]}'],
  [`Now: show on, 14 lights, master 100. ${Z}\nRequest: what is your favourite?`, '{"actions":[{"do":"say","text":"Candy Cane Lane, every time!"}]}'],
];

// What a draft look has in each zone, so tweaks start from it.
function draftLine(draft, st, engineLooks) {
  if (!draft) return '';
  const look = engineLooks && engineLooks.find(l => l.id === draft.id);
  if (!look || !look.lights) return `\nDrafting "${draft.name}" (not playing). Tweaks: repeat one set per zone with the change.`;
  const z = st.zones.map(zone => {
    const id = Object.keys(look.lights).find(lid => (st.lights.find(l => l.id === lid) || {}).zone === zone.id);
    const L = id && look.lights[id];
    return L ? `${zone.id} ${L.effect} [${L.palette.join(',')}] speed ${L.speed}` : null;
  }).filter(Boolean).join('; ');
  return `\nDrafting "${draft.name}" (not playing): ${z}. Tweaks: repeat one set per zone with the change.`;
}

// C9 plug lights: which numbers they are, their blink and tonight's budget.
// Lights with a spot brightness below 100%.
function trimLine(st) {
  const t = st.lights.map((l, i) => ({ l, n: i + 1 })).filter(x => x.l.trim != null && x.l.trim < 100);
  return t.length ? `\nSpot brightness: ${t.map(x => `light ${x.n} ${x.l.trim}%`).join(', ')}.` : '';
}
function plugLine(st) {
  const p = st.lights.map((l, i) => ({ l, n: i + 1 })).filter(x => x.l.plug);
  return p.length ? `\nC9 plug lights (on/off only): ${p.map(x => `light ${x.n} ${x.l.blink ? `blinking every ${x.l.blink}s` : 'steady'}, ${x.l.clicksLeft ?? '?'} clicks left tonight`).join('; ')}.` : '';
}

function stateLine(st) {
  const zones = st.zones.map(z => `${z.id} ${z.off ? 'off' : z.current || 'custom'}`).join(', ');
  const now = new Date(), y = now.getMonth() === 11 && now.getDate() > 25 ? now.getFullYear() + 1 : now.getFullYear();
  const days = Math.ceil((new Date(y, 11, 25) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  // Saved looks change as the elves design, so they live here, after the
  // cached part of the prompt, not in the system prompt.
  const mine = st.looks.filter(l => !l.builtin);
  return `Now: ${now.toDateString()}, ${days} days to Christmas. Show ${st.running ? 'on' : 'off'}, ${st.lights.length} lights, master ${st.master}. Zones: ${zones}.`
    + (mine.length ? `\nYour saved looks: ${mine.map(l => `${l.id} (${l.name})`).join(', ')}` : '')
    + plugLine(st) + trimLine(st);
}

// Plain-English summary written from what actually ran, not by Llama.
function describe(done, st) {
  const span = (ids) => {
    if (ids === 'all' || ids.length === st.lights.length) return 'all lights';
    const z = [...st.groups, ...st.zones].find(z => { const zl = st.lights.filter(l => (z.zones || [z.id]).includes(l.zone)).map(l => l.id); return zl.length === ids.length && ids.every(i => zl.includes(i)); }) || st.zones.find(z => { const zl = st.lights.filter(l => l.zone === z.id).map(l => l.id); return zl.length === ids.length && ids.every(i => zl.includes(i)); });
    if (z) return z.name;
    const n = ids.map(id => st.lights.findIndex(l => l.id === id) + 1).sort((a, b) => a - b);
    const run = n.every((x, i) => !i || x === n[i - 1] + 1);
    return n.length === 1 ? `light ${n[0]}` : run ? `lights ${n[0]}-${n[n.length - 1]}` : `lights ${n.join(', ')}`;
  };
  const eff = (id) => (st.effects.find(e => e.id === id) || {}).name || id;
  const pal = (id) => (st.palettes.find(p => p.id === id) || {}).name || id;
  const zn = (id) => ([...st.groups, ...st.zones].find(z => z.id === id) || {}).name || id;
  return done.map(({ a, ids, look }) => {
    switch (a.do) {
      case 'power': return a.zone ? `${zn(a.zone)} ${a.on === false ? 'off' : 'on'}` : a.on === false ? 'Lights off' : 'Lights on';
      case 'look': return a.zone ? `${look.name} in ${zn(a.zone)}` : look.name;
      case 'set': {
        const bits = [];
        if (a.effect) bits.push(eff(a.effect));
        if (a.colors && a.colors.length) bits.push([...new Set(a.colors.map(c => colorName(c)))].join(' & '));
        else if (a.palette) bits.push(pal(a.palette));
        if (a.speed !== undefined) bits.push(`speed ${a.speed}×`);
        else if (a.speedx !== undefined && a.speedx !== 1) bits.push(a.speedx < 1 ? 'slower' : 'faster');
        if (a.bri !== undefined) bits.push(`brightness ${a.bri}%`);
        if (a.trim !== undefined) bits.push(`spot brightness ${a.trim}% (kept for every show)`);
        if (a.blink !== undefined) bits.push(a.blink > 0 ? `blinking every ${Math.max(10, a.blink)} s` : 'steady');
        if (a.on === false) bits.push('off');
        return `${bits.join(', ') || 'Updated'} on ${span(ids)}`;
      }
      case 'master': return `Brightness ${st.master}%`;
      case 'next': return 'Next look';
      case 'rotate': return a.enabled === false ? 'Auto-rotate off' : `Changing looks every ${a.minutes || st.rotate.minutes} min`;
      case 'schedule': return a.enabled === false ? 'Schedule off' : `On at ${a.start || st.schedule.on}, off at ${a.stop || st.schedule.off}, every day`;
      case 'save': return `Saved as "${a.name}" in Looks`;
      case 'find': return '';   // listed by the caller
      case 'say': return String(a.text || '').trim();
      default: return '';
    }
  }).filter((x, i, all) => x && all.indexOf(x) === i).join('. ');
}

// Nearest named colour, for replies ("#ffd700" -> "gold").
const colorName = (c) => {
  const k = String(c || '').trim().toLowerCase();
  if (COLOR_NAMES[k]) return k;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(k);
  if (!m) return k;
  const rgb = m.slice(1).map(h => parseInt(h, 16));
  let best = k, dist = Infinity;
  for (const [n, hex] of Object.entries(COLOR_NAMES)) {
    const d = [1, 3, 5].reduce((t, i, j) => t + (parseInt(hex.slice(i, i + 2), 16) - rgb[j]) ** 2, 0);
    if (d < dist) { dist = d; best = n; }
  }
  return best;
};
const color = (c) => {
  const k = String(c || '').trim().toLowerCase();
  return COLOR_NAMES[k] || k;
};

// The zone a request names, if it names exactly one. Llama often drops the
// zone on "set", so the app fills it in when the words are unambiguous.
function zoneInText(text, st) {
  const t = ` ${text.toLowerCase().replace(/[^a-z ]/g, ' ')} `;
  const hits = new Set();
  if (/ front left | left front | front left side /.test(t)) hits.add('front-left');
  if (/ front right | right front /.test(t)) hits.add('front-right');
  if (!hits.size && / (front yard|front|out front) /.test(t)) hits.add('front');
  if (/ (back yard|backyard|back|out back) /.test(t) && !/ (turn|come|go|put) .*back on /.test(t)) hits.add('back');
  if (/ back on /.test(t) && / (backyard|back yard) /.test(t)) hits.add('back');
  for (const z of st.zones) if (t.includes(` ${z.name.toLowerCase()} `)) hits.add(z.id);
  return hits.size === 1 ? [...hits][0] : null;
}

// Same look (or power) sent zone by zone to every zone -> one whole-yard action.
function mergeZones(actions, st) {
  if (!Array.isArray(actions)) return [];
  const all = st.zones.map(z => z.id);
  const expand = (z) => z === 'front' ? all.filter(x => x.startsWith('front')) : [z];
  for (const kind of ['look', 'power']) {
    const zoned = actions.filter(a => a.do === kind && a.zone);
    const key = (a) => kind === 'look' ? a.look : String(a.on);
    if (!zoned.length || !zoned.every(a => key(a) === key(zoned[0]))) continue;
    const covered = new Set(zoned.flatMap(a => expand(a.zone)));
    if (all.every(z => covered.has(z))) {
      const { zone, ...one } = zoned[0];
      actions = [...actions.filter(a => !zoned.includes(a)), one];
    }
  }
  return actions;
}

// A "set" action -> the light ids it covers, and the engine patch it means.
function setIds(a, st) {
  if (a.lights && a.lights.length) return a.lights.map(n => st.lights[n - 1]).filter(Boolean).map(l => l.id);
  if (!a.zone) return 'all';
  return st.lights.filter(l => a.zone === 'front' ? l.zone.startsWith('front') : l.zone === a.zone).map(l => l.id);
}
function setPatch(a) {
  const p = {};
  if (a.effect) p.effect = a.effect;
  if (a.colors && a.colors.length) p.palette = a.colors.map(color);
  else if (a.palette) p.palette = a.palette;
  if (a.bri !== undefined) p.bri = a.bri;
  if (a.speed !== undefined) p.speed = a.speed;
  if (a.speedx !== undefined) p.speedx = a.speedx;
  if (a.blink !== undefined) p.blink = a.blink;
  if (a.trim !== undefined) p.trim = a.trim;
  if (a.on !== undefined) p.on = a.on; else if (p.effect || p.palette) p.on = true;
  return p;
}
const zoneLabel = (a, st) => a.lights && a.lights.length ? `lights ${a.lights.join(', ')}` : a.zone ? ([...st.groups, ...st.zones].find(z => z.id === a.zone) || {}).name || a.zone : 'Whole yard';
function setWords(a, st) {
  const bits = [];
  if (a.effect) bits.push(((st.effects.find(e => e.id === a.effect) || {}).name || a.effect).toLowerCase());
  if (a.colors && a.colors.length) bits.push([...new Set(a.colors.map(colorName))].join(' & '));
  else if (a.palette) bits.push(((st.palettes.find(p => p.id === a.palette) || {}).name || a.palette).toLowerCase());
  if (a.speedx !== undefined && a.speedx !== 1) bits.push(a.speedx < 1 ? 'slower' : 'faster');
  return bits.join(', ') || 'tweaked';
}

// Shows whose names match a search. A word also matches its Christmas cousins
// ("snow" finds Frosty, Glacier, Winter...).
const RELATED = {
  snow: ['snow', 'frost', 'winter', 'glacier', 'ice', 'icy', 'flake'], santa: ['santa', 'sleigh', 'sled', 'claus'],
  candy: ['candy', 'cane', 'cain', 'sugar'], grinch: ['grinch'], tree: ['tree'], blue: ['blue', 'ice', 'icy', 'frost', 'glacier'],
  warm: ['warm', 'hearth', 'cozy', 'fire'], party: ['party', 'disco', 'dance', 'fireworks'], chase: ['chase', 'jump', 'moving', 'spin'],
  sparkle: ['sparkle', 'twinkle', 'star', 'magic'], christmas: ['christmas', 'xmas', 'noel'],
};
function findShows(query, st) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  const words = norm(query).split(/\s+/).filter(w => w.length >= 3 && !['show', 'shows', 'the', 'and', 'with', 'have', 'any', 'what', 'which'].includes(w));
  const terms = [...new Set(words.flatMap(w => RELATED[w] || RELATED[w.replace(/s$/, '')] || [w.replace(/s$/, '')]))];
  if (!terms.length) return [];
  return st.looks.filter(l => terms.some(t => norm(l.name).includes(t))).slice(0, 16).map(l => ({ id: l.id, name: l.name }));
}

// training: what the owner has taught (lib/training.js); shared by the live
// elves and the training sandbox.
// catalog: the owner's ratings/tags/notes/flavor per show (lib/catalog.js).
function createAssistant({ engine, llama, training = null, catalog = null, log = console.log, onChange = () => {} }) {
  const history = [];   // { at, text, reply, ok, ms, llm (actions JSON for follow-ups), shows, saved }
  let seq = 0;
  const remember = (h) => { history.push({ id: `${Date.now().toString(36)}-${++seq}`, at: Date.now(), ...h }); if (history.length > 20) history.shift(); onChange(); };
  const taught = () => (training ? training.messages() : []);

  function runActions(actions, st) {
    const done = [], errors = [], shows = [];
    let saved = null;
    const lightIds = (nums) => {
      if (!Array.isArray(nums) || !nums.length) return 'all';
      const ids = nums.map(n => st.lights[n - 1]).filter(Boolean).map(l => l.id);
      if (!ids.length) throw new Error(`No light ${nums.join(', ')}`);
      return ids;
    };
    for (const a of actions || []) {
      let ids = null, look = null;
      try {
        switch (a.do) {
          case 'power':
            if (a.zone) engine.setZone(a.zone, { off: a.on === false });
            else a.on === false ? engine.stop() : engine.start();
            break;
          case 'look': {
            look = st.looks.find(l => l.id === a.look) || st.looks.find(l => l.name.toLowerCase() === String(a.look || '').toLowerCase());
            if (!look) throw new Error(`No look "${a.look}"`);
            if (!engine.running) engine.start();
            engine.applyLook(look.id, a.zone);
            break;
          }
          case 'set': {
            const patch = {};
            if (a.effect) patch.effect = a.effect;
            if (a.colors && a.colors.length) patch.palette = a.colors.map(color);
            else if (a.palette) patch.palette = a.palette;
            if (a.bri !== undefined) patch.bri = a.bri;
            if (a.speed !== undefined) patch.speed = a.speed;
            if (a.blink !== undefined) patch.blink = a.blink;
            if (a.trim !== undefined) patch.trim = a.trim;
            if (a.on !== undefined) patch.on = a.on;
            else if (patch.effect || patch.palette) patch.on = true;
            if (!Object.keys(patch).length && a.speedx === undefined) continue;
            const inZone = (l) => a.zone === 'front' ? l.zone.startsWith('front') : l.zone === a.zone;
            ids = (!a.lights || !a.lights.length) && a.zone ? st.lights.filter(inZone).map(l => l.id) : lightIds(a.lights);
            // C9 plug lights are on/off only: for them, only blink/on mean anything.
            const plugOnly = ids !== 'all' && ids.length && ids.every(id => (st.lights.find(l => l.id === id) || {}).plug);
            if (plugOnly) {
              for (const k of Object.keys(patch)) if (!['blink', 'on'].includes(k)) delete patch[k];
              delete a.effect; delete a.colors; delete a.palette; delete a.speed; delete a.speedx; delete a.bri;
              if (!Object.keys(patch).length) continue;
            }
            if (a.speedx !== undefined && a.speed === undefined) {
              const list = ids === 'all' ? st.lights.map(l => l.id) : ids;
              for (const id of list) engine.setLights([id], { ...patch, speed: st.lights.find(l => l.id === id).speed * a.speedx });
            } else if (Object.keys(patch).length) engine.setLights(ids, patch);
            else continue;
            break;
          }
          case 'master': engine.setMaster(a.value); break;
          case 'next': engine.nextLook(); break;
          case 'rotate': engine.setRotate({ enabled: a.enabled, minutes: a.minutes }); break;
          case 'schedule': engine.setSchedule({ enabled: a.enabled ?? true, on: a.start || undefined, off: a.stop || undefined }); break;
          case 'save': {
            const name = String(a.name || '').trim().slice(0, 40) || 'Elf Special';
            const after = engine.saveLook(name);
            const look = after.looks.find(l => !l.builtin && l.name.toLowerCase() === name.toLowerCase());
            saved = look ? { id: look.id, name: look.name } : null;
            break;
          }
          case 'find': shows.push(...findShows(a.query, st)); break;
          case 'say': if (!String(a.text || '').trim()) continue; break;
          default: continue;
        }
        done.push({ a, ids, look });
      } catch (e) { errors.push(e.message); }
    }
    return { done, errors, shows, saved };
  }

  // Instant answers that don't need Llama.
  function quick(text, st) {
    const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
    if (/^(lights? )?(on|turn (them |it )?on|start)$/.test(t)) { engine.start(); return { reply: 'Lights on!', llm: { actions: [{ do: 'power', on: true }] } }; }
    if (/^(lights? )?(off|turn (them |it )?off|stop)$/.test(t)) { engine.stop(); return { reply: 'Lights off. Goodnight!', llm: { actions: [{ do: 'power', on: false }] } }; }
    // "play it" / "show me" right after a design plays the draft.
    const lastSaved = [...history].reverse().find(h => h.saved);
    if (lastSaved && /^(play|show|try|run|see) (it|that|this|me)( one| now)?$|^show me$|^play$/.test(t)) {
      if (!engine.running) engine.start();
      engine.applyLook(lastSaved.saved.id);
      return { reply: `Playing "${lastSaved.saved.name}"!`, llm: { actions: [{ do: 'look', look: lastSaved.saved.id }] } };
    }
    // "what santa shows do I have?", "which ones have snow?": search in code.
    if (/^(what|which|show me|list|find|do i have|any)\b/.test(t) && /\b(shows?|looks?|scenes?|diys?|ones?|have)\b/.test(t)) {
      let shows = findShows(t, st);
      // "which shows are cozy?" -> shows the owner tagged cozy, then name matches.
      if (catalog) {
        const tags = catalog.TAGS.filter(tag => t.includes(tag.replace('-only', '')) || t.includes(tag));
        if (tags.length) { const tagged = catalog.withTags(tags).filter(x => st.looks.some(l => l.id === x.id)); shows = [...tagged, ...shows.filter(x => !tagged.some(y => y.id === x.id))].slice(0, 16); }
      }
      if (shows.length) return { reply: `Found ${shows.length}: tap one to play it.`, shows, llm: { actions: [{ do: 'find', query: t }] } };
    }
    // "Sleigh Ride", "play santa sleigh": exact names skip Llama (emoji and
    // punctuation in Govee names ignored).
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(t.replace(/^(play|show|put on|switch to)\s+/, '').replace(/\s+(look|scene|show|diy)$/, ''));
    const look = want && (st.looks.find(l => norm(l.name) === want) || st.looks.find(l => l.id === t));
    if (look) { engine.applyLook(look.id); if (!engine.running) engine.start(); return { reply: `${look.name} it is!`, llm: { actions: [{ do: 'look', look: look.id }] } }; }
    return null;
  }

  // The owner's show catalog, for requests about picking or designing shows.
  // It changes as shows are rated, so it rides in the last message (cache-safe),
  // and only when it's relevant (it costs reading time on every request).
  const SHOWY = /\b(show|look|scene|diy|something|play|put on|design|surprise|create|mood|cozy|kids?|late|energ|fun|calm|quiet|party|favou?rite|like|best|tonight|similar|flavou?r|vibe)\w*/i;
  const showNotes = (text, st) => {
    if (!catalog || !SHOWY.test(text)) return '';
    const c = catalog.compact(st.looks);
    const fav = st.palettes.find(p => p.id === 'favourites');
    return (c ? `\nOwner's show notes (+ liked, - disliked, tags, colours, pace; prefer liked shows that fit, avoid disliked; front-only/back-only = use only there; when designing, match the colours and pace of liked shows):\n${c}` : '')
      + (fav ? `\nOwner's favourite colours (palette "favourites"): ${fav.colors.join(' ')}. Use them in designs unless asked for other colours.` : '');
  };

  // The last few turns (within 20 minutes), so follow-ups like "more red" work.
  const recent = () => {
    const h = history.filter(x => x.llm && Date.now() - x.at < 20 * 60000).slice(-3);
    return h.length ? `\nEarlier: ${h.map(x => `"${x.text}" -> ${JSON.stringify(x.llm.actions)}`).join('; ')}` : '';
  };

  // Read the fixed part of the prompt into Ollama's cache ahead of time, so
  // the first real request after a restart doesn't pay ~1 minute for it.
  async function prime() {
    const st = engine.status();
    const key = systemPrompt(st) + JSON.stringify(taught());
    if (key === primed) return;
    try {
      await llama.chat([
        { role: 'system', content: key },
        ...EXAMPLES.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
        ...taught(),
        { role: 'user', content: `${stateLine(st)}\nRequest: hello` },
      ], { maxTokens: 1, temperature: 0.1 });
      primed = key; log('Elves ready');
    } catch (e) { log(`Elves warm-up: ${e.message}`); }
  }
  let primed = null;

  return {
    prime,
    history: () => history.map(({ llm, ...h }) => ({ ...h, canLearn: !!(llm && llm.actions && llm.actions.length) })),
    clear() { history.length = 0; onChange(); },
    // 👍: keep what the elves did for that request as a worked example.
    good(id) {
      const h = history.find(x => x.id === id);
      if (!h || !h.llm || !h.llm.actions || !h.llm.actions.length) throw new Error('Nothing to learn from that one');
      if (!training) throw new Error('Training is off');
      training.addExample(h.text, h.llm.actions, h.retryOf ? 'corrected' : 'thumbs up');
      h.rated = 'good'; onChange();
    },
    // 👎 + what it should have done: ask again with the correction.
    async retry(id, hint) {
      const h = history.find(x => x.id === id);
      if (!h) throw new Error('That answer is gone');
      if (!String(hint || '').trim()) throw new Error('Say what it should have done');
      h.rated = 'bad'; onChange();
      const r = await this.ask(h.text, { hint });
      const last = history[history.length - 1];
      if (last) { last.retryOf = id; last.hint = hint; onChange(); }
      return r;
    },
    // opts.hint: the owner's correction when redoing a 👎 answer.
    async ask(text, { hint } = {}) {
      text = String(text || '').trim().slice(0, 300);
      if (!text) throw new Error('Type what you want the lights to do');
      hint = String(hint || '').trim().slice(0, 300);
      const st = engine.status();
      // "remember the backyard is the deck" -> a house note.
      if (training && !hint && /^(remember|note)\b/i.test(text)) {
        try { const n = training.addNote(text); remember({ text, reply: `Got it, I'll remember: ${n}`, ok: true, ms: 0 }); return { reply: `Got it, I'll remember: ${n}` }; }
        catch (e) { remember({ text, reply: e.message, ok: false, ms: 0 }); throw e; }
      }
      try {
        const q = hint ? null : quick(text, st);
        if (q) { remember({ text, reply: q.reply, ok: true, ms: 0, llm: q.llm, shows: q.shows }); return { reply: q.reply, shows: q.shows || [] }; }
      } catch (e) { remember({ text, reply: e.message, ok: false, ms: 0 }); throw e; }

      const last = history[history.length - 1];
      const draft = last && last.saved && Date.now() - last.at < 20 * 60000 && !st.zones.some(z => z.current === last.saved.id) ? last.saved : null;
      // Designing gets more room and a livelier temperature than commands.
      const creative = /\b(surprise|design|create|invent|make (me |up )?(a |an )?(new )?(show|look|theme)|come up with|new show|new look|something new)\b/i.test(text);
      let out;
      try {
        out = await llama.chat([
          { role: 'system', content: systemPrompt(st) },
          ...EXAMPLES.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
          // What the owner taught (notes, 👍 and corrected examples).
          ...taught(),
          // Recent turns go inside the last message, not as extra turns: the
          // prompt before it then never changes and Ollama reuses its cache
          // (re-reading ~1500 tokens costs ~55 s on this CPU).
          { role: 'user', content: `${stateLine(st)}${showNotes(text, st)}${draftLine(draft, st, engine.savedLooks())}${recent()}\nRequest: ${text}${hint ? `\nOwner's correction of your last answer to this: ${hint}` : ''}` },
        ], { format: schema(st), maxTokens: creative ? 320 : 160, temperature: creative ? 0.8 : 0.1 });
      } catch (e) {
        const msg = `The elves are asleep (${e.message})`;
        remember({ text, reply: msg, ok: false });
        throw new Error(msg);
      }
      let parsed;
      try { parsed = JSON.parse(out.text); } catch (_) { parsed = { actions: [] }; }
      let actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const named = zoneInText(text, st);
      if (named && !creative) actions = actions.map(a => (['set', 'look', 'power'].includes(a.do) && !a.zone && !(a.lights && a.lights.length)) ? { ...a, zone: named } : a);
      // Speed and brightness only change when asked: models like to tack a
      // "slower" or a brightness onto colour/effect commands.
      if (!creative && !draft) {
        const asked = `${text} ${hint}`;   // a correction counts as asking
        const sp = /\b(slow|slower|fast|faster|speed|quick|quicker|calm|chill|hurry|lazy)\w*/i.test(asked);
        const br = /\b(bright|brighter|dim|dimmer|brightness|glow|dark|darker|percent|%)/i.test(asked);
        actions = actions.map(a => {
          if (a.do !== 'set') return a;
          const b = { ...a };
          if (!sp) { delete b.speed; delete b.speedx; }
          if (!br) delete b.bri;
          return b;
        });
      }
      // Saving only when asked: models like to tack a "save" onto plain commands.
      if (!creative && !/\b(save|keep|call it|name it)\b/i.test(text)) actions = actions.filter(a => a.do !== 'save');
      // A design is one set per zone; Llama sometimes leaves the zones out, which
      // would make each set overwrite the last. Hand them out in order.
      if (creative || (draft && actions.every(a => ['set', 'say', 'save'].includes(a.do)))) {
        const loose = actions.filter(a => a.do === 'set' && !a.zone && !(a.lights && a.lights.length));
        const order = loose.length === 2 ? ['front', 'back'] : st.zones.map(z => z.id);
        if (loose.length > 1) loose.forEach((a, i) => { if (order[i]) a.zone = order[i]; });
      }
      // Designs (and tweaks to a design that hasn't been played yet) are built
      // aside as a saved look; the show that's playing carries on.
      const sets = actions.filter(a => a.do === 'set');
      const tweak = !creative && draft && sets.length && actions.every(a => ['set', 'say', 'save'].includes(a.do));
      if (creative || tweak) {
        let designed = null, errs = [];
        try {
          const edits = sets.map(a => ({ ids: setIds(a, st), patch: setPatch(a) }));
          const name = tweak ? draft.name : (actions.find(a => a.do === 'save') || {}).name || 'Elf Special';
          designed = engine.designLook(name, edits, tweak ? draft.id : null);
        } catch (e) { errs.push(e.message); }
        const parts = [...new Set(sets.map(a => `${zoneLabel(a, st)}: ${setWords(a, st)}`))].join('; ');
        const said = (actions.find(a => a.do === 'say') || {}).text;
        let reply = designed ? `${tweak ? 'Updated' : 'Designed'} "${designed.name}" (${parts}). Still playing what was on; tap Play to see it.` : `Couldn't design that: ${errs.join('; ')}`;
        if (said && designed) reply = `${said.trim().replace(/([^.!?])$/, '$1.')} ${reply}`;
        const tm = out.timing || {};
        log(`Elves: "${text}" -> ${tweak ? 'tweak' : 'design'} ${designed ? designed.name : 'failed'} (${(out.ms / 1000).toFixed(1)}s; read ${tm.promptTokens} tok in ${tm.promptS}s, wrote ${tm.outTokens} in ${tm.outS}s)`);
        remember({ text, reply, ok: !!designed, ms: out.ms, llm: { actions }, saved: designed || undefined, draft: true });
        return { reply, errors: errs, ms: out.ms, shows: [], saved: designed };
      }
      if (!engine.running && sets.length) engine.start();
      const { done, errors, shows, saved } = runActions(mergeZones(actions, st), engine.status());
      const said = describe(done, engine.status());
      let reply = said ? said.replace(/([^.!?])$/, '$1!') : '';
      if (done.some(d => d.a.do === 'find')) reply = (reply ? reply + ' ' : '') + (shows.length ? `Found ${shows.length}: tap one to play it.` : 'No shows with that in the name.');
      if (!reply) reply = errors.length ? 'Nothing changed.' : "I'm not sure what to change. Try a show name, a colour, or \"surprise me\".";
      if (errors.length) reply += ` (Couldn't: ${errors.join('; ')})`;
      const tm = out.timing || {};
      log(`Elves: "${text}" -> ${done.map(d => d.a.do).join(', ') || 'nothing'} (${(out.ms / 1000).toFixed(1)}s; read ${tm.promptTokens} tok in ${tm.promptS}s, wrote ${tm.outTokens} in ${tm.outS}s)`);
      remember({ text, reply, ok: !errors.length, ms: out.ms, llm: { actions }, shows: shows.length ? shows : undefined, saved: saved || undefined });
      return { reply, errors, ms: out.ms, shows, saved };
    },
  };
}

module.exports = { createAssistant };
