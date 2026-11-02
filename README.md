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

## Zones

The yard is split into **Front Left**, **Front Right** and **Backyard**
(Setup: pick each pair's zone). **Front yard** means both front zones
together. Tap a zone under the yard picture (or its name above its lights)
and the Lights and Looks tabs work on just that zone; **Whole yard** works on
everything. Each zone has its own on/off switch and can have its own on/off
times (Looks → Schedule). Auto-rotate can be limited to some zones ("Rotate
in"). Chases and waves run within a zone. The elves understand zones:
"candy cane out front, warm twinkle out back", "turn off the backyard".

A Govee scene can play in one zone only if the app knows which Govee lights
are in it: add them with **Scan → Use** (that records their hardware id).

## Bluetooth lights (BRMesh app)

BRMesh lights only talk Bluetooth, so an ESP32 does the talking. It runs
ESPHome with the [esphome-fastcon](https://github.com/dennispg/esphome-fastcon)
component and the app sends it colours over Wi-Fi.

1. **Mesh key**: set the lights up in the BRMesh app on an **Android** phone,
   plug the phone into the server, turn on USB debugging, and run
   (then toggle a light in the app):
   `adb logcat | grep -m 1 -o 'jyq_helper: .* payload:.\{24\},[[:space:]]*key:[[:space:]]*.\{8\}' | awk '{print $NF}'`
   It prints 8 hex characters.
2. **Light ids**: usually 1 and 2 for the first two lights added in the app.
   The same logcat output shows the id when you toggle each light.
3. Copy `deploy/secrets.example.yaml` to `deploy/secrets.yaml`, fill in Wi-Fi
   and the mesh key, set the `light_id`s in `deploy/esp32-brmesh.yaml`.
4. Flash: plug the ESP32 into the server, `esphome run deploy/esp32-brmesh.yaml`.
5. App: **Setup → + Add Bluetooth pair**, type the ESP32's IP, Save, Test.

Bluetooth lights update about 3-4 times a second (BLE drops commands if
spammed), so fast chases look steppier on them than on the Govee lights.
They keep running the app's effects while a Govee cloud scene plays.

## Govee scenes and DIYs

**Setup → Govee account**: paste the API key from the Govee app (Profile →
About Us → Apply for API Key). Govee's built-in scenes (Christmas-A, Sled,
...) and any DIYs you save from the app's Share Space then show up as looks,
work in auto-rotate, and the elves can pick them. They play through Govee's
cloud and run on the lights themselves; the app stops streaming while one is
on. Tap scenes in Setup to choose which show in Looks. New DIYs show up
within the hour, or tap Refresh. The key is kept in `secrets.json` (git
ignores it) and never sent to the browser.

## Ask the elves

The box at the top of the Lights tab takes plain English: "something cozy",
"red and green chase", "snowfall on 7 to 12", "slower", "on at 4:30, off at 11".
It runs on local Llama 3.1 8B through Ollama, so nothing leaves the house.
Most requests take 2-6 s on this CPU. "on", "off" and a look's exact name are
instant. The app starts Ollama itself if it isn't running.

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
| `POST /api/ask` `{text}` | plain-English command (local Llama) |
| `POST /api/music/enable` `{enabled}`, `POST /api/music` `{level, beat}` | music |

Settings live in `config.json`, which git ignores.
