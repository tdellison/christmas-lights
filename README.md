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

## Install as an app

The page installs to a home screen with its own icon and name.

- **Android tablet (Chrome)**: Chrome only installs full-screen apps from
  https, so the app also runs on `https://192.168.1.118:3101` with its own
  local certificate. Once per tablet:
  1. Open `http://192.168.1.118:3100/ca.crt` to download the certificate.
  2. Settings → search **"certificate"** → **Install a certificate** →
     **CA certificate** → Install anyway → pick `christmas-lights-ca.crt`.
  3. Open `https://192.168.1.118:3101` in Chrome → menu (⋮) → **Save and
     share** → **Install app** (newer Chrome tucks it in there).
  (Without the certificate, menu → Add to Home screen on the http address
  still gives an icon; it just opens with the address bar.)
- **iPhone / iPad (Safari)**: Share → **Add to Home Screen**. Opens full
  screen.

## Spot brightness

Lights tab → tick a light → **Spot brightness** (or tell the elves "always
keep the sidewalk trees a bit dimmer"). It caps that light for where it
stands, in every show: our looks, saved and designed shows, the Director's
picks. Shows never save or change it. During a Govee scene the app can only
set a spotlight pair's overall brightness, so the pair uses the average of
its two lights' spot settings.

## Zones

The yard is split into **Front Left** and **Front Right** (Setup: pick each
pair's zone). The Backyard zone was dropped (the T-Rex Santa lights it); the
Bluetooth pair is in Front Left. `POST /api/zones-add {id, name}` brings a
zone back, `POST /api/zones/<id>/remove {to}` removes one. **Front yard** means both front zones
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
4. Flash: plug the ESP32 into the server, run `sudo bash deploy/setup-esp32.sh`
   (Wi-Fi + USB access), then `esphome run deploy/esp32-brmesh.yaml`. ESPHome
   lives in `~/.local/share/esphome-venv`. If the fast upload fails ("stub
   flasher"), flash at 115200 with esptool (this board needed it).
   Flashed 2026-11-14: brmesh-bridge, fixed at 192.168.1.50 (set in the YAML,
   below the router's DHCP range).
5. App: **Setup → + Add Bluetooth pair**, type the ESP32's IP, Save, Test.

Bluetooth lights update about 3-4 times a second (BLE drops commands if
spammed), so fast chases look steppier on them than on the Govee lights.
They keep running the app's effects while a Govee cloud scene plays.

## C9 strings on relays

Plain C9 and string lights are switched by an ESP32 with a solid-state relay
board (8 channels or more). Each channel is one group of strings: plug as
many strands into it as the channel's rating allows (common SSR boards: 2 A,
about 200 W; LED C9 strands draw roughly 0.1-0.2 A each).

1. Fill in `deploy/secrets.yaml`, then with the ESP32 on USB:
   `esphome run deploy/esp32-relays.yaml`. Wiring notes are at the top of it.
2. App: **Setup → + Add C9 relay board**, type the ESP32's IP, pick its zone,
   Save, Test. Each channel shows up as a light (C9 1, C9 2, ...).
3. Lights tab: pick a channel and set its **C9 string colour** so the
   preview looks like the real strings.

Strings can only be on or off, so effects become on/off patterns: Chase and
Alternate step across the channels, Twinkle/Sparkle/Snowfall pop strings on,
Breathe and Fade blink slowly, and Music Pulse flashes on the beat.

## Smart plug (Tuya: Enbrighten, Smart Life)

A Wi-Fi plug switches whatever is plugged into it (e.g. all the C9s) **on and
off only**: with the show, its zone's switch, the schedule and the elves. It
never blinks for effects: its relay clicks and wears out, so it switches at
most every 4 s and only for real on/off changes. Smart lights plugged into it
lose power whenever it's off, so keep smart lights on an always-on outlet.

One-time setup (gets the plug's device ID and local key):
1. Move the plug from the Enbrighten app to the **Smart Life** app.
2. Free account at **iot.tuya.com** → Cloud → create a project (data centre:
   Western America) → Devices → Link App Account → scan the QR with Smart Life.
3. Run `python3 -m tinytuya wizard` with the project's Access ID / Secret; it
   lists each plug's **id**, **key**, IP and protocol version.
4. App: **Setup → + Add smart plug**, fill in IP, Device ID, Local key and
   version, pick its zone, Save, Test.

The key stays on the server (config.json) and is never sent to the app's page.

**Blinking**: the plug can blink everything on it together, at most every 10 s,
within a nightly budget of ~600 clicks (about three seasons of plug life).
Qwen decides when: the Director chooses blink or steady with each show it
picks, its designs can include it, and the elves will do it on request
("make the C9s blink slowly"). Once tonight's clicks are used, the C9s stay
steady until tomorrow.

**More plugs** (e.g. a laser projector): add each as its own smart plug and
fill in **What it powers** ("laser projector: red & green dots on the house").
For every show it picks, the Director judges whether each plug fits the
show's colours: the projector goes off for blue/white shows and on for
red/green ones; plain strings stay on (blinking only when he chooses, paced
to last the night). The elves switch them by name ("turn off the laser
dots").

## Govee scenes and DIYs

**Setup → Govee account**: paste the API key from the Govee app (Profile →
About Us → Apply for API Key). Govee's built-in scenes (Christmas-A, Sled,
...) and any DIYs you save from the app's Share Space then show up as looks,
work in auto-rotate, and the elves can pick them. They play through Govee's
cloud and run on the lights themselves; the app stops streaming while one is
on. Every scene and DIY is on the Looks tab, grouped (Your Govee DIYs,
Govee Christmas & winter, More Govee scenes) with a search box. New DIYs show up
within the hour, or tap Refresh. The key is kept in `secrets.json` (git
ignores it) and never sent to the browser.

## Watch & rate, and the Director

**Looks → Watch & rate** plays every show in turn (choose minutes each and
which shows; it uses the selected zone). For the one playing: **👍 / 👎**,
tags (cozy, energetic, kids, late night, front-only, back-only) and a note.
Back / +1 min / Next / Stop. Auto-rotate pauses while watching. Everything
goes into the show catalog (`catalog.json`), and look cards show their score
and tags.

While a Govee show plays, Watch mode also **records its colours and pace**
(it asks a spotlight its colour ~4×/s; the spotlight must be online), so one
pass rates and catalogues. The colours of everything you 👍 become the **"Your
Favourites" palette**, which Qwen designs and directs with ("design something
in the style of my favourites") and you can pick in the light editor.

**Looks → Director**: Qwen picks what plays out front and out back every N
minutes from that catalog, the time of night and what he played lately, and
says why. Your hard rules are enforced in code: never a 👎 show,
front-only/back-only respected, no recent repeats, Govee shows only where
the app knows the Govee lights (Scan → Use). If he can't be reached, a
weighted pick from your ratings covers that turn. It replaces auto-rotate.

The elves get the catalog too ("something the kids like", "which shows are
cozy?").

## Ask the elves

The **Elves** tab is a chat that runs on local Qwen 3 8B (nothing leaves
the house). The box on the Lights tab sends to it too.

- **Commands**: "candy cane out front, warm twinkle out back", "slower",
  "turn off the backyard", "on at 4:30, off at 11". Follow-ups work ("more
  red", "now do that out back").
- **Find shows**: "what snow shows do I have?" lists matches to tap and play.
  Show names play instantly ("Sleigh Ride", "play santa sleigh").
- **Design**: "surprise me" or "design an icy blue show called Jack Frost".
  The elves build it as a saved look while the current show keeps playing,
  then offer **Play** and **Delete it**. Tweaks right after ("more white",
  "make the backyard sparkle") change the design, not the yard. Designs take
  ~10-60 s; commands a few seconds.

### Training the elves

Elves tab → **Training**. The elves now work on a **sandbox copy** of the
yard (shown above the chat); nothing reaches the real lights.

- **👍** on a good answer saves it as an example they copy from then on.
- **👎** asks what it should have done, redoes it, and a 👍 on the redo saves
  the corrected version.
- **House notes**: "remember the backyard is the deck" (or the Add box).
- **Keep it** copies a design made in training into the real Looks.
- **Run test**: 14 everyday requests, each checked; shows the score so you
  can see whether teaching helped.

What they're taught is in `training.json` and is used by the live elves too.

**Govee show sniffer** (experiment): `node tools/sniff-govee.js 192.168.1.209 --all`
plays each Govee show and samples the spotlight's colour 4×/s to record its
flavor (main colours, how fast it changes) in `data/sniff/`. If it reports
STUCK, the light doesn't reveal show colours and this can't work.

## Effects

Solid, Breathe, Colour Fade, Wave, Chase, Candy Cane, Alternate, Twinkle,
Snowfall, Sparkle, Hearth Glow, Rainbow, Music Pulse, Runner (a flash
shoots across the whole yard; the Grinch Run look is red/white with a green
flash).

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
