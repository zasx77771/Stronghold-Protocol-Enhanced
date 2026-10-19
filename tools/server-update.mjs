// tools/server-update.mjs — what `node scripts/make-server-lite.mjs --update --from <base>[,<base>…]` (docs/WINDOWS.md §7)
// needs: read an earlier server pack — its released zip, or the folder it was extracted to — into {path → size +
// sha256}, compare the new full pack with every base, and stage the update package (the changed files plus
// app/MANIFEST.json and app/UPDATE.json).
//
// The player's update package (tools/package-update.mjs, tools/package.mjs --update) is the same idea over the app
// folder alone: an update zip extracted over the install, and server/update.js — which the server runs before anything
// else (server/http/boot.js: applyPendingUpdate) — reads MANIFEST.json and UPDATE.json back, verifies the install,
// deletes the old files UPDATE.json lists and renames UPDATE.json to .update-applied.json. Here the pack is one level
// higher: the zip holds `app\` (the install) next to `node\`, the launcher and the README. So:
//
//   * app\ — compared with the bases and described by app\MANIFEST.json: every file of the pack's app folder, the art
//     lists (data/assets.json) included. A player package leaves those out (setup manages them, server/update.js's
//     isSetupArt); a server pack ships them as ordinary files, so an update must carry a changed one like any other
//     file — and inManifest() would drop it. That is why the manifest of a server pack is written here.
//   * node\, the launcher, the README, LICENSE and the notices — outside the install: compared (a changed one ships)
//     but never in `removed`, which is relative to app\ and thus cannot delete anything outside it. A changed Node
//     runtime therefore cannot be an update (node\node.exe is 83 MB of the pack): the build refuses instead of shipping
//     a pack that mixes a new app\ with an old node\.
//
// One update zip works over each base (a file ships when it is new or differs from at least one of them), the same rule
// as the player update. The zip has no top-level folder: the operator extracts it into the pack root (the folder with
// app\ and 启动轻量服务端.bat), whatever they renamed that folder to.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { APPLIED_FILE, MANIFEST_FILE, UPDATE_FILE, digestFile, parseManifest, parseUpdate, removalProblem } from '../server/update.js';
import { diffBases, manifestText, readZip, updateText, walk } from './package-update.mjs';

/** The folder of the server pack an update replaces (server/update.js's root on the server). */
export const APP_DIR = 'app';
/** The folder holding the portable Node runtime; an update never changes it. */
const NODE_DIR = 'node';
/** The update machinery's own files: never compared, never in the manifest. */
const META = new Set([MANIFEST_FILE, UPDATE_FILE, APPLIED_FILE]);

/** `Stronghold-Protocol-Server-v<版本>-win-x64.zip` — the full pack scripts/make-server-lite.mjs writes. */
export const fullName = (version) => `Stronghold-Protocol-Server-v${version}-win-x64.zip`;
/** `Stronghold-Protocol-Server-v<版本>-win-x64-update.zip` — the update package written next to it. */
export const updateName = (version) => `Stronghold-Protocol-Server-v${version}-win-x64-update.zip`;

const posix = (rel) => rel.split('/');
const abs = (root, rel) => path.join(root, ...posix(rel));
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** One path of a pack, by where it lives. */
function slot(rel) {
  if (rel === APP_DIR) return null;
  if (rel.startsWith(`${APP_DIR}/`)) {
    const a = rel.slice(APP_DIR.length + 1);
    return META.has(a) ? { where: 'meta', rel: a } : { where: 'app', rel: a };
  }
  if (rel.startsWith(`${NODE_DIR}/`)) return { where: 'node', rel: rel.slice(NODE_DIR.length + 1) };
  return { where: 'root', rel };
}

function emptyPack(source) {
  return { source, version: '', app: new Map(), root: new Map(), node: new Map(), update: false };
}

/**
 * An earlier server pack as the base of an update: its released zip (`windows-server/app/…`, the top folder whatever
 * the release called it), the folder that zip was extracted to (any folder holding `app/package.json`), or that
 * pack's `app` folder itself.
 * @param {string} source
 * @returns {{ source: string, version: string, app: Map<string, { size: number, sha256: string }>,
 *             root: Map<string, { size: number, sha256: string }>, node: Map<string, { size: number, sha256: string }>,
 *             update: boolean }}
 */
export function readServerBase(source) {
  const at = path.resolve(source);
  let st;
  try { st = fs.statSync(at); } catch { throw new Error(`基包 ${source}：不存在`); }
  const out = emptyPack(at);
  const add = (rel, d) => {
    const s = slot(rel);
    if (!s) return;
    if (s.where === 'meta') { if (s.rel === UPDATE_FILE) out.update = true; return; }
    if (s.where === 'node' && s.rel === '') return;
    out[s.where].set(s.rel, d);
  };

  if (st.isDirectory()) {
    if (!fs.existsSync(path.join(at, APP_DIR, 'package.json'))) {
      if (!fs.existsSync(path.join(at, 'package.json'))) {
        throw new Error(`基包 ${source}：既不是服务端包（包根要有 ${APP_DIR}/package.json），也不是解出来的 ${APP_DIR} 文件夹`);
      }
      // the app folder itself
      for (const rel of walk(at)) {
        if (META.has(rel)) { if (rel === UPDATE_FILE) out.update = true; continue; }
        const d = digestFile(abs(at, rel));
        if (!d) throw new Error(`基包 ${source}：读不到 ${rel}`);
        out.app.set(rel, d);
      }
    } else {
      for (const rel of walk(at)) {
        const d = digestFile(abs(at, rel));
        if (!d) throw new Error(`基包 ${source}：读不到 ${rel}`);
        add(rel, d);
      }
    }
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(at, APP_DIR, 'package.json'), 'utf8')); } catch {
      try { pkg = JSON.parse(fs.readFileSync(path.join(at, 'package.json'), 'utf8')); } catch { pkg = null; }
    }
    out.version = pkg?.version;
  } else {
    let pkg = null;
    let top = null;
    try {
      readZip(at, (raw, data) => {
        let rel = raw.replace(/^\.\//, '');
        if (top === null) {
          const i = rel.indexOf('/');
          if (i < 0) throw new Error(`${rel} 不在一个顶层文件夹里（不是发布用的服务端 zip？）`);
          top = rel.slice(0, i);
        }
        if (!rel.startsWith(`${top}/`)) throw new Error(`${rel} 不在 ${top}/ 里（不是发布用的服务端 zip？）`);
        rel = rel.slice(top.length + 1);
        if (!rel) return;
        if (rel === `${APP_DIR}/package.json`) {
          try { pkg = JSON.parse(data.toString('utf8')); } catch { pkg = null; }
        }
        add(rel, { size: data.length, sha256: digestOf(data) });
      });
    } catch (e) {
      throw new Error(`基包 ${source}：${e.message}`, { cause: e });
    }
    if (!pkg) throw new Error(`基包 ${source}：zip 里没有 ${APP_DIR}/package.json（不是服务端包）`);
    out.version = pkg.version;
  }

  if (typeof out.version !== 'string' || !VERSION.test(out.version)) {
    throw new Error(`基包 ${source}：${APP_DIR}/package.json 里没有可用的版本号（${out.version ?? '缺失'}）`);
  }
  if (out.update) throw new Error(`基包 ${source} 是增量包（带 ${APP_DIR}/${UPDATE_FILE}）：请用完整包`);
  if (out.app.size === 0) throw new Error(`基包 ${source}：${APP_DIR} 里没有任何文件（包没解压完整？）`);
  return out;
}

/** sha256 of a buffer (readZip hands the bytes; a base zip's digests are computed, not read from a manifest). */
const digestOf = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The files of a built pack (the full stage of scripts/make-server-lite.mjs) by slot, without the update machinery's. */
export function readPackDir(dir) {
  const at = path.resolve(dir);
  if (!fs.existsSync(path.join(at, APP_DIR, 'package.json'))) throw new Error(`${dir}：没有 ${APP_DIR}/package.json，不是服务端包`);
  const out = emptyPack(at);
  for (const rel of walk(at)) {
    const s = slot(rel);
    if (!s || s.where === 'meta') continue;
    const d = digestFile(abs(at, rel));
    if (!d) throw new Error(`读不到 ${rel}`);
    out[s.where].set(s.rel, d);
  }
  return out;
}

/**
 * Write app/MANIFEST.json: every file of the pack's app folder except the update machinery's own, so the applier
 * verifies the whole install. Unlike a player package's manifest (server/update.js inManifest) it lists data/assets.json
 * and the other art lists — a server pack ships them and an update replaces them like any other file.
 * @param {string} appDir
 * @param {string} version
 * @returns {{ app: string, files: Map<string, { size: number, sha256: string }>, text: string }}
 */
export function writeServerManifest(appDir, version) {
  const at = path.resolve(appDir);
  const files = new Map();
  for (const rel of walk(at)) {
    if (META.has(rel)) continue;
    const d = digestFile(abs(at, rel));
    if (!d) throw new Error(`读不到 ${rel}`);
    files.set(rel, d);
  }
  if (!files.size) throw new Error(`${appDir} 是空的`);
  const text = manifestText({ app: version, files });
  parseManifest(text); // the server reads it back
  fs.writeFileSync(path.join(at, MANIFEST_FILE), text);
  return { app: version, files, text };
}

/** A Node runtime the update cannot replace: every base must ship the same node\ files as this pack. */
function sameNode(next, bases) {
  for (const b of bases) {
    if (!b.node.size) continue;
    for (const [rel, d] of b.node) {
      const n = next.get(rel);
      if (!n) throw new Error(`v${b.version} 带 node/${rel}，这次打包没带（--no-node？）：增量包换不了 Node 运行时，换过 Node 请发完整包`);
      if (n.size !== d.size || n.sha256 !== d.sha256) {
        throw new Error(`v${b.version} 的 node/${rel} 与这次打包的不是同一份：node\\ 在 app\\ 外，增量包覆盖不到，换过 Node 运行时（NODE_PIN）只能发完整包`);
      }
    }
  }
}

/**
 * Compare the new pack with the bases.
 * @param {{ app: Map, root: Map, node: Map }} next
 * @param {ReturnType<typeof readServerBase>[]} bases
 * @returns {{ app: ReturnType<typeof diffBases>, root: ReturnType<typeof diffBases> }}
 */
export function diffServerPack(next, bases) {
  sameNode(next.node, bases);
  const lane = (key) => bases.map((b) => ({ version: b.version, files: b[key] }));
  const app = diffBases(next.app, lane('app'), { removable: (rel) => !removalProblem(rel) });
  const root = diffBases(next.root, lane('root'));
  return { app, root };
}

/**
 * Stage the update package: the app files that ship, the root files that ship, app/MANIFEST.json (the whole new app
 * folder) and app/UPDATE.json. `stage` must not exist yet.
 * @param {{ full: string, stage: string, version: string, bases: ReturnType<typeof readServerBase>[] }} o
 * @returns {{ diff: { app: any, root: any }, update: object, next: object, manifest: object, bytes: number,
 *             removedBytes: number }}
 */
export function stageUpdate({ full, stage, version, bases }) {
  if (!bases.length) throw new Error('增量包至少需要一个基包（--from）');
  const next = readPackDir(full);
  const diff = diffServerPack(next, bases);
  const copy = (rel, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(abs(full, rel), to);
  };
  for (const rel of diff.app.ship) copy(`${APP_DIR}/${rel}`, abs(stage, `${APP_DIR}/${rel}`));
  for (const rel of diff.root.ship) copy(rel, abs(stage, rel));

  const manifest = writeServerManifest(abs(full, APP_DIR), version);
  const files = new Map(diff.app.ship.map((rel) => [rel, next.app.get(rel)]));
  const update = { app: version, from: bases.map((b) => b.version), files, removed: diff.app.removed };
  const text = updateText(update);
  parseUpdate(text); // the server reads it back
  fs.mkdirSync(abs(stage, APP_DIR), { recursive: true });
  fs.writeFileSync(abs(stage, `${APP_DIR}/${MANIFEST_FILE}`), manifest.text);
  fs.writeFileSync(abs(stage, `${APP_DIR}/${UPDATE_FILE}`), text);

  // what the operator extracts must be what UPDATE.json promises
  for (const rel of diff.app.ship) {
    const got = digestFile(abs(stage, `${APP_DIR}/${rel}`));
    const want = next.app.get(rel);
    if (!got || got.size !== want.size || got.sha256 !== want.sha256) throw new Error(`暂存后的 ${rel} 与 UPDATE.json 不一致`);
  }
  for (const rel of diff.root.ship) {
    const got = digestFile(abs(stage, rel));
    const want = next.root.get(rel);
    if (!got || got.size !== want.size || got.sha256 !== want.sha256) throw new Error(`暂存后的 ${rel} 与比对结果不一致`);
  }
  const bytes = diff.app.ship.reduce((n, rel) => n + next.app.get(rel).size, 0);
  return { diff, update, next, manifest, bytes, files: [...diff.app.ship] };
}

/** The file names of a zip, `./` dropped (a zip of a folder's contents starts some entries that way). */
export function listZip(zipPath) {
  const names = [];
  readZip(zipPath, (name) => {
    const rel = name.replace(/^\.\//, '');
    if (rel) names.push(rel);
  });
  return names.sort();
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a buffer (zlib.crc32 exists only in newer Node; the zip writer keeps its own). */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Zip a folder's contents — no top-level folder: the operator extracts the update into the pack root. Written here
 * rather than with `zip` / `tar -a`: the archive is this repo's own artifact, the bytes must not depend on which
 * archiver a build machine has (a GNU tar writes a plain tar under a .zip name), and a UTF-8 name flag keeps
 * 启动轻量服务端.bat and the docs readable whatever code page Windows uses.
 */
export function zipContents(srcDir, zipPath) {
  const at = path.resolve(srcDir);
  const local = [];
  const central = [];
  let offset = 0;
  for (const rel of walk(at).sort()) {
    const name = Buffer.from(rel, 'utf8');
    const data = fs.readFileSync(path.join(at, ...rel.split('/')));
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);

    const ent = Buffer.alloc(46);
    ent.writeUInt32LE(0x02014b50, 0);
    ent.writeUInt16LE(20, 4); // made by
    ent.writeUInt16LE(20, 6); // version needed
    ent.writeUInt16LE(0x800, 8);
    ent.writeUInt16LE(8, 10);
    ent.writeUInt16LE(0, 12);
    ent.writeUInt16LE(0x21, 14);
    ent.writeUInt32LE(crc, 16);
    ent.writeUInt32LE(packed.length, 20);
    ent.writeUInt32LE(data.length, 24);
    ent.writeUInt16LE(name.length, 28);
    ent.writeUInt16LE(0, 30); // extra
    ent.writeUInt16LE(0, 32); // comment
    ent.writeUInt16LE(0, 34); // disk
    ent.writeUInt16LE(0, 36); // internal attributes
    ent.writeUInt32LE(0, 38); // external attributes
    ent.writeUInt32LE(offset, 42);
    central.push(ent, name);
    offset += head.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(path.dirname(path.resolve(zipPath)), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([...local, cd, end]));
  return 'builtin zip';
}

/** Whether a folder is the work folder of an earlier --update run (deletable with --force). */
export function updateWorkVerdict(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'refuse';
  }
  if (entries.length === 0) return 'empty';
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  if (dirs.has('full') || dirs.has('update')) return 'bundle';
  return 'refuse';
}
