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
- `lib/llama.js` + `lib/assistant.js`: "Ask the elves" chat (Elves tab).
  Local Qwen 3 8B (Ollama, `think: false`, CPU, ~60 tok/s reading, ~5 tok/s
  writing); chosen over Llama 3.1 8B by a scored 14-request test. Code
  strips unasked speed/brightness/save from plain commands.
  Llama only returns `{actions:[]}` (schema-enforced, ids are enums); the app
  runs them and writes the reply. Designs ("surprise me", "design ... called
  X") are built aside with `engine.designLook` and saved, never applied live;
  tweaks right after go to that draft; "play it" plays it. Show searches,
  on/off and exact show names are handled in code, no Llama.
  Prompt cache: system prompt + examples must stay byte-identical (saved
  looks, history and draft go in the LAST message) or Ollama re-reads ~1500
  tokens (~55 s). `assistant.prime()` warms it at startup.
- Training (`lib/training.js`, `lib/trainTest.js`, server `sandbox`): a
  second engine (`auto:false`, no drivers) + second assistant practise on a
  copy of the yard. Notes and 👍/corrected examples (training.json) are
  appended after the built-in examples in every elves prompt. The scored test
  (14 requests) runs in-app; keep it passing when changing prompts.
- Effects get `ctx.yard` (0..1 position in the whole yard) besides the
  per-zone `pos`; `runner` uses it to cross zones.
- Catalog / Watch / Director: `lib/catalog.js` (catalog.json: per look id
  up/down, tags, notes, sniffed flavor from data/sniff), `lib/watch.js`
  (plays each show N min, pauses rotate), `lib/director.js` (Qwen picks front
  + back every N min; code enforces 👎 never, front/back-only, no repeats,
  Govee only where d.mac known; weighted fallback if Qwen fails). The
  compact catalog goes in the LAST message only (elves: only for show-ish
  requests) to keep the prompt cache. Watch sniffs Govee shows (engine
  probeDevice ~4/s, `lib/flavor.js` summarize) into catalog flavor; server
  keeps PALETTES.favourites = colours of 👍 shows (flavor.favourites).
- `lib/goveeCloud.js`: Govee Platform API (cloud) for Govee scenes + app
  DIYs, offered to the engine as `govee:<kind>:<name>` looks. While one plays
  the engine sends nothing. Key in `secrets.json`, never in git or the UI.
- `lib/esphome.js`: ESP32s running ESPHome, over REST. Device kinds:
  `brmesh` (BLE lights via fastcon, `ble` = light names,
  `deploy/esp32-brmesh.yaml`) and `relay` (C9 strings on SSRs, `ch` = switch
  names, `deploy/esp32-relays.yaml`). Relay lights run effects on
  white/black and are on when bright; `light.string` is preview colour only.
  One command per entity per gap (lights 250 ms, switches 100 ms), none in flight.
- `lib/tuya.js`: Tuya smart plugs via `tuyapi` (local). Device `kind: plug`,
  one light, on/off only (follows light.on + zone + show, ignores effects);
  min 4 s between switches, newest wish wins. `tuyaKey` is redacted from
  status (`hasKey`). `light.blink` (s, ≥10) blinks it until tonight's
  click budget (600, `tuya.clicksLeft`) runs out; Qwen sets it (elves
  `set.blink`, Director `plugBlink` per pick).
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
