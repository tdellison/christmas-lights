# Christmas Lights

Christmas yard light controller for Govee lights over the LAN. Runs on the
Ubuntu server, controlled from your phone. Lights only. Music is an option you
can switch on later.

## Run it

```
npm install
npm start          # http://<server-ip>:3100
```

Port 3100. It listens on the Govee LAN port 4002, so **don't run another
Govee LAN app on the same machine at the same time.**

Auto-start: see `deploy/christmas-lights.service`.

## Setup (once)

1. In the Govee app, turn on **LAN Control** for each light.
2. **Setup → Scan network**, then **Add** each light. Or type its IP.
3. Say how many lights are on each controller. A Spotlight 2 two-pack is
   **2**: one IP, two lights you control separately.
4. Put the lights in yard order, left to right. Chases and waves follow it.
   Use **Find it** on the Lights tab to blink one light white.

## Using it

- **Lights**: tick one or more lights, then set the effect, palette or your
  own colours, brightness and speed. Each light can run something different.
- **Looks**: 10 built-in Christmas looks. Set the yard how you like it and
  **Save current** to make your own.
- **Auto-rotate**: switches to the next look in the playlist every N minutes.
  Tick which looks are in it.
- **Schedule**: turns the lights on and off at set times every day. A manual
  OFF holds until the next on time.
- If the server restarts while the lights were on, they come back on.

## Effects

Solid, Breathe, Colour Fade, Wave, Chase, Candy Cane, Alternate, Twinkle,
Snowfall, Sparkle, Hearth Glow, Rainbow, Music Pulse.

To add one, write a function in `lib/effects.js`. It gets the time, the
light's place in the yard and its palette, and returns a colour. It shows up
in the app automatically.

## Music (optional)

Turn it on in **Setup → Music**. After that, anything that POSTs
`{ "level": 0..1, "beat": true|false }` to `/api/music` drives the
beat-aware effects: Chase, Alternate, Sparkle and Music Pulse. With no feed,
every effect runs on its own clock. Nothing is built to send the feed yet.
That's the next piece if you want it, for example a script that plays a song
to the Bluetooth speaker and does beat detection.

## API

| | |
|---|---|
| `GET /api/status` | everything |
| `POST /api/start`, `/api/stop` | show on/off |
| `POST /api/master` `{value}` | master brightness 1-100 |
| `POST /api/scan` | discover lights |
| `POST /api/devices` `{ip, name, segments}` | add a controller |
| `POST /api/devices/:id` / `DELETE` | edit / remove |
| `POST /api/lights` `{ids:[..]\|'all', on, effect, palette, color, bri, speed, name}` | set lights |
| `POST /api/lights/order` `{order:[ids]}` | yard order |
| `POST /api/lights/identify` `{id}` | blink one light |
| `POST /api/looks/apply\|save\|delete\|next` | looks |
| `POST /api/rotate` `{enabled, minutes, list}` | auto-rotate |
| `POST /api/schedule` `{enabled, on, off, tz}` | daily schedule |
| `POST /api/music/enable` `{enabled}`, `POST /api/music` `{level, beat}` | music |

Settings live in `config.json`, which git ignores.
