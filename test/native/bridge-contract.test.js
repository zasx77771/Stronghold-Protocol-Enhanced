import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bridge = await readFile(new URL('../../native/bridge/stronghold-native-bridge.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');

test('native bridge is a classic, browser-inert injection payload', () => {
  assert.match(bridge, /^\/\*[\s\S]*?\*\/\s*\(function installStrongholdNativeBridge\(\)/);
  assert.doesNotMatch(bridge, /^\s*import\s/m);
  assert.match(bridge, /if \(!hasTauri && !hasAndroid\) return/);
  assert.match(bridge, /globalThis\.WebSocket = TcpWebSocket/);
  assert.match(bridge, /__strongholdNativeTcpEvent/);
});

test('current upstream entry retains the injection anchor', () => {
  assert.match(index, /<head>/i);
  assert.match(index, /<\/head>/i);
  assert.match(index, /<script type="module" src="\/js\/main\.js"/);
});

test('native bridge never lifts the game session token into the asset channel', () => {
  // The R2 asset token handoff is retired: no welcome-token observer, no assetToken hook.
  assert.doesNotMatch(bridge, /observeAssetToken|assetToken\(/);
  assert.doesNotMatch(bridge, /message\?\.t !== 'welcome'/);
  assert.doesNotMatch(bridge, /registerImportedAssetWorker/);
});

test('native bridge accepts both native event call shapes', () => {
  // Tauri forwards `(id, payload)`; the Android shell passes one object built by
  // `evaluateJavascript`. A payload without an id used to look up nothing, so every Android event was
  // dropped and the client sat in "connecting" until the server's hello timeout.
  assert.match(bridge, /function report\(idOrPayload, maybePayload\)/);
  assert.match(bridge, /payload === undefined && idOrPayload && typeof idOrPayload === 'object'/);
  assert.match(bridge, /id = payload\.id/);
});

test('native bridge exposes one asset-status channel per host', () => {
  assert.match(bridge, /sp-asset-event/);
  assert.match(bridge, /__strongholdAssetUpdate/);
  assert.match(bridge, /StrongholdAndroidAssets/);
  assert.match(bridge, /sp-asset-event[\s\S]*?receiveAssetStatus/);
});
