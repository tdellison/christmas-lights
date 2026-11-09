// ─── Show catalog: what the owner thinks of each look and Govee show ─────────
//
// Built mostly in Watch mode: 👍/👎, tags (cozy, energetic, kids, late night,
// front-only, back-only) and notes per show, plus the colour "flavor" the
// sniffer recorded for Govee shows (data/sniff/*.json). The elves (and a
// future show director) get a compact version so they can pick and design
// with it. Kept in catalog.json (git-ignored, like config.json).

'use strict';

const fs = require('fs');
const path = require('path');

const TAGS = ['cozy', 'energetic', 'kids', 'late night', 'front-only', 'back-only'];

// palettes: effects PALETTES, so app looks can show their colours too.
function createCatalog({ file, sniffDir, palettes = {}, log = console.log, onChange = () => {} }) {
  let data = {};   // look id -> { name, up, down, tags[], notes[{text, at}], flavor, watched }
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { log(`catalog save failed: ${e.message}`); } }, 300);
    onChange();
  };
  const entry = (id, name) => {
    const e = data[id] = data[id] || { name: name || id, up: 0, down: 0, tags: [], notes: [] };
    if (name) e.name = name;
    return e;
  };

  // Flavor from the sniffer: one file per show, matched by look id.
  function loadFlavors() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(sniffDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(sniffDir, f), 'utf8'));
          if (!j.id || !j.summary || !j.summary.answered) continue;
          const s = j.summary;
          entry(j.id, j.show).flavor = s.stuck ? { stuck: true } : { colours: s.colours.slice(0, 4), changesPerSecond: s.changesPerSecond, at: j.at };
          n++;
        } catch (_) {}
      }
    } catch (_) {}
    if (n) save();
    return n;
  }
  loadFlavors();

  const clean = (id) => { const e = data[id]; if (e && !e.up && !e.down && !e.tags.length && !e.notes.length && !e.flavor) delete data[id]; };

  return {
    TAGS,
    all: () => data,
    loadFlavors,
    rate(id, name, up) { const e = entry(id, name); up ? e.up++ : e.down++; save(); return e; },
    // Undo the last 👍/👎 (tapped by mistake).
    unrate(id, up) { const e = data[id]; if (!e) return; if (up && e.up) e.up--; if (!up && e.down) e.down--; clean(id); save(); },
    toggleTag(id, name, tag) {
      if (!TAGS.includes(tag)) throw new Error(`Unknown tag "${tag}"`);
      const e = entry(id, name);
      e.tags = e.tags.includes(tag) ? e.tags.filter(t => t !== tag) : [...e.tags, tag];
      clean(id); save(); return data[id] || null;
    },
    addNote(id, name, text) {
      text = String(text || '').trim().slice(0, 200);
      if (!text) throw new Error('Type a note first');
      const e = entry(id, name); e.notes.push({ text, at: Date.now() });
      if (e.notes.length > 5) e.notes.shift();
      save(); return e;
    },
    deleteNote(id, at) { const e = data[id]; if (!e) return; e.notes = e.notes.filter(n => n.at !== at); clean(id); save(); },
    watched(id, name) { entry(id, name).watched = Date.now(); save(); },
    // Colours/pace from sniffing a Govee show (Watch mode or the sniffer script).
    setFlavor(id, name, s) {
      if (!s || !s.answered) return;
      entry(id, name).flavor = s.stuck ? { stuck: true } : { colours: s.colours.slice(0, 4), changesPerSecond: s.changesPerSecond, at: new Date().toISOString() };
      save();
    },
    // Shows carrying any tag in `tags`.
    withTags(tags) { return Object.entries(data).filter(([, e]) => e.tags.some(t => tags.includes(t))).map(([id, e]) => ({ id, name: e.name })); },
    // One short line per show worth mentioning, best liked first, for prompts:
    //   govee:diy:Sleigh Ride "Sleigh Ride" +3 cozy,kids; red/gold, fast; "kids love it"
    compact(looks, max = 30) {
      const known = new Set(looks.map(l => l.id));
      const rows = Object.entries(data).filter(([id, e]) => known.has(id) && (e.up || e.down || e.tags.length || e.notes.length || (e.flavor && !e.flavor.stuck)));
      rows.sort(([, a], [, b]) => (b.up - b.down) - (a.up - a.down) || b.tags.length - a.tags.length);
      return rows.slice(0, max).map(([id, e]) => {
        const score = e.up - e.down;
        const bits = [`${id} "${e.name}"`];
        if (e.up || e.down) bits.push(score > 0 ? `+${score}` : String(score));
        if (e.tags.length) bits.push(e.tags.join(','));
        const look = looks.find(l => l.id === id);
        if (!(e.flavor && e.flavor.colours) && look && look.palette && palettes[look.palette]) bits.push(palettes[look.palette].colors.join('/'));
        if (e.flavor && e.flavor.colours) bits.push(`${e.flavor.colours.map(c => c.hex).join('/')} ${e.flavor.changesPerSecond >= 2 ? 'fast' : e.flavor.changesPerSecond >= 0.5 ? 'medium' : 'slow'}`);
        if (e.notes.length) bits.push(`"${e.notes[e.notes.length - 1].text}"`);
        return bits.join(' ');
      }).join('\n');
    },
  };
}

module.exports = { createCatalog, TAGS };
