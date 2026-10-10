import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_CLIENT_RUNTIME_FILES,
  missingClientRuntimeFiles,
  validateClientRuntime,
} from '../tools/validate-client-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-android-runtime-'));
  for (const relative of REQUIRED_CLIENT_RUNTIME_FILES) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'runtime');
  }
  return root;
}

test('Android embedded runtime validation accepts a complete module graph', () => {
  const root = runtimeFixture();
  try {
    assert.deepEqual(missingClientRuntimeFiles(root), []);
    assert.doesNotThrow(() => validateClientRuntime(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Android embedded runtime validation reports every missing generated dependency', () => {
  const root = runtimeFixture();
  try {
    for (const relative of ['vendor/preact.module.js', 'vendor/pixi.min.js', 'fonts/fonts.css']) {
      fs.rmSync(path.join(root, ...relative.split('/')));
    }
    assert.deepEqual(missingClientRuntimeFiles(root), [
      'vendor/preact.module.js',
      'vendor/pixi.min.js',
      'fonts/fonts.css',
    ]);
    assert.throws(() => validateClientRuntime(root), /vendor\/preact\.module\.js[\s\S]*fonts\/fonts\.css/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Android build prepares vendors and validates the copied runtime before Gradle', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/build-android-client.ps1'), 'utf8');
  const releaseScript = fs.readFileSync(path.join(ROOT, 'scripts/publish-client-release.ps1'), 'utf8');
  const vendor = script.indexOf('tools\\vendor.mjs');
  const validate = script.indexOf('tools\\validate-client-runtime.mjs');
  const gradle = script.indexOf('assembleDebug');
  assert.ok(vendor >= 0, 'the Android build generates ignored vendor files');
  assert.ok(validate > vendor, 'validation runs after vendor preparation');
  assert.ok(gradle > validate, 'validation runs before Gradle packages the APK');
  assert.match(script, /ResourceSourceDir/, 'a release worktree can reuse the prepared assets and fonts');
  assert.match(releaseScript, /AndroidResourceSourceDir/, 'the release entry point exposes the resource source');
  assert.match(releaseScript, /AndroidArguments\.ResourceSourceDir = \$AndroidResourceSourceDir/,
    'the release entry point forwards the resource source to the Android build');
});
