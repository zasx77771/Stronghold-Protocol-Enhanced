import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBinaryDelta, applyWindowsDelta, createBinaryDelta, createWindowsDelta, sha256File,
} from '../tools/clientDelta.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stronghold-client-delta-'));
  return { root, path: (...parts) => join(root, ...parts), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Windows client delta copies changed files, removes old files, and verifies the base tree', async () => {
  const f = fixture();
  try {
    const from = f.path('from'); const to = f.path('to'); const pkg = f.path('package'); const installed = f.path('installed');
    for (const dir of [from, to, installed]) mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(from, 'same.txt'), 'same'); writeFileSync(join(from, 'nested', 'changed.txt'), 'old'); writeFileSync(join(from, 'removed.txt'), 'remove me');
    writeFileSync(join(to, 'same.txt'), 'same'); writeFileSync(join(to, 'nested', 'changed.txt'), 'new'); writeFileSync(join(to, 'nested', 'added.txt'), 'added');
    writeFileSync(join(installed, 'same.txt'), 'same'); writeFileSync(join(installed, 'nested', 'changed.txt'), 'old'); writeFileSync(join(installed, 'removed.txt'), 'remove me');
    const built = await createWindowsDelta({ fromDir: from, toDir: to, outDir: pkg, fromVersion: '1.0.0', toVersion: '1.1.0' });
    assert.deepEqual(built.manifest.removed, ['removed.txt']);
    assert.deepEqual(built.manifest.changed.map((file) => file.path), ['nested/added.txt', 'nested/changed.txt']);
    await applyWindowsDelta({ packageDir: pkg, targetDir: installed });
    assert.equal(readFileSync(join(installed, 'nested', 'changed.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(installed, 'nested', 'added.txt'), 'utf8'), 'added');
    assert.throws(() => readFileSync(join(installed, 'removed.txt')));
    await assert.rejects(() => applyWindowsDelta({ packageDir: pkg, targetDir: installed }), /expected base version/);
  } finally { f.cleanup(); }
});

test('Android binary delta reconstructs the exact signed target bytes and rejects an unrelated APK', async () => {
  const f = fixture();
  try {
    const from = f.path('old.apk'); const target = f.path('new.apk'); const delta = f.path('update.spdelta'); const output = f.path('rebuilt.apk'); const wrong = f.path('wrong.apk');
    const chunk = Buffer.alloc(32 * 1024, 7);
    const old = Buffer.concat([chunk, Buffer.from('stable-data'), chunk, Buffer.from('old trailer')]);
    const next = Buffer.concat([chunk, Buffer.from('stable-data'), chunk, Buffer.from('new trailer and a little more')]);
    writeFileSync(from, old); writeFileSync(target, next); writeFileSync(wrong, Buffer.from('not the expected apk'));
    const built = await createBinaryDelta({ fromFile: from, toFile: target, outFile: delta, blockSize: 32 * 1024 });
    assert.ok(built.patchBytes < next.length, 'unchanged blocks are referenced instead of copied');
    const applied = await applyBinaryDelta({ fromFile: from, deltaFile: delta, outFile: output });
    assert.equal(applied.sha256, await sha256File(target));
    assert.deepEqual(readFileSync(output), next);
    await assert.rejects(() => applyBinaryDelta({ fromFile: wrong, deltaFile: delta, outFile: f.path('bad.apk') }), /expected base version/);
  } finally { f.cleanup(); }
});
