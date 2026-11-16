# christmas-lights: notes for Claude Code

Christmas light controller: Govee LAN lights, BRMesh Bluetooth lights and Tuya smart plugs. Lights only, music optional.
Govee LAN, ptReal and queue rules apply.

- `lib/govee.js`: UDP. Per-IP queue with a 50 ms gap (controllers drop
  packets above about 20/s). `segments()` sends ptReal frames: one packet, one
  frame per colour, with a segment mask.
- `lib/engine.js`: devices map to lights (`<deviceId>:<segment>`), 10 Hz
  tick, sends only on change, at most one packet per device per tick, skips
  a device whose queue is busy. Also looks, rotate, schedule and the music
  feed.
- Zones: `cfg.zones` (front-left, front-right; no backyard, owner's
  decision) each with off, current
  look, optional own schedule; devices have `zone`; `front` = both front
  zones. Effect groups are per zone. Govee scenes per zone need `d.mac`
  (from Scan → Use). The elves get the zone from the request words when
  Qwen leaves it out (`zoneInText`). Zones are fixed (no add/remove API).
- `light.trim` (5-100, spot brightness): placement cap applied in frame()
  after effect × bri; never saved in or applied from looks; during a Govee
  scene the pair's LAN brightness = master × average trim.
- Evening polish: `lib/sun.js` (NOAA sunset; schedule.on may be 'sunset' +
  sunsetOffset, cfg.location lat/lon), engine fades (per-light crossfade
  FADE_MS on effect/palette/on changes, showFade in at start/out at stop;
  stop() fades then stopNow()), `lib/health.js` (probes devices every 2 min
  while running, alert after 2 misses), `lib/occasion.js` (special nights +
  Open-Meteo snow, one line in the Director's prompt).
- `lib/effects.js`: `fx(ctx) -> {r,g,b}`. No warm effects/palettes (Hearth
  Glow and Warm White removed: off the owner's scheme). Keep effects pure functions of
  `ctx.t`. Per-light random state goes in `ctx.mem`.
- `lib/llama.js` (old name, runs Qwen) + `lib/assistant.js`: "Ask the elves" chat (Elves tab).
  Local Qwen 3 30B-A3B instruct-2507 (Ollama, MoE ~3B active, ~18 GB RAM, CPU);
  chosen by the scored 14-request test over Qwen 3 8B, Qwen 3.5 9B and Llama
  3.1 8B (14/14, ~2x faster than the 8B). Re-run the test before any swap. Code
  strips unasked speed/brightness/save from plain commands.
  Qwen only returns `{actions:[]}` (schema-enforced, ids are enums); the app
  runs them and writes the reply. Designs ("surprise me", "design ... called
  X") are built aside with `engine.designLook` and saved, never applied live;
  tweaks right after go to that draft; "play it" plays it. Show searches,
  on/off and exact show names are handled in code, no Qwen.
  Prompt cache: system prompt + examples must stay byte-identical (saved
  looks, history and draft go in the LAST message) or Ollama re-reads ~1500
  tokens (~55 s). `assistant.prime()` warms it at startup.
- Training (`lib/training.js`, `lib/trainTest.js`, server `sandbox`): a
  second engine (`auto:false`, no drivers) + second assistant practise on a
  copy of the yard. Notes and 👍/corrected examples (training.json) are
  appended after the built-in examples in every elves prompt. The scored test
  (14 requests) runs in-app; keep it passing when changing prompts.
- Effects get `ctx.yard` (0..1 position across the light's AREA: both front
  zones together) besides the per-zone `pos`; `runner` uses it to cross the
  front yard.
- Director: `lib/director.js` (Qwen picks one show for the whole yard every
  N min, `{show, why}`, from the looks + time of night + occasion + recent
  picks; code enforces no repeats of the last few (fewer when there are few
  looks) and Govee only where d.mac known; random allowed look if Qwen fails).
  Watch & rate, the ratings catalog (👍/👎, tags, notes) and the Govee show
  sniffer were removed 2026-11-16 (owner: all 9 looks get used; Qwen learns
  style from the looks themselves and from Training). Server keeps
  PALETTES.favourites = colours of the 9 built-in looks (not rainbow,
  max 8). House style: elves `styleLines()` and Director `system()` list each
  built-in look's effect + colour words (fixed, cache-safe); no warm white /
  amber / orange / gold unless asked (prompt + `isWarm` code guard swaps them
  for white when the request has no WARM_WORDS).
- `cfg.goveeCloud` (default false, owner's choice: those shows were made for
  roofline lights): server only creates the cloud client and passes
  `external` when true, so off = no cloud calls and no `govee:*` looks
  anywhere. Zones pointing at a govee look reset to custom. trainTest keeps
  its own fake Govee DIYs, so the test is unchanged.
- `lib/goveeCloud.js`: Govee Platform API (cloud) for Govee scenes + app
  DIYs, offered to the engine as `govee:<kind>:<name>` looks. While one plays
  the engine sends nothing. Key in `secrets.json`, never in git or the UI.
- `lib/blelocal.js`: BRMesh lights from the server's TP-Link adapter (hci by
  address 58:D8:12:36:D0:B5) via `hcitool cmd` legacy advertising (hcitool
  has setcap). Device `brmesh` (no ip, `ble` = brmesh_N, N = BRMesh light
  id): sent to only when `via: 'server'`; `via: 'none'` = spare slot,
  preview only. Every command is
  sent at seq s and s+128 (lights accept only "newer" seq mod 256, shared
  with the BRMesh app); seq persisted in ble-seq.json. Newest wish per light,
  ~150 ms per advert. The ESP32/ESPHome bridge and C9 relay boards were
  removed 2026-11-16 (TP-Link works; owner can't splice); they're in git
  history if ever needed.
- `lib/tuya.js`: Tuya smart plugs via `tuyapi` (local). Device `kind: plug`,
  one light, on/off only (follows light.on + zone + show, ignores effects);
  min 4 s between switches, newest wish wins. `tuyaKey` is redacted from
  status (`hasKey`). `light.blink` (s, ≥10) blinks it until tonight's
  click budget (600, `tuya.clicksLeft`) runs out; Qwen sets it (elves
  `set.blink`). Plugs have `about` (what they power). Director step 2
  (`askPlugs`): Qwen judges each plug's `fit` against the picked show's
  colours, code turns clash→off / fit→on and paces blink so the budget
  lasts to the schedule's off time. Elves switch plugs named/described in
  the request in code ("turn off the laser dots").
- `public/index.html`: single-file phone UI over a WebSocket.

Rules:
- Never send faster than the tick. Never queue a backlog of effect frames.
- HTTPS twin on 3101 from `tls/` (git-ignored local CA `ca.crt`/`ca.key` +
  `cert.pem` for 192.168.1.118), for installing as an Android app; both
  ports share the WebSockets. `/ca.crt` serves the CA's public cert.
- Port 3100. Govee listen port 4002 clashes with any other Govee LAN
  app, so never run two at once.
- Fresh installs start with PAIR_SLOTS = 2 Govee pair slots (4 lights), no
  IPs; a slot with no IP is previewed but never sent to. Owner's yard: Pair 1
  (.216) + Pair 4 (.209), "Bluetooth pair" (via server), "Bluetooth spare"
  (via none, never sent), C9 plug 1-4 (empty). Plug lights
  carry `ready` (ip + tuyaId + key) in status; the Director's askPlugs and
  the elves' plugLine skip plugs that aren't ready. trainTest builds its own
  6-pair + Bluetooth yard (lights 1-6 front left, 7-12 front right, 13-14
  Bluetooth); don't tie it to PAIR_SLOTS. Its zone requests use left/right
  (no backyard) since 2026-11-16.
- Owner prefers short answers and no prices.
