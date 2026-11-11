// Generates tauri-setup/icons/icon.ico (+ png previews) with no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'icons');
fs.mkdirSync(OUT, { recursive: true });

function render(size) {
  const SS = 4;                       // supersample
  const W = size * SS;
  const px = new Float32Array(W * W * 4);   // premultiplied-ish rgba in 0..1
  const c = W / 2;
  const R = W * 0.44;                 // main disc radius
  const inner = W * 0.185;            // white core
  const rayIn = W * 0.255, rayOut = W * 0.395, rayHalf = W * 0.022;

  const rgbTop = [255, 196, 75];      // #FFC24B
  const rgbBot = [255, 128, 45];      // #FF8030

  function put(x, y, r, g, b, a) {
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - c + 0.5, dy = y - c + 0.5;
      const d = Math.hypot(dx, dy);
      const t = Math.min(1, Math.max(0, (dx * 0.5 + dy * 0.85) / (W * 0.9) + 0.5));
      const r = (rgbTop[0] + (rgbBot[0] - rgbTop[0]) * t) / 255;
      const g = (rgbTop[1] + (rgbBot[1] - rgbTop[1]) * t) / 255;
      const b = (rgbTop[2] + (rgbBot[2] - rgbTop[2]) * t) / 255;

      if (d <= R) put(x, y, r, g, b, 1);
      // 8 white rays, then the white core
      const seg = Math.PI / 4;
      const ang = Math.atan2(dy, dx);
      const delta = Math.abs(ang - Math.round(ang / seg) * seg);
      if (d >= rayIn && d <= rayOut && d * Math.sin(delta) <= rayHalf) put(x, y, 1, 1, 1, 1);
      if (d <= inner) put(x, y, 1, 1, 1, 1);
    }
  }

  // downsample
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = px[i + 3];
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (a > 0) { buf[o] = Math.round((r / a) * 255); buf[o + 1] = Math.round((g / a) * 255); buf[o + 2] = Math.round((b / a) * 255); }
      buf[o + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

/* ---------- PNG encoder ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- ICO container (PNG entries are valid since Vista) ---------- */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  const blobs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dir.push(d); blobs.push(e.data);
  }
  return Buffer.concat([head, ...dir, ...blobs]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map((s) => ({ size: s, data: png(render(s), s) }));
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(entries));
for (const s of [32, 128, 256]) {
  fs.writeFileSync(path.join(OUT, s + 'x' + s + '.png'), png(render(s), s));
}
fs.writeFileSync(path.join(OUT, '128x128@2x.png'), png(render(256), 256));
console.log('icons ->', OUT);
