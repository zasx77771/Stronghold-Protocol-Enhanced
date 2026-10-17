import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ASSET_FILES,
  KIND_BASE,
  KIND_DELTA,
  PACKAGE_FORMAT,
  PACKAGE_MANIFEST,
  PACKAGE_STATE,
  STATE_FORMAT,
  assetPathProblem,
  assertAssetPath,
  baseManifest,
  build,
  collectAssetFiles,
  compareVersions,
  deltaManifest,
  emptyIndex,
  inventoryDigest,
  isAssetPath,
  readIndex,
  updateIndex,
  validateIndex,
  validateManifest,
  verifyPackage,
  writePackage,
} from '../../tools/assetPackages.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'sp-assets-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const baseTree = {
  'assets/a.png': 'alpha',
  'assets/nested/b.png': 'bravo',
  'fonts/f.woff2': 'font',
  'data/assets.json': '{"groups":{}}',
  'data/unrelated.json': '{"not":"an asset"}',
  'server/code.js': 'not packaged',
};

test('the path rules mirror Rust and Java and reject unsafe or non-asset paths', () => {
  assert.equal(assetPathProblem('assets/a.png'), null);
  assert.equal(assetPathProblem('data/assets.json'), null);
  for (const [path, reason] of [
    ['', 'empty path'],
    ['assets\\a.png', 'backslash in path'],
    ['/assets/a.png', 'absolute path'],
    ['assets/a.png/', 'trailing slash'],
    ['C:/assets/a.png', 'drive-letter path'],
    ['assets//a.png', 'empty path segment'],
    ['assets/../a.png', 'unsafe path segment'],
    ['assets/中文.png', 'non-ASCII path'],
    ['assets/a.png ', 'trailing whitespace in path'],
    ['assets/~398f32e2ff78d9e6/a.png', 'hashed web path in native package'],
  ]) {
    assert.equal(assetPathProblem(path), reason);
  }
  assert.equal(isAssetPath('assets/a.png'), true);
  assert.equal(isAssetPath('assets/'), false);
  assert.equal(isAssetPath('server/a.js'), false);
  assert.equal(isAssetPath('data/local-assets.json'), true);
  assert.throws(() => assertAssetPath('../evil.png'), /unsafe asset path/);
  assert.throws(() => assertAssetPath('data/other.json'), /outside the runtime asset set/);
  assert.throws(() => assertAssetPath('assets/.DS_Store'), /junk file/);
});

test('collecting a tree keeps only the runtime set and ignores junk and program files', () => {
  const root = tree({ ...baseTree, 'assets/.DS_Store': 'junk' });
  try {
    const files = collectAssetFiles(root);
    assert.deepEqual([...files.keys()].sort(), [
      'assets/a.png',
      'assets/nested/b.png',
      'data/assets.json',
      'fonts/f.woff2',
    ]);
    assert.equal(files.get('assets/a.png').sha256.length, 64);
    rmSync(join(root, 'data', 'assets.json'));
    assert.throws(() => collectAssetFiles(root), /no data\/assets.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a base package carries the complete manifest, STATE.json and the sorted files', () => {
  const root = tree(baseTree);
  const out = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  try {
    const result = build({ source: root, out, version: '1.0.0' });
    assert.equal(result.manifest.kind, KIND_BASE);
    assert.equal(result.manifest.inventory, inventoryDigest(collectAssetFiles(root)));
    assert.equal(result.packageInfo.name, 'assets-base-1.0.0.zip');
    assert.equal(result.manifest.bytes, result.manifest.shipped.bytes);

    const summary = verifyPackage(join(out, result.packageInfo.name));
    assert.equal(summary.kind, KIND_BASE);
    assert.equal(summary.version, '1.0.0');

    const index = readIndex(join(out, 'assets-index.json'));
    assert.equal(index.latest, '1.0.0');
    assert.deepEqual(index.bases, [{
      version: '1.0.0',
      to: '1.0.0',
      name: 'assets-base-1.0.0.zip',
      size: result.packageInfo.size,
      sha256: result.packageInfo.sha256,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('a delta records from/fromInventory and exactly the changed and removed files', () => {
  const previousRoot = tree(baseTree);
  const nextTree = { ...baseTree, 'assets/b.png': 'brand new', 'data/assets.json': '{"groups":{"updated":true}}' };
  delete nextTree['assets/a.png'];
  const nextRoot = tree(nextTree);
  const out = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  try {
    const previous = collectAssetFiles(previousRoot);
    const result = build({ source: nextRoot, previous: previousRoot, from: '1.0.0', version: '1.0.1', out });
    assert.equal(result.manifest.kind, KIND_DELTA);
    assert.equal(result.manifest.from, '1.0.0');
    assert.equal(result.manifest.fromInventory, inventoryDigest(previous));
    assert.deepEqual(result.manifest.removed.map((entry) => entry.path), ['assets/a.png']);
    assert.equal(result.manifest.removed[0].sha256, previous.get('assets/a.png').sha256);
    assert.deepEqual(Object.keys(result.manifest.files).sort(), ['assets/b.png', 'data/assets.json']);
    assert.equal(result.manifest.count, collectAssetFiles(nextRoot).size);
    assert.equal(result.manifest.shipped.count, 2);
    verifyPackage(join(out, result.packageInfo.name));

    const index = readIndex(join(out, 'assets-index.json'));
    assert.equal(index.latest, '1.0.1');
    assert.deepEqual(Object.keys(index.versions), ['1.0.0', '1.0.1']);
    assert.equal(index.versions['1.0.0'].inventory, result.manifest.fromInventory);
    assert.equal(index.deltas.length, 1);
    assert.equal(index.deltas[0].name, 'assets-delta-1.0.0-1.0.1.zip');
  } finally {
    rmSync(previousRoot, { recursive: true, force: true });
    rmSync(nextRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('the same source and version produce byte-identical packages', () => {
  const root = tree(baseTree);
  const first = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  const second = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  try {
    const one = build({ source: root, out: first, version: '2.0.0' });
    const two = build({ source: root, out: second, version: '2.0.0' });
    assert.equal(one.packageInfo.sha256, two.packageInfo.sha256);
    assert.deepEqual(readFileSync(join(first, one.packageInfo.name)), readFileSync(join(second, two.packageInfo.name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('invalid manifests and tampered package bytes are refused before they reach a store', () => {
  const files = new Map([['assets/a.png', { size: 1, sha256: 'a'.repeat(64) }]]);
  assert.throws(() => validateManifest({ ...baseManifest('1.0.0', files), count: 5 }), /base package must ship every file/);
  assert.throws(() => validateManifest({ ...baseManifest('1.0.0', files), inventory: 'nope' }), /bad inventory/);
  const overlap = {
    ...baseManifest('1.0.0', files),
    kind: KIND_DELTA,
    from: '0.9.0',
    fromInventory: 'c'.repeat(64),
    removed: [{ path: 'assets/a.png', size: 1, sha256: 'a'.repeat(64) }],
  };
  assert.throws(() => validateManifest(overlap), /both ship and remove/);

  const root = tree({ 'assets/a.png': 'X', 'data/assets.json': '{}' });
  const out = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  try {
    const payload = new Map([['assets/a.png', { size: 1, sha256: 'b'.repeat(64) }]]);
    payload.root = root;
    const manifest = {
      format: PACKAGE_FORMAT,
      kind: KIND_DELTA,
      version: '1.0.1',
      from: '1.0.0',
      fromInventory: 'c'.repeat(64),
      inventory: inventoryDigest(payload),
      count: 1,
      bytes: 1,
      shipped: { count: 1, bytes: 1 },
      files: { 'assets/a.png': { size: 1, sha256: 'b'.repeat(64) } },
      removed: [],
    };
    validateManifest(manifest);
    const info = writePackage(out, manifest, payload);
    assert.throws(() => verifyPackage(join(out, info.name)), /does not match its sha256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('indexes are validated, versioned and never list an unsafe package name', () => {
  const index = emptyIndex();
  const manifest = baseManifest('1.2.3', new Map([['assets/a.png', { size: 1, sha256: 'a'.repeat(64) }]]));
  const next = updateIndex(index, {
    manifest,
    packageInfo: { name: 'assets-base-1.2.3.zip', size: 10, sha256: 'b'.repeat(64) },
    latest: true,
  });
  assert.equal(next.latest, '1.2.3');
  assert.deepEqual(next.bases[0], {
    version: '1.2.3',
    to: '1.2.3',
    name: 'assets-base-1.2.3.zip',
    size: 10,
    sha256: 'b'.repeat(64),
  });
  assert.throws(() => validateIndex({ ...next, bases: [{ ...next.bases[0], name: 'assets-base-9.9.9.zip' }] }), /must be assets-base-1\.2\.3\.zip/);
  assert.equal(compareVersions('1.10.0', '1.9.0') > 0, true);
  assert.equal(compareVersions('2.6.5', '2.6.5'), 0);
});

test('a base and a delta to the same target are distinct routes and both stay listed', () => {
  const files = new Map([['assets/a.png', { size: 1, sha256: 'a'.repeat(64) }]]);
  const baseOne = baseManifest('1.0.0', files);
  const delta = {
    ...baseManifest('1.0.1', files),
    kind: KIND_DELTA,
    from: '1.0.0',
    fromInventory: baseOne.inventory,
  };
  let index = updateIndex(emptyIndex(), {
    manifest: baseOne,
    packageInfo: { name: 'assets-base-1.0.0.zip', size: 10, sha256: '1'.repeat(64) },
    latest: true,
  });
  index = updateIndex(index, {
    manifest: delta,
    packageInfo: { name: 'assets-delta-1.0.0-1.0.1.zip', size: 5, sha256: '2'.repeat(64) },
    latest: true,
    fromInfo: { version: '1.0.0', inventory: baseOne.inventory, count: 1, bytes: 1 },
  });
  index = updateIndex(index, {
    manifest: baseManifest('1.0.1', files),
    packageInfo: { name: 'assets-base-1.0.1.zip', size: 10, sha256: '3'.repeat(64) },
    latest: true,
  });
  assert.deepEqual(index.bases.map((item) => item.name), ['assets-base-1.0.0.zip', 'assets-base-1.0.1.zip']);
  assert.deepEqual(index.deltas.map((item) => item.name), ['assets-delta-1.0.0-1.0.1.zip']);
  assert.deepEqual(Object.keys(index.versions), ['1.0.0', '1.0.1']);
});

test('the output directory cannot be the official release folder or live inside the source', () => {
  const root = tree(baseTree);
  const out = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  try {
    assert.throws(
      () => build({ source: root, out: join(out, 'enhanced-client-servers'), version: '1.0.0' }),
      /refusing to write native packages into a release folder/,
    );
    assert.throws(
      () => build({ source: root, out: join(root, 'assets'), version: '1.0.0' }),
      /must not be inside the asset source/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('verification refuses a ZIP entry that expands beyond its declared size', () => {
  const root = tree({ ...baseTree, 'assets/big.bin': 'a'.repeat(4096) });
  const out = mkdtempSync(join(tmpdir(), 'sp-packages-'));
  try {
    const result = build({ source: root, out, version: '1.0.0' });
    const packageFile = join(out, result.packageInfo.name);
    const bytes = readFileSync(packageFile);
    let patched = false;
    for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
      const nameLength = bytes.readUInt16LE(offset + 28);
      const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
      if (name !== 'assets/big.bin') continue;
      bytes.writeUInt32LE(16, offset + 24);
      patched = true;
      break;
    }
    assert.equal(patched, true);
    writeFileSync(packageFile, bytes);
    assert.throws(() => verifyPackage(packageFile), /expands beyond its declared size/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('the runtime asset set is the documented four roots and nothing else', () => {
  assert.deepEqual(ASSET_FILES, ['data/assets.json', 'data/local-assets.json']);
  assert.equal(PACKAGE_MANIFEST, 'ASSETS.json');
  assert.equal(PACKAGE_STATE, 'STATE.json');
  assert.equal(STATE_FORMAT, 'sp-assets-state-v1');
});
