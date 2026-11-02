// ─── Ask the elves: plain-English commands through local Llama ────────────────
//
// "candy cane, slower" -> Llama returns { actions[] } (JSON, schema enforced
// by Ollama) -> each action is checked and run through the engine, and the
// reply is written from what actually ran.
// Llama never touches the lights directly; the engine stays in charge of
// timing. Exact matches ("on", "off", a look's name) skip Llama entirely.

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
      type: 'array', maxItems: 4,
      items: {
        anyOf: [
          act('power', { on: bool, zone }, ['on']),
          act('look', { look, zone }, ['look']),
          act('set', { zone, lights: { type: 'array', items: int }, effect, palette, colors: { type: 'array', items: str }, bri: int, speed: { type: 'number' }, speedx: { type: 'number' }, on: bool }, ['lights']),
          act('master', { value: int }, ['value']),
          act('next'),
          act('rotate', { enabled: bool, minutes: int }),
          act('schedule', { enabled: bool, start: str, stop: str }),
        ],
      },
    },
  },
  };
};

function systemPrompt(st) {
  // Kept short and identical between requests: on this CPU Llama reads about
  // 60 tokens a second, so every line here costs time on every request.
  return `You control Christmas yard lights. Output JSON {"actions":[...]} with ONLY what the user asked for, usually one action.
zone: ${[...st.groups, ...st.zones].map(z => `${z.id} (${z.name})`).join(', ')}. Leave zone out for the whole yard.
power {on, zone}
look {look: id, zone}
set {zone, lights: [numbers] ([] = all in the zone, or the whole yard), effect, palette, colors: [hex], bri 0-100, speed 0.25-4, speedx (multiply speed), on} - ONLY fields that change
master {value 1-100}
next
rotate {enabled, minutes}
schedule {start "HH:MM", stop "HH:MM"} - 24h
effects: ${st.effects.map(e => e.id).join(' ')}
palettes: ${st.palettes.map(p => p.id).join(' ')}
looks: ${st.looks.map(l => l.id).join(' ')}
A mood (cozy, fun, calm) = one look. slower = speedx 0.5, faster = speedx 2. dimmer/brighter = master -/+ 20. Not about the lights = {"actions":[]}.`;
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
];

function stateLine(st) {
  const zones = st.zones.map(z => `${z.id} ${z.off ? 'off' : z.current || 'custom'}`).join(', ');
  return `Now: show ${st.running ? 'on' : 'off'}, ${st.lights.length} lights, master ${st.master}. Zones: ${zones}.`;
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
        if (a.colors && a.colors.length) bits.push(a.colors.map(c => colorName(c)).join(' & '));
        else if (a.palette) bits.push(pal(a.palette));
        if (a.speed !== undefined) bits.push(`speed ${a.speed}×`);
        else if (a.speedx !== undefined && a.speedx !== 1) bits.push(a.speedx < 1 ? 'slower' : 'faster');
        if (a.bri !== undefined) bits.push(`brightness ${a.bri}%`);
        if (a.on === false) bits.push('off');
        return `${bits.join(', ') || 'Updated'} on ${span(ids)}`;
      }
      case 'master': return `Brightness ${a.value}%`;
      case 'next': return 'Next look';
      case 'rotate': return a.enabled === false ? 'Auto-rotate off' : `Changing looks every ${a.minutes || st.rotate.minutes} min`;
      case 'schedule': return a.enabled === false ? 'Schedule off' : `On at ${a.start || st.schedule.on}, off at ${a.stop || st.schedule.off}, every day`;
      default: return '';
    }
  }).filter(Boolean).join('. ');
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

function createAssistant({ engine, llama, log = console.log, onChange = () => {} }) {
  const history = [];   // { at, text, reply, ok, ms }
  const remember = (h) => { history.push({ at: Date.now(), ...h }); if (history.length > 12) history.shift(); onChange(); };

  function runActions(actions, st) {
    const done = [], errors = [];
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
            if (a.on !== undefined) patch.on = a.on;
            else if (patch.effect || patch.palette) patch.on = true;
            if (!Object.keys(patch).length && a.speedx === undefined) continue;
            const inZone = (l) => a.zone === 'front' ? l.zone.startsWith('front') : l.zone === a.zone;
            ids = (!a.lights || !a.lights.length) && a.zone ? st.lights.filter(inZone).map(l => l.id) : lightIds(a.lights);
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
          default: continue;
        }
        done.push({ a, ids, look });
      } catch (e) { errors.push(e.message); }
    }
    return { done, errors };
  }

  // Instant answers that don't need Llama.
  function quick(text, st) {
    const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
    if (/^(lights? )?(on|turn (them |it )?on|start)$/.test(t)) { engine.start(); return 'Lights on!'; }
    if (/^(lights? )?(off|turn (them |it )?off|stop)$/.test(t)) { engine.stop(); return 'Lights off. Goodnight!'; }
    const look = st.looks.find(l => l.name.toLowerCase() === t || l.id === t);
    if (look) { engine.applyLook(look.id); if (!engine.running) engine.start(); return `${look.name} it is!`; }
    return null;
  }

  return {
    history: () => history,
    async ask(text) {
      text = String(text || '').trim().slice(0, 300);
      if (!text) throw new Error('Type what you want the lights to do');
      const st = engine.status();
      try {
        const q = quick(text, st);
        if (q) { remember({ text, reply: q, ok: true, ms: 0 }); return { reply: q }; }
      } catch (e) { remember({ text, reply: e.message, ok: false, ms: 0 }); throw e; }

      let out;
      try {
        out = await llama.chat([
          { role: 'system', content: systemPrompt(st) },
          ...EXAMPLES.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
          { role: 'user', content: `${stateLine(st)}\n\nRequest: ${text}` },
        ], { format: schema(st), maxTokens: 160, temperature: 0.1 });
      } catch (e) {
        const msg = `The elves are asleep (${e.message})`;
        remember({ text, reply: msg, ok: false });
        throw new Error(msg);
      }
      let parsed;
      try { parsed = JSON.parse(out.text); } catch (_) { parsed = { actions: [] }; }
      let actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const named = zoneInText(text, st);
      if (named) actions = actions.map(a => (['set', 'look', 'power'].includes(a.do) && !a.zone && !(a.lights && a.lights.length)) ? { ...a, zone: named } : a);
      const { done, errors } = runActions(mergeZones(actions, st), engine.status());
      let reply = done.length ? describe(done, engine.status()) + '!' : errors.length ? 'Nothing changed.' : "That's not something I can do with the lights.";
      if (errors.length) reply += ` (Couldn't: ${errors.join('; ')})`;
      const tm = out.timing || {};
      log(`Elves: "${text}" -> ${done.map(d => d.a.do).join(', ') || 'nothing'} (${(out.ms / 1000).toFixed(1)}s; read ${tm.promptTokens} tok in ${tm.promptS}s, wrote ${tm.outTokens} in ${tm.outS}s)`);
      remember({ text, reply, ok: !errors.length, ms: out.ms });
      return { reply, errors, ms: out.ms };
    },
  };
}

module.exports = { createAssistant };
