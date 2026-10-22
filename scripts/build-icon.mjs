#!/usr/bin/env node
// Renders the Omnidex app icon. Mirrors the in-app brandmark: a thin
// accent ring (the "orbit") with a small filled satellite dot, sitting
// on the dark surface tile. Outputs build/icon.ico (multi-res Windows
// container, PNG-encoded frames) and build/icon.png (256, used as the
// macOS/linux source).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '../build');
mkdirSync(buildDir, { recursive: true });

// Brand tokens (sRGB approximations of the OKLCH ramp in
// renderer-react/src/styles/global.css).
//   surface-950 ≈ oklch(0.12 0.012 250)  — near-black blue-gray
//   accent-500  ≈ oklch(0.66 0.20 55)    — warm amber
const SURFACE = '#0F1419';
const ACCENT = '#E89A2C';
const ACCENT_DIM = '#7B5118';

// 256-unit viewBox; sharp rasterizes to whatever density we ask for.
const SVG = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.18"/>
      <stop offset="70%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="256" height="256" rx="48" ry="48" fill="${SURFACE}"/>
  <rect width="256" height="256" rx="48" ry="48" fill="url(#glow)"/>
  <circle cx="128" cy="128" r="64" fill="none" stroke="${ACCENT_DIM}" stroke-width="14" opacity="0.55"/>
  <circle cx="128" cy="128" r="64" fill="none" stroke="${ACCENT}" stroke-width="10"
          stroke-dasharray="170 230" stroke-linecap="round" transform="rotate(-30 128 128)"/>
  <circle cx="184" cy="84" r="18" fill="${ACCENT}"/>
  <circle cx="184" cy="84" r="6" fill="${SURFACE}"/>
</svg>`;

const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function renderPng(size) {
  return await sharp(Buffer.from(SVG)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

// Inline ICO writer. Container holds N PNG blobs; ICONDIRENTRY uses
// width/height byte 0 to mean 256 (per the ICO spec).
function buildIco(frames) {
  const HEADER = 6;
  const ENTRY = 16;
  const headerBuf = Buffer.alloc(HEADER + ENTRY * frames.length);
  headerBuf.writeUInt16LE(0, 0); // reserved
  headerBuf.writeUInt16LE(1, 2); // 1 = icon
  headerBuf.writeUInt16LE(frames.length, 4);

  let offset = HEADER + ENTRY * frames.length;
  const blobs = [];
  for (let i = 0; i < frames.length; i++) {
    const { size, png } = frames[i];
    const dim = size === 256 ? 0 : size;
    const base = HEADER + i * ENTRY;
    headerBuf.writeUInt8(dim, base + 0); // width
    headerBuf.writeUInt8(dim, base + 1); // height
    headerBuf.writeUInt8(0, base + 2); // palette colors
    headerBuf.writeUInt8(0, base + 3); // reserved
    headerBuf.writeUInt16LE(1, base + 4); // color planes
    headerBuf.writeUInt16LE(32, base + 6); // bits per pixel
    headerBuf.writeUInt32LE(png.length, base + 8); // bytes
    headerBuf.writeUInt32LE(offset, base + 12); // file offset
    offset += png.length;
    blobs.push(png);
  }
  return Buffer.concat([headerBuf, ...blobs]);
}

const frames = await Promise.all(SIZES.map(async (size) => ({ size, png: await renderPng(size) })));

const ico = buildIco(frames);
writeFileSync(resolve(buildDir, 'icon.ico'), ico);
console.log(`wrote build/icon.ico (${ico.length.toLocaleString()} bytes, ${SIZES.length} frames)`);

// Also drop a 256 PNG so electron-builder has a Linux/macOS source.
writeFileSync(resolve(buildDir, 'icon.png'), frames[frames.length - 1].png);
console.log(
  `wrote build/icon.png (${frames[frames.length - 1].png.length.toLocaleString()} bytes)`,
);

// macOS .icns container. Apple's ICNS is `icns` magic + total length, then a
// run of typed chunks (OSType + chunk length incl. 8-byte header + PNG data).
// The modern OSTypes below are all PNG-encoded, so Finder/Dock and
// electron-builder read them without a separate iconset. Retina types reuse
// the same-pixel-size frame (e.g. ic11 = 16@2x = 32px).
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

async function buildIcns() {
  const cache = new Map(frames.map((f) => [f.size, f.png]));
  const pngFor = async (size) => {
    if (!cache.has(size)) cache.set(size, await renderPng(size));
    return cache.get(size);
  };
  const chunks = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = await pngFor(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }
  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(8 + body.length);
  out.write('icns', 0, 'ascii');
  out.writeUInt32BE(8 + body.length, 4);
  body.copy(out, 8);
  return out;
}

const icns = await buildIcns();
writeFileSync(resolve(buildDir, 'icon.icns'), icns);
console.log(`wrote build/icon.icns (${icns.length.toLocaleString()} bytes, ${ICNS_TYPES.length} frames)`);

// Save a preview so a human can sanity-check the design.
writeFileSync(resolve(buildDir, 'icon.svg'), SVG);
console.log('wrote build/icon.svg');
