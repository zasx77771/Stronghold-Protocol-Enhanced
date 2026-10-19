// test/server-update.test.js — the server pack's update package (tools/server-update.mjs,
// scripts/make-server-lite.mjs --update, docs/WINDOWS.md §7): reading an earlier server pack (its released zip, the
// folder it was extracted to, or its app folder), the app\MANIFEST.json a server pack carries, the comparison with the
// bases, the staged package (so `app\` keeps its art lists, which the player's package treats as setup art), the zip
// (no top-level folder: the operator extracts it into the pack root) and the whole round trip through the server's own
// boot step (server/update.js applyPendingUpdate) over a small temporary pack. No network, no npm install.
// Run: node --test test/server-update.test.js (the player's side: test/update-package.test.js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLIED_FILE, MANIFEST_FILE, UPDATE_FILE, applyPendingUpdate, checkInstall } from '../server/update.js';
import { walk } from '../tools/package-update.mjs';
import {
  crc32, listZip, readPackDir, readServerBase, stageUpdate, updateName, updateWorkVerdict, writeServerManifest, zipContents,
} from '../tools/server-update.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'make-server-lite.mjs');

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-srv-update-${tag}-`));
const put = (dir, rel, body = `// ${rel}\n`) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));
const json = (dir, rel) => JSON.parse(read(dir, rel));
const quiet = () => ({ log: () => {}, warn: () => {}, error: () => {} });
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
// The script's argument checks run a child node; a sandbox that forbids creating the child's pipes (EPERM, seen under
// the Windows harness) skips those three cases instead of failing — CI runs them (test/update-package.test.js spawns too).
const canSpawn = (() => {
  const p = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  return !p.error && p.status === 0;
})();
const noSpawn = canSpawn ? false : 'cannot spawn node from this sandbox (EPERM): the child-process cases run in CI';

const PACK_ROOT = { 'README-Lite-Server.md': '# lite\n', '启动轻量服务端.bat': '@echo off\r\n', LICENSE: 'GPL\n' };
const NODE = { 'node.exe': 'MZ-fake-node', 'LICENSE-node.txt': 'MIT\n' };

/** A server pack folder: `app\` (with a package.json), `node\`, and the pack root files. */
function makePack(dir, { version, app = {}, node = NODE, root = PACK_ROOT }) {
  put(dir, 'app/package.json', `${JSON.stringify({ name: 'stronghold-protocol', version, private: true }, null, 2)}\n`);
  for (const [rel, body] of Object.entries(app)) put(dir, `app/${rel}`, body);
  for (const [rel, body] of Object.entries(node)) put(dir, `node/${rel}`, body);
  for (const [rel, body] of Object.entries(root)) put(dir, rel, body);
  return dir;
}

/** Overlay `from` onto `to`, the way extracting the update zip into the pack root does. */
function overlay(from, to) {
  for (const rel of walk(from)) {
    const dst = path.join(to, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(from, ...rel.split('/')), dst);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a base

test('readServerBase: a pack folder, its app folder and the released zip all give the same app files and version', () => {
  const dir = tmp('base');
  const pack = makePack(path.join(dir, 'pack'), {
    version: '1.9.0',
    app: { 'server/a.js': 'A1', 'data/assets.json': '{"items":{}}\n', 'public/assets/x.png': 'X' },
  });

  const fromFolder = readServerBase(pack);
  assert.equal(fromFolder.version, '1.9.0');
  assert.deepEqual([...fromFolder.app.keys()].sort(), ['data/assets.json', 'package.json', 'public/assets/x.png', 'server/a.js']);
  assert.deepEqual([...fromFolder.root.keys()].sort(), ['LICENSE', 'README-Lite-Server.md', '启动轻量服务端.bat']);
  assert.deepEqual(fromFolder.node.get('node.exe'), { size: 12, sha256: sha('MZ-fake-node') });
  assert.equal(fromFolder.update, false);

  const fromApp = readServerBase(path.join(pack, 'app'));
  assert.equal(fromApp.version, '1.9.0');
  assert.deepEqual([...fromApp.app.keys()].sort(), [...fromFolder.app.keys()].sort());
  assert.equal(fromApp.root.size, 0, 'the app folder has no pack root');

  // the released zip: whatever the release called its top folder, readServerBase strips it
  const zipped = path.join(dir, 'ziproot', 'windows-server');
  fs.mkdirSync(path.dirname(zipped), { recursive: true });
  fs.cpSync(pack, zipped, { recursive: true });
  const zipPath = path.join(dir, 'released.zip');
  zipContents(path.join(dir, 'ziproot'), zipPath);
  const fromZip = readServerBase(zipPath);
  assert.equal(fromZip.version, '1.9.0');
  assert.deepEqual([...fromZip.app.keys()].sort(), [...fromFolder.app.keys()].sort());
  assert.deepEqual([...fromZip.root.keys()].sort(), [...fromFolder.root.keys()].sort());
  assert.equal(fromZip.node.size, 2, 'the zip keeps node\\, read from the top folder whatever the release called it');
});

test('readServerBase: refuses an update package, a folder that is neither pack nor app, and a manifest with no version', () => {
  const dir = tmp('refuse');
  const pack = makePack(path.join(dir, 'pack'), { version: '1.9.0', app: {} });
  put(pack, `app/${UPDATE_FILE}`, '{"format":1}\n');
  assert.throws(() => readServerBase(pack), /是增量包/);

  fs.mkdirSync(path.join(dir, 'random'), { recursive: true });
  put(path.join(dir, 'random'), 'README.md', 'x');
  assert.throws(() => readServerBase(path.join(dir, 'random')), /不是服务端包/);

  const noVersion = makePack(path.join(dir, 'noversion'), { version: '1.9.0' });
  put(noVersion, 'app/package.json', '{"name":"x"}\n');
  assert.throws(() => readServerBase(noVersion), /没有可用的版本号/);

  assert.throws(() => readServerBase(path.join(dir, 'nope')), /不存在/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The manifest a server pack carries

test('writeServerManifest: every file of app\, art lists included, the update machinery\'s files left out', () => {
  const pack = makePack(tmp('manifest'), {
    version: '2.0.0',
    app: { 'server/a.js': 'A2', 'data/assets.json': '{"items":{"x":1}}\n', 'public/assets/x.png': 'X' },
  });
  const app = path.join(pack, 'app');
  writeServerManifest(app, '2.0.0');
  const m = json(app, MANIFEST_FILE);
  assert.equal(m.format, 1);
  assert.equal(m.app, '2.0.0');
  assert.ok(m.files['data/assets.json'], 'the art list is an ordinary file here: server/update.js would drop it from a player manifest');
  assert.ok(m.files['public/assets/x.png']);
  assert.deepEqual(m.files['server/a.js'], { size: 2, sha256: sha('A2') });

  // the rewritten manifest and UPDATE.json are never part of it
  put(app, UPDATE_FILE, '{}\n');
  writeServerManifest(app, '2.0.0');
  const again = json(app, MANIFEST_FILE);
  assert.ok(!again.files[MANIFEST_FILE] && !again.files[UPDATE_FILE]);
  assert.deepEqual(readPackDir(pack).app.has(MANIFEST_FILE), false, 'readPackDir skips the machinery too');

  fs.mkdirSync(path.join(pack, 'empty'));
  assert.throws(() => writeServerManifest(path.join(pack, 'empty'), '2.0.0'), /是空的/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The comparison and the staged package

/** The full pack of 2.0.0 and a base of 1.9.0 sharing data/assets.json (identical: it must still reach the server). */
function twoVersions(tag) {
  const dir = tmp(tag);
  const full = makePack(path.join(dir, 'full'), {
    version: '2.0.0',
    app: {
      'server/a.js': 'A2',
      'server/b.js': 'B',
      'server/fresh.js': 'F',
      'data/assets.json': '{"items":{"x":1}}\n',
      'shared/constants.js': "export const V = '2.0.0';\n",
    },
  });
  const baseDir = makePack(path.join(dir, 'base'), {
    version: '1.9.0',
    app: {
      'server/a.js': 'A1',
      'server/b.js': 'B',
      'server/gone.js': 'G',
      'data/assets.json': '{"items":{"x":1}}\n',
      'shared/constants.js': "export const V = '1.9.0';\n",
    },
  });
  return { dir, full, base: readServerBase(baseDir), baseDir };
}

test('stageUpdate: only the changed app files, plus MANIFEST.json and UPDATE.json; node\ and the pack root stay out', () => {
  const { dir, full, base } = twoVersions('stage');
  const stage = path.join(dir, 'stage');
  const r = stageUpdate({ full, stage, version: '2.0.0', bases: [base] });

  // the version bump in app/package.json is a real change: it ships like any other file
  const pkgBytes = Buffer.byteLength(read(full, 'app/package.json'));
  assert.deepEqual(r.files, ['package.json', 'server/a.js', 'server/fresh.js', 'shared/constants.js']);
  assert.deepEqual(walk(stage).sort(), [
    `app/${MANIFEST_FILE}`,
    `app/${UPDATE_FILE}`,
    'app/package.json',
    'app/server/a.js',
    'app/server/fresh.js',
    'app/shared/constants.js',
  ].sort());

  const u = json(stage, `app/${UPDATE_FILE}`);
  assert.deepEqual(u.from, ['1.9.0']);
  assert.equal(u.count, 4);
  assert.deepEqual(u.removed, [{ path: 'server/gone.js', sha256: [sha('G')] }]);
  assert.deepEqual(Object.keys(u.files).sort(), r.files);
  assert.equal(u.bytes, pkgBytes + 2 + 1 + 26);

  const m = json(stage, `app/${MANIFEST_FILE}`);
  assert.equal(m.app, '2.0.0');
  assert.deepEqual(Object.keys(m.files).sort(), [
    'data/assets.json', 'package.json', 'server/a.js', 'server/b.js', 'server/fresh.js', 'shared/constants.js',
  ], 'the manifest describes the whole new app\, not only what ships');
  assert.ok(m.files['data/assets.json'], 'an unchanged art list is still verified by the server after the update');
});

test('stageUpdate: a changed Node runtime or a missing node\ is refused — an update cannot replace it', () => {
  const { dir, full, base } = twoVersions('node');
  put(full, 'node/node.exe', 'MZ-other-node');
  assert.throws(() => stageUpdate({ full, stage: path.join(dir, 's1'), version: '2.0.0', bases: [base] }), /换过 Node 运行时/);

  fs.rmSync(path.join(full, 'node'), { recursive: true });
  assert.throws(() => stageUpdate({ full, stage: path.join(dir, 's2'), version: '2.0.0', bases: [base] }), /没带/);
});

test('stageUpdate: a pack root file that changed ships, one the new version dropped is only reported', () => {
  const { dir, full, base } = twoVersions('root');
  put(full, 'README-Lite-Server.md', '# lite v2\n');
  put(full, 'NEW-NOTICE.md', 'notice\n');
  const r = stageUpdate({ full, stage: path.join(dir, 'stage'), version: '2.0.0', bases: [base] });
  assert.deepEqual(r.diff.root.ship, ['NEW-NOTICE.md', 'README-Lite-Server.md']);
  assert.ok(has(path.join(dir, 'stage'), 'NEW-NOTICE.md'), 'a new root file ships next to app\ (it is outside the install)');
  fs.rmSync(path.join(full, 'node'), { recursive: true, force: true });
  fs.rmSync(path.join(full, 'README-Lite-Server.md'), { force: true });
  const { base: withRoot } = twoVersions('root2');
  const r2 = stageUpdate({
    full: makePack(path.join(dir, 'full2'), { version: '2.0.0', app: { 'server/a.js': 'A2' }, root: { LICENSE: 'GPL\n' } }),
    stage: path.join(dir, 'stage2'),
    version: '2.0.0',
    bases: [withRoot],
  });
  assert.deepEqual(r2.diff.root.removed.map((x) => x.path), ['README-Lite-Server.md', '启动轻量服务端.bat'], 'reported, never staged: app/ is the only place an update deletes');
  assert.ok(!has(path.join(dir, 'stage2'), 'README-Lite-Server.md'));
});

// ---------------------------------------------------------------------------------------------------------------------
// The zip and the boot step

test('zipContents: the archive holds exactly the staged files, with no top-level folder', () => {
  const { dir, full, base } = twoVersions('zip');
  const stage = path.join(dir, 'stage');
  stageUpdate({ full, stage, version: '2.0.0', bases: [base] });
  const zipPath = path.join(dir, updateName('2.0.0'));
  zipContents(stage, zipPath);
  assert.deepEqual(listZip(zipPath), walk(stage).sort());
  assert.ok(listZip(zipPath).every((n) => n.startsWith('app/')), 'extracted into the pack root: app/ covers the install\'s app/');
  assert.equal(path.basename(zipPath), 'Stronghold-Protocol-Server-v2.0.0-win-x64-update.zip');
});

test('round trip: extracting the update over the base pack, the server applies it and deletes the old files', () => {
  const { dir, full, base, baseDir } = twoVersions('boot');
  const stage = path.join(dir, 'stage');
  stageUpdate({ full, stage, version: '2.0.0', bases: [base] });
  const zipPath = path.join(dir, updateName('2.0.0'));
  zipContents(stage, zipPath);

  const install = path.join(dir, 'install');
  fs.cpSync(baseDir, install, { recursive: true });
  put(install, 'app/server/local-only.js', 'mine\n'); // per-machine file: an update must not touch it
  overlay(stage, install); // what `tar -xf <zip> -C <pack root>` does

  const log = quiet();
  const app = path.join(install, 'app'); // the server's root is the pack's app\ (server/http/config.js: ROOT = server/..)
  assert.equal(checkInstall(app).state, 'ok');
  const r = applyPendingUpdate(app, { log });
  assert.equal(r.state, 'applied');
  assert.equal(read(install, 'app/server/a.js'), 'A2');
  assert.equal(read(install, 'app/shared/constants.js'), "export const V = '2.0.0';\n");
  assert.ok(has(install, 'app/server/fresh.js'));
  assert.ok(!has(install, 'app/server/gone.js'), 'the file 1.9.0 shipped and 2.0.0 does not is deleted');
  assert.ok(has(install, 'app/server/local-only.js'), 'a file the pack never shipped stays');
  assert.ok(!has(install, `app/${UPDATE_FILE}`));
  assert.ok(has(install, `app/${APPLIED_FILE}`));
  assert.ok(has(install, 'app/data/assets.json'), 'the art list survives (it is a plain file here)');
  assert.equal(checkInstall(app).state, 'ok', 'the install matches the new manifest; an extra local file is not an error');
});

test('round trip: a locally modified file the new version keeps makes the server refuse to start', () => {
  const { dir, full, base, baseDir } = twoVersions('fail');
  const stage = path.join(dir, 'stage');
  stageUpdate({ full, stage, version: '2.0.0', bases: [base] });
  const install = path.join(dir, 'install');
  fs.cpSync(baseDir, install, { recursive: true });
  put(install, 'app/server/b.js', 'B but edited by hand\n');
  overlay(stage, install);

  const r = applyPendingUpdate(path.join(install, 'app'), { log: quiet() });
  assert.equal(r.state, 'failed');
  assert.deepEqual(r.fatal, ['server/b.js']);
  assert.ok(has(install, `app/${UPDATE_FILE}`), 'the pending update stays for the operator to see');
});

test('a second update package over the applied install: the base version it names is not what the manifest says', () => {
  // The applier checks the result, not the base: an update staged for 2.0.0 applies to an install coming from any base
  // whose files it completes. Two packages from different bases into the same folder would therefore mix app\ versions,
  // which is why the release ships one package and names the bases it supports.
  const { dir, full, base, baseDir } = twoVersions('any');
  const stage = path.join(dir, 'stage');
  stageUpdate({ full, stage, version: '2.0.0', bases: [base] });
  const install = path.join(dir, 'install');
  fs.cpSync(baseDir, install, { recursive: true });
  fs.rmSync(path.join(install, 'app/server/gone.js')); // a 1.9.0 install that already deleted it
  overlay(stage, install);
  assert.equal(applyPendingUpdate(path.join(install, 'app'), { log: quiet() }).state, 'applied');
});

// ---------------------------------------------------------------------------------------------------------------------
// The zip reader, on a name an older release wrote

test('readZip: a CP936 launcher name from an older Windows zip decodes to the real name', () => {
  const dir = tmp('cp936');
  // 启动轻量服务端.bat in CP936, the flag bit 11 clear and no Unicode Path field: what Info-ZIP's zip on a Chinese
  // Windows writes, and what the 3.2.0 server pack has
  const name = Buffer.from([
    0xC6, 0xF4, 0xB6, 0xAF, 0xC7, 0xE1, 0xC1, 0xBF, 0xB7, 0xFE, 0xCE, 0xF1, 0xB6, 0xCB, 0x2E, 0x62, 0x61, 0x74,
  ]);
  const data = Buffer.from('@echo off\r\n');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6); // no UTF-8 flag
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // this entry alone starts at 0
  const cd = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  const zipPath = path.join(dir, 'cp936.zip');
  fs.writeFileSync(zipPath, Buffer.concat([local, name, data, cd, end]));
  assert.deepEqual(listZip(zipPath), ['启动轻量服务端.bat']);
});

// ---------------------------------------------------------------------------------------------------------------------
// The script's own surface

test('updateWorkVerdict: only an earlier work folder (or nothing) is deletable', () => {
  const dir = tmp('verdict');
  assert.equal(updateWorkVerdict(path.join(dir, 'missing')), 'missing');
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.equal(updateWorkVerdict(path.join(dir, 'empty')), 'empty');
  fs.mkdirSync(path.join(dir, 'bundle/full'), { recursive: true });
  assert.equal(updateWorkVerdict(path.join(dir, 'bundle')), 'bundle');
  put(path.join(dir, 'other'), 'notes.txt', 'x');
  assert.equal(updateWorkVerdict(path.join(dir, 'other')), 'refuse');
});

test('the script: --update needs --from, refuses --no-node and keeps --from to itself', { skip: noSpawn }, () => {
  const noFrom = run('--update');
  assert.equal(noFrom.status, 1);
  assert.match(`${noFrom.stdout}${noFrom.stderr}`, /--update 需要 --from/);

  const lone = run('--from', 'whatever.zip');
  assert.equal(lone.status, 1);
  assert.match(`${lone.stdout}${lone.stderr}`, /只跟 --update 一起用/);

  const dir = tmp('script');
  const baseDir = makePack(path.join(dir, 'base'), { version: '1.9.0', app: { 'server/a.js': 'A1' } });
  const noNode = run('--update', '--from', baseDir, '--no-node');
  assert.equal(noNode.status, 1);
  assert.match(`${noNode.stdout}${noNode.stderr}`, /不要加 --no-node/);

  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--keep-stage/);
  assert.match(help.stdout, /--update/);
});

test('the script: a base that is not older than the build is refused before anything is built', { skip: noSpawn }, () => {
  const pkg = json(ROOT, 'package.json');
  const dir = tmp('newer');
  const same = makePack(path.join(dir, 'same'), { version: pkg.version, app: { 'server/a.js': 'A' } });
  const r = run('--update', '--from', same, '--out', path.join(dir, 'out'));
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /不比当前版本/);
});
