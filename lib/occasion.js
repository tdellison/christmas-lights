// ─── What tonight is: special nights and the weather ─────────────────────────
//
// For the Director (and the app): Christmas Eve, Christmas Day, New Year's Eve
// and the last days before Christmas, plus whether it's snowing right now.
// Weather comes from Open-Meteo (free, no key) for the yard's location, every
// 15 minutes; only the location's rough coordinates are sent.

'use strict';

const SNOW = new Set([71, 73, 75, 77, 85, 86]);

function specialNight(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric', day: 'numeric' }).formatToParts(now).map(x => [x.type, x.value]));
  const m = +p.month, d = +p.day;
  if (m === 12 && d === 24) return { name: 'Christmas Eve', note: 'the biggest night: go all out, favourite and most festive shows' };
  if (m === 12 && d === 25) return { name: 'Christmas Day', note: 'joyful, classic Christmas shows all evening' };
  if (m === 12 && d === 31) return { name: "New Year's Eve", note: 'party and sparkle, energetic shows, fireworks-style late' };
  if (m === 12 && d >= 18 && d <= 23) return { name: `${25 - d} days to Christmas`, note: 'build up the excitement' };
  return null;
}

function createOccasion({ engine, log = console.log, onChange = () => {} }) {
  let weather = null;   // { snowing, code, tempC, at }

  async function refresh() {
    const { lat, lon } = engine.status().location || {};
    if (lat == null || lon == null) return;
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,temperature_2m,snowfall`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      const c = j.current || {};
      const snowing = SNOW.has(c.weather_code) || (c.snowfall || 0) > 0;
      if (!weather || weather.snowing !== snowing) log(`Weather: ${snowing ? 'snowing' : 'not snowing'} (${c.temperature_2m}°C)`);
      weather = { snowing, code: c.weather_code, tempC: c.temperature_2m, at: Date.now() };
      onChange();
    } catch (e) { setTimeout(refresh, 60000); }   // network blip: try again in a minute, keep the last reading
  }
  refresh();
  setInterval(refresh, 15 * 60000);

  return {
    refresh,
    now() {
      const tz = engine.status().schedule.tz;
      return { special: specialNight(tz), weather };
    },
    // One line for prompts, or ''.
    line() {
      const { special, weather: w } = this.now();
      const bits = [];
      if (special) bits.push(`Tonight is ${special.name}: ${special.note}.`);
      if (w && w.snowing) bits.push(`It is snowing right now: lean towards snowy, frosty, wintry shows.`);
      return bits.join(' ');
    },
  };
}

module.exports = { createOccasion, specialNight };
