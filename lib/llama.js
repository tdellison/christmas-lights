// ─── Local Llama through Ollama ───────────────────────────────────────────────
//
// Llama 3.1 8B on CPU: ~18 s to load, then a few seconds per short reply. The
// model is loaded at startup and kept loaded (keep_alive -1), and requests run
// one at a time. If Ollama isn't running it is started as this user, since the
// model lives in ~/.ollama.

'use strict';

const { spawn } = require('child_process');

const HOST = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.LLAMA_MODEL || 'llama3.1:8b';

function createLlama({ log = console.log, onChange = () => {} } = {}) {
  let chain = Promise.resolve();
  let ready = false, busy = false, lastError = null, lastMs = null;
  const set = (patch) => { ({ ready = ready, busy = busy, lastError = lastError, lastMs = lastMs } = { ready, busy, lastError, lastMs, ...patch }); onChange(); };

  async function up() {
    try { return (await fetch(`${HOST}/api/version`, { signal: AbortSignal.timeout(1500) })).ok; }
    catch (_) { return false; }
  }
  async function ensureServer() {
    if (await up()) return true;
    log('Ollama not running - starting it');
    try {
      const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      p.on('error', (e) => { lastError = `cannot start ollama: ${e.message}`; });
      p.unref();
    } catch (e) { lastError = e.message; return false; }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await up()) return true;
    }
    lastError = lastError || 'Ollama did not come up';
    return false;
  }

  async function call(messages, { maxTokens = 200, temperature = 0.2, format } = {}) {
    const t0 = Date.now();
    const r = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: MODEL, stream: false, keep_alive: -1, ...(format ? { format } : {}),
        // 4 threads leaves cores for the light engine and anything else on the box.
        options: { num_predict: maxTokens, temperature, num_thread: 4, num_ctx: 4096 },
        messages,
      }),
    });
    const body = await r.json();
    if (!r.ok || body.error) throw new Error(body.error || `ollama ${r.status}`);
    const sec = (ns) => Math.round((ns || 0) / 1e8) / 10;
    return {
      text: String(body.message?.content || '').trim(), ms: Date.now() - t0,
      timing: { promptTokens: body.prompt_eval_count, promptS: sec(body.prompt_eval_duration), outTokens: body.eval_count, outS: sec(body.eval_duration) },
    };
  }

  // One request at a time; later ones wait their turn.
  function run(fn) {
    const job = chain.then(async () => {
      set({ busy: true });
      try {
        if (!(await ensureServer())) throw new Error(lastError || 'Ollama unavailable');
        const out = await fn();
        set({ ready: true, lastError: null, lastMs: out.ms });
        return out;
      } catch (e) { set({ lastError: e.message }); throw e; }
      finally { set({ busy: false }); }
    });
    chain = job.catch(() => {});
    return job;
  }

  return {
    MODEL,
    warm() {
      return run(() => call([{ role: 'user', content: 'Say OK.' }], { maxTokens: 2 }))
        .then(({ ms }) => log(`Llama ready (${MODEL}, ${(ms / 1000).toFixed(1)}s)`))
        .catch((e) => log(`Llama unavailable: ${e.message}`));
    },
    chat: (messages, opts) => run(() => call(messages, opts)),
    status: () => ({ model: MODEL, ready, busy, lastError, lastMs }),
  };
}

module.exports = { createLlama };
