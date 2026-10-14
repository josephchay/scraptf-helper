// Generates the app and tray icons as PNGs with no dependencies: shapes are
// rasterised with supersampling and encoded by hand (zlib + CRC32).
//   assets/icon.png      256x256  window, installer and notification icon
//   assets/tray.png       32x32   tray icon (Windows scales it to the tray size)
//   assets/tray@2x.png    64x64   tray icon for 200% displays
// Usage: node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'assets');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** rgba: Uint8Array of size*size*4, straight (non-premultiplied) alpha. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing (unit square coordinates, y down)
// ---------------------------------------------------------------------------

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const BG_TOP = hex('#262B36');
const BG_BOTTOM = hex('#13161C');
const ORANGE_LIGHT = hex('#E07B43');
const ORANGE = hex('#CF6A32');
const ORANGE_RIM = hex('#A4511F');
const CUTOUT = hex('#171A21');

function roundedRectSdf(x, y, inset, radius) {
  const half = 0.5 - inset;
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function inTriangle(px, py, a, b, c) {
  // Sign of (p - p3) x (p2 - p3) for each edge; inside when all signs agree.
  const side = (p2, p3) => (px - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (py - p3[1]);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Colour of the topmost shape at (x, y), or null for transparent.
 * Rounded dark square, orange coin with a darker rim, dark upward arrow.
 */
function sample(x, y, d) {
  if (roundedRectSdf(x, y, d.inset, d.corner) > 0) return null;
  let colour = mix(BG_TOP, BG_BOTTOM, y);

  const cx = 0.5;
  const cy = 0.5;
  const r = Math.hypot(x - cx, y - cy);
  if (r <= d.coin) {
    // Light from the top-left.
    const t = Math.min(1, Math.max(0, ((x - cx) + (y - cy)) / (2 * d.coin) + 0.5));
    colour = r >= d.coin - d.rim ? ORANGE_RIM : mix(ORANGE_LIGHT, ORANGE, t);

    const s = d.coin / 0.34; // arrow geometry is drawn for a 0.34 coin
    const ax = (v) => cx + (v - 0.5) * s;
    const ay = (v) => cy + (v - 0.5) * s;
    const head = [
      [ax(0.5), ay(0.255)],
      [ax(0.315), ay(0.485)],
      [ax(0.685), ay(0.485)],
    ];
    const inShaft = x >= ax(0.435) && x <= ax(0.565) && y >= ay(0.47) && y <= ay(0.735);
    if (inShaft || inTriangle(x, y, head[0], head[1], head[2])) colour = CUTOUT;
  }
  return colour;
}

function render(size, design) {
  const ss = size <= 64 ? 8 : 4;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, design);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return out;
}

// Tray sizes use less padding so the coin stays legible at 16 px.
const APP_DESIGN = { inset: 0.04, corner: 0.22, coin: 0.34, rim: 0.03 };
const TRAY_DESIGN = { inset: 0, corner: 0.2, coin: 0.4, rim: 0.045 };

const targets = [
  { file: 'icon.png', size: 256, design: APP_DESIGN },
  { file: 'tray.png', size: 32, design: TRAY_DESIGN },
  { file: 'tray@2x.png', size: 64, design: TRAY_DESIGN },
];

mkdirSync(outDir, { recursive: true });
for (const t of targets) {
  const png = encodePng(t.size, render(t.size, t.design));
  writeFileSync(path.join(outDir, t.file), png);
  console.log(`wrote assets/${t.file} (${t.size}x${t.size}, ${png.length} bytes)`);
}
