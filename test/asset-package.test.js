import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  KIND_BASE, KIND_DELTA, PACKAGE_MANIFEST, PACKAGE_STATE, STATE_FILE, INDEX_FILE,
  applyPackage, assetPathProblem, assertAssetPath, buildIndex, checkConfig, checkIndex, checkManifest,
  extractPackage, inventoryDigest, inventoryLines, inventoryStats, isAssetPath, loadInventory, loadRootState,
  lookupAsset, makeConfig, planPackage, planRelease, planRoute, readIndex, readStore, safeJoin,
  scanAssetFiles,
  sha256File, stampRoot, stateFromInventory, strandedVersions, verifyPackage, withZip, writeIndex, writePackage,
  writeZipArchive
} from '../tools/assetPackages.mjs';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

const V1 = {
  'assets/char/avatar/char_002_amiya.png': 'amiya-v1',
  'assets/char/avatar/char_003_kalts.png': 'kalts-v1',
  'fonts/bender-regular.woff2': 'font-v1',
  'data/assets.json': '{"version":1}'
};

const V2 = {
  'assets/char/avatar/char_002_amiya.png': 'amiya-v2',
  'assets/char/avatar/char_101_sora.png': 'sora-v1',
  'fonts/bender-regular.woff2': 'font-v1',
  'data/assets.json': '{"version":2}'
};

const V3 = {
  'assets/char/avatar/char_002_amiya.png': 'amiya-v2',
  'assets/char/avatar/char_101_sora.png': 'sora-v1',
  'assets/local/scene/board.png': 'board-v3',
  'data/assets.json': '{"version":3}'
};

function fixture(name = 'stronghold-asset-package-') {
  const root = mkdtempSync(join(tmpdir(), name));
  return {
    root,
    path: (...parts) => join(root, ...parts),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function writeTree(root, files) {
  for (const [rel, data] of Object.entries(files)) {
    const target = join(root, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return root;
}

/** Copy every entry of a package into a new zip, optionally renaming or replacing one entry. */
function rewritePackage(source, target, { rename = null, replace = null } = {}) {
  const entries = [];
  withZip(source, (zip) => {
    for (const item of zip.entries) {
      const name = rename && item.name === rename.from ? rename.to : item.name;
      const data = replace && item.name === replace.name ? Buffer.from(replace.data) : zip.read(item);
      entries.push({ name, data, store: item.method === 0 });
    }
  });
  writeZipArchive(target, entries);
}

test('the asset inventory covers the runtime asset set, ignores junk, and digests deterministically', () => {
  const f = fixture();
  try {
    const root = writeTree(f.path('client'), {
      ...V1,
      'index.html': '<html></html>',
      'js/main.js': 'code',
      'vendor/pixi.min.js': 'vendor',
      'data/cards.json': '{}',
      'assets/.DS_Store': 'junk',
      'assets/char/avatar/Thumbs.db': 'junk',
      'assets/char/avatar/char_002_amiya.png.tmp': 'junk'
    });
    const files = scanAssetFiles(root);
    assert.deepEqual(Object.keys(files).sort(), Object.keys(V1).sort(), 'only the runtime asset set is tracked');
    for (const [rel, entry] of Object.entries(files)) {
      assert.equal(entry.size, Buffer.byteLength(V1[rel]));
      assert.equal(entry.sha256, sha256Hex(V1[rel]));
    }
    assert.equal(inventoryDigest(files), inventoryDigest({ ...files }), 'the digest does not depend on key order');
    assert.deepEqual(inventoryStats(files), { count: 4, bytes: Object.values(V1).reduce((n, v) => n + Buffer.byteLength(v), 0) });
    assert.equal(isAssetPath('assets/a.png'), true);
    assert.equal(isAssetPath('js/main.js'), false);

    stampRoot(root, '2.6.1');
    const state = loadRootState(root);
    assert.equal(existsSync(f.path('client', STATE_FILE)), true);
    assert.equal(state.format, 'sp-assets-state-v1');
    assert.equal(state.version, '2.6.1');
    assert.equal(state.inventory, inventoryDigest(files));
    assert.equal(state.files['data/assets.json'].sha256, sha256Hex(V1['data/assets.json']));
    assert.deepEqual(Object.keys(stateFromInventory('2.6.1', files).files), Object.keys(files));

    // The canonical digest format is shared with the Java client: keep it pinned.
    assert.equal(
      inventoryLines({
        'assets/a.png': { size: 3, sha256: 'a'.repeat(64) },
        'fonts/b.woff2': { size: 12, sha256: 'b'.repeat(64) },
        'data/assets.json': { size: 5, sha256: 'c'.repeat(64) }
      }),
      `assets/a.png\t3\t${'a'.repeat(64)}\n`
      + `data/assets.json\t5\t${'c'.repeat(64)}\n`
      + `fonts/b.woff2\t12\t${'b'.repeat(64)}\n`
    );
    assert.equal(
      inventoryDigest({
        'assets/a.png': { size: 3, sha256: 'a'.repeat(64) },
        'fonts/b.woff2': { size: 12, sha256: 'b'.repeat(64) },
        'data/assets.json': { size: 5, sha256: 'c'.repeat(64) }
      }),
      '26ae0cbf62df26d3baf06d6e7a7dfe14a756f629251770874bcde523f42395b0'
    );
  } finally {
    f.cleanup();
  }
});

test('a delta ships only added and changed files plus tombstones, a base ships the full state', () => {
  const f = fixture();
  try {
    const before = scanAssetFiles(writeTree(f.path('v2'), V2));
    const after = scanAssetFiles(writeTree(f.path('v3'), V3));
    const delta = planPackage({ kind: KIND_DELTA, version: '2.6.3', from: '2.6.2', before, after });
    assert.deepEqual(Object.keys(delta.files).sort(), ['assets/local/scene/board.png', 'data/assets.json']);
    assert.deepEqual(delta.removed.map((item) => item.path), ['fonts/bender-regular.woff2']);
    assert.equal(delta.removed[0].sha256, sha256Hex(V2['fonts/bender-regular.woff2']));
    assert.equal(delta.from, '2.6.2');
    assert.equal(delta.fromInventory, inventoryDigest(before));
    assert.equal(delta.inventory, inventoryDigest(after), 'a delta declares the complete target inventory');
    assert.deepEqual({ count: delta.count, bytes: delta.bytes }, inventoryStats(after));
    assert.deepEqual(delta.shipped, inventoryStats(delta.files));
    assert.equal(checkManifest(delta).length, 0);

    const base = planPackage({ kind: KIND_BASE, version: '2.6.2', after: before });
    assert.deepEqual(Object.keys(base.files).sort(), Object.keys(V2).sort(), 'a base ships every file');
    assert.equal(base.count, Object.keys(V2).length);
    assert.equal(base.inventory, inventoryDigest(before));

    const unchanged = planPackage({ kind: KIND_DELTA, version: '2.6.3', from: '2.6.2', before: after, after });
    assert.deepEqual(Object.keys(unchanged.files), []);
    assert.deepEqual(unchanged.removed, []);
  } finally {
    f.cleanup();
  }
});

test('packages are deterministic zips and verify entry hashes, sizes and the archive digest', () => {
  const f = fixture();
  try {
    const root = writeTree(f.path('client'), V1);
    stampRoot(root, '2.6.2');
    const files = scanAssetFiles(root);
    const manifest = planPackage({ kind: KIND_BASE, version: '2.6.2', after: files });
    const first = f.path('one', 'assets-base-2.6.2.zip');
    const second = f.path('two', 'assets-base-2.6.2.zip');
    const written = writePackage({ out: first, manifest, root });
    writePackage({ out: second, manifest, root });
    assert.equal(sha256File(first), sha256File(second), 'the same state always produces the same bytes');
    assert.equal(written.sha256, sha256File(first));
    assert.equal(written.entries, Object.keys(V1).length + 2, 'the archive carries ASSETS.json and STATE.json');
    assert.ok(withZip(first, (zip) => zip.entries.some((item) => item.name === PACKAGE_STATE)));

    const verified = verifyPackage(first, { expectedSha256: written.sha256, kind: KIND_BASE, version: '2.6.2' });
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.manifest.inventory, manifest.inventory);
    assert.equal(verified.state.inventory, manifest.inventory, 'a base package ships the complete state');

    const wrongDigest = verifyPackage(first, { expectedSha256: 'a'.repeat(64) });
    assert.equal(wrongDigest.problems.length, 1);
    assert.match(wrongDigest.problems[0], /does not match the index digest/);

    const tampered = f.path('tampered.zip');
    rewritePackage(first, tampered, { replace: { name: 'data/assets.json', data: '{"version":99999}' } });
    const tamperedProblems = verifyPackage(tampered).problems;
    assert.ok(tamperedProblems.some((line) => /data\/assets\.json hashes to/.test(line)), tamperedProblems.join('; '));
    assert.ok(tamperedProblems.some((line) => /is \d+ bytes, expected/.test(line)), tamperedProblems.join('; '));

    const renamed = f.path('renamed.zip');
    rewritePackage(first, renamed, { rename: { from: 'assets/char/avatar/char_003_kalts.png', to: 'assets/char/avatar/char_004_x.png' } });
    const renamedProblems = verifyPackage(renamed).problems;
    assert.ok(renamedProblems.some((line) => /missing assets\/char\/avatar\/char_003_kalts\.png/.test(line)), renamedProblems.join('; '));
  } finally {
    f.cleanup();
  }
});

test('unsafe paths are refused before anything is written or served', () => {
  const f = fixture();
  try {
    for (const bad of ['../evil.txt', '/etc/passwd', 'assets/../evil.txt', 'assets\\..\\evil.txt', 'assets//x.png', './assets/x.png', 'C:/x.png', 'assets/x.png ', 'assets/./x.png', '']) {
      assert.ok(assetPathProblem(bad), `${bad} must be refused`);
      assert.throws(() => assertAssetPath(bad), /unsafe asset path/);
    }
    assert.equal(assetPathProblem('assets/char/avatar/char_002_amiya.png'), null);
    assert.throws(() => safeJoin(f.root, '../outside.txt'), /unsafe asset path/);

    const root = writeTree(f.path('client'), V1);
    stampRoot(root, '2.6.2');
    const okRel = 'assets/ok.png';
    const evilRel = '../evil.txt';
    const okData = Buffer.from('ok');
    const evilData = Buffer.from('evil');
    const files = {
      [okRel]: { size: okData.length, sha256: sha256Hex(okData) },
      [evilRel]: { size: evilData.length, sha256: sha256Hex(evilData) }
    };
    const manifest = {
      format: 'sp-assets-package-v1',
      kind: KIND_BASE,
      version: '9.9.9',
      count: 2,
      bytes: okData.length + evilData.length,
      inventory: inventoryDigest(files),
      shipped: inventoryStats(files),
      files
    };
    assert.ok(checkManifest(manifest).some((line) => /unsafe file path/.test(line)));
    const evilZip = f.path('evil.zip');
    writeZipArchive(evilZip, [
      { name: PACKAGE_MANIFEST, data: Buffer.from(JSON.stringify(manifest)) },
      { name: okRel, data: okData },
      { name: evilRel, data: evilData }
    ]);
    assert.ok(verifyPackage(evilZip).problems.some((line) => /unsafe file path/.test(line)));
    assert.throws(() => extractPackage(evilZip, manifest, f.path('staging')), /unsafe asset path/);
    assert.equal(existsSync(f.path('evil.txt')), false, 'nothing may land outside the staging directory');
    const before = loadInventory(root);
    assert.throws(() => applyPackage(root, evilZip), /refusing to apply|unsafe asset path|no ASSETS\.json/);
    assert.deepEqual(loadInventory(root), before, 'a rejected package leaves the served state untouched');
    assert.equal(readStore(root), null, 'a rejected package is never recorded');
  } finally {
    f.cleanup();
  }
});

test('a failed update never damages the assets the client already has', () => {
  const f = fixture();
  try {
    const root = writeTree(f.path('client'), V1);
    stampRoot(root, '2.6.1');
    const beforeFiles = scanAssetFiles(root);
    const afterFiles = scanAssetFiles(writeTree(f.path('v2'), V2));
    const manifests = {
      base: planPackage({ kind: KIND_BASE, version: '2.6.1', after: beforeFiles }),
      delta: planPackage({ kind: KIND_DELTA, version: '2.6.2', from: '2.6.1', before: beforeFiles, after: afterFiles })
    };
    const base = f.path('packages', 'assets-base-2.6.1.zip');
    const delta = f.path('packages', 'assets-delta-2.6.1-2.6.2.zip');
    const baseWritten = writePackage({ out: base, manifest: manifests.base, root });
    const deltaWritten = writePackage({ out: delta, manifest: manifests.delta, root: writeTree(f.path('v2'), V2) });

    const applied = applyPackage(root, base, { expectedSha256: baseWritten.sha256 });
    assert.equal(applied.version, '2.6.1');
    assert.equal(loadInventory(root).version, '2.6.1');
    const store = readStore(root);
    const served = loadInventory(root).inventory;

    // 1. an archive that does not match the published digest
    assert.throws(
      () => applyPackage(root, delta, { expectedSha256: 'b'.repeat(64) }),
      /does not match the index digest/
    );
    // 2. an archive whose contents do not match its manifest
    const tampered = f.path('packages', 'tampered-delta.zip');
    rewritePackage(delta, tampered, { replace: { name: 'data/assets.json', data: '{"version":99}' } });
    assert.throws(() => applyPackage(root, tampered, { expectedSha256: sha256File(tampered) }), /refusing to apply/);
    // 3. a package that does not continue from the local version
    const otherFiles = scanAssetFiles(writeTree(f.path('v3'), V3));
    const wrongFrom = f.path('packages', 'assets-delta-1.0.0-2.6.2.zip');
    const wrongManifest = planPackage({ kind: KIND_DELTA, version: '2.6.2', from: '1.0.0', before: otherFiles, after: afterFiles });
    writePackage({ out: wrongFrom, manifest: wrongManifest, root: writeTree(f.path('v2'), V2) });
    assert.throws(() => applyPackage(root, wrongFrom), /refusing to apply|does not continue from/);
    // 4. a manifest whose declared inventory the files cannot reach
    const lying = f.path('packages', 'lying-delta.zip');
    rewritePackage(delta, lying, { replace: { name: PACKAGE_MANIFEST, data: JSON.stringify({ ...manifests.delta, inventory: 'c'.repeat(64) }) } });
    assert.throws(() => applyPackage(root, lying), /declares/);
    // 5. extraction that would exceed the byte budget
    assert.throws(() => applyPackage(root, delta, { maxExtractBytes: 1 }), /above the 1 byte limit/);

    assert.equal(loadInventory(root).version, '2.6.1', 'the local version never moves on failure');
    assert.equal(loadInventory(root).inventory, served, 'the served inventory never moves on failure');
    assert.deepEqual(readStore(root), store, 'the store pointer never moves on failure');
    assert.equal(existsSync(f.path('client', 'asset-staging')), false, 'staging is cleaned up');
    assert.equal(readFileSync(f.path('client', 'data', 'assets.json'), 'utf8'), V1['data/assets.json']);

    // The good delta then applies and lands exactly on the published state.
    const ok = applyPackage(root, delta, { expectedSha256: deltaWritten.sha256 });
    assert.equal(ok.version, '2.6.2');
    assert.equal(ok.applied, '2.6.2');
    assert.equal(loadInventory(root).inventory, inventoryDigest(afterFiles));
    assert.equal(readFileSync(lookupAsset(root, 'assets/char/avatar/char_101_sora.png').file, 'utf8'), 'sora-v1');
    assert.equal(lookupAsset(root, 'assets/char/avatar/char_003_kalts.png'), null, 'a tombstoned file is no longer served');
    assert.equal(readFileSync(f.path('client', 'data', 'assets.json'), 'utf8'), V1['data/assets.json'], 'the floor stays as the APK shipped it');
  } finally {
    f.cleanup();
  }
});

test('a base plus deltas builds the full chain and only the published set is served', () => {
  const f = fixture();
  try {
    const v1Root = writeTree(f.path('v1'), V1);
    const v2Root = writeTree(f.path('v2'), V2);
    const v3Root = writeTree(f.path('v3'), V3);
    const v1 = scanAssetFiles(v1Root);
    const v2 = scanAssetFiles(v2Root);
    const v3 = scanAssetFiles(v3Root);
    const base = f.path('pkg', 'assets-base-2.6.1.zip');
    const d12 = f.path('pkg', 'assets-delta-2.6.1-2.6.2.zip');
    const d23 = f.path('pkg', 'assets-delta-2.6.2-2.6.3.zip');
    writePackage({ out: base, manifest: planPackage({ kind: KIND_BASE, version: '2.6.1', after: v1 }), root: v1Root, state: stateFromInventory('2.6.1', v1) });
    writePackage({ out: d12, manifest: planPackage({ kind: KIND_DELTA, version: '2.6.2', from: '2.6.1', before: v1, after: v2 }), root: v2Root });
    writePackage({ out: d23, manifest: planPackage({ kind: KIND_DELTA, version: '2.6.3', from: '2.6.2', before: v2, after: v3 }), root: v3Root });

    const root = writeTree(f.path('device'), V1);
    stampRoot(root, '2.6.1');
    applyPackage(root, base);
    applyPackage(root, d12);
    applyPackage(root, d23);
    const inventory = loadInventory(root);
    assert.equal(inventory.version, '2.6.3');
    assert.equal(inventory.inventory, inventoryDigest(v3));
    assert.equal(readStore(root).layers.length, 3, 'every delta is kept on top of the floor');
    assert.equal(readFileSync(lookupAsset(root, 'assets/local/scene/board.png').file, 'utf8'), 'board-v3');

    const hit = lookupAsset(root, 'assets/local/scene/board.png');
    assert.equal(hit.layer, '0003-delta-2.6.2-2.6.3');
    assert.equal(lookupAsset(root, 'fonts/bender-regular.woff2'), null, 'a removed file is not resurrected from an older layer');
    assert.equal(lookupAsset(root, 'js/main.js'), null, 'only asset paths are served from the runtime store');
    assert.equal(lookupAsset(root, '../evil.txt'), null);
    assert.equal(lookupAsset(root, 'data/assets.json').layer, '0003-delta-2.6.2-2.6.3');
  } finally {
    f.cleanup();
  }
});

test('the index picks the shortest safe route and falls back to a base when the chain is unsafe', () => {
  const f = fixture();
  try {
    const roots = {
      '2.6.1': writeTree(f.path('v1'), V1),
      '2.6.2': writeTree(f.path('v2'), V2),
      '2.6.3': writeTree(f.path('v3'), V3)
    };
    const trees = {};
    for (const [version, root] of Object.entries(roots)) trees[version] = scanAssetFiles(root);
    const packages = [];
    const files = [
      ['base', '2.6.1', null, roots['2.6.1']],
      ['base', '2.6.2', null, roots['2.6.2']],
      ['delta', '2.6.2', '2.6.1', roots['2.6.2']],
      ['delta', '2.6.3', '2.6.2', roots['2.6.3']]
    ];
    for (const [kind, version, from, root] of files) {
      const before = from ? trees[from] : null;
      const manifest = planPackage({ kind, version, from, before, after: trees[version] });
      const name = kind === KIND_BASE ? `assets-base-${version}.zip` : `assets-delta-${from}-${version}.zip`;
      const out = f.path('pkg', name);
      const written = writePackage({ out, manifest, root });
      packages.push({
        kind,
        version,
        from,
        name,
        size: written.size,
        sha256: written.sha256,
        inventory: manifest.inventory,
        count: manifest.count,
        bytes: manifest.bytes
      });
    }
    const index = buildIndex({ latest: '2.6.3', packages, maxChain: 3 });
    assert.deepEqual(checkIndex(index), []);
    assert.deepEqual(index.bases.map((item) => item.version), ['2.6.1', '2.6.2']);
    assert.deepEqual(index.deltas.map((item) => `${item.from}->${item.to}`), ['2.6.1->2.6.2', '2.6.2->2.6.3']);
    const indexFile = f.path('pkg', INDEX_FILE);
    writeIndex(indexFile, index);
    assert.equal(readIndex(indexFile).latest, '2.6.3');

    const deltaRoute = planRoute(index, { version: '2.6.1', inventory: index.versions['2.6.1'].inventory });
    assert.equal(deltaRoute.status, 'update');
    assert.equal(deltaRoute.route.kind, KIND_DELTA);
    assert.deepEqual(deltaRoute.route.steps.map((step) => step.name), ['assets-delta-2.6.1-2.6.2.zip', 'assets-delta-2.6.2-2.6.3.zip']);
    assert.equal(deltaRoute.route.steps[1].from, '2.6.2');

    const preferBase = planRoute(index, { version: '2.6.1', inventory: index.versions['2.6.1'].inventory }, { preferDelta: false });
    assert.equal(preferBase.route.kind, KIND_BASE);
    assert.equal(preferBase.route.steps.length, 2, 'a base plus one delta');

    const current = planRoute(index, { version: '2.6.3', inventory: index.versions['2.6.3'].inventory });
    assert.equal(current.status, 'current');
    assert.equal(current.route, null);

    const longChain = planRoute(index, { version: '2.6.1', inventory: index.versions['2.6.1'].inventory }, { maxChain: 1 });
    assert.equal(longChain.status, 'update');
    assert.equal(longChain.route.kind, KIND_BASE, 'a chain that is too long uses a base instead');
    assert.ok(longChain.base.bytes >= 0);

    const drift = planRoute(index, { version: '2.6.1', inventory: 'd'.repeat(64) });
    assert.equal(drift.status, 'repair');
    assert.equal(drift.verification, 'mismatch');
    assert.match(drift.reason, /does not match published/);
    assert.equal(drift.route.kind, KIND_BASE);

    const fresh = planRoute(index, null);
    assert.equal(fresh.status, 'repair');
    assert.equal(fresh.verification, 'unknown');
    assert.equal(fresh.route.steps[0].name, 'assets-base-2.6.2.zip', 'the fresh route is the shortest one');

    const unpublished = planRoute(index, { version: '9.9.9', inventory: 'e'.repeat(64) });
    assert.equal(unpublished.verification, 'unpublished');
    assert.equal(unpublished.route.kind, KIND_BASE);

    const stale = buildIndex({ latest: '9.9.9', packages, maxChain: 3 });
    const blocked = planRoute(stale, { version: '2.6.1', inventory: index.versions['2.6.1'].inventory });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.route, null);
    assert.match(blocked.reason, /no route to the latest version/);

    const badIndex = buildIndex({ latest: '2.6.1', packages: [{ kind: KIND_BASE, version: '2.6.1', name: 'assets-base-2.6.2.zip', size: 1, sha256: 'a'.repeat(64) }] });
    assert.ok(checkIndex(badIndex).some((line) => /does not match 2\.6\.1/.test(line)));
  } finally {
    f.cleanup();
  }
});

test('a release publishes a delta when it can and a baseline when it must', () => {
  const f = fixture();
  try {
    const roots = {
      '2.6.1': writeTree(f.path('v1'), V1),
      '2.6.2': writeTree(f.path('v2'), V2),
      '2.6.3': writeTree(f.path('v3'), V3)
    };
    const trees = {};
    for (const [version, root] of Object.entries(roots)) trees[version] = scanAssetFiles(root);
    const digests = {};
    for (const [version, tree] of Object.entries(trees)) digests[version] = inventoryDigest(tree);

    const written = [];
    for (const [kind, version, from, root] of [
      ['base', '2.6.1', null, roots['2.6.1']],
      ['delta', '2.6.2', '2.6.1', roots['2.6.2']],
      ['delta', '2.6.3', '2.6.2', roots['2.6.3']]
    ]) {
      const before = from ? trees[from] : null;
      const manifest = planPackage({ kind, version, from, before, after: trees[version] });
      const name = kind === KIND_BASE ? `assets-base-${version}.zip` : `assets-delta-${from}-${version}.zip`;
      const item = writePackage({ out: f.path('pkg', name), manifest, root });
      written.push({
        kind, version, from, name, size: item.size, sha256: item.sha256, inventory: manifest.inventory,
        fromInventory: manifest.fromInventory || null, count: manifest.count, bytes: manifest.bytes
      });
    }
    const index = buildIndex({ latest: '2.6.3', packages: written, maxChain: 3 });

    // A delta teaches the index the published inventory of the version it starts from, even when no package
    // of that version exists, so a client at 2.6.1 still gets a verified route.
    const deltasOnly = buildIndex({ latest: '2.6.3', packages: written.filter((item) => item.kind === KIND_DELTA), maxChain: 3 });
    assert.deepEqual(deltasOnly.bases, [], 'a delta-only index still has to route a client');
    assert.deepEqual(deltasOnly.versions['2.6.1'], { inventory: digests['2.6.1'], count: 0, bytes: 0 });
    assert.equal(deltasOnly.versions['2.6.3'].inventory, digests['2.6.3']);
    const fromKnown = planRoute(deltasOnly, { version: '2.6.1', inventory: deltasOnly.versions['2.6.1'].inventory });
    assert.equal(fromKnown.verification, 'ok');
    assert.equal(fromKnown.route.kind, KIND_DELTA);
    assert.deepEqual(fromKnown.route.steps.map((step) => step.name), ['assets-delta-2.6.1-2.6.2.zip', 'assets-delta-2.6.2-2.6.3.zip']);

    // The first release of all has to publish a baseline.
    const first = planRelease({ index: null, afterDigest: digests['2.6.1'], beforeDigest: null, from: null, to: '2.6.1' });
    assert.deepEqual([first.base, first.delta], [true, false]);
    assert.ok(first.notes.some((note) => /no baseline has been published yet/.test(note)));

    // A release whose previous tree is what was published only needs the delta.
    const routine = planRelease({ index, afterDigest: digests['2.6.3'], beforeDigest: digests['2.6.2'], from: '2.6.2', to: '2.6.3' });
    assert.deepEqual([routine.base, routine.delta], [false, true], routine.notes.join('; '));

    // A previous tree that no longer matches what was published would reach nobody, so publish a baseline.
    const driftedRelease = planRelease({ index, afterDigest: digests['2.6.3'], beforeDigest: 'd'.repeat(64), from: '2.6.2', to: '2.6.3' });
    assert.deepEqual([driftedRelease.base, driftedRelease.delta], [true, true]);
    assert.ok(driftedRelease.notes.some((note) => /does not match the published inventory of 2\.6\.2/.test(note)));

    // A chain that would grow past the client limit is cut by a fresh baseline.
    const longChain = planRelease({ index, afterDigest: digests['2.6.3'], beforeDigest: digests['2.6.2'], from: '2.6.2', to: '2.6.3', maxChain: 1 });
    assert.equal(longChain.base, true);
    assert.ok(longChain.notes.some((note) => /exceed the client limit of 1/.test(note)));

    // A mainline release always starts a new baseline and needs no delta across it.
    const mainline = planRelease({ index, afterDigest: digests['2.6.3'], beforeDigest: digests['2.6.2'], from: '2.6.2', to: '2.6.3', mainline: true });
    assert.deepEqual([mainline.base, mainline.delta], [true, false]);

    // An unchanged asset set publishes no package at all: the index points the new version at the
    // already published payload, so the same bytes are never uploaded twice under a new version name.
    const unchanged = planRelease({ index, afterDigest: digests['2.6.3'], beforeDigest: digests['2.6.3'], from: '2.6.3', to: '2.6.4' });
    assert.deepEqual([unchanged.base, unchanged.delta], [false, false]);
    assert.equal(unchanged.reuse.version, '2.6.3');
    assert.equal(unchanged.reuse.via, KIND_DELTA);
    assert.ok(unchanged.notes.some((note) => /identical to published 2\.6\.3/.test(note)));
    assert.ok(unchanged.notes.some((note) => /needs no delta from 2\.6\.3/.test(note)));

    // Publishing that metadata-only release records the pointer in the index. No package is added, and a
    // client that already holds the reused payload is up to date instead of being reported as stranded.
    const reuseIndex = {
      ...index,
      latest: '2.6.4',
      versions: {
        ...index.versions,
        '2.6.4': { inventory: digests['2.6.3'], count: 0, bytes: 0, reused: '2.6.3', reusedVia: KIND_DELTA }
      }
    };
    assert.deepEqual(checkIndex(reuseIndex), []);
    assert.equal(reuseIndex.bases.length, index.bases.length, 'a metadata-only release publishes no base');
    assert.equal(reuseIndex.deltas.length, index.deltas.length, 'a metadata-only release publishes no delta');
    const onPayload = planRoute(reuseIndex, { version: '2.6.3', inventory: digests['2.6.3'] });
    assert.equal(onPayload.status, 'current', onPayload.reason);
    assert.equal(onPayload.providerVersion, '2.6.3');
    assert.equal(onPayload.verification, 'ok');
    const onAlias = planRoute(reuseIndex, { version: '2.6.4', inventory: digests['2.6.3'] });
    assert.equal(onAlias.status, 'current', onAlias.reason);
    assert.equal(onAlias.providerVersion, '2.6.3');
    assert.deepEqual(strandedVersions(reuseIndex), []);

    // A pointer at a version the index does not publish is rejected instead of routing nowhere.
    const brokenPointer = { ...reuseIndex, versions: { ...reuseIndex.versions, '2.6.4': { inventory: digests['2.6.3'], count: 0, bytes: 0, reused: '9.9.9' } } };
    assert.ok(checkIndex(brokenPointer).some((line) => /reuses 9\.9\.9, which the index does not publish/.test(line)));

    // Without a previous tree only a baseline can be published, and a version without any route is stranded.
    const noPrevious = planRelease({ index, afterDigest: digests['2.6.3'] });
    assert.deepEqual([noPrevious.base, noPrevious.delta], [true, false]);
    assert.deepEqual(strandedVersions(index), []);
    const staleIndex = buildIndex({ latest: '9.9.9', packages: written, maxChain: 3 });
    assert.deepEqual(strandedVersions(staleIndex).sort(), ['2.6.1', '2.6.2', '2.6.3'], 'no version can reach 9.9.9');
  } finally {
    f.cleanup();
  }
});

test('the public configuration refuses secrets and degrades safely when it is not set', () => {
  const good = makeConfig({ indexUrl: 'https://assets.example.test/stronghold/assets-index.json' });
  assert.deepEqual(checkConfig(good), []);
  assert.equal(good.format, 'sp-assets-config-v1');
  assert.equal(good.maxChain, 3);
  assert.equal(good.indexUrl, 'https://assets.example.test/stronghold/assets-index.json');

  const cases = [
    [makeConfig({}), /indexUrl is required/],
    [makeConfig({ indexUrl: 'ftp://example.test/index.json' }), /must be an http\(s\) URL/],
    [makeConfig({ indexUrl: 'https://user:secret@example.test/index.json' }), /credentials/],
    [makeConfig({ indexUrl: 'https://example.test/index.json?X-Amz-Signature=abc' }), /signature/],
    [makeConfig({ indexUrl: 'http://example.test/index.json' }), /must use https/],
    [{ ...good, format: 'other' }, /format/],
    [{ ...good, maxChain: 0 }, /maxChain/]
  ];
  for (const [config, pattern] of cases) {
    const problems = checkConfig(config);
    assert.ok(problems.length, `expected a problem for ${JSON.stringify(config)}`);
    assert.ok(problems.some((line) => pattern.test(line)), `${JSON.stringify(config)}: ${problems.join('; ')}`);
  }
  assert.deepEqual(checkConfig(makeConfig({ indexUrl: 'http://10.0.0.5/index.json', allowHttp: true })), []);
});
