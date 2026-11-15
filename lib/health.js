// ─── Light health: notice when something stops answering ─────────────────────
//
// Every couple of minutes while the show is on, asks each light that has an
// address whether it's there. Two misses in a row raises an alert (shown in
// the app and logged); an answer clears it. Lights with no IP are skipped.

'use strict';

const EVERY_MS = 2 * 60000;

function createHealth({ engine, log = console.log, onChange = () => {} }) {
  const misses = {};    // device id -> consecutive failed checks
  const alerts = {};    // device id -> { name, since }

  async function check() {
    if (!engine.running) return;
    for (const d of engine.status().devices) {
      const reachable = d.ip || d.via === 'server';
      if (!reachable || (d.kind === 'plug' && !d.hasKey)) { delete misses[d.id]; delete alerts[d.id]; continue; }
      let ok = false;
      try { const r = await engine.probeDevice(d.id); ok = !!(r && r.ok); } catch (_) {}
      if (ok) {
        if (alerts[d.id]) { log(`${d.name} is answering again`); delete alerts[d.id]; onChange(); }
        misses[d.id] = 0;
      } else {
        misses[d.id] = (misses[d.id] || 0) + 1;
        if (misses[d.id] === 2 && !alerts[d.id]) {
          alerts[d.id] = { name: d.name, since: Date.now() };
          log(`ALERT: ${d.name} isn't answering (check its power and Wi-Fi)`);
          onChange();
        }
      }
    }
  }
  setInterval(() => { check().catch(() => {}); }, EVERY_MS);

  return {
    check,
    alerts: () => Object.entries(alerts).map(([id, a]) => ({ id, ...a })),
    dismiss(id) { delete alerts[id]; misses[id] = -5; onChange(); },   // quiet for ~10 more minutes
  };
}

module.exports = { createHealth };
