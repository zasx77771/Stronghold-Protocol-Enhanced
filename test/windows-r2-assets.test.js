import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIndex, planPackage, scanAssetFiles, writeIndex, writePackage,
} from '../tools/assetPackages.mjs';

const require = createRequire(import.meta.url);
const { RuntimeAssetUpdater, configuredUrl, readConfig } = require('../desktop/runtime/assets.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-windows-r2-'));
  return { root, path: (...parts) => path.join(root, ...parts), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Windows runtime configuration refuses unsafe URLs and requires a private token endpoint', () => {
  assert.equal(configuredUrl('https://assets.example.test/assets-index.json')?.hostname, 'assets.example.test');
  for (const value of [
    'http://assets.example.test/assets-index.json',
    'https://user:secret@assets.example.test/assets-index.json',
    'https://assets.example.test/assets-index.json?token=secret',
    'ftp://assets.example.test/assets-index.json',
  ]) assert.equal(configuredUrl(value), null, value);
  const f = fixture();
  try {
    const config = f.path('client', 'asset-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const packages = { checkConfig: () => [], DEFAULT_MAX_CHAIN: 3, DEFAULT_MAX_INDEX_BYTES: 1024, DEFAULT_MAX_DOWNLOAD_BYTES: 2048, DEFAULT_MAX_EXTRACT_BYTES: 4096 };
    fs.writeFileSync(config, JSON.stringify({ format: 'sp-assets-config-v1', indexUrl: 'https://assets.example.test/assets-index.json' }));
    assert.equal(readConfig(f.path('client'), packages).enabled, false);
    fs.writeFileSync(config, JSON.stringify({ format: 'sp-assets-config-v1', indexUrl: 'https://assets.example.test/assets-index.json', tokenUrl: 'https://game.example.test/api/assets/token' }));
    assert.equal(readConfig(f.path('client'), packages).enabled, true);
  } finally { f.cleanup(); }
});

test('Windows runtime downloader refuses a cross-origin redirect before repeating a Worker token', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      assert.equal(init.headers.Authorization, 'Bearer header.payload.signature');
      return new Response(null, { status: 302, headers: { location: 'https://other.example.test/package.zip' } });
    };
    const updater = new RuntimeAssetUpdater({ clientRoot: '', stateRoot: '', packageModule: '' });
    await assert.rejects(
      updater.request('https://worker.example.test/assets-index.json', { allowHttp: false }, 'header.payload.signature'),
      /cross-origin asset redirect is refused/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Windows thin-package and Electron bridge wiring remain explicit', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-windows-client.ps1'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'runtime', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'runtime', 'preload.cjs'), 'utf8');
  const browser = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  assert.match(build, /\$AssetIndexUrl/);
  assert.match(build, /\$AssetTokenUrl/);
  assert.match(build, /assets\.cjs/);
  assert.match(build, /assetPackages\.mjs/);
  assert.match(build, /'assets', 'fonts'/);
  assert.match(build, /data\\assets\.json/);
  assert.match(main, /app\.getPath\('userData'\).*asset-runtime/);
  assert.match(main, /runtimeAssets\.lookup/);
  assert.match(main, /sp-asset-session-token/);
  assert.match(preload, /setAssetSessionToken/);
  assert.match(browser, /strongholdClient\?\.setAssetSessionToken/);
});
