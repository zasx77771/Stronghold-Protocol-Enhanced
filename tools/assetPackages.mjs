/**
 * Runtime asset packages for Cloudflare R2.
 *
 * The Android client no longer needs a new APK for art updates. The release pipeline publishes
 *   - `assets-base-<version>.zip`  : the complete asset state of one version
 *   - `assets-delta-<from>-<to>.zip`: only the added / changed / removed files between two versions
 *   - `assets-index.json`          : the small release index the app reads first
 * and the app applies one route (a base package, or a bounded chain of delta packages) with an
 * atomic, verifiable switch. Nothing here talks to the network: these helpers only build, read and
 * verify packages, and provide a reference applier that mirrors the Android implementation.
 *
 * See `docs/ASSETS.md` ("运行时素材包") for the format, the path rules and the safety contract, and
 * `scripts/CLIENT-UPDATES.md` for the release workflow. `tools/assets-r2.mjs` is the CLI.
 *
 * Layout produced by this module (used by the Android store and the reference applier):
 *
 *   <asset root>/
 *     asset-state.json                    // floor state, generated at build time into the APK assets
 *     asset-config.json                   // optional public config (index URL), never an asset
 *     asset-store.json                    // active pointer: {version, floor, layers[]}
 *     asset-layers/0001-delta-<from>-<to>/ // applied packages, newest generation wins
 *     asset-staging/                      // download + extraction scratch (removed on failure)
 *     asset-retired/                       // files removed by the last update (one update of grace)
 *
 * The mutable directories only exist after the first successful update. A build tree (or an APK)
 * only needs `asset-state.json`; the app falls back to the APK copy for every path that no layer
 * provides.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PACKAGE_FORMAT = 'sp-assets-package-v1';
export const STATE_FORMAT = 'sp-assets-state-v1';
export const STORE_FORMAT = 'sp-assets-store-v1';
export const INDEX_FORMAT = 'sp-assets-index-v1';
export const CONFIG_FORMAT = 'sp-assets-config-v1';

export const STATE_FILE = 'asset-state.json';
export const STORE_FILE = 'asset-store.json';
export const CONFIG_FILE = 'asset-config.json';
export const LAYER_DIR = 'asset-layers';
export const STAGING_DIR = 'asset-staging';
export const RETIRED_DIR = 'asset-retired';
export const PACKAGE_MANIFEST = 'ASSETS.json';
export const PACKAGE_STATE = 'STATE.json';
export const INDEX_FILE = 'assets-index.json';

export const KIND_BASE = 'base';
export const KIND_DELTA = 'delta';
export const DEFAULT_MAX_CHAIN = 3;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 1536 * 1024 * 1024;
export const DEFAULT_MAX_EXTRACT_BYTES = 4096 * 1024 * 1024;
export const DEFAULT_MAX_INDEX_BYTES = 1024 * 1024;

/** Asset roots served from the store instead of the APK. Program files stay in the APK. */
export const ASSET_DIRS = ['assets/', 'fonts/'];
export const ASSET_FILES = ['data/assets.json', 'data/local-assets.json'];

/** Names that are never published, matching the packaging rules for the repository. */
const JUNK = [
  /(?:^|\/)\.DS_Store$/, /(?:^|\/)Thumbs\.db$/i, /(?:^|\/)desktop\.ini$/i, /(?:^|\/)\._[^/]*$/,
  /(?:^|\/)\.git(?:\/|$)/, /~$/, /\.(?:tmp|temp|bak|swp|swo|crdownload|part)$/i
];

export const posix = (rel) => String(rel).split('\\').join('/');

export const basePackageName = (version) => `assets-base-${version}.zip`;
export const deltaPackageName = (from, to) => `assets-delta-${from}-${to}.zip`;

/** Version of a package file name, or null when the name is not an asset package. */
export function packageNameInfo(name) {
  const base = /^assets-base-(.+)\.zip$/.exec(name);
  if (base) return { kind: KIND_BASE, version: base[1], from: null };
  const delta = /^assets-delta-(.+)-(.+)\.zip$/.exec(name);
  if (delta) return { kind: KIND_DELTA, from: delta[1], version: delta[2] };
  return null;
}

/** True for a path that belongs to the runtime asset set. */
export function isAssetPath(rel) {
  const p = posix(rel);
  if (!p || p.startsWith('/') || p.endsWith('/')) return false;
  if (ASSET_FILES.includes(p)) return true;
  return ASSET_DIRS.some((dir) => p.startsWith(dir) && p.length > dir.length);
}

/** True for files that must never appear in a package. */
export function isJunkAsset(rel) {
  const p = posix(rel);
  return JUNK.some((re) => re.test(p));
}

/**
 * Package path rules, shared with the Android extractor. Returns null when the path is safe, or a
 * short reason string. Absolute paths, traversal, empty segments, backslashes, control characters
 * and non-printable-ASCII names are rejected so the Node and Java inventory digests agree.
 */
export function assetPathProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  const p = rel;
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('/')) return 'absolute path';
  if (p.endsWith('/')) return 'trailing slash';
  if (/^[A-Za-z]:/.test(p)) return 'drive-letter path';
  if (p.includes('//')) return 'empty path segment';
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'unsafe path segment';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'control character in path';
  if (/[^\u0020-\u007e]/.test(p)) return 'non-ASCII path';
  if (/\s$/.test(p)) return 'trailing whitespace in path';
  return null;
}

export function assertAssetPath(rel) {
  const problem = assetPathProblem(rel);
  if (problem) throw new Error(`unsafe asset path ${JSON.stringify(rel)}: ${problem}`);
  return rel;
}

/** Resolve `rel` under `root`, refusing anything that leaves it. */
export function safeJoin(root, rel) {
  assertAssetPath(rel);
  const resolved = path.resolve(root, ...rel.split('/'));
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`asset path escapes the tree: ${rel}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let read;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Canonical inventory digest. Both Node and the Android client hash
 * `<path>\t<size>\t<sha256>\n` for every path in ascending ASCII order, so the digest travels in
 * the index and in every package manifest as a cheap, exact consistency check.
 */
export function inventoryLines(files) {
  const keys = files instanceof Map ? [...files.keys()] : Object.keys(files);
  keys.sort();
  let text = '';
  for (const key of keys) {
    const entry = files instanceof Map ? files.get(key) : files[key];
    text += `${key}\t${Number(entry.size)}\t${String(entry.sha256).toLowerCase()}\n`;
  }
  return text;
}

export function inventoryDigest(files) {
  return sha256Hex(inventoryLines(files));
}

export function inventoryStats(files) {
  const keys = files instanceof Map ? [...files.keys()] : Object.keys(files);
  let bytes = 0;
  for (const key of keys) bytes += Number((files instanceof Map ? files.get(key) : files[key]).size);
  return { count: keys.length, bytes };
}

// ---------------------------------------------------------------------------
// Inventories
// ---------------------------------------------------------------------------

function walk(root, rel, out) {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  for (const name of readdirSync(dir).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(root, child, out);
    } else if (info.isFile()) {
      if (!isAssetPath(child)) continue;
      if (isJunkAsset(child)) continue;
      out[child] = { size: info.size, sha256: sha256File(full) };
    }
  }
  return out;
}

/**
 * Hash every asset file under `root` (a directory holding `assets/`, `fonts/`, `data/assets.json`).
 * Pass `subtree` to hash a single asset root such as `assets` — the paths are still relative to
 * `root`, so several subtrees can be merged into one inventory.
 */
export function scanAssetFiles(root, { subtree = null } = {}) {
  const files = {};
  if (subtree) {
    const full = path.join(root, ...subtree.split('/'));
    if (!existsSync(full)) return files;
    walk(root, subtree, files);
  } else {
    walk(root, '', files);
  }
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return sorted;
}

export function readState(file) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (state.format !== STATE_FORMAT) throw new Error(`unsupported state format: ${state.format}`);
  if (!state.files || typeof state.files !== 'object') throw new Error('state has no files map');
  return state;
}

export function stateFromInventory(version, files, { floor = 'apk' } = {}) {
  const sorted = {};
  for (const key of Object.keys(files).sort()) {
    const entry = files[key];
    sorted[key] = { size: Number(entry.size), sha256: String(entry.sha256).toLowerCase() };
  }
  const stats = inventoryStats(sorted);
  return {
    format: STATE_FORMAT,
    version,
    floor,
    count: stats.count,
    bytes: stats.bytes,
    inventory: inventoryDigest(sorted),
    files: sorted
  };
}

export function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state)}\n`);
  return file;
}

/** Stamp `<root>/asset-state.json` from the asset files currently in `root`. */
export function stampRoot(root, version, { out = path.join(root, STATE_FILE) } = {}) {
  const state = stateFromInventory(version, scanAssetFiles(root));
  writeState(out, state);
  return state;
}

/** Load the floor state of a build tree / APK assets directory, or null when it has none. */
export function loadRootState(root) {
  const file = path.join(root, STATE_FILE);
  if (!existsSync(file)) return null;
  return readState(file);
}

// ---------------------------------------------------------------------------
// Diffs and package manifests
// ---------------------------------------------------------------------------

/** Files added or changed between two inventories, and files removed. */
export function diffInventories(before, after) {
  const changed = [];
  const removed = [];
  for (const [rel, entry] of Object.entries(after)) {
    const old = before[rel];
    if (!old || Number(old.size) !== Number(entry.size) || String(old.sha256).toLowerCase() !== String(entry.sha256).toLowerCase()) {
      changed.push(rel);
    }
  }
  for (const rel of Object.keys(before)) {
    if (!after[rel]) removed.push(rel);
  }
  changed.sort();
  removed.sort();
  return { changed, removed };
}

/**
 * Build a package manifest. `files` maps the shipped paths to `{size, sha256}` and `removed` lists
 * the tombstones with their previous content. `inventory` is always the digest of the full target
 * state, so a client can prove that the package landed on exactly the published state.
 */
export function buildManifest({
  kind, version, from = null, fromInventory = null, inventory, files, removed = []
}) {
  const shipped = inventoryStats(files);
  const stats = inventoryStats(inventory);
  const manifest = {
    format: PACKAGE_FORMAT,
    kind,
    version,
    count: stats.count,
    bytes: stats.bytes,
    inventory: inventoryDigest(inventory),
    shipped,
    files
  };
  if (kind === KIND_DELTA) {
    manifest.from = from;
    manifest.fromInventory = fromInventory;
    manifest.removed = removed;
  } else if (from) {
    throw new Error('a base package has no source version');
  }
  return manifest;
}

export function checkManifest(manifest, { name = 'package' } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return [`${name}: not an object`];
  if (manifest.format !== PACKAGE_FORMAT) problems.push(`${name}: format ${manifest.format}`);
  if (manifest.kind !== KIND_BASE && manifest.kind !== KIND_DELTA) problems.push(`${name}: kind ${manifest.kind}`);
  if (!manifest.version) problems.push(`${name}: no version`);
  if (manifest.kind === KIND_DELTA && !manifest.from) problems.push(`${name}: delta without a source version`);
  if (!manifest.inventory || !/^[0-9a-f]{64}$/.test(String(manifest.inventory))) problems.push(`${name}: bad inventory digest`);
  if (!manifest.files || typeof manifest.files !== 'object') problems.push(`${name}: no files map`);
  for (const rel of Object.keys(manifest.files || {})) {
    const problem = assetPathProblem(rel);
    if (problem) problems.push(`${name}: unsafe file path ${JSON.stringify(rel)}: ${problem}`);
    if (isJunkAsset(rel)) problems.push(`${name}: junk file ${rel}`);
    const entry = manifest.files[rel];
    if (!entry || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) problems.push(`${name}: bad sha256 for ${rel}`);
  }
  for (const item of manifest.removed || []) {
    const problem = assetPathProblem(item && item.path);
    if (problem) problems.push(`${name}: unsafe removed path ${JSON.stringify(item && item.path)}: ${problem}`);
    if (!item || !/^[0-9a-f]{64}$/.test(String(item.sha256))) problems.push(`${name}: bad removed sha256 for ${item && item.path}`);
  }
  return problems;
}

/** Assemble the manifest of a base or delta package from two inventories. */
export function planPackage({ kind, version, from = null, before = null, after }) {
  if (kind === KIND_BASE) {
    const files = {};
    for (const rel of Object.keys(after).sort()) files[rel] = { size: after[rel].size, sha256: after[rel].sha256 };
    return buildManifest({ kind, version, inventory: after, files });
  }
  if (!before) throw new Error('a delta package needs the previous inventory');
  const { changed, removed } = diffInventories(before, after);
  const files = {};
  for (const rel of changed) files[rel] = { size: after[rel].size, sha256: after[rel].sha256 };
  const tombstones = removed.map((rel) => ({ path: rel, size: before[rel].size, sha256: before[rel].sha256 }));
  return buildManifest({
    kind,
    version,
    from,
    fromInventory: inventoryDigest(before),
    inventory: after,
    files,
    removed: tombstones
  });
}

// ---------------------------------------------------------------------------
// ZIP writing (deterministic, classic ZIP: fewer than 65535 entries, below 4 GiB)
// ---------------------------------------------------------------------------

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01, the earliest representable date
const ZIP_LIMIT = 0xfffffffe;

let crcTable = null;

export function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function deflateRaw(buf) {
  return zlib.deflateRawSync(buf, { level: 9 });
}

function inflateRaw(buf) {
  return zlib.inflateRawSync(buf);
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value >>> 0, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * Write a deterministic classic ZIP. Entry order is the caller's, timestamps are fixed, names are
 * UTF-8 flagged, and the caller decides between STORE (already compressed media) and DEFLATE.
 * Throws when the archive would need ZIP64 — for the asset set that means a base package beyond
 * 4 GiB, which should be split instead of silently written as an unreadable file.
 */
export function writeZipArchive(out, entries) {
  if (entries.length > 0xffff) throw new Error(`${entries.length} entries exceed the classic ZIP limit`);
  const parts = [];
  const central = [];
  let offset = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const stored = entry.store ? raw : deflateRaw(raw);
    const useStore = entry.store || stored.length >= raw.length;
    const body = useStore ? raw : stored;
    const method = useStore ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
    const crc = crc32(raw);
    const header = Buffer.concat([
      u32(ZIP_LOCAL), u16(ZIP_VERSION), u16(ZIP_FLAG_UTF8), u16(method), u16(0), u16(ZIP_DOS_DATE),
      u32(crc), u32(body.length), u32(raw.length), u16(name.length), u16(0)
    ]);
    parts.push(header, name, body);
    central.push({
      name, method, crc, comp: body.length, size: raw.length, offset
    });
    offset += header.length + name.length + body.length;
    totalBytes += raw.length;
    if (offset >= ZIP_LIMIT || totalBytes >= ZIP_LIMIT) {
      throw new Error('archive exceeds the classic ZIP size limit; split the asset set');
    }
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const item of central) {
    const header = Buffer.concat([
      u32(ZIP_CENTRAL), u16(ZIP_VERSION), u16(ZIP_VERSION), u16(ZIP_FLAG_UTF8), u16(item.method),
      u16(0), u16(ZIP_DOS_DATE), u32(item.crc), u32(item.comp), u32(item.size),
      u16(item.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(item.offset)
    ]);
    parts.push(header, item.name);
    cdSize += header.length + item.name.length;
  }
  parts.push(Buffer.concat([
    u32(ZIP_EOCD), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdOffset), u16(0)
  ]));
  const data = Buffer.concat(parts);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, data);
  return { path: out, size: data.length, entries: central.length };
}

/**
 * Open a ZIP written by `writeZipArchive` or any classic writer and read its central directory.
 * The returned `read(entry)` reuses the open descriptor, so the caller must `close()` it — prefer
 * `withZip`, which does that even when the callback throws.
 */
export function readZipEntries(file) {
  const size = statSync(file).size;
  const tail = Math.min(size, 66000);
  const fd = openSync(file, 'r');
  try {
    const tailBuf = Buffer.alloc(tail);
    readSync(fd, tailBuf, 0, tail, size - tail);
    let eocd = -1;
    for (let i = tail - 22; i >= 0; i -= 1) {
      if (tailBuf.readUInt32LE(i) === ZIP_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${file}: no ZIP end-of-central-directory record`);
    const count = tailBuf.readUInt16LE(eocd + 10);
    const cdSize = tailBuf.readUInt32LE(eocd + 12);
    const cdOffset = tailBuf.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error(`${file}: ZIP64 archives are not supported`);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (cd.readUInt32LE(at) !== ZIP_CENTRAL) throw new Error(`${file}: corrupt central directory`);
      const flags = cd.readUInt16LE(at + 8);
      if (flags & 0x0001) throw new Error(`${file}: encrypted entries are not supported`);
      const method = cd.readUInt16LE(at + 10);
      const crc = cd.readUInt32LE(at + 16);
      const comp = cd.readUInt32LE(at + 20);
      const raw = cd.readUInt32LE(at + 24);
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      const localOffset = cd.readUInt32LE(at + 42);
      const name = cd.subarray(at + 46, at + 46 + nameLen).toString('utf8');
      if (comp === 0xffffffff || raw === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error(`${file}: ZIP64 entry ${name} is not supported`);
      }
      entries.push({ name, method, crc, comp, size: raw, offset: localOffset });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, read: (entry) => readEntryData(fd, file, entry), close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Open `file` for the duration of `fn` and always release the descriptor. */
export function withZip(file, fn) {
  const zip = readZipEntries(file);
  try {
    return fn(zip);
  } finally {
    zip.close();
  }
}

function readEntryData(fd, file, entry) {
  const header = Buffer.alloc(30);
  readSync(fd, header, 0, 30, entry.offset);
  if (header.readUInt32LE(0) !== ZIP_LOCAL) throw new Error(`${file}: corrupt local header for ${entry.name}`);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = Buffer.alloc(entry.comp);
  readSync(fd, data, 0, entry.comp, start);
  const raw = entry.method === ZIP_METHOD_STORE ? data : inflateRaw(data);
  if (raw.length !== entry.size) throw new Error(`${file}: ${entry.name} has ${raw.length} bytes, expected ${entry.size}`);
  if (crc32(raw) !== entry.crc) throw new Error(`${file}: ${entry.name} failed its CRC check`);
  return raw;
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function collectFiles(root, rels, { maxSolo } = {}) {
  const entries = [];
  for (const rel of rels) {
    const file = safeJoin(root, rel);
    const info = statSync(file);
    if (!info.isFile()) throw new Error(`${rel} is not a regular file in ${root}`);
    if (maxSolo && info.size > maxSolo) throw new Error(`${rel} is ${info.size} bytes, above the ${maxSolo} byte limit`);
    entries.push({ name: rel, data: readFileSync(file), store: /\.(?:png|jpe?g|webp|gif|mp3|ogg|m4a|wav|zip|woff2?|ttf)$/i.test(rel) });
  }
  return entries;
}

/**
 * Write one package. The manifest is written first so readers and the app can start with it, and it
 * is always compressed: a package is written to a temporary name and renamed, so an interrupted run
 * never leaves a half package that a later `index` would publish.
 */
export function writePackage({ out, manifest, root = null }) {
  const problems = checkManifest(manifest, { name: path.basename(out) });
  if (problems.length) throw new Error(problems.join('; '));
  if (manifest.kind === KIND_BASE && !root) throw new Error('a base package needs the source tree');
  const names = Object.keys(manifest.files).sort();
  const entries = [{ name: PACKAGE_MANIFEST, data: Buffer.from(`${JSON.stringify(manifest)}\n`), store: false }];
  if (manifest.kind === KIND_BASE) {
    const state = stateFromInventory(manifest.version, manifest.files, { floor: 'base' });
    entries.push({ name: PACKAGE_STATE, data: Buffer.from(`${JSON.stringify(state)}\n`), store: false });
    entries.push(...collectFiles(root, names));
  } else {
    entries.push(...collectFiles(root, names));
  }
  const tmp = `${out}.part`;
  rmSync(tmp, { force: true });
  const written = writeZipArchive(tmp, entries);
  rmSync(out, { force: true });
  renameSync(tmp, out);
  return { path: out, size: written.size, sha256: sha256File(out), entries: written.entries };
}

/** Read the package manifest without extracting anything else. */
export function readPackageManifest(file) {
  return withZip(file, (zip) => {
    const entry = zip.entries.find((item) => item.name === PACKAGE_MANIFEST);
    if (!entry) throw new Error(`${file}: no ${PACKAGE_MANIFEST}`);
    return JSON.parse(zip.read(entry).toString('utf8'));
  });
}

/** Read the full target inventory (bases ship `STATE.json`; deltas derive it from the local state). */
export function readPackageState(file) {
  return withZip(file, (zip) => {
    const entry = zip.entries.find((item) => item.name === PACKAGE_STATE);
    if (!entry) return null;
    return JSON.parse(zip.read(entry).toString('utf8'));
  });
}

/** Verify a package the way the client does: zip digest, manifest, entries, digests, tombstones. */
export function verifyPackage(file, { expectedSha256 = null, kind = null, version = null, from = null, before = null } = {}) {
  const problems = [];
  const fileHash = sha256File(file);
  if (expectedSha256 && fileHash !== String(expectedSha256).toLowerCase()) {
    problems.push(`package sha256 ${fileHash} does not match the index digest ${expectedSha256}`);
  }
  const { manifest, state } = withZip(file, (zip) => {
    const manifestEntry = zip.entries.find((item) => item.name === PACKAGE_MANIFEST);
    if (!manifestEntry) throw new Error(`${file}: no ${PACKAGE_MANIFEST}`);
    const parsed = JSON.parse(zip.read(manifestEntry).toString('utf8'));
    const stateEntry = zip.entries.find((item) => item.name === PACKAGE_STATE);
    const parsedState = stateEntry ? JSON.parse(zip.read(stateEntry).toString('utf8')) : null;
    problems.push(...checkManifest(parsed, { name: path.basename(file) }));
    const byName = new Map(zip.entries.map((item) => [item.name, item]));
    let bytes = 0;
    for (const [rel, entry] of Object.entries(parsed.files || {})) {
      const item = byName.get(rel);
      if (!item) { problems.push(`package is missing ${rel}`); continue; }
      const data = zip.read(item);
      bytes += data.length;
      const digest = sha256Hex(data);
      if (digest !== String(entry.sha256).toLowerCase()) problems.push(`${rel} hashes to ${digest}, expected ${entry.sha256}`);
      if (data.length !== Number(entry.size)) problems.push(`${rel} is ${data.length} bytes, expected ${entry.size}`);
    }
    const shippedBytes = Number(parsed.shipped && parsed.shipped.bytes);
    if (bytes !== shippedBytes) problems.push(`shipped bytes ${bytes} do not match the manifest ${shippedBytes}`);
    return { manifest: parsed, state: parsedState };
  });
  if (kind && manifest.kind !== kind) problems.push(`package kind ${manifest.kind}, expected ${kind}`);
  if (version && manifest.version !== version) problems.push(`package version ${manifest.version}, expected ${version}`);
  if (from && manifest.from !== from) problems.push(`package source version ${manifest.from}, expected ${from}`);
  if (manifest.kind === KIND_BASE) {
    if (!state) problems.push('a base package must ship STATE.json');
    else if (state.inventory !== manifest.inventory) problems.push('STATE.json does not match the manifest inventory');
  } else if (before) {
    const expected = inventoryDigest(before);
    if (manifest.fromInventory !== expected) {
      problems.push(`package expects source inventory ${manifest.fromInventory}, local state is ${expected}`);
    }
  }
  return { problems, manifest, sha256: fileHash, state };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Build the release index from package files (order and duplicates are normalised here). */
export function buildIndex({ latest, packages, maxChain = DEFAULT_MAX_CHAIN }) {
  const bases = [];
  const deltas = [];
  const versions = {};
  for (const item of packages) {
    const signalled = packageNameInfo(item.name);
    const kind = item.kind || (signalled && signalled.kind);
    const version = item.version || (signalled && signalled.version);
    const from = item.from || (signalled && signalled.from) || null;
    if (!kind || !version) continue;
    if (kind === KIND_BASE) {
      bases.push({ version, name: item.name, size: item.size, sha256: item.sha256 });
    } else {
      deltas.push({ from, to: version, name: item.name, size: item.size, sha256: item.sha256 });
    }
    if (item.inventory) {
      versions[version] = { inventory: item.inventory, count: item.count || 0, bytes: item.bytes || 0 };
    }
    // A delta also tells us the published inventory of the version it starts from, which is what a
    // client at that version has to match. Without it the route from the previous version could only be
    // "unpublished", so the client would try a delta nobody can verify.
    if (kind === KIND_DELTA && from && item.fromInventory && !versions[from]) {
      versions[from] = { inventory: item.fromInventory, count: 0, bytes: 0 };
    }
  }
  const byVersion = (a, b) => compareVersions(a.version, b.version);
  bases.sort(byVersion);
  deltas.sort((a, b) => compareVersions(a.to, b.to) || compareVersions(a.from, b.from));
  const top = latest || [...bases.map((b) => b.version), ...deltas.map((d) => d.to)].sort(compareVersions).pop();
  return {
    format: INDEX_FORMAT,
    latest: top,
    maxChain,
    versions,
    bases,
    deltas
  };
}

export function writeIndex(file, index) {
  const problems = checkIndex(index);
  if (problems.length) throw new Error(problems.join('; '));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(index)}\n`);
  return file;
}

export function readIndex(file) {
  const index = JSON.parse(readFileSync(file, 'utf8'));
  if (index.format !== INDEX_FORMAT) throw new Error(`${file}: unsupported index format ${index.format}`);
  return index;
}

const isInventoryDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

/** Every version the index itself publishes a payload for (an index-wide fact, never cached in it). */
export function providerVersions(index) {
  const names = new Set();
  const versions = new Set();
  for (const item of (index && index.bases) || []) { names.add(item.name); versions.add(String(item.version)); }
  for (const item of (index && index.deltas) || []) { versions.add(String(item.to)); }
  return { names, versions };
}

/**
 * True when the index still holds the exact payload that a client at `version` needs. A version is
 * served either by its own base/delta or by a `reused` pointer at an older version whose published
 * inventory is identical, which is how a release that ships no new asset bytes reuses the chain that
 * is already in the bucket instead of uploading the same content again under a new version name.
 */
export function versionProvides(index, version) {
  const { names, versions } = providerVersions(index);
  const want = String(version);
  if (names.has(basePackageName(want))) return true;
  return versions.has(want);
}

/** The published version whose payload is byte-identical to `inventory`, or null. */
export function reuseCandidate(index, inventory) {
  if (!index || !isInventoryDigest(inventory)) return null;
  const wanted = String(inventory).toLowerCase();
  const options = [];
  for (const item of index.bases || []) {
    const info = index.versions && index.versions[item.version];
    if (info && String(info.inventory).toLowerCase() === wanted) options.push({ version: String(item.version), via: KIND_BASE });
  }
  for (const item of index.deltas || []) {
    const info = index.versions && index.versions[item.to];
    if (info && String(info.inventory).toLowerCase() === wanted) options.push({ version: String(item.to), via: KIND_DELTA });
  }
  /**
   * The newest version wins; at the same version a baseline beats the delta that arrives at it, because the
   * baseline is the package that carries the full payload for every client, not only for the ones already
   * sitting on the delta's `from`. The order is total, so the choice is deterministic.
   */
  options.sort((a, b) => compareVersions(a.version, b.version)
    || (a.via === b.via ? 0 : a.via === KIND_BASE ? 1 : -1));
  return options.length ? options[options.length - 1] : null;
}

/**
 * The version whose package actually carries `version`'s asset set.
 *
 * A metadata-only release records `versions[version].reused = <older version>` because the bytes are
 * already in the bucket. Routing and stranding have to follow that pointer: the delegated version has
 * no package of its own, so a route is computed to the version that publishes the payload. A cycle or a
 * pointer at a version the index does not serve resolves to `version` itself, which then routes (or
 * fails) exactly as it did before the pointer existed.
 */
export function resolveProviderVersion(index, version) {
  let current = version ? String(version) : null;
  if (!current || !index || !index.versions) return current;
  const seen = new Set([current]);
  for (let step = 0; step < 8; step += 1) {
    const info = index.versions[current];
    const next = info && info.reused ? String(info.reused) : null;
    if (!next || seen.has(next) || !versionProvides(index, next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

/** Problems that stop a version from being published on top of `index`, in report order. */
export function checkPublishTarget(index, version) {
  const problems = [];
  if (!version) return ['publish: no version was given'];
  if (index && index.latest && compareVersions(version, index.latest) <= 0) {
    problems.push(`publish: ${version} does not come after the published latest ${index.latest}`);
  }
  return problems;
}

export function checkIndex(index) {
  const problems = [];
  if (!index || typeof index !== 'object') return ['index: not an object'];
  if (index.format !== INDEX_FORMAT) problems.push(`index: format ${index.format}`);
  if (!index.latest) problems.push('index: no latest version');
  if (!Array.isArray(index.bases)) problems.push('index: no bases list');
  if (!Array.isArray(index.deltas)) problems.push('index: no deltas list');
  for (const item of index.bases || []) {
    if (item.name !== basePackageName(item.version)) problems.push(`index: base name ${item.name} does not match ${item.version}`);
    if (!/^[0-9a-f]{64}$/.test(String(item.sha256))) problems.push(`index: base ${item.name} has no sha256`);
  }
  for (const item of index.deltas || []) {
    if (item.name !== deltaPackageName(item.from, item.to)) problems.push(`index: delta name ${item.name} does not match ${item.from}->${item.to}`);
    if (!/^[0-9a-f]{64}$/.test(String(item.sha256))) problems.push(`index: delta ${item.name} has no sha256`);
  }
  if (!index.versions || typeof index.versions !== 'object') problems.push('index: no versions map');
  for (const [version, info] of Object.entries(index.versions || {})) {
    if (!info || typeof info !== 'object') { problems.push(`index: version ${version} is not an object`); continue; }
    if (!info.inventory) problems.push(`index: version ${version} has no inventory digest`);
    if (info.reused && !versionProvides(index, info.reused)) {
      problems.push(`index: version ${version} reuses ${info.reused}, which the index does not publish`);
    }
  }
  return problems;
}

export function indexBytes(index) {
  return Buffer.byteLength(`${JSON.stringify(index)}\n`);
}

/** Numeric version comparison for `0.M.N` / `M.N.R` style versions. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Route selection
// ---------------------------------------------------------------------------

function edgeMap(index) {
  const edges = new Map();
  for (const delta of index.deltas) {
    if (!edges.has(delta.from)) edges.set(delta.from, []);
    edges.get(delta.from).push(delta);
  }
  for (const list of edges.values()) list.sort((a, b) => compareVersions(a.to, b.to) || a.name.localeCompare(b.name));
  return edges;
}

/** Shortest delta chain from `from` to `to`, at most `maxChain` steps, or null. */
export function shortestDeltaChain(index, from, to, maxChain = DEFAULT_MAX_CHAIN) {
  if (from === to) return [];
  const edges = edgeMap(index);
  const queue = [{ version: from, steps: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const node = queue.shift();
    if (node.steps.length >= maxChain) continue;
    for (const delta of edges.get(node.version) || []) {
      if (seen.has(delta.to)) continue;
      const steps = [...node.steps, { kind: KIND_DELTA, from: delta.from, to: delta.to, name: delta.name, size: delta.size, sha256: delta.sha256 }];
      if (delta.to === to) return steps;
      seen.add(delta.to);
      queue.push({ version: delta.to, steps });
    }
  }
  return null;
}

/** The base package that reaches `latest` with the fewest steps (a base resets the whole state). */
export function bestBaseRoute(index, latest, maxChain = DEFAULT_MAX_CHAIN) {
  let best = null;
  for (const base of index.bases) {
    const chain = shortestDeltaChain(index, base.version, latest, maxChain);
    if (!chain) continue;
    const steps = [{ kind: KIND_BASE, from: base.version, to: base.version, name: base.name, size: base.size, sha256: base.sha256 }, ...chain];
    if (!best || steps.length < best.length) best = steps;
  }
  return best;
}

export function routeBytes(steps) {
  return steps.reduce((sum, step) => sum + Number(step.size || 0), 0);
}

/**
 * Decide how a client with the given local state reaches the published index.
 *
 * `local` is `{version, inventory}`; `inventory` may be null when the client has no usable state
 * (fresh install without a stamped state file, or a detected mismatch). The device only trusts a
 * delta chain when its own inventory digest matches the published digest of the version it runs,
 * which is how a corrupted or hand-modified cache turns into the "download a fresh base" repair
 * path instead of a silently wrong update.
 */
/**
 * Decide what one release has to publish.
 *
 * A delta is published whenever the previous asset tree is known, because it is the shortest path for the
 * clients that are up to date. A baseline is published when the release crosses an upstream baseline, when
 * none is published yet, when the previous tree no longer matches what was published for it (its delta
 * would reach nobody), or when another delta would push the chain past the client limit. The decision is
 * pure so the release scripts and the tests agree.
 */
export function planRelease({
  index = null,
  afterDigest = null,
  beforeDigest = null,
  from = null,
  to = null,
  mainline = false,
  forceBase = false,
  maxChain = DEFAULT_MAX_CHAIN
} = {}) {
  const notes = [];
  const published = index && Array.isArray(index.bases) && index.bases.length ? index : null;
  const comparable = Boolean(from && beforeDigest);
  let base = Boolean(mainline || forceBase);
  if (mainline) notes.push('mainline release: a new baseline carries the new asset set');
  else if (forceBase) notes.push('--force-base was given');
  if (!published) {
    if (!base) notes.push('no baseline has been published yet, so this release starts one');
    base = true;
  }
  /*
   * A release that ships no new asset bytes must not publish a package at all. When the index already
   * serves a version whose published inventory is exactly this release's inventory, that version's
   * baseline and delta chain stay in the bucket and the new version is recorded as reusing it; the
   * release only republishes the index metadata. Reuse is decided before any baseline/delta decision
   * so a version bump cannot duplicate an already validated upload.
   */
  let reuse = null;
  /* Reuse only applies to a forward release: `to` must come after the version the previous tree came from. */
  const forward = Boolean(to && from && compareVersions(to, from) > 0);
  if (published && !base && to && isInventoryDigest(afterDigest) && forward) {
    const candidate = reuseCandidate(published, afterDigest);
    if (candidate && !versionProvides(published, to)) {
      reuse = { ...candidate, inventory: String(afterDigest).toLowerCase() };
      notes.push(`the asset set of ${to || 'the new version'} is identical to published ${candidate.version}, so its ${candidate.via} package is reused and no new object is uploaded`);
      base = false;
    }
  }
  if (published && !base && !reuse && comparable && published.versions && published.versions[from]
    && published.versions[from].inventory !== beforeDigest) {
    base = true;
    notes.push(`the previous tree does not match the published inventory of ${from}, so its delta would reach nobody`);
  }
  if (published && !base && !reuse && comparable) {
    const newestBase = published.bases[published.bases.length - 1].version;
    const since = published.deltas.filter((item) => compareVersions(item.to, newestBase) > 0).length;
    if (since >= maxChain) {
      base = true;
      notes.push(`${since} deltas already follow baseline ${newestBase}; a longer chain would exceed the client limit of ${maxChain}`);
    }
  }
  const delta = comparable && !mainline && !reuse;
  if (reuse) notes.push(`a reused release needs no delta from ${from}`);
  else if (mainline) notes.push('a mainline release needs no delta across the baseline');
  else if (!comparable) {
    notes.push('no usable previous tree was given, so only a baseline can be published');
    base = true;
  }
  if (delta && beforeDigest === afterDigest) {
    notes.push(`the asset set did not change between ${from} and ${to || 'the new version'}`);
  }
  return { base, delta, reuse, notes };
}

/** Versions a client can no longer bring up to date through any route it is allowed to take. */
export function strandedVersions(index, maxChain = index.maxChain || DEFAULT_MAX_CHAIN) {
  const stranded = [];
  for (const [version, info] of Object.entries((index && index.versions) || {})) {
    if (!info || !info.inventory) continue;
    const plan = planRoute(index, { version, inventory: info.inventory }, { maxChain });
    if (plan.status === 'blocked') stranded.push(version);
  }
  return stranded;
}

export function planRoute(index, local, { maxChain = index.maxChain || DEFAULT_MAX_CHAIN, preferDelta = true } = {}) {
  const latest = index.latest;
  const version = local && local.version ? local.version : null;
  const inventory = local && local.inventory ? String(local.inventory).toLowerCase() : null;
  const published = version && index.versions ? index.versions[version] : null;
  let verification = 'unknown';
  if (version && published && inventory) verification = published.inventory === inventory ? 'ok' : 'mismatch';
  else if (version && !published) verification = 'unpublished';
  /*
   * A version can be served by a package published under an older version (`versions[v].reused`). The
   * delegated version has no package of its own, so both ends of the route have to be resolved to the
   * versions that really publish the bytes: `providerVersion` is what the client has, `target` is what
   * `latest` serves. A client on the reused payload is then up to date instead of being reported as
   * stranded, and one that is behind still gets the existing delta chain to that payload.
   */
  const providerVersion = version ? resolveProviderVersion(index, version) : null;
  const providerEntry = providerVersion && index.versions ? index.versions[providerVersion] : null;
  if (providerVersion !== version && providerEntry && inventory) {
    verification = providerEntry.inventory === inventory ? 'ok' : 'mismatch';
  }
  const target = latest ? resolveProviderVersion(index, latest) : null;
  const baseRoute = bestBaseRoute(index, target, maxChain);
  const result = {
    status: 'blocked',
    local: { version, inventory },
    latest,
    providerVersion,
    verification,
    route: null,
    base: baseRoute ? { steps: baseRoute, bytes: routeBytes(baseRoute) } : null,
    reason: ''
  };
  if (compareVersions(providerVersion, target) === 0 && verification !== 'mismatch') {
    return {
      ...result,
      status: 'current',
      reason: providerVersion === version
        ? (target === latest ? `already on ${latest}` : `already on the asset set published for ${latest}`)
        : `${version} reuses the payload published for ${providerVersion}`
    };
  }
  const deltaChain = providerVersion && verification === 'ok' ? shortestDeltaChain(index, providerVersion, target, maxChain) : null;
  if (deltaChain && deltaChain.length && preferDelta) {
    return {
      ...result,
      status: 'update',
      route: { kind: KIND_DELTA, steps: deltaChain, bytes: routeBytes(deltaChain) },
      reason: `${deltaChain.length} delta package(s) from ${providerVersion}`
    };
  }
  if (baseRoute) {
    const repair = verification === 'mismatch' || !version;
    return {
      ...result,
      status: repair ? 'repair' : 'update',
      route: { kind: KIND_BASE, steps: baseRoute, bytes: routeBytes(baseRoute) },
      reason: verification === 'mismatch'
        ? `local state does not match published ${version}; using a fresh base`
        : !version ? 'no local state; using a base package' : `no usable delta chain; base ${baseRoute[0].from}`
    };
  }
  if (compareVersions(providerVersion, target) === 0) {
    return { ...result, status: 'current', reason: `already on ${latest}` };
  }
  return { ...result, reason: 'the index has no route to the latest version' };
}

// ---------------------------------------------------------------------------
// Reference applier (mirrors the Android store)
// ---------------------------------------------------------------------------

export function readStore(root) {
  const file = path.join(root, STORE_FILE);
  if (!existsSync(file)) return null;
  const store = JSON.parse(readFileSync(file, 'utf8'));
  if (store.format !== STORE_FORMAT) throw new Error(`unsupported store format: ${store.format}`);
  return store;
}

function layerPath(root, dir) {
  return path.join(root, LAYER_DIR, dir);
}

function layerGeneration(dir) {
  const match = /^(\d{4})-/.exec(dir);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** Merge the floor state and every applied layer into the inventory the client currently serves. */
export function loadInventory(root) {
  const state = loadRootState(root);
  const store = readStore(root);
  let version = state ? state.version : null;
  let files = state ? { ...state.files } : {};
  for (const layerPkg of (store && store.layers) || []) {
    const dir = layerPath(root, layerPkg.dir);
    const manifest = readPackageManifestFromDir(dir);
    if (!manifest) throw new Error(`layer ${layerPkg.dir} has no ${PACKAGE_MANIFEST}`);
    files = applyManifestToInventory(files, manifest);
    version = manifest.version;
  }
  return { version, files, inventory: inventoryDigest(files), floor: state ? 'apk' : 'none', layers: (store && store.layers) || [] };
}

function readPackageManifestFromDir(dir) {
  const file = path.join(dir, PACKAGE_MANIFEST);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function applyManifestToInventory(files, manifest) {
  // A base package carries the complete state, so it replaces whatever came before (compaction).
  const next = manifest.kind === KIND_BASE ? {} : { ...files };
  for (const [rel, entry] of Object.entries(manifest.files)) {
    next[rel] = { size: Number(entry.size), sha256: String(entry.sha256).toLowerCase() };
  }
  for (const item of manifest.removed || []) delete next[item.path];
  return next;
}

/**
 * Extract a package into `dest`, refusing traversal, absolute paths, junk names and entries that do
 * not match the manifest. Every shipped file is hashed again after writing. A throw leaves a partly
 * written `dest` behind on purpose: the caller removes the whole staging directory.
 */
export function extractPackage(file, manifest, dest, { maxExtractBytes = DEFAULT_MAX_EXTRACT_BYTES } = {}) {
  const shipped = manifest.shipped || inventoryStats(manifest.files);
  if (Number(shipped.bytes) > maxExtractBytes) {
    throw new Error(`package extracts ${shipped.bytes} bytes, above the ${maxExtractBytes} byte limit`);
  }
  return withZip(file, (zip) => {
    mkdirSync(dest, { recursive: true });
    const written = new Set();
    for (const item of zip.entries) {
      if (item.name === PACKAGE_MANIFEST || item.name === PACKAGE_STATE) continue;
      assertAssetPath(item.name);
      if (isJunkAsset(item.name)) throw new Error(`package ships junk file ${item.name}`);
      const expected = manifest.files[item.name];
      if (!expected) throw new Error(`package ships ${item.name}, which the manifest does not list`);
      const data = zip.read(item);
      const digest = sha256Hex(data);
      if (digest !== String(expected.sha256).toLowerCase()) {
        throw new Error(`${item.name} hashes to ${digest}, expected ${expected.sha256}`);
      }
      if (data.length !== Number(expected.size)) throw new Error(`${item.name} is ${data.length} bytes, expected ${expected.size}`);
      const out = safeJoin(dest, item.name);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, data);
      written.add(item.name);
    }
    for (const rel of Object.keys(manifest.files)) {
      if (!written.has(rel)) throw new Error(`package is missing ${rel}`);
    }
    return [...written];
  });
}

/**
 * Apply a verified package to the asset tree at `root`, exactly like the Android store:
 * stage and verify, move the layer into place, then swap the store pointer atomically. A failure at
 * any point removes the staging directory and leaves the previous store untouched.
 */
export function applyPackage(root, file, { expectedSha256 = null, maxExtractBytes = DEFAULT_MAX_EXTRACT_BYTES } = {}) {
  const before = loadInventory(root);
  const manifest = readPackageManifest(file);
  const verified = verifyPackage(file, {
    expectedSha256,
    kind: manifest.kind,
    version: manifest.version,
    from: manifest.from || null,
    before: before.files
  });
  if (verified.problems.length) throw new Error(`refusing to apply: ${verified.problems.join('; ')}`);
  if (manifest.kind === KIND_DELTA) {
    if (manifest.from !== before.version) {
      throw new Error(`package ${manifest.from} -> ${manifest.version} does not continue from ${before.version}`);
    }
    if (manifest.fromInventory !== before.inventory) {
      throw new Error(`package expects source inventory ${manifest.fromInventory}, the local state is ${before.inventory}`);
    }
  } else if (before.version && compareVersions(manifest.version, before.version) < 0) {
    throw new Error(`package ${manifest.version} is older than the local ${before.version}`);
  }
  const nextInventory = applyManifestToInventory(before.files, manifest);
  const nextDigest = inventoryDigest(nextInventory);
  if (nextDigest !== manifest.inventory) {
    throw new Error(`package lands on inventory ${nextDigest}, the manifest declares ${manifest.inventory}`);
  }
  const staging = path.join(root, STAGING_DIR);
  rmSync(staging, { recursive: true, force: true });
  try {
    extractPackage(file, manifest, path.join(staging, 'files'), { maxExtractBytes });
    const store = readStore(root) || { format: STORE_FORMAT, version: null, floor: before.floor, layers: [] };
    rmSync(path.join(root, RETIRED_DIR), { recursive: true, force: true });
    retireRemoved(root, before, nextInventory, store);
    const generation = store.layers.reduce((max, layer) => Math.max(max, layerGeneration(layer.dir)), 0) + 1;
    const dir = `${String(generation).padStart(4, '0')}-${manifest.kind}-${manifest.from || manifest.version}-${manifest.version}`;
    const layers = path.join(root, LAYER_DIR);
    mkdirSync(layers, { recursive: true });
    renameSync(path.join(staging, 'files'), layerPath(root, dir));
    writeFileSync(path.join(layerPath(root, dir), PACKAGE_MANIFEST), `${JSON.stringify(manifest)}\n`);
    if (verified.state) writeFileSync(path.join(layerPath(root, dir), PACKAGE_STATE), `${JSON.stringify(verified.state)}\n`);
    const kept = manifest.kind === KIND_BASE ? [] : store.layers;
    if (manifest.kind === KIND_BASE) {
      for (const layer of store.layers) rmSync(layerPath(root, layer.dir), { recursive: true, force: true });
    }
    const nextStore = {
      format: STORE_FORMAT,
      version: manifest.version,
      floor: before.floor,
      layers: [...kept, { dir, kind: manifest.kind, version: manifest.version, from: manifest.from || null }]
    };
    const pointer = path.join(root, STORE_FILE);
    writeFileSync(`${pointer}.tmp`, `${JSON.stringify(nextStore, null, 2)}\n`);
    renameSync(`${pointer}.tmp`, pointer);
    return {
      ...nextStore,
      applied: manifest.version,
      files: Object.keys(manifest.files).length,
      removed: (manifest.removed || []).length
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Keep the files this update deletes available for one update cycle (in-flight pages). */
function retireRemoved(root, before, next, store) {
  const removed = Object.keys(before.files).filter((rel) => !next[rel]);
  if (!removed.length) return;
  const retired = path.join(root, RETIRED_DIR);
  mkdirSync(retired, { recursive: true });
  for (const rel of removed) {
    const inLayer = [...store.layers].reverse()
      .map((layer) => safeJoin(layerPath(root, layer.dir), rel))
      .find((candidate) => existsSync(candidate));
    if (!inLayer) continue;
    const target = safeJoin(retired, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(inLayer));
  }
}

/**
 * Resolve one served path against the inventory the layers produced (newest layer first), then the
 * retired grace set, then the tree that carries the floor. The inventory is the set the client is
 * entitled to see, so it is checked first: a file a later update removed is never resurrected from an
 * older layer or from the floor.
 */
export function lookupAsset(root, rel) {
  const served = loadInventory(root);
  if (!Object.prototype.hasOwnProperty.call(served.files, rel)) return null;
  const store = readStore(root);
  for (const layer of [...((store && store.layers) || [])].reverse()) {
    const candidate = safeJoin(layerPath(root, layer.dir), rel);
    if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate, layer: layer.dir };
  }
  const retired = safeJoin(path.join(root, RETIRED_DIR), rel);
  if (existsSync(retired) && statSync(retired).isFile()) return { file: retired, layer: 'retired' };
  const floor = safeJoin(root, rel);
  if (existsSync(floor) && statSync(floor).isFile()) return { file: floor, layer: 'floor' };
  return null;
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

/**
 * Validate the public runtime configuration. The index URL and the limits are public build-time
 * data: no credentials, no signed URLs, no query secrets — the file may be committed or shipped in
 * the APK.
 */
export function checkConfig(config) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['config: not an object'];
  if (config.format !== CONFIG_FORMAT) problems.push(`config: format ${config.format}`);
  const url = String(config.indexUrl || '');
  if (!url) {
    problems.push('config: indexUrl is required');
  } else if (!/^https?:\/\//i.test(url)) {
    problems.push('config: indexUrl must be an http(s) URL');
  } else {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      problems.push('config: indexUrl is not a valid URL');
    }
    if (parsed) {
      if (parsed.username || parsed.password) problems.push('config: indexUrl must not carry credentials');
      if (!config.allowHttp && parsed.protocol !== 'https:') problems.push('config: indexUrl must use https');
      if (/[?&](?:sig|signature|token|key|secret|x-amz-)/i.test(parsed.search)) {
        problems.push('config: indexUrl must not carry signature or token parameters');
      }
    }
  }
  for (const key of ['maxChain', 'maxDownloadBytes', 'maxExtractBytes']) {
    if (config[key] !== undefined && (!Number.isFinite(Number(config[key])) || Number(config[key]) <= 0)) {
      problems.push(`config: ${key} must be a positive number`);
    }
  }
  return problems;
}

export function makeConfig({ indexUrl, maxChain = DEFAULT_MAX_CHAIN, maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES, maxExtractBytes = DEFAULT_MAX_EXTRACT_BYTES, allowHttp = false, note = '' } = {}) {
  const config = {
    format: CONFIG_FORMAT,
    indexUrl: indexUrl || '',
    maxChain: Number(maxChain),
    maxDownloadBytes: Number(maxDownloadBytes),
    maxExtractBytes: Number(maxExtractBytes),
    allowHttp: Boolean(allowHttp)
  };
  if (note) config.note = note;
  return config;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}
