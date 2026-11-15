// FastCon (BRMesh) advert encoder, ported from esphome-fastcon; matched the
// BRMesh app's own adverts byte for byte (2026-11-03). For checking what the
// ESP32 bridge broadcasts: node tools/fastcon.js <hex advert> [key hex]
'use strict';
const ENC = [0x5e, 0x36, 0x7b, 0xc4], ADDR = [0xc1, 0xc2, 0xc3];
const rev8 = (d) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((d >> i) & 1) << (7 - i); return r; };
const rev16 = (d) => { let r = 0; for (let i = 0; i < 16; i++) r |= ((d >> i) & 1) << (15 - i); return r; };
function crc16(addr, data) {
  let crc = 0xffff;
  const step = (b) => { crc ^= (b << 8) & 0xffff; for (let j = 0; j < 4; j++) { let t = (crc << 1) & 0xffff; if (crc & 0x8000) t ^= 0x1021; crc = (t << 1) & 0xffff; if (t & 0x8000) crc ^= 0x1021; } };
  for (const b of [...addr].reverse()) step(b);
  for (const b of data) step(rev8(b));
  return (~rev16(crc)) & 0xffff;
}
function whiten(buf, val) {
  const c = { a0: 1, a4: (val >> 5) & 1, a8: (val >> 4) & 1, ac: (val >> 3) & 1, a10: (val >> 2) & 1, a14: (val >> 1) & 1, a18: val & 1 };
  for (let i = 0; i < buf.length; i++) {
    const vC = c.ac, v14 = c.a14, v18 = c.a18, v10 = c.a10, v8 = v14 ^ c.a8, v4 = v10 ^ c.a4, _v = v18 ^ vC, v0 = _v ^ c.a0, b = buf[i];
    buf[i] = ((b & 0x80) ^ ((v8 ^ v18) << 7)) + ((b & 0x40) ^ (v0 << 6)) + ((b & 0x20) ^ (v4 << 5)) + ((b & 0x10) ^ (v8 << 4)) + ((b & 0x08) ^ (_v << 3)) + ((b & 0x04) ^ (v10 << 2)) + ((b & 0x02) ^ (v14 << 1)) + ((b & 0x01) ^ (v18 << 0));
    c.a8 = v4; c.ac = v8; c.a10 = v8 ^ vC; c.a14 = v0 ^ v10; c.a18 = v4 ^ v14; c.a0 = v8 ^ v18; c.a4 = v0;
  }
}
function rfPayload(addr, data) {
  const off = 0x12, inv = 0x0f, size = off + addr.length + data.length, r = new Array(size + 2).fill(0);
  r[0x0f] = 0x71; r[0x10] = 0x0f; r[0x11] = 0x55;
  addr.forEach((b, i) => { r[off + addr.length - i - 1] = b; });
  data.forEach((b, i) => { r[off + addr.length + i] = b; });
  for (let i = inv; i < inv + addr.length + 3; i++) r[i] = rev8(r[i]);
  const crc = crc16(addr, data); r[size] = crc & 0xff; r[size + 1] = crc >> 8;
  whiten(r, 0x25);
  return r.slice(0x0f);
}
function command(key, lightId, lightData, seq) {
  const inner = new Array(12).fill(0);
  inner[0] = 2 | ((lightData.length + 1) << 4); inner[1] = lightId; lightData.forEach((b, i) => { inner[2 + i] = b; });
  const body = [((lightId >> 8) & 0xf) | (5 << 4) | 0x80, seq & 0xff, key[3], 0, ...inner];
  body[3] = body.reduce((s, b, i) => (i === 3 ? s : (s + b) & 0xff), 0);
  for (let i = 0; i < 4; i++) body[i] ^= ENC[i];
  for (let i = 0; i < inner.length; i++) body[4 + i] ^= key[i & 3];
  return { body, adv: rfPayload(ADDR, body) };
}
module.exports = { command };

// CLI: node tools/fastcon.js <light id> <light data hex> <seq> [key hex]
// prints the 31-byte legacy advert (flags + manufacturer 0xfff0 + payload) as
// space-separated hex, ready for `hcitool cmd 0x08 0x0008 1f ...`.
if (require.main === module) {
  const [id, data, seq, key = '39383832'] = process.argv.slice(2);
  const bytes = (h) => h.match(/../g).map(x => parseInt(x, 16));
  const p = command(bytes(key), Number(id), bytes(data), Number(seq)).adv;
  const adv = [0x02, 0x01, 0x06, p.length + 3, 0xff, 0xf0, 0xff, ...p];
  while (adv.length < 31) adv.push(0);
  console.log(adv.map(b => b.toString(16).padStart(2, '0')).join(' '));
}
