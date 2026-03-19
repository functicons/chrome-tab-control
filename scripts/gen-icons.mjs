#!/usr/bin/env node
// Generate PNG icons for the Tab Control Chrome extension.
// Design: blue rounded-rect background with a white robot face.
// No dependencies — uses raw PNG encoding with Node.js zlib.

import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = resolve(__dirname, '../extension/icons');

// Colors
const BG = [26, 115, 232, 255];    // #1a73e8 blue
const WHITE = [255, 255, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];
const DARK_BLUE = [13, 71, 161, 255]; // #0d47a1 darker blue for depth
const LIGHT = [200, 220, 255, 255];   // light accent

function createImage(size) {
  const pixels = new Uint8Array(size * size * 4);
  return {
    size,
    pixels,
    set(x, y, [r, g, b, a]) {
      if (x < 0 || x >= size || y < 0 || y >= size) return;
      const i = (y * size + x) * 4;
      pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
    },
    get(x, y) {
      if (x < 0 || x >= size || y < 0 || y >= size) return TRANSPARENT;
      const i = (y * size + x) * 4;
      return [pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]];
    },
  };
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1-x2)**2 + (y1-y2)**2);
}

function blend(c1, c2, t) {
  return c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
}

function fillRoundedRect(img, x1, y1, x2, y2, r, color) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      // Check corners
      const corners = [
        [x1 + r, y1 + r], [x2 - r, y1 + r],
        [x1 + r, y2 - r], [x2 - r, y2 - r],
      ];
      let inside = true;
      if (x < x1 + r && y < y1 + r) inside = dist(x, y, corners[0][0], corners[0][1]) <= r;
      else if (x > x2 - r && y < y1 + r) inside = dist(x, y, corners[1][0], corners[1][1]) <= r;
      else if (x < x1 + r && y > y2 - r) inside = dist(x, y, corners[2][0], corners[2][1]) <= r;
      else if (x > x2 - r && y > y2 - r) inside = dist(x, y, corners[3][0], corners[3][1]) <= r;
      if (inside) img.set(x, y, color);
    }
  }
}

function fillRect(img, x1, y1, x2, y2, color) {
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++)
      img.set(x, y, color);
}

function fillCircle(img, cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if (dist(x, y, cx, cy) <= r) img.set(x, y, color);
}

function drawIcon(size) {
  const img = createImage(size);
  const s = size;
  // Background: rounded rect
  const radius = Math.round(s * 0.22);
  fillRoundedRect(img, 0, 0, s - 1, s - 1, radius, BG);

  // Subtle gradient: darker at bottom
  for (let y = 0; y < s; y++) {
    const t = y / s * 0.25;
    for (let x = 0; x < s; x++) {
      const c = img.get(x, y);
      if (c[3] > 0) img.set(x, y, blend(BG, DARK_BLUE, t));
    }
  }

  // Robot head: white rounded rect
  const headL = Math.round(s * 0.22);
  const headR = Math.round(s * 0.78);
  const headT = Math.round(s * 0.30);
  const headB = Math.round(s * 0.75);
  const headRadius = Math.round(s * 0.10);
  fillRoundedRect(img, headL, headT, headR, headB, headRadius, WHITE);

  // Antenna: vertical line + circle
  const antX = Math.round(s * 0.5);
  const antTop = Math.round(s * 0.14);
  const antBot = headT;
  const antW = Math.max(1, Math.round(s * 0.03));
  fillRect(img, antX - antW, antTop + Math.round(s * 0.06), antX + antW, antBot, WHITE);
  fillCircle(img, antX, antTop + Math.round(s * 0.04), Math.round(s * 0.05), WHITE);

  // Eyes: two blue circles
  const eyeY = Math.round(s * 0.46);
  const eyeLX = Math.round(s * 0.36);
  const eyeRX = Math.round(s * 0.64);
  const eyeR = Math.round(s * 0.07);
  fillCircle(img, eyeLX, eyeY, eyeR, BG);
  fillCircle(img, eyeRX, eyeY, eyeR, BG);

  // Eye highlights
  const hlR = Math.max(1, Math.round(eyeR * 0.35));
  fillCircle(img, eyeLX - Math.round(eyeR * 0.25), eyeY - Math.round(eyeR * 0.25), hlR, LIGHT);
  fillCircle(img, eyeRX - Math.round(eyeR * 0.25), eyeY - Math.round(eyeR * 0.25), hlR, LIGHT);

  // Mouth: blue rounded rect
  const mouthL = Math.round(s * 0.34);
  const mouthR = Math.round(s * 0.66);
  const mouthT = Math.round(s * 0.58);
  const mouthB = Math.round(s * 0.65);
  const mouthRadius = Math.round(s * 0.03);
  fillRoundedRect(img, mouthL, mouthT, mouthR, mouthB, mouthRadius, BG);

  // Ears: small rects on sides
  const earW = Math.round(s * 0.05);
  const earH = Math.round(s * 0.12);
  const earT = Math.round(s * 0.44);
  fillRoundedRect(img, headL - earW - Math.round(s * 0.02), earT, headL - Math.round(s * 0.02), earT + earH, Math.round(s * 0.02), WHITE);
  fillRoundedRect(img, headR + Math.round(s * 0.02), earT, headR + earW + Math.round(s * 0.02), earT + earH, Math.round(s * 0.02), WHITE);

  return img;
}

// PNG encoder
function toPNG(img) {
  const { size, pixels } = img;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const buf = Buffer.alloc(4 + type.length + data.length + 4);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4);
    data.copy(buf, 4 + type.length);
    // CRC32
    const crcData = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xFFFFFFFF;
    for (const byte of crcData) {
      crc ^= byte;
      for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    buf.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, buf.length - 4);
    return buf;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data with filter bytes
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // no filter
    for (let x = 0; x < size * 4; x++) {
      raw[rowOffset + 1 + x] = pixels[y * size * 4 + x];
    }
  }

  const compressed = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Generate all sizes
mkdirSync(ICON_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const img = drawIcon(size);
  const png = toPNG(img);
  const path = resolve(ICON_DIR, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`Generated ${path} (${png.length} bytes)`);
}
