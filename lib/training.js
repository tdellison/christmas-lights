// ─── What the owner has taught the elves ──────────────────────────────────────
//
// House notes ("remember the backyard is the deck") and worked examples
// (a request and the actions that were right for it, from 👍 or a corrected
// 👎). Both go into every elves prompt right after the built-in examples, so
// Qwen follows them. Kept in training.json (git-ignored, like config.json).

'use strict';

const fs = require('fs');

const MAX_NOTES = 40, MAX_EXAMPLES = 60;

function createTraining({ file, log = console.log, onChange = () => {} }) {
  let data = { notes: [], examples: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { log(`training save failed: ${e.message}`); } onChange(); };
  const id = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  return {
    notes: () => data.notes,
    examples: () => data.examples,
    addNote(text) {
      text = String(text || '').trim().replace(/^(remember|note)( that)?[:,]?\s*/i, '').slice(0, 200);
      if (!text) throw new Error('What should the elves remember?');
      data.notes.push({ id: id(), text, at: Date.now() });
      if (data.notes.length > MAX_NOTES) data.notes.shift();
      save(); log(`Elves will remember: ${text}`);
      return text;
    },
    deleteNote(nid) { data.notes = data.notes.filter(n => n.id !== nid); save(); },
    // A request and the actions that were right for it. Same request again replaces it.
    addExample(request, actions, source = 'thumbs up') {
      request = String(request || '').trim().slice(0, 300);
      if (!request || !Array.isArray(actions) || !actions.length) throw new Error('Nothing to learn from that one');
      data.examples = data.examples.filter(e => e.request.toLowerCase() !== request.toLowerCase());
      data.examples.push({ id: id(), request, actions, source, at: Date.now() });
      if (data.examples.length > MAX_EXAMPLES) data.examples.shift();
      save(); log(`Elves learned: "${request}"`);
    },
    deleteExample(eid) { data.examples = data.examples.filter(e => e.id !== eid); save(); },
    // Extra prompt turns: notes, then the learned examples, oldest first so a
    // new one only re-reads the tail of Ollama's cache.
    messages() {
      const out = [];
      if (data.notes.length) {
        out.push({ role: 'user', content: `House notes from the owner (always follow these):\n${data.notes.map(n => `- ${n.text}`).join('\n')}` });
        out.push({ role: 'assistant', content: '{"actions":[]}' });
      }
      for (const e of data.examples) {
        out.push({ role: 'user', content: `Request: ${e.request}` });
        out.push({ role: 'assistant', content: JSON.stringify({ actions: e.actions }) });
      }
      return out;
    },
  };
}

module.exports = { createTraining };
