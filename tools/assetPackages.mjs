#!/usr/bin/env node
// Native asset packages for the Windows and Android AssetStore.
//
// This is NOT the web asset pack written by `tools/package.mjs --assets`: that one is a plain
// `public/assets` tree the title screen imports through the browser. A native package is a ZIP with
// a signed-format manifest (`ASSETS.json`, `format=sp-assets-package-v1`), an inventory digest over
// `<path>\t<size>\t<sha256>\n`, and — for a base package — `STATE.json`. The Rust and Java clients
// parse exactly those fields, so the writer below follows them byte for byte instead of inventing a
// second format.
//
// Everything is deterministic for the same inputs and toolchain: entries are sorted, ZIP timestamps
// are fixed, no extra fields or data descriptors are written, and JSON is emitted with two-space
// indentation and a trailing newline. The output contains no credentials, no URLs and no signatures.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const PACKAGE_FORMAT = 'sp-assets-package-v1';
export const INDEX_FORMAT = 'sp-assets-index-v1';
export const STATE_FORMAT = 'sp-assets-state-v1';
export const KIND_BASE = 'base';
export const KIND_DELTA = 'delta';
export const PACKAGE_MANIFEST = 'ASSETS.json';
export const PACKAGE_STATE = 'STATE.json';
export const DEFAULT_OUT = '.native-assets/packages';
export const ASSET_DIRS = ['assets/', 'fonts/'];
export const ASSET_FILES = ['data/assets.json', 'data/local-assets.json'];
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 60_000;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const JUNK = [
  /(?:^|\/)\.DS_Store$/,
  /(?:^|\/)Thumbs\.db$/i,
  /(?:^|\/)desktop\.ini$/i,
  /(?:^|\/)\._[^/]*$/,
  /(?:^|\/)\.git(?:\/|$)/,
  /~$/,
  /\.(?:tmp|temp|bak|swp|swo|crdownload|part)$/i,
];

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sumBytes(files) {
  let total = 0;
  for (const entry of files.values()) total += entry.size;
  return total;
}

/** The path rules shared with `asset_path_problem()` (Rust) and `AssetPaths.problem()` (Java). */
export function assetPathProblem(rel) {
  if (rel === null || rel === undefined || rel === '') return 'empty path';
  if (rel.includes('\\')) return 'backslash in path';
  if (rel.startsWith('/')) return 'absolute path';
  if (rel.endsWith('/')) return 'trailing slash';
  if (/^[A-Za-z]:/.test(rel)) return 'drive-letter path';
  if (rel.includes('//')) return 'empty path segment';
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'unsafe path segment';
    // A `~<16 hex>` segment is the web server's hashed view of a file. Native packages must carry
    // the plain tree, otherwise Rust/Java would store a second, unreachable copy of every asset.
    if (/^~[0-9a-f]{16}$/.test(segment)) return 'hashed web path in native package';
  }
  if (/[\u0000-\u001f\u007f]/.test(rel)) return 'control character in path';
  if (/[^\u0020-\u007e]/.test(rel)) return 'non-ASCII path';
  if (/\s$/.test(rel)) return 'trailing whitespace in path';
  return null;
}

export function isAssetPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.startsWith('/') || rel.endsWith('/')) return false;
  if (ASSET_FILES.includes(rel)) return true;
  return ASSET_DIRS.some((dir) => rel.startsWith(dir) && rel.length > dir.length);
}

export function isJunkPath(rel) {
  return JUNK.some((pattern) => pattern.test(rel));
}

export function assertAssetPath(rel) {
  const problem = assetPathProblem(rel);
  if (problem) throw new Error(`unsafe asset path "${rel}": ${problem}`);
  if (!isAssetPath(rel)) throw new Error(`path outside the runtime asset set: ${rel}`);
  if (isJunkPath(rel)) throw new Error(`junk file is not a runtime asset: ${rel}`);
}

/** Canonical inventory digest: SHA-256 over sorted `path\tsize\tsha256\n` lines. */
export function inventoryDigest(files) {
  const lines = [...files.keys()]
    .sort()
    .map((path) => `${path}\t${files.get(path).size}\t${files.get(path).sha256}\n`)
    .join('');
  return sha256Hex(Buffer.from(lines, 'utf8'));
}

export function totalBytes(files) {
  return sumBytes(files);
}

function walk(root, prefix, files) {
  const dir = join(root, prefix);
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (prefix === '' && !['assets', 'fonts', 'data'].includes(name)) continue;
    if (prefix === 'data' && !ASSET_FILES.includes(`data/${name}`)) continue;
    const full = join(root, rel);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new Error(`symbolic links are not packaged: ${full}`);
    if (info.isDirectory()) {
      walk(root, rel, files);
      continue;
    }
    if (!info.isFile()) throw new Error(`unsupported file type: ${full}`);
    if (!isAssetPath(rel)) continue;
    if (isJunkPath(rel)) continue;
    assertAssetPath(rel);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${rel} is larger than ${MAX_FILE_BYTES} bytes`);
    const data = readFileSync(full);
    if (data.length !== info.size) throw new Error(`${rel} changed while it was read`);
    files.set(rel, { size: data.length, sha256: sha256Hex(data) });
  }
}

/** Collect the runtime asset set below `sourceRoot` (`assets/`, `fonts/`, `data/assets.json`, …). */
export function collectAssetFiles(sourceRoot) {
  const root = resolve(sourceRoot);
  if (!existsSync(root)) throw new Error(`asset source does not exist: ${root}`);
  if (!statSync(root).isDirectory()) throw new Error(`asset source is not a directory: ${root}`);
  const files = new Map();
  walk(root, '', files);
  if (!files.has('data/assets.json')) {
    throw new Error(`${root} has no data/assets.json; a native asset tree needs the served manifest`);
  }
  const seen = new Set();
  for (const rel of files.keys()) {
    const folded = rel.toLowerCase();
    if (seen.has(folded)) throw new Error(`paths collide on a case-insensitive file system: ${rel}`);
    seen.add(folded);
  }
  return files;
}

function shippedFrom(next, previous) {
  const shipped = new Map();
  for (const [path, entry] of next) {
    const old = previous?.get(path);
    if (!old || old.size !== entry.size || old.sha256 !== entry.sha256) shipped.set(path, entry);
  }
  return shipped;
}

function removedFrom(next, previous) {
  const removed = [];
  for (const [path, entry] of [...(previous ?? new Map()).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!next.has(path)) removed.push({ path, size: entry.size, sha256: entry.sha256 });
  }
  return removed;
}

export function baseManifest(version, files) {
  const shipped = new Map(files);
  return {
    format: PACKAGE_FORMAT,
    kind: KIND_BASE,
    version,
    inventory: inventoryDigest(files),
    count: files.size,
    bytes: totalBytes(files),
    shipped: { count: shipped.size, bytes: totalBytes(shipped) },
    files: manifestFiles(shipped),
    removed: [],
  };
}

export function deltaManifest(version, from, next, previous) {
  if (!previous) throw new Error('a delta package needs the previous asset tree');
  const shipped = shippedFrom(next, previous);
  return {
    format: PACKAGE_FORMAT,
    kind: KIND_DELTA,
    version,
    from,
    fromInventory: inventoryDigest(previous),
    inventory: inventoryDigest(next),
    count: next.size,
    bytes: totalBytes(next),
    shipped: { count: shipped.size, bytes: totalBytes(shipped) },
    files: manifestFiles(shipped),
    removed: removedFrom(next, previous),
  };
}

function manifestFiles(files) {
  const object = {};
  for (const path of [...files.keys()].sort()) {
    object[path] = { size: files.get(path).size, sha256: files.get(path).sha256 };
  }
  return object;
}

function stateFor(version, files) {
  return {
    format: STATE_FORMAT,
    version,
    count: files.size,
    bytes: totalBytes(files),
    digest: inventoryDigest(files),
    files: manifestFiles(files),
  };
}

/** Validate a manifest the way `AssetPackage.check()` and `apply_package()` do. */
export function validateManifest(manifest) {
  const problems = [];
  if (manifest?.format !== PACKAGE_FORMAT) problems.push(`format ${manifest?.format}`);
  if (manifest?.kind !== KIND_BASE && manifest?.kind !== KIND_DELTA) problems.push(`kind ${manifest?.kind}`);
  if (typeof manifest?.version !== 'string' || !VERSION.test(manifest.version)) problems.push('no usable version');
  if (!HEX64.test(String(manifest?.inventory))) problems.push('bad inventory digest');
  if (manifest?.kind === KIND_BASE) {
    if (manifest.from !== undefined || manifest.fromInventory !== undefined) problems.push('a base package has a source version');
  } else if (typeof manifest?.from !== 'string' || !VERSION.test(manifest.from)) {
    problems.push('a delta package has no source version');
  } else if (!HEX64.test(String(manifest.fromInventory))) {
    problems.push('a delta package has no source inventory');
  }
  const files = manifest?.files;
  const shippedPaths = new Set();
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    problems.push('no files map');
  } else {
    const paths = Object.keys(files);
    if (!Number.isInteger(manifest.count) || manifest.count < 0) problems.push('bad count');
    if (!Number.isInteger(manifest.bytes) || manifest.bytes < 0) problems.push('bad bytes');
    if (Number.isInteger(manifest.count) && manifest.count < paths.length) problems.push('the manifest ships more files than the target state holds');
    if (manifest.kind === KIND_BASE && Number.isInteger(manifest.count) && manifest.count !== paths.length) {
      problems.push('a base package must ship every file of its state');
    }
    if (!Number.isInteger(manifest.shipped?.count) || !Number.isInteger(manifest.shipped?.bytes)) {
      problems.push('bad shipped totals');
    } else if (manifest.shipped.count !== paths.length) {
      problems.push('shipped count does not match the files map');
    }
    let bytes = 0;
    for (const [path, entry] of Object.entries(files)) {
      shippedPaths.add(path);
      try {
        assertAssetPath(path);
      } catch (error) {
        problems.push(error.message);
      }
      if (!entry || !Number.isInteger(entry.size) || entry.size < 0) problems.push(`bad size for ${path}`);
      else bytes += entry.size;
      if (!entry || !HEX64.test(String(entry.sha256))) problems.push(`bad sha256 for ${path}`);
    }
    if (Number.isInteger(manifest.shipped?.bytes) && manifest.shipped.bytes !== bytes) {
      problems.push('shipped bytes do not match the files map');
    }
    if (manifest.kind === KIND_BASE && Number.isInteger(manifest.bytes) && manifest.bytes !== bytes) {
      problems.push('base bytes do not match the files map');
    }
  }
  const removed = manifest?.removed ?? [];
  if (!Array.isArray(removed)) {
    problems.push('bad removed list');
  } else {
    for (const tombstone of removed) {
      if (shippedPaths.has(tombstone?.path)) problems.push(`a package cannot both ship and remove ${tombstone.path}`);
      try {
        assertAssetPath(tombstone?.path);
      } catch (error) {
        problems.push(error.message);
      }
      if (!Number.isInteger(tombstone?.size) || tombstone.size < 0) problems.push(`bad removed size for ${tombstone?.path}`);
      if (!HEX64.test(String(tombstone?.sha256))) problems.push(`bad removed sha256 for ${tombstone?.path}`);
    }
  }
  if (problems.length > 0) throw new Error(`invalid package manifest:\n- ${problems.join('\n- ')}`);
  return manifest;
}

// --- deterministic ZIP -------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(data) {
  let value = -1;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000;

class ZipWriter {
  constructor(file) {
    this.fd = openSync(file, 'w');
    this.offset = 0;
    this.entries = [];
  }

  write(buffer) {
    writeSync(this.fd, buffer, 0, buffer.length);
    this.offset += buffer.length;
  }

  add(name, data, { compress = true } = {}) {
    if (this.entries.length >= MAX_ZIP_ENTRIES) {
      throw new Error(`a native asset package may hold at most ${MAX_ZIP_ENTRIES} entries`);
    }
    const nameBytes = Buffer.from(name, 'utf8');
    if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`zip entry name is not printable ASCII: ${name}`);
    let method = 0;
    let payload = data;
    if (compress && data.length >= 256) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names; no data descriptor
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const localOffset = this.offset;
    this.write(header);
    this.write(nameBytes);
    this.write(payload);
    this.entries.push({ nameBytes, method, crc, compressed: payload.length, size: data.length, localOffset });
  }

  close() {
    const centralOffset = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x031e, 4); // made by: Unix, zip 3.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(DOS_TIME, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      this.write(header);
      this.write(entry.nameBytes);
    }
    const centralSize = this.offset - centralOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    this.write(eocd);
    closeSync(this.fd);
  }
}

function sha256File(file) {
  const digest = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

export function packageName(kind, version, from) {
  return kind === KIND_BASE ? `assets-base-${version}.zip` : `assets-delta-${from}-${version}.zip`;
}

/**
 * Write a package atomically: the ZIP is built under a temporary name, hashed, then renamed over the
 * destination. Returns the index entry for the package.
 */
export function writePackage(outDir, manifest, payload, { dryRun = false } = {}) {
  validateManifest(manifest);
  const name = manifest.kind === KIND_BASE
    ? packageName(KIND_BASE, manifest.version)
    : packageName(KIND_DELTA, manifest.version, manifest.from);
  const target = join(outDir, name);
  if (dryRun) {
    return { name, size: null, sha256: null, dryRun: true };
  }
  mkdirSync(outDir, { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    const writer = new ZipWriter(temp);
    writer.add(PACKAGE_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), { compress: false });
    if (manifest.kind === KIND_BASE) {
      writer.add(PACKAGE_STATE, Buffer.from(`${JSON.stringify(stateFor(manifest.version, payload), null, 2)}\n`, 'utf8'), { compress: false });
    }
    for (const path of [...payload.keys()].sort()) writer.add(path, readFileSync(join(payload.root, path)));
    writer.close();
    const size = statSync(temp).size;
    if (size > MAX_ZIP_BYTES) throw new Error(`native asset package is larger than ${MAX_ZIP_BYTES} bytes`);
    const sha256 = sha256File(temp);
    if (existsSync(target)) rmSync(target);
    renameSync(temp, target);
    return { name, size: statSync(target).size, sha256 };
  } catch (error) {
    if (existsSync(temp)) rmSync(temp);
    throw error;
  }
}

function withRoot(files, root) {
  const map = new Map(files);
  Object.defineProperty(map, 'root', { value: root, enumerable: false });
  return map;
}

// --- index -------------------------------------------------------------------------------------

export function emptyIndex() {
  return { format: INDEX_FORMAT, latest: '', versions: {}, bases: [], deltas: [] };
}

export function compareVersions(left, right) {
  const a = String(left).split('.');
  const b = String(right).split('.');
  if (a.every((part) => /^\d+$/.test(part)) && b.every((part) => /^\d+$/.test(part))) {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = Number(a[index] ?? 0) - Number(b[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

export function validateIndex(index) {
  const problems = [];
  if (index?.format !== INDEX_FORMAT) problems.push(`format ${index?.format}`);
  if (typeof index?.latest !== 'string' || index.latest === '') problems.push('no latest version');
  if (!index?.versions || typeof index.versions !== 'object' || Array.isArray(index.versions)) problems.push('no versions map');
  else {
    for (const [version, info] of Object.entries(index.versions)) {
      if (!VERSION.test(version)) problems.push(`bad version ${version}`);
      if (!HEX64.test(String(info?.inventory))) problems.push(`bad inventory for ${version}`);
      if (info?.count !== undefined && (!Number.isInteger(info.count) || info.count < 0)) problems.push(`bad count for ${version}`);
      if (info?.bytes !== undefined && (!Number.isInteger(info.bytes) || info.bytes < 0)) problems.push(`bad bytes for ${version}`);
    }
  }
  for (const [field, list] of [['bases', index?.bases], ['deltas', index?.deltas]]) {
    if (!Array.isArray(list)) {
      problems.push(`no ${field} array`);
      continue;
    }
    for (const item of list) {
      const to = item?.to;
      if (typeof to !== 'string' || !VERSION.test(to)) problems.push(`${field} entry has no usable target version`);
      const expected = field === 'bases' ? `assets-base-${to}.zip` : `assets-delta-${item?.from}-${to}.zip`;
      if (item?.name !== expected) problems.push(`${field} package ${item?.name} must be ${expected}`);
      if (!Number.isInteger(item?.size) || item.size < 0) problems.push(`${field} package ${item?.name} has no size`);
      if (!HEX64.test(String(item?.sha256))) problems.push(`${field} package ${item?.name} has no sha256 digest`);
      if (field === 'bases' && item?.version !== undefined && item.version !== to) {
        problems.push(`bases package ${item?.name} has version ${item.version} but targets ${to}`);
      }
      if (field === 'deltas' && (typeof item?.from !== 'string' || !VERSION.test(item.from))) {
        problems.push(`deltas package ${item?.name} has no source version`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`invalid asset index:\n- ${problems.join('\n- ')}`);
  return index;
}

/** Record a package in the index. Rebuilding a version replaces its packages, never duplicates them. */
export function updateIndex(index, { manifest, packageInfo, latest = false, fromInfo = null }) {
  const next = {
    format: INDEX_FORMAT,
    latest: index.latest || '',
    versions: { ...index.versions },
    bases: [...index.bases],
    deltas: [...index.deltas],
  };
  if (fromInfo && !next.versions[fromInfo.version]) {
    next.versions[fromInfo.version] = {
      inventory: fromInfo.inventory,
      count: fromInfo.count,
      bytes: fromInfo.bytes,
    };
  }
  next.versions[manifest.version] = {
    inventory: manifest.inventory,
    count: manifest.count,
    bytes: manifest.bytes,
  };
  // Replace only the same package identity: rebuilding a base must not delete a delta that serves
  // the same target (fresh installs need the base, existing installs can use the delta), and deltas
  // from different source versions are distinct routes to the same target.
  if (manifest.kind === KIND_BASE) {
    next.bases = next.bases.filter((item) => item.to !== manifest.version);
  } else {
    next.deltas = next.deltas.filter((item) => !(item.to === manifest.version && item.from === manifest.from));
  }
  if (manifest.kind === KIND_BASE) {
    next.bases.push({
      version: manifest.version,
      to: manifest.version,
      name: packageInfo.name,
      size: packageInfo.size,
      sha256: packageInfo.sha256,
    });
  } else {
    next.deltas.push({
      from: manifest.from,
      to: manifest.version,
      name: packageInfo.name,
      size: packageInfo.size,
      sha256: packageInfo.sha256,
    });
  }
  if (latest || next.latest === '' || compareVersions(manifest.version, next.latest) >= 0) next.latest = manifest.version;
  const versions = {};
  for (const version of Object.keys(next.versions).sort(compareVersions)) versions[version] = next.versions[version];
  next.versions = versions;
  next.bases.sort((a, b) => compareVersions(a.to, b.to) || (a.name < b.name ? -1 : 1));
  next.deltas.sort((a, b) => compareVersions(a.to, b.to) || compareVersions(a.from, b.from) || (a.name < b.name ? -1 : 1));
  return validateIndex(next);
}

export function readIndex(file) {
  if (!existsSync(file)) return emptyIndex();
  return validateIndex(JSON.parse(readFileSync(file, 'utf8')));
}

export function writeIndex(file, index) {
  validateIndex(index);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  if (existsSync(file)) rmSync(file);
  renameSync(temp, file);
}

// --- ZIP verification --------------------------------------------------------------------------

function u16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function u32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

export function readZipEntries(file) {
  if (statSync(file).size > MAX_ZIP_BYTES) throw new Error(`${file} is larger than ${MAX_ZIP_BYTES} bytes`);
  const data = readFileSync(file);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset -= 1) {
    if (u32(data, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a ZIP archive`);
  if (u16(data, eocd + 4) !== 0 || u16(data, eocd + 6) !== 0) throw new Error('multi-disk ZIP archives are not supported');
  const count = u16(data, eocd + 10);
  const centralSize = u32(data, eocd + 12);
  const centralOffset = u32(data, eocd + 16);
  if (centralOffset + centralSize > data.length) throw new Error('truncated ZIP central directory');
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (u32(data, cursor) !== 0x02014b50) throw new Error('bad ZIP central directory entry');
    const flags = u16(data, cursor + 8);
    const method = u16(data, cursor + 10);
    const crc = u32(data, cursor + 16);
    const compressed = u32(data, cursor + 20);
    const size = u32(data, cursor + 24);
    const nameLength = u16(data, cursor + 28);
    const extraLength = u16(data, cursor + 30);
    const commentLength = u16(data, cursor + 32);
    const localOffset = u32(data, cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (entries.has(name)) throw new Error(`duplicate ZIP entry: ${name}`);
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe ZIP entry: ${name}`);
    if (name.endsWith('/')) throw new Error(`directory entries are not supported: ${name}`);
    if (flags & 0x0001) throw new Error(`encrypted ZIP entry: ${name}`);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new Error('ZIP64 entries are not supported');
    if (u32(data, localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localName = u16(data, localOffset + 26);
    const localExtra = u16(data, localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = data.subarray(start, start + compressed);
    if (raw.length !== compressed) throw new Error(`truncated ZIP entry: ${name}`);
    let content;
    if (method === 0) content = raw;
    else if (method === 8) {
      try {
        content = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`ZIP entry ${name} expands beyond its declared size`);
        throw error;
      }
    } else throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    if (content.length !== size) throw new Error(`ZIP entry ${name} is ${content.length} bytes, expected ${size}`);
    if (crc32(content) !== crc) throw new Error(`ZIP entry ${name} has a bad CRC`);
    entries.set(name, content);
  }
  return entries;
}

/** Verify a package against the manifest rules and the files it actually carries. */
export function verifyPackage(file) {
  const entries = readZipEntries(file);
  const manifestBytes = entries.get(PACKAGE_MANIFEST);
  if (!manifestBytes) throw new Error(`${file} has no ${PACKAGE_MANIFEST}`);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
  const allowed = new Set([PACKAGE_MANIFEST]);
  if (manifest.kind === KIND_BASE) allowed.add(PACKAGE_STATE);
  for (const [path, entry] of Object.entries(manifest.files)) {
    allowed.add(path);
    const content = entries.get(path);
    if (!content) throw new Error(`package is missing ${path}`);
    if (content.length !== entry.size) throw new Error(`${path} is ${content.length} bytes, the manifest declares ${entry.size}`);
    if (sha256Hex(content) !== entry.sha256) throw new Error(`${path} does not match its sha256`);
  }
  for (const name of entries.keys()) {
    if (!allowed.has(name)) throw new Error(`package carries an entry the manifest does not list: ${name}`);
  }
  if (manifest.kind === KIND_BASE) {
    const stateBytes = entries.get(PACKAGE_STATE);
    if (!stateBytes) throw new Error(`a base package must ship ${PACKAGE_STATE}`);
    const state = JSON.parse(stateBytes.toString('utf8'));
    if (state?.format !== STATE_FORMAT) throw new Error(`${PACKAGE_STATE} has format ${state?.format}`);
    if (state?.version !== manifest.version) throw new Error(`${PACKAGE_STATE} has version ${state?.version}`);
    const files = new Map(Object.entries(state.files ?? {}).map(([path, entry]) => [path, { size: entry.size, sha256: entry.sha256 }]));
    if (inventoryDigest(files) !== manifest.inventory) throw new Error(`${PACKAGE_STATE} does not match the manifest inventory`);
  }
  return {
    name: file,
    kind: manifest.kind,
    version: manifest.version,
    from: manifest.from ?? null,
    inventory: manifest.inventory,
    count: manifest.count,
    bytes: manifest.bytes,
    shipped: manifest.shipped,
  };
}

// --- CLI ---------------------------------------------------------------------------------------

function usage() {
  return `原生 AssetStore 素材包生成器（Rust/Java 共用契约）

用法：
  node tools/assetPackages.mjs --source <素材树> [--out <目录>] [--version <版本>]
  node tools/assetPackages.mjs --source <素材树> --previous <旧素材树> --from <旧版本> --version <新版本>
  node tools/assetPackages.mjs --verify <包.zip>
  node tools/assetPackages.mjs --verify-index <assets-index.json>

选项：
  --source <目录>     含 assets/、fonts/、data/assets.json 的素材树（必填）
  --previous <目录>   生成 delta 时的旧素材树
  --from <版本>       delta 的源版本（与 --previous 一起使用）
  --version <版本>    目标版本，默认取 package.json 的 version
  --out <目录>        输出目录，默认 ${DEFAULT_OUT}（worktree 内，已忽略）
  --index <文件>      索引文件，默认 <out>/assets-index.json
  --latest            强制把 --version 设为索引 latest
  --dry-run           只计算并打印计划，不写文件
  --verify <zip>      校验一个已有原生包
  --verify-index <f>  校验一个已有索引
  --help              显示本帮助

安全边界：
  - 只打包 assets/**、fonts/**、data/assets.json、data/local-assets.json。
  - 包内写 ASSETS.json；base 另写 STATE.json；不写端点、密钥或签名。
  - 拒绝符号链接、非 ASCII 路径、父目录段、盘符、junk 文件。
  - 拒绝输出到 enhanced-client-servers；不生成正式发布目录。
  - 同一输入与 Node/zlib 版本产生逐字节一致的结果。`;
}

export function parseArgs(argv) {
  const options = { latest: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case '--source': options.source = take(); break;
      case '--previous': options.previous = take(); break;
      case '--from': options.from = take(); break;
      case '--version': options.version = take(); break;
      case '--out': options.out = take(); break;
      case '--index': options.index = take(); break;
      case '--latest': options.latest = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--verify': options.verify = take(); break;
      case '--verify-index': options.verifyIndex = take(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function assertVersion(value, label) {
  if (!VERSION.test(String(value))) throw new Error(`${label} is not a usable version: ${value}`);
  return String(value);
}

function assertOutDir(out, source) {
  const resolved = resolve(out);
  const segments = resolved.split(sep).map((segment) => segment.toLowerCase());
  // Release folders are operated by the release process, not by this generator.
  if (segments.some((segment) => segment === 'enhanced-client-servers' || segment === '成果文件')) {
    throw new Error(`refusing to write native packages into a release folder: ${resolved}`);
  }
  if (resolved.toLowerCase() === ROOT.toLowerCase()) {
    throw new Error(`refusing to write native packages into the repository root: ${resolved}`);
  }
  const fromSource = relative(resolve(source), resolved);
  if (fromSource === '' || (!fromSource.startsWith('..') && !isAbsolute(fromSource))) {
    throw new Error(`the output directory must not be inside the asset source: ${resolved}`);
  }
  return resolved;
}

function readPackageVersion() {
  const file = join(ROOT, 'package.json');
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

export function build(options) {
  if (!options.source) throw new Error('--source is required');
  const source = resolve(options.source);
  const out = assertOutDir(options.out ?? join(ROOT, DEFAULT_OUT), source);
  const version = assertVersion(options.version ?? readPackageVersion(), 'version');
  const next = collectAssetFiles(source);
  let manifest;
  let payload;
  let fromInfo = null;
  if (options.previous) {
    if (!options.from) throw new Error('--previous also needs --from');
    const from = assertVersion(options.from, 'from');
    const previous = collectAssetFiles(options.previous);
    manifest = deltaManifest(version, from, next, previous);
    payload = withRoot(shippedFrom(next, previous), source);
    fromInfo = {
      version: from,
      inventory: inventoryDigest(previous),
      count: previous.size,
      bytes: totalBytes(previous),
    };
  } else {
    if (options.from) throw new Error('--from is only valid together with --previous');
    manifest = baseManifest(version, next);
    payload = withRoot(next, source);
  }
  validateManifest(manifest);
  const packageInfo = writePackage(out, manifest, payload, { dryRun: options.dryRun });
  const indexFile = resolve(options.index ?? join(out, 'assets-index.json'));
  const index = readIndex(indexFile);
  const nextIndex = updateIndex(index, {
    manifest,
    packageInfo: { ...packageInfo, size: packageInfo.size ?? 0, sha256: packageInfo.sha256 ?? '0'.repeat(64) },
    latest: options.latest,
    fromInfo,
  });
  if (!options.dryRun) writeIndex(indexFile, nextIndex);
  return { out, indexFile, packageInfo, manifest, index: nextIndex, dryRun: options.dryRun };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.verify) {
    const summary = verifyPackage(options.verify);
    console.log(`verified ${summary.kind} ${summary.version} (${summary.count} files, ${summary.bytes} bytes)`);
    return 0;
  }
  if (options.verifyIndex) {
    const file = resolve(options.verifyIndex);
    if (!existsSync(file)) throw new Error(`index does not exist: ${file}`);
    const index = readIndex(file);
    console.log(`verified index ${index.latest} (${Object.keys(index.versions).length} versions, ${index.bases.length} bases, ${index.deltas.length} deltas)`);
    return 0;
  }
  if (!options.source) {
    console.log(usage());
    return 1;
  }
  const result = build(options);
  console.log(`${result.dryRun ? 'would write' : 'wrote'} ${result.packageInfo.name}`);
  console.log(`  kind      ${result.manifest.kind}`);
  console.log(`  version   ${result.manifest.version}${result.manifest.from ? ` (from ${result.manifest.from})` : ''}`);
  console.log(`  inventory ${result.manifest.inventory}`);
  console.log(`  state     ${result.manifest.count} files, ${result.manifest.bytes} bytes`);
  console.log(`  shipped   ${result.manifest.shipped.count} files, ${result.manifest.shipped.bytes} bytes`);
  if (result.manifest.removed.length > 0) console.log(`  removed   ${result.manifest.removed.length} files`);
  console.log(`  index     ${result.indexFile} (latest ${result.index.latest})`);
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`asset packages: ${error.message}`);
    process.exitCode = 1;
  }
}
