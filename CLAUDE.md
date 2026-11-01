# christmas-lights: notes for Claude Code

Christmas light controller for Govee LAN lights. Lights only, music optional.
It was split out of haunt-ctrl's `lights/lightMode.js`, so the same Govee
LAN, ptReal and queue rules apply.

- `lib/govee.js`: UDP. Per-IP queue with a 50 ms gap (controllers drop
  packets above about 20/s). `segments()` sends ptReal frames: one packet, one
  frame per colour, with a segment mask.
- `lib/engine.js`: devices map to lights (`<deviceId>:<segment>`), 10 Hz
  tick, sends only on change, at most one packet per device per tick, skips
  a device whose queue is busy. Also looks, rotate, schedule and the music
  feed.
- `lib/effects.js`: `fx(ctx) -> {r,g,b}`. Keep effects pure functions of
  `ctx.t`. Per-light random state goes in `ctx.mem`.
- `public/index.html`: single-file phone UI over a WebSocket.

Rules:
- Never send faster than the tick. Never queue a backlog of effect frames.
- Port 3100. Govee listen port 4002 clashes with haunt-ctrl (retired for the
  season, being redesigned), so never run both at once.
- Owner prefers short answers and no prices.
