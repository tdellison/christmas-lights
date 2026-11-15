// ─── Sunset (and sunrise) for a place and day, NOAA's formulas ───────────────
//
// sunset(date, lat, lon) -> Date (UTC instant) or null near the poles.
// Accurate to about a minute, which is plenty for "lights on at dusk".

'use strict';

const rad = Math.PI / 180;

function sunTime(date, lat, lon, rising) {
  // Day of year at local noon-ish.
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const n = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 864e5);
  const lngHour = lon / 15;
  const t = n + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
  const zenith = 90.833;   // official sunrise/sunset
  const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  let H = rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
  H /= 15;
  const T = H + RA - 0.06571 * t - 6.622;
  let UT = ((T - lngHour) % 24 + 24) % 24;
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return new Date(d.getTime() + UT * 3600e3);
}

const sunset = (date, lat, lon) => sunTime(date, lat, lon, false);
const sunrise = (date, lat, lon) => sunTime(date, lat, lon, true);

// Sunset today in a time zone, as minutes after local midnight.
function sunsetMinutes(lat, lon, tz, now = new Date()) {
  // "Today" in the zone, at local noon, so the UTC date is right.
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value]));
  const noon = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, 19));
  const s = sunset(noon, lat, lon);
  if (!s) return null;
  const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(s).map(x => [x.type, x.value]));
  return +q.hour * 60 + +q.minute;
}

module.exports = { sunset, sunrise, sunsetMinutes };
