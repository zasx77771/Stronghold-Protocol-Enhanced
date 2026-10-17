import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  INDEX_FILE, inventoryDigest, planPackage, scanAssetFiles, sha256File, writeIndex, writePackage
} from '../tools/assetPackages.mjs';
import {
  PLAN_FORMAT, buildPlan, loadChannel, parseSnapshot, planToJson, readSnapshot, run
} from '../tools/r2-sync-plan.mjs';

/*
 * An offline fixture of the shape the real 2.6.3 channel has: one content-addressed baseline, an optional
 * content-addressed delta, and the signed index metadata. Nothing here touches the network; the "bucket"
 * is a JSON file that a read-only `list-objects-v2` would have produced.
 */
const V263 = {
  'assets/char/avatar/char_002_amiya.png': 'amiya-2.6.3',
  'assets/char/avatar/char_101_sora.png': 'sora-2.6.3',
  'fonts/bender-regular.woff2': 'font-2.6.3',
  'data/assets.json': '{"version":"2.6.3"}'
};
// 2.6.4 ships no game art: the tree is byte-for-byte the 2.6.3 tree.
const V264 = { ...V263 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stronghold-r2-sync-'));
  return { root, path: (...parts) => join(root, ...parts), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeTree(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return dir;
}

/**
 * Build a channel directory with a 2.6.3 baseline (plus an optional 2.6.3 -> 2.6.4 delta) and the index.
 * `reuse` records a metadata-only 2.6.4 exactly like `tools/assets-r2.mjs publish-version` does.
 */
function makeChannel(f, { delta = false, reuse = null, latest = '2.6.3' } = {}) {
  const channel = f.path('channel');
  mkdirSync(channel, { recursive: true });
  const beforeRoot = writeTree(f.path('tree-2.6.3'), V263);
  const afterRoot = writeTree(f.path('tree-2.6.4'), V264);
  const before = scanAssetFiles(beforeRoot);
  const after = scanAssetFiles(afterRoot);
  const digest = inventoryDigest(before);
  assert.equal(inventoryDigest(after), digest, 'the fixture trees are byte-identical');

  const basePlan = planPackage({ kind: 'base', version: '2.6.3', before: null, after: before });
  const base = writePackage({ out: join(channel, 'assets-base-2.6.3.zip'), manifest: basePlan, root: beforeRoot });
  const bases = [{ version: '2.6.3', name: 'assets-base-2.6.3.zip', size: base.size, sha256: base.sha256 }];
  const deltas = [];
  const versions = { '2.6.3': { inventory: digest, count: basePlan.count, bytes: basePlan.bytes } };
  if (delta) {
    const deltaPlan = planPackage({ kind: 'delta', version: '2.6.4', from: '2.6.3', before, after });
    const item = writePackage({ out: join(channel, 'assets-delta-2.6.3-2.6.4.zip'), manifest: deltaPlan, root: afterRoot });
    deltas.push({ from: '2.6.3', to: '2.6.4', name: 'assets-delta-2.6.3-2.6.4.zip', size: item.size, sha256: item.sha256 });
    versions['2.6.4'] = { inventory: digest, count: deltaPlan.count, bytes: deltaPlan.bytes };
  }
  if (reuse) {
    versions['2.6.4'] = { inventory: digest, count: basePlan.count, bytes: basePlan.bytes, reused: reuse, reusedVia: 'base' };
  }
  const index = { format: 'sp-assets-index-v1', latest, maxChain: 3, versions, bases, deltas };
  writeIndex(join(channel, INDEX_FILE), index);
  return { channel, index, digest };
}

/** A bucket snapshot that lists every object in `channel` as healthy, like a fresh listing. */
function healthySnapshot(channel, { omit = [], override = {} } = {}) {
  const objects = [];
  for (const name of readdirSync(channel).sort()) {
    if (omit.includes(name)) continue;
    const file = join(channel, name);
    const entry = override[name] || {};
    objects.push({
      key: name,
      size: entry.size === undefined ? statSync(file).size : entry.size,
      sha256: entry.sha256 === undefined ? sha256File(file) : entry.sha256
    });
  }
  return { format: 'sp-assets-r2-snapshot-v1', objects };
}

/** Call the CLI entry point in process so both the exit status and the printed plan are checked. */
function capture(argv) {
  const lines = [];
  const code = run(argv, { out: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
}

test('the 2.6.4 index reuses the published 2.6.3 baseline and plans zero uploads', () => {
  const f = fixture();
  try {
    const { channel, digest } = makeChannel(f, { reuse: '2.6.3' });
    const index = JSON.parse(readFileSync(join(channel, INDEX_FILE), 'utf8'));
    assert.equal(index.latest, '2.6.3');
    assert.equal(index.versions['2.6.4'].reused, '2.6.3');
    assert.equal(index.versions['2.6.4'].inventory, digest, '2.6.4 keeps the 2.6.3 inventory');
    assert.deepEqual(index.bases.map((item) => item.name), ['assets-base-2.6.3.zip'], 'no 2.6.4 ZIP is written');
    assert.deepEqual(index.deltas, [], 'no 2.6.4 delta is written');

    // The bucket already holds the baseline and that same index: nothing has to move.
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel)));
    const channelState = loadChannel(channel);
    assert.deepEqual(channelState.problems, []);
    const plan = buildPlan({ channel: channelState, snapshot: readSnapshot(snapshotFile) });
    assert.equal(plan.complete, true);
    assert.deepEqual(plan.counts, {
      objects: 2, packages: 1, missing: 0, mismatched: 0, unverifiable: 0, upToDate: 2,
      uploads: 0, verifications: 0, indexPublishes: 0
    });
    assert.deepEqual(plan.uploads, []);
    assert.deepEqual(Object.values(plan.contentIndex), [['assets-base-2.6.3.zip']], 'content maps to one key');
    assert.deepEqual(plan.packages.map((item) => item.key), ['assets-base-2.6.3.zip']);
    assert.equal(plan.indexPublish, null);
    assert.match(planToJson(plan), new RegExp(`"format":"${PLAN_FORMAT}"`));

    const cli = capture(['--dir', channel, '--snapshot', snapshotFile]);
    assert.equal(cli.code, 0);
    assert.match(cli.text, /the bucket already serves this channel; nothing to do/);
    assert.doesNotMatch(cli.text, /INCOMPLETE/);
    assert.doesNotMatch(cli.text, /aws s3 cp/);
  } finally {
    f.cleanup();
  }
});

test('a release that only rewrites the index publishes it last and uploads no package', () => {
  const f = fixture();
  try {
    // 2.6.4 moves `latest` forward over the reused 2.6.3 payload: the only object that changes is the index.
    const { channel } = makeChannel(f, { reuse: '2.6.3', latest: '2.6.4' });
    const current = readFileSync(join(channel, INDEX_FILE), 'utf8');
    // The bucket still holds the previous index, which differs by bytes and not by size.
    const previous = current.replace('"latest":"2.6.4"', '"latest":"2.6.3"');
    assert.notEqual(previous, current);
    assert.equal(Buffer.byteLength(previous), Buffer.byteLength(current), 'the published index has the same size');
    const staleFile = f.path('stale-index.json');
    writeFileSync(staleFile, previous);
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel, {
      override: { [INDEX_FILE]: { sha256: sha256File(staleFile) } }
    })));

    const plan = buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) });
    assert.equal(plan.complete, true);
    assert.equal(plan.counts.uploads, 0, 'a metadata-only release uploads no package');
    assert.equal(plan.counts.mismatched, 1, 'the stale index is detected by hash at an equal size');
    assert.equal(plan.counts.indexPublishes, 1);
    assert.equal(plan.indexPublishedLast, true);
    assert.deepEqual(plan.operations.map((operation) => operation.action), ['publish-index']);

    const cli = capture(['--dir', channel, '--snapshot', snapshotFile, '--commands']);
    assert.equal(cli.code, 0);
    assert.match(cli.text, /aws s3 cp "assets-index\.json"/);
    assert.doesNotMatch(cli.text, /aws s3 cp "assets-base/);
  } finally {
    f.cleanup();
  }
});

test('two keys carrying identical bytes are refused as one content-addressed object twice', () => {
  const f = fixture();
  try {
    // The shape a naive version bump would produce: 2.6.4 copies the 2.6.3 baseline under a new name
    // instead of reusing the published payload.
    const { channel, index, digest } = makeChannel(f);
    const base = join(channel, 'assets-base-2.6.3.zip');
    copyFileSync(base, join(channel, 'assets-base-2.6.4.zip'));
    index.latest = '2.6.4';
    index.versions['2.6.4'] = { inventory: digest, count: index.versions['2.6.3'].count, bytes: index.versions['2.6.3'].bytes };
    index.bases.push({ version: '2.6.4', name: 'assets-base-2.6.4.zip', size: statSync(base).size, sha256: sha256File(base) });
    writeIndex(join(channel, INDEX_FILE), index);

    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel)));
    const state = loadChannel(channel);
    assert.ok(
      state.problems.some((line) => /assets-base-2\.6\.3\.zip and assets-base-2\.6\.4\.zip carry identical content/.test(line)),
      state.problems.join('; ')
    );
    const plan = buildPlan({ channel: state, snapshot: readSnapshot(snapshotFile) });
    assert.deepEqual(Object.values(plan.contentIndex), [['assets-base-2.6.3.zip', 'assets-base-2.6.4.zip']]);

    const cli = capture(['--dir', channel, '--snapshot', snapshotFile]);
    assert.equal(cli.code, 1);
    assert.match(cli.text, /carry identical content/);
    assert.match(cli.text, /INCOMPLETE: the plan cannot be proven complete/);
    assert.doesNotMatch(cli.text, /aws s3 cp/, 'a duplicated upload is never printed as a plan');
  } finally {
    f.cleanup();
  }
});

test('a missing content-addressed object is detected with its exact key and hash, and only it is uploaded', () => {
  const f = fixture();
  try {
    const { channel } = makeChannel(f, { delta: true });
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel, { omit: ['assets-delta-2.6.3-2.6.4.zip'] })));
    const plan = buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) });
    assert.equal(plan.complete, true, plan.problems.join('; '));
    assert.equal(plan.counts.missing, 1);
    assert.equal(plan.counts.mismatched, 0);
    assert.deepEqual(plan.uploads.map((item) => item.key), ['assets-delta-2.6.3-2.6.4.zip']);
    const upload = plan.uploads[0];
    assert.equal(upload.action, 'upload');
    assert.equal(upload.bucket, 'r2');
    assert.equal(upload.sha256, sha256File(join(channel, 'assets-delta-2.6.3-2.6.4.zip')));
    assert.equal(upload.kind, 'delta');
    assert.equal(upload.version, '2.6.4');
    assert.equal(upload.from, '2.6.3');
    assert.match(upload.reason, /missing in the bucket snapshot/);
    assert.deepEqual(plan.upToDate, ['assets-base-2.6.3.zip', 'assets-index.json']);
    assert.equal(plan.verifications.length, 1);
    assert.equal(plan.verifications[0].key, upload.key);
    assert.deepEqual(plan.verifications[0].expect, { size: upload.size, sha256: upload.sha256 });
    assert.equal(plan.verifications[0].order, upload.order + 1);
    assert.deepEqual(plan.verifications[0].verify, ['size', 'sha256', 'content-type', 'cache-control']);
    assert.equal(plan.indexPublish, null, 'the index is already correct, so it is not republished');
  } finally {
    f.cleanup();
  }
});

test('a hash mismatch and a size mismatch are reported with what the snapshot says', () => {
  const f = fixture();
  try {
    const { channel } = makeChannel(f, { delta: true });
    const deltaFile = join(channel, 'assets-delta-2.6.3-2.6.4.zip');
    const baseFile = join(channel, 'assets-base-2.6.3.zip');
    const good = { size: statSync(deltaFile).size, sha256: sha256File(deltaFile) };
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel, {
      override: {
        'assets-delta-2.6.3-2.6.4.zip': { size: good.size, sha256: 'f'.repeat(64) },
        'assets-base-2.6.3.zip': { size: statSync(baseFile).size + 1, sha256: sha256File(baseFile) }
      }
    })));
    const plan = buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) });
    assert.equal(plan.complete, true, plan.problems.join('; '));
    assert.equal(plan.counts.missing, 0);
    assert.equal(plan.counts.mismatched, 2);
    assert.deepEqual(plan.uploads.map((item) => item.key), ['assets-base-2.6.3.zip', 'assets-delta-2.6.3-2.6.4.zip'], 'sorted by key');
    const delta = plan.uploads.find((item) => item.key === 'assets-delta-2.6.3-2.6.4.zip');
    assert.equal(delta.sha256, good.sha256, 'the plan carries the expected hash, not the snapshot hash');
    assert.equal(delta.size, good.size);
    assert.match(delta.reason, /does not match the index/);
    const base = plan.uploads.find((item) => item.key === 'assets-base-2.6.3.zip');
    assert.equal(base.size, statSync(baseFile).size, 'the expected size comes from the local channel');
    // Every difference names the key, the expected hash/size and what the snapshot says.
    const detail = plan.operations.filter((item) => item.action === 'upload').map((item) => item.key);
    assert.deepEqual(detail, ['assets-base-2.6.3.zip', 'assets-delta-2.6.3-2.6.4.zip']);

    const strict = capture(['--dir', channel, '--snapshot', snapshotFile]);
    assert.equal(strict.code, 0);
    assert.match(strict.text, /2 mismatched/);
  } finally {
    f.cleanup();
  }
});

test('a snapshot without any digest is unverifiable and the plan is refused', () => {
  const f = fixture();
  try {
    const { channel } = makeChannel(f, { delta: true });
    const opaque = f.path('opaque.json');
    writeFileSync(opaque, JSON.stringify({
      objects: [
        { key: 'assets-base-2.6.3.zip', size: statSync(join(channel, 'assets-base-2.6.3.zip')).size },
        { key: 'assets-delta-2.6.3-2.6.4.zip', size: statSync(join(channel, 'assets-delta-2.6.3-2.6.4.zip')).size },
        { key: 'assets-index.json', size: statSync(join(channel, 'assets-index.json')).size }
      ]
    }));
    const cli = capture(['--dir', channel, '--snapshot', opaque]);
    assert.equal(cli.code, 1);
    assert.match(cli.text, /unverifiable/);
    assert.match(cli.text, /INCOMPLETE: the plan cannot be proven complete/);
    assert.doesNotMatch(cli.text, /aws s3 cp/);
  } finally {
    f.cleanup();
  }
});

test('the plan is exactly uploads, then head-object verification, then the index metadata last', () => {
  const f = fixture();
  try {
    const { channel } = makeChannel(f, { delta: true });
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel, {
      omit: ['assets-delta-2.6.3-2.6.4.zip'],
      override: { 'assets-index.json': { size: 1, sha256: '0'.repeat(64) } }
    })));
    const plan = buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) });
    assert.equal(plan.complete, true, plan.problems.join('; '));
    assert.deepEqual(
      plan.operations.map((item) => [item.order, item.action, item.key]),
      [
        [1, 'upload', 'assets-delta-2.6.3-2.6.4.zip'],
        [2, 'head-object', 'assets-delta-2.6.3-2.6.4.zip'],
        [3, 'publish-index', INDEX_FILE]
      ]
    );
    assert.equal(plan.indexPublishedLast, true);
    assert.equal(plan.operations.at(-1).action, 'publish-index');
    assert.equal(plan.indexPublish.key, INDEX_FILE);
    assert.equal(plan.indexPublish.sha256, sha256File(join(channel, INDEX_FILE)));
    assert.match(plan.indexPublish.reason, /does not match the bucket snapshot/);

    const cli = capture(['--dir', channel, '--snapshot', snapshotFile, '--commands']);
    assert.equal(cli.code, 0);
    assert.match(cli.text, /aws s3 cp "assets-delta-2.6.3-2.6.4.zip"/);
    assert.match(cli.text, /aws s3api head-object --bucket r2 --key "assets-delta-2.6.3-2.6.4.zip"/);
    assert.match(cli.text, /aws s3 cp "assets-index.json"/);
    assert.match(cli.text, /--content-type application\/json/);
    const lines = cli.text.split('\n');
    assert.ok(
      lines.findIndex((line) => line.includes('head-object --bucket')) < lines.findIndex((line) => line.includes('cp "assets-index.json"')),
      'the index is published last'
    );
  } finally {
    f.cleanup();
  }
});

test('a snapshot that cannot prove the object set is refused instead of printing a misleading plan', () => {
  const f = fixture();
  try {
    const { channel } = makeChannel(f, { delta: true });
    const empty = f.path('empty.json');
    writeFileSync(empty, JSON.stringify({ format: 'sp-assets-r2-snapshot-v1', objects: [] }));
    const cli = capture(['--dir', channel, '--snapshot', empty]);
    assert.equal(cli.code, 1);
    assert.match(cli.text, /lists no objects at all/);
    assert.match(cli.text, /INCOMPLETE: the plan cannot be proven complete/);
    assert.doesNotMatch(cli.text, /aws s3 cp/, 'nothing that looks like a finished upload is printed');

    // The first publish of a genuinely empty bucket is an explicit, deliberate decision.
    const allowed = capture(['--dir', channel, '--snapshot', empty, '--allow-empty-bucket']);
    assert.equal(allowed.code, 0);
    assert.match(allowed.text, /aws s3 cp "assets-base-2.6.3.zip"/);
    assert.match(allowed.text, /aws s3 cp "assets-delta-2.6.3-2.6.4.zip"/);
    assert.match(allowed.text, /aws s3 cp "assets-index.json"/);

    const missingSnapshot = capture(['--dir', channel]);
    assert.equal(missingSnapshot.code, 1);
    assert.match(missingSnapshot.text, /--snapshot is required/);
    const broken = capture(['--dir', channel, '--snapshot', f.path('does-not-exist.json')]);
    assert.equal(broken.code, 1);
    assert.match(broken.text, /r2-sync-plan: /);
  } finally {
    f.cleanup();
  }
});

test('an index that contradicts the local channel fails before a plan is trusted', () => {
  const f = fixture();
  try {
    const { channel, index } = makeChannel(f, { delta: true });
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel)));
    // The index now serves a base whose name does not match its version and which is not in the directory.
    index.bases[0].name = 'assets-base-2.6.9.zip';
    writeFileSync(join(channel, INDEX_FILE), `${JSON.stringify(index)}\n`);
    const cli = capture(['--dir', channel, '--snapshot', snapshotFile]);
    assert.equal(cli.code, 1);
    assert.match(cli.text, /problem: index: base name assets-base-2\.6\.9\.zip does not match 2\.6\.3/);
    assert.match(cli.text, /problem: assets-base-2\.6\.9\.zip is listed in the index but missing in /);
    assert.match(cli.text, /INCOMPLETE: the plan cannot be proven complete/);
    assert.doesNotMatch(cli.text, /aws s3 cp/, 'an unprovable channel never prints a runbook');

    const commands = capture(['--dir', channel, '--snapshot', snapshotFile, '--commands']);
    assert.equal(commands.code, 1);
    assert.equal(commands.text, '# INCOMPLETE: the plan cannot be proven complete; no commands are emitted');
  } finally {
    f.cleanup();
  }
});

test('two runs over the same inputs are byte-identical, and the tool performs no network I/O', () => {
  const f = fixture();
  try {
    const { channel } = makeChannel(f, { delta: true });
    const snapshotFile = f.path('bucket.json');
    writeFileSync(snapshotFile, JSON.stringify(healthySnapshot(channel, { omit: ['assets-base-2.6.3.zip'] })));
    const first = planToJson(buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) }));
    const second = planToJson(buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) }));
    assert.equal(first, second, 'equal inputs produce byte-identical plans');
    assert.doesNotMatch(first, /"generatedAt"|"timestamp"|"host"|"date"|"mtime"/);
    const firstCli = capture(['--dir', channel, '--snapshot', snapshotFile, '--json']);
    const secondCli = capture(['--dir', channel, '--snapshot', snapshotFile, '--json']);
    assert.equal(firstCli.text, secondCli.text);
    assert.equal(firstCli.text, first.trimEnd());

    // No network: replace fetch with a trap and prove it is never called.
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls += 1; throw new Error('the sync plan must not touch the network'); };
    try {
      const plan = buildPlan({ channel: loadChannel(channel), snapshot: readSnapshot(snapshotFile) });
      assert.equal(plan.counts.uploads, 1);
      assert.equal(plan.uploads[0].key, 'assets-base-2.6.3.zip');
      assert.equal(capture(['--dir', channel, '--snapshot', snapshotFile]).code, 0);
      assert.equal(capture(['--dir', channel, '--snapshot', snapshotFile, '--commands']).code, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 0, 'no network request was attempted');
    const source = readFileSync(new URL('../tools/r2-sync-plan.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|undici|XMLHttpRequest|aws-sdk/, 'the tool imports no network client');
  } finally {
    f.cleanup();
  }
});

test('the snapshot accepts the S3 listing shapes and rejects keys that could escape the bucket root', () => {
  const listing = [
    { Key: 'assets-base-2.6.3.zip', Size: 12, ETag: '"d41d8cd98f00b204e9800998ecf8427e"', Metadata: { 'content-type': 'application/zip' } },
    { key: 'assets-delta-2.6.3-2.6.4.zip', size: 4, sha256: 'a'.repeat(64) }
  ];
  const json = parseSnapshot(JSON.stringify({ Contents: listing }));
  assert.deepEqual(json.problems, []);
  assert.equal(json.objects.size, 2);
  assert.equal(json.objects.get('assets-base-2.6.3.zip').etag, 'd41d8cd98f00b204e9800998ecf8427e');
  assert.deepEqual(json.objects.get('assets-base-2.6.3.zip').metadata, { 'content-type': 'application/zip' });
  assert.equal(json.objects.get('assets-delta-2.6.3-2.6.4.zip').sha256, 'a'.repeat(64));
  assert.equal(json.format, 'sp-assets-r2-snapshot-v1');

  const ndjson = parseSnapshot('{"Key":"assets-base-2.6.3.zip","Size":12}\n{"Key":"assets-delta-2.6.3-2.6.4.zip","Size":4}\n');
  assert.deepEqual(ndjson.problems, []);
  assert.equal(ndjson.objects.size, 2);

  // `aws s3api list-objects-v2 --output json` is pretty-printed: every line of it must be read.
  const pretty = parseSnapshot(JSON.stringify({ objects: listing }, null, 2), { name: 'listing.json' });
  assert.deepEqual(pretty.problems, [], pretty.problems.join('; '));
  assert.equal(pretty.objects.size, 2);
  assert.equal(pretty.objects.get('assets-delta-2.6.3-2.6.4.zip').sha256, 'a'.repeat(64));

  const unsafe = parseSnapshot(JSON.stringify([
    { Key: '../escape.zip', Size: 1 },
    { Key: 'nested/object.zip', Size: 1 },
    { Key: '', Size: 1 }
  ]));
  assert.equal(unsafe.objects.size, 0);
  assert.equal(unsafe.problems.length, 3);

  const duplicated = parseSnapshot(JSON.stringify([{ Key: 'a.zip', Size: 1 }, { Key: 'a.zip', Size: 2 }]));
  assert.equal(duplicated.objects.size, 1);
  assert.equal(duplicated.problems.length, 1);
  assert.match(duplicated.problems[0], /listed twice/);
});
