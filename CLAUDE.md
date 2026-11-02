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
- Zones: `cfg.zones` (front-left, front-right, back) each with off, current
  look, optional own schedule; devices have `zone`; `front` = both front
  zones. Effect groups are per zone. Govee scenes per zone need `d.mac`
  (from Scan → Use). The elves get the zone from the request words when
  Llama leaves it out (`zoneInText`).
- `lib/effects.js`: `fx(ctx) -> {r,g,b}`. Keep effects pure functions of
  `ctx.t`. Per-light random state goes in `ctx.mem`.
- `lib/llama.js` + `lib/assistant.js`: "Ask the elves". Local Llama 3.1 8B
  (Ollama, CPU, ~60 tok/s reading, ~5 tok/s writing). Llama only returns
  `{actions:[]}` (schema-enforced, ids are enums); the app runs them and
  writes the reply. Keep the system prompt + examples static so Ollama's
  prefix cache holds, and keep Llama's output short: writing is the cost.
- `lib/goveeCloud.js`: Govee Platform API (cloud) for Govee scenes + app
  DIYs, offered to the engine as `govee:<kind>:<name>` looks. While one plays
  the engine sends nothing. Key in `secrets.json`, never in git or the UI.
- `lib/esphome.js`: ESP32s running ESPHome, over REST. Device kinds:
  `brmesh` (BLE lights via fastcon, `ble` = light names,
  `deploy/esp32-brmesh.yaml`) and `relay` (C9 strings on SSRs, `ch` = switch
  names, `deploy/esp32-relays.yaml`). Relay lights run effects on
  white/black and are on when bright; `light.string` is preview colour only.
  One command per entity per gap (lights 250 ms, switches 100 ms), none in flight.
- `public/index.html`: single-file phone UI over a WebSocket.

Rules:
- Never send faster than the tick. Never queue a backlog of effect frames.
- HTTPS twin on 3101 from `tls/` (git-ignored local CA `ca.crt`/`ca.key` +
  `cert.pem` for 192.168.1.118), for installing as an Android app; both
  ports share the WebSockets. `/ca.crt` serves the CA's public cert.
- Port 3100. Govee listen port 4002 clashes with any other Govee LAN
  app, so never run two at once.
- Fresh installs start with 6 two-light pair slots (12 lights) and no IPs;
  a slot with no IP is previewed but never sent to.
- Owner prefers short answers and no prices.
