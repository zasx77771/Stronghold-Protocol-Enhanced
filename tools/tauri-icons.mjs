#!/usr/bin/env node

/**
 * Generate the small set of application icons `src-tauri/tauri.conf.json` points at.
 *
 * The Windows client ships through `cargo tauri build`, and both the executable and the NSIS
 * installer need a real `.ico`; Tauri refuses to bundle without the files listed under
 * `bundle.icon`. The repository does not keep binary blobs for a build input that is fully
 * deterministic, so this script derives the icons from a colour palette and a geometry instead, and
 * `scripts/build-windows-client.ps1` runs it before `cargo tauri build` whenever they are missing.
 *
 * It writes PNG (RGBA, zlib deflate via `node:zlib`) and a Windows ICO that carries the same pixels
 * as a 32-bit BGRA bitmap. Only `node:` built-ins are used, so it runs before any `npm ci`.
 *
 *   node tools/tauri-icons.mjs --write            # generate next to src-tauri/tauri.conf.json
 *   node tools/tauri-icons.mjs --write --out DIR
 *   node tools/tauri-icons.mjs --check            # exit 1 when a listed icon is missing or empty
 *
 * The output is intentionally plain: a dark rounded plate in the client's background colour with a
 * brighter diamond mark, which reads at 32 px and stays legible in the taskbar. Replace
 * `ICON_SPEC` with the project's real artwork when it is available; nothing else has to change.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(PROJECT_ROOT, 'src-tauri', 'icons');

/** Colours are `[r, g, b, a]`; the plate matches `tauri.conf.json` `backgroundColor`. */
export const ICON_SPEC = Object.freeze({
  background: [12, 15, 14, 255],
  plate: [21, 26, 24, 255],
  mark: [214, 179, 106, 255],
  markInner: [246, 226, 176, 255],
});

/** `bundle.icon` in `src-tauri/tauri.conf.json`; keep the two lists in step. */
export const ICON_FILES = Object.freeze(['32x32.png', '128x128.png', 'icon.ico']);

/** Sizes each PNG is generated at, plus the size carried inside the ICO. */
export const PNG_SIZES = Object.freeze([32, 128]);

/** ICO entries, largest last so Windows picks by its own preference order. */
export const ICO_SIZES = Object.freeze([16, 32, 48, 64, 256]);

function roundRectCoverage(x, y, size, inset, radius) {
  // Signed distance from the rounded-rectangle edge, in pixels; negative is inside.
  const half = size / 2 - inset;
  const dx = Math.abs(x - size / 2 + 0.5) - (half - radius);
  const dy = Math.abs(y - size / 2 + 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return Math.min(Math.max(dx, dy), 0) + outside - radius;
}

function diamondCoverage(x, y, size, scale) {
  // Rotated square: the L1 distance to the centre, normalised so 0 is the edge.
  const dx = Math.abs(x - size / 2 + 0.5) / (size / 2);
  const dy = Math.abs(y - size / 2 + 0.5) / (size / 2);
  return (dx + dy) / scale - 1;
}

function mix(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha),
    Math.max(base[3], over[3]),
  ];
}

function coverageAlpha(distance, feather) {
  if (distance <= -feather) return 1;
  if (distance >= feather) return 0;
  return (feather - distance) / (2 * feather);
}

/**
 * Render one square icon as RGBA bytes.
 *
 * @param {number} size edge length in pixels
 * @param {typeof ICON_SPEC} [spec]
 * @returns {Buffer} `size * size * 4` bytes, row-major, top-left origin
 */
export function renderIcon(size, spec = ICON_SPEC) {
  if (!Number.isInteger(size) || size < 8 || size > 1024) {
    throw new RangeError(`icon size out of range: ${size}`);
  }
  const buffer = Buffer.alloc(size * size * 4);
  const feather = Math.max(0.5, size / 64);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let pixel = spec.background;
      pixel = mix(pixel, spec.plate, coverageAlpha(roundRectCoverage(x, y, size, size * 0.06, size * 0.22), feather));
      pixel = mix(pixel, spec.mark, coverageAlpha(diamondCoverage(x, y, size, 0.82), feather));
      pixel = mix(pixel, spec.markInner, coverageAlpha(diamondCoverage(x, y, size, 0.34), feather));
      const offset = (y * size + x) * 4;
      buffer[offset] = pixel[0];
      buffer[offset + 1] = pixel[1];
      buffer[offset + 2] = pixel[2];
      buffer[offset + 3] = pixel[3];
    }
  }
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * Encode RGBA bytes as a PNG.
 *
 * @param {Buffer} rgba `size * size * 4` bytes
 * @param {number} size edge length
 * @returns {Buffer}
 */
export function encodePng(rgba, size) {
  if (rgba.length !== size * size * 4) {
    throw new RangeError(`expected ${size * size * 4} RGBA bytes, received ${rgba.length}`);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function bmpEntry(rgba, size) {
  // ICO stores a bottom-up 32-bit BGRA bitmap with an all-zero AND mask; alpha does the work.
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const source = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const from = source + x * 4;
      const to = (y * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height counts the image plus the mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

/**
 * Encode several RGBA renders as one Windows ICO file.
 *
 * Entries up to 128 px are stored as 32-bit BGRA bitmaps (the classic form every shell version
 * reads). The 256 px entry is embedded as PNG, which is what Windows itself writes from Vista on and
 * keeps the file a few kilobytes instead of a few hundred.
 *
 * @param {{ size: number, rgba: Buffer }[]} images sizes are 16…256
 * @returns {Buffer}
 */
export function encodeIco(images) {
  if (!images.length) throw new RangeError('an ICO needs at least one image');
  const entries = images.map(({ size, rgba }) => ({
    size,
    data: size >= 256 ? encodePng(rgba, size) : bmpEntry(rgba, size),
  }));
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size; // 0 means 256
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

/**
 * The exact bytes written for `name`. Exported so a test can assert the container headers without
 * generating the files.
 *
 * @param {string} name one of `ICON_FILES`
 * @returns {Buffer}
 */
export function iconBytes(name) {
  if (name.endsWith('.ico')) {
    return encodeIco(ICO_SIZES.map((size) => ({ size, rgba: renderIcon(size) })));
  }
  const match = /^(\d+)x(\d+)\.png$/.exec(name);
  if (!match) throw new RangeError(`unsupported icon name: ${name}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width !== height) throw new RangeError(`icons must be square: ${name}`);
  return encodePng(renderIcon(width), width);
}

/**
 * Write every icon into `outDir`.
 *
 * @param {string} [outDir]
 * @returns {{ name: string, path: string, bytes: number }[]}
 */
export function writeIcons(outDir = DEFAULT_OUT) {
  fs.mkdirSync(outDir, { recursive: true });
  return ICON_FILES.map((name) => {
    const target = path.join(outDir, name);
    const body = iconBytes(name);
    fs.writeFileSync(target, body);
    return { name, path: target, bytes: body.length };
  });
}

/**
 * Report the icons listed in `tauri.conf.json` that are missing or empty.
 *
 * @param {string} [outDir]
 * @returns {string[]}
 */
export function missingIcons(outDir = DEFAULT_OUT) {
  return ICON_FILES.filter((name) => {
    try {
      return fs.statSync(path.join(outDir, name)).size === 0;
    } catch {
      return true;
    }
  });
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 && argv[outIndex + 1] ? path.resolve(argv[outIndex + 1]) : DEFAULT_OUT;
  if (argv.includes('--check')) {
    const missing = missingIcons(outDir);
    if (missing.length) {
      console.error(`Missing client icons in ${outDir}:\n${missing.map((name) => `  - ${name}`).join('\n')}`);
      console.error('Run: node tools/tauri-icons.mjs --write');
      return 1;
    }
    console.log(`Client icons ready: ${outDir}`);
    return 0;
  }
  if (!argv.includes('--write')) {
    console.error('Usage: node tools/tauri-icons.mjs --write [--out DIR] | --check [--out DIR]');
    return 2;
  }
  for (const written of writeIcons(outDir)) {
    console.log(`wrote ${path.relative(PROJECT_ROOT, written.path)} (${written.bytes} bytes)`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
