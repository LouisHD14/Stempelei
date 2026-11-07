// Erzeugt die PNG-Bilder für Apple und Google Wallet aus dem Stern der Marke.
// Aufruf: node tools/wallet-images.mjs   (schreibt nach public/assets/wallet/)
// Ohne Bildbibliothek: Kreis und Stern werden mit 4×4 Unterabtastung gerastert, PNG mit zlib geschrieben.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/assets/wallet');
const INK = [0x17, 0x2e, 0x5b]; // --ink-tinte
const STAR_COLOR = [0xfd, 0xfb, 0xf8]; // --color-cotton
// Stern aus dem Logo der Website, Koordinaten im 48er-Raster
const STAR = [
  [24, 11],
  [28, 19.2],
  [37, 20.4],
  [30.5, 26.7],
  [32.1, 35.7],
  [24, 31.4],
  [15.9, 35.7],
  [17.5, 26.7],
  [11, 20.4],
  [20, 19.2],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** shape: 'circle' (Apple, runder Hintergrund) oder 'square' (Google schneidet selbst rund zu) */
function render(size, shape) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let star = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // Punkt im 48er-Raster
          const gx = ((x + (sx + 0.5) / S) / size) * 48;
          const gy = ((y + (sy + 0.5) / S) / size) * 48;
          const inBg = shape === 'square' || (gx - 24) ** 2 + (gy - 24) ** 2 <= 23 ** 2;
          if (!inBg) continue;
          bg++;
          if (inPolygon(gx, gy, STAR)) star++;
        }
      }
      const n = S * S;
      const a = bg / n;
      const t = bg ? star / bg : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(INK[c] * (1 - t) + STAR_COLOR[c] * t);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, px);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // Bit pro Kanal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const files = {
  'icon.png': render(29, 'circle'),
  'icon@2x.png': render(58, 'circle'),
  'icon@3x.png': render(87, 'circle'),
  'logo.png': render(50, 'circle'),
  'logo@2x.png': render(100, 'circle'),
  'logo@3x.png': render(150, 'circle'),
  // Google verlangt ein quadratisches Logo, mindestens 660 px
  'logo-google.png': render(660, 'square'),
};
for (const [name, data] of Object.entries(files)) writeFileSync(join(OUT, name), data);
console.log(`${Object.keys(files).length} Bilder in ${OUT}`);
