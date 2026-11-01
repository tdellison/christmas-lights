# christmas-lights: notes for Claude Code

Christmas light controller for Govee LAN lights. Lights only, music optional.
Govee LAN, ptReal and queue rules apply.

- `lib/govee.js`: UDP. Per-IP queue with a 50 ms gap (controllers drop
  packets above about 20/s). `segments()` sends ptReal frames: one packet, one
  frame per colour, with a segment mask.
- `lib/engine.js`: devices map to lights (`<deviceId>:<segment>`), 10 Hz
  tick, sends only on change, at most one packet per device per tick, skips
  a device whose queue is busy. Also looks, rotate, schedule and the music
  feed.
- `lib/effects.js`: `fx(ctx) -> {r,g,b}`. Keep effects pure functions of
  `ctx.t`. Per-light random state goes in `ctx.mem`.
- `lib/llama.js` + `lib/assistant.js`: "Ask the elves". Local Llama 3.1 8B
  (Ollama, CPU, ~60 tok/s reading, ~5 tok/s writing). Llama only returns
  `{actions:[]}` (schema-enforced, ids are enums); the app runs them and
  writes the reply. Keep the system prompt + examples static so Ollama's
  prefix cache holds, and keep Llama's output short: writing is the cost.
- `public/index.html`: single-file phone UI over a WebSocket.

Rules:
- Never send faster than the tick. Never queue a backlog of effect frames.
- Port 3100. Govee listen port 4002 clashes with any other Govee LAN
  app, so never run two at once.
- Fresh installs start with 6 two-light pair slots (12 lights) and no IPs;
  a slot with no IP is previewed but never sent to.
- Owner prefers short answers and no prices.
