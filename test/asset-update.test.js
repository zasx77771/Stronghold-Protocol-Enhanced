// The thin Android client's explicit runtime-asset download (enhanced 2.6.4).
//
// Two layers are covered here, both runnable without a browser, a device or an Android build:
//
//   1. the pure state model (public/js/ui/assetUpdateStatus.js) — the confirmation contract, the phases,
//      the per-package progress and the retry offer;
//   2. the source contract of the lobby entry and its dialog (public/js/ui/assetUpdate.js), the native
//      bridge (MainActivity.java AssetBridge) and the session snapshot (AssetUpdateSession.java), asserted
//      on the text of those files, because none of them can be executed from here.
//
// The same feature is exercised on the JVM (tools/android-asset-tests.mjs → AssetSelfTest.java) and, with
// a real browser, by test/ui/*.browser.test.js (needs SP_E2E=1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSET_UPDATE_BRIDGE,
  ASSET_UPDATE_CHANNEL,
  ASSET_UPDATE_FORMAT,
  ASSET_UPDATE_STATES,
  assetUpdateBridge,
  assetUpdatePlan,
  assetUpdateProgress,
  describeAssetUpdate,
  formatBytes,
  parseAssetUpdateStatus,
} from '../public/js/ui/assetUpdateStatus.js';
import { statusLine } from '../public/js/ui/assetUpdate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/** Code without comments, for assertions about what a file mentions in executable form. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const UPDATER = 'public/js/ui/assetUpdate.js';
const STATUS_MODEL = 'public/js/ui/assetUpdateStatus.js';
const updater = read(UPDATER);
const model = read(STATUS_MODEL);
const lobby = read('public/js/screens/lobby.js');
const title = read('public/js/screens/title.js');
const activity = read('android/app/src/main/java/com/strongholdprotocol/covenant/MainActivity.java');
const session = read('android/app/src/main/java/com/strongholdprotocol/covenant/assets/AssetUpdateSession.java');

/** A snapshot as the native session marshals it. */
const snapshot = (patch = {}) => ({ format: ASSET_UPDATE_FORMAT, state: 'idle', ...patch });
/** The plan of a pending update with `count` packages. */
const plan = (count = 1, patch = {}) => ({
  status: 'update',
  reason: 'update',
  routeKind: 'base',
  localVersion: '1.0.0',
  latest: '2.0.1',
  bytes: count * 4096,
  packages: Array.from({ length: count }, (_, index) => ({ name: `assets-base-2.0.${index}.zip`, size: 4096 })),
  ...patch,
});

test('the entry exists only where the packaged Android bridge does', () => {
  const bridge = { available: () => true, status: () => '{}', start: () => {} };
  assert.equal(assetUpdateBridge({}), null);
  assert.equal(assetUpdateBridge({ [ASSET_UPDATE_BRIDGE]: null }), null);
  assert.equal(assetUpdateBridge({ [ASSET_UPDATE_BRIDGE]: { status: () => '{}' } }), null, 'start is required');
  assert.equal(assetUpdateBridge({ [ASSET_UPDATE_BRIDGE]: { start: () => {} } }), null, 'status is required');
  assert.equal(assetUpdateBridge({ [ASSET_UPDATE_BRIDGE]: { ...bridge, available: () => false } }), null, 'unavailable');
  assert.equal(assetUpdateBridge({ [ASSET_UPDATE_BRIDGE]: bridge }), bridge);
  assert.equal(ASSET_UPDATE_BRIDGE, 'StrongholdAndroidAssets');
  assert.equal(ASSET_UPDATE_CHANNEL, '__strongholdAssetUpdate');
});

test('only our own snapshots are trusted', () => {
  assert.equal(parseAssetUpdateStatus(''), null);
  assert.equal(parseAssetUpdateStatus('not json'), null);
  assert.equal(parseAssetUpdateStatus(JSON.stringify({ state: 'ready' })), null, 'a foreign object is ignored');
  assert.equal(parseAssetUpdateStatus(JSON.stringify({ format: 'sp-asset-index-v1' })), null);
  const parsed = parseAssetUpdateStatus(JSON.stringify(snapshot({ state: 'ready' })));
  assert.equal(parsed.state, 'ready');
  assert.equal(parseAssetUpdateStatus(snapshot()).format, ASSET_UPDATE_FORMAT);
  assert.equal(parseAssetUpdateStatus(null), null);
});

test('progress uses only what the session knows', () => {
  const partial = assetUpdateProgress(snapshot({ done: 512, total: 4096, packageIndex: 2, packageCount: 3, packageName: 'assets-delta-1.0.0-2.0.0.zip', packageDone: 256, packageSize: 1024 }));
  assert.equal(partial.ratio, 0.125);
  assert.equal(partial.packageRatio, 0.25);
  assert.deepEqual([partial.index, partial.count, partial.name], [2, 3, 'assets-delta-1.0.0-2.0.0.zip']);
  assert.equal(assetUpdateProgress(null).ratio, 0, 'an unknown total never divides by zero');
  assert.equal(assetUpdateProgress(snapshot({ done: 99 })).ratio, 0);
  const clamped = assetUpdateProgress(snapshot({ done: 9000, total: 100 }));
  assert.equal(clamped.ratio, 1, 'an over-reported count is clamped');
  const junk = assetUpdateProgress(snapshot({ done: 'x', total: -5, packageSize: 'NaN', packageName: 7 }));
  assert.deepEqual([junk.done, junk.total, junk.packageSize, junk.name], [0, 0, 0, '']);
});

test('the plan is exactly what the confirmation lists', () => {
  const mine = assetUpdatePlan(snapshot({ plan: plan(2) }));
  assert.equal(mine.count, 2);
  assert.equal(mine.bytes, 8192);
  assert.equal(mine.route, 'base');
  assert.equal(mine.latest, '2.0.1');
  assert.deepEqual(mine.packages.map((item) => item.name), ['assets-base-2.0.0.zip', 'assets-base-2.0.1.zip']);
  const unnamed = assetUpdatePlan(snapshot({ plan: plan(0, { packages: [{ size: 10 }, { name: '' }, { name: 'a.zip' }] }) }));
  assert.equal(unnamed.count, 1, 'a package without a name is not listed');
  assert.equal(assetUpdatePlan(null).count, 0);
  assert.equal(assetUpdatePlan(snapshot({ plan: { packages: 'no' } })).count, 0);
  assert.equal(assetUpdatePlan(snapshot({ plan: plan(1, { bytes: -3 }) })).bytes, 0);
});

test('a transfer is offered only while a prepared plan waits', () => {
  const ready = describeAssetUpdate(snapshot({ state: 'ready', plan: plan(2), enabled: true, hasSession: true }));
  assert.equal(ready.canConfirm, true);
  assert.equal(ready.busy, false);
  assert.equal(ready.canCancel, false);
  assert.equal(describeAssetUpdate(snapshot({ state: 'ready', plan: plan(0) })).canConfirm, false, 'nothing to install');
  for (const state of ASSET_UPDATE_STATES.filter((name) => name !== 'ready')) {
    assert.equal(describeAssetUpdate(snapshot({ state, plan: plan(2) })).canConfirm, false, `${state} never confirms`);
  }
  assert.equal(describeAssetUpdate(null).canConfirm, false);
});

test('moving bytes offer cancelling, never confirming', () => {
  for (const state of ['preparing', 'downloading', 'applying']) {
    const info = describeAssetUpdate(snapshot({ state, plan: plan(2) }));
    assert.equal(info.busy, true, state);
    assert.equal(info.canCancel, true, state);
    assert.equal(info.canConfirm, false, state);
    assert.equal(info.canRetry, false, state);
  }
});

test('failures and cancellations offer retry, and say why', () => {
  const failed = describeAssetUpdate(snapshot({ state: 'failed', retryable: true, error: 'assets: update failed (http 503)' }));
  assert.equal(failed.canRetry, true);
  assert.equal(failed.error, 'assets: update failed (http 503)');
  assert.equal(describeAssetUpdate(snapshot({ state: 'failed', retryable: false })).canRetry, false);
  assert.equal(describeAssetUpdate(snapshot({ state: 'cancelled' })).canRetry, true);
  const blocked = describeAssetUpdate(snapshot({ state: 'blocked', plan: plan(0, { status: 'blocked', reason: 'chain is longer than 3' }) }));
  assert.equal(blocked.canConfirm, false);
  assert.equal(blocked.canRetry, false);
  assert.equal(blocked.blocked, true);
});

test('unknown states read as unavailable, and waiting has its own phase', () => {
  assert.equal(describeAssetUpdate(null).state, 'unavailable');
  assert.equal(describeAssetUpdate(snapshot({ state: 'teleporting' })).state, 'unavailable');
  assert.equal(describeAssetUpdate(snapshot({ state: 'waiting-session' })).phase, 'waiting');
  for (const state of ASSET_UPDATE_STATES) {
    assert.equal(describeAssetUpdate(snapshot({ state })).state, state, state);
  }
  assert.equal(describeAssetUpdate(snapshot({ state: 'complete' })).complete, true);
});

test('bytes are shown in KB and MB', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(5 * 1048576 + 524288), '5.5 MB');
  assert.equal(formatBytes(-1), '0 KB');
  assert.equal(formatBytes('x'), '0 KB');
});

test('reading a status never starts a transfer', () => {
  // The pure model is inert: it can only classify a snapshot.
  for (const verb of ['prepare', 'start', 'retry', 'cancel']) {
    assert.doesNotMatch(model, new RegExp(`\\.${verb}\\(`), `the state model must not call ${verb}()`);
  }
  assert.doesNotMatch(updater, /setInterval|setTimeout/, 'nothing polls or retries on its own');
  // The mount effect only registers the push channel and reads the current status.
  const effect = updater.slice(updater.indexOf('useEffect(() => {'), updater.indexOf('}, []);'));
  assert.match(effect, /globalThis\[ASSET_UPDATE_CHANNEL\] = onState;/, 'the native push channel is registered');
  assert.match(effect, /active\.status\(\)/, 'the initial snapshot is read once');
  assert.doesNotMatch(effect, /\.(prepare|start|retry|cancel)\(/, 'mounting must not transfer anything');
  // Every verb is reachable only from a click handler inside the dialog.
  assert.match(updater, /data-testid="asset-update-confirm" onClick=\$\{\(\) => bridge\.start\(\)\}/);
  assert.match(updater, /data-testid="asset-update-retry" onClick=\$\{\(\) => bridge\.retry\(\)\}/);
  assert.match(updater, /data-testid="asset-update-cancel" onClick=\$\{\(\) => bridge\.cancel\(\)\}/);
  assert.match(updater, /if \(!info\.busy && !info\.complete\) bridge\.prepare\(\);/, 'opening reads a plan, not bytes');
});

test('the dialog reports progress, completion and failures', () => {
  for (const id of ['asset-update-entry', 'asset-update-status', 'asset-update-confirm', 'asset-update-retry', 'asset-update-cancel', 'asset-update-close', 'asset-update-error', 'asset-update-packages']) {
    assert.match(updater, new RegExp(`data-testid="${id}"`), `missing ${id}`);
  }
  assert.match(updater, /role="status" data-testid="asset-update-status"/, 'the status line is announced');
  assert.match(updater, /loading=\$\{info\.busy\}/, 'the entry shows the transfer is running');
  assert.match(updater, /icon="download"/, 'the entry carries the download icon');
  assert.match(updater, /max=\$\{Math\.max\(1, progress\.total\)\}/, 'progress never divides by zero');
  assert.match(updater, /formatBytes\(progress\.packageDone\)/, 'per-package bytes are shown');
});

test('the JS model and the native session agree on the snapshot', () => {
  const nativeStatus = session.slice(session.indexOf('Map<String, Object> status()'));
  const keys = new Set([...nativeStatus.matchAll(/\.put\("([A-Za-z0-9]+)"/g)].map((match) => match[1]));
  for (const key of ['format', 'state', 'message', 'error', 'retryable', 'done', 'total', 'packageIndex', 'packageCount', 'packageName', 'packageDone', 'packageSize', 'plan']) {
    assert.ok(keys.has(key), `AssetUpdateSession.status() must publish ${key}`);
  }
  assert.equal(ASSET_UPDATE_FORMAT, session.match(/STATUS_FORMAT\s*=\s*"([^"]+)"/)[1], 'both sides share one format');
  assert.ok(ASSET_UPDATE_STATES.includes(session.match(/UNAVAILABLE\s*=\s*"([^"]+)"/)[1]), 'states match the native names');
  const planKeys = new Set([...session.matchAll(/\.put\("([A-Za-z0-9]+)"/g)].map((match) => match[1]));
  for (const key of ['status', 'reason', 'routeKind', 'localVersion', 'latest', 'bytes', 'count', 'packages', 'name', 'size', 'sha256']) {
    assert.ok(planKeys.has(key), `the plan must publish ${key}`);
  }
});

test('no secret can cross the JavaScript bridge', () => {
  const bridge = activity.slice(activity.indexOf('private final class AssetBridge'));
  const methods = [...bridge.matchAll(/@JavascriptInterface\s+public\s+[A-Za-z_][\w.<>[\]]*\s+(\w+)\(/g)].map((match) => match[1]);
  assert.deepEqual(methods, ['available', 'status', 'prepare', 'start', 'retry', 'cancel']);
  assert.match(activity, /addJavascriptInterface\(new AssetBridge\(\), "StrongholdAndroidAssets"\)/);
  for (const forbidden of ['token', 'Token', 'Authorization', 'Bearer', 'assetToken']) {
    assert.doesNotMatch(code(updater), new RegExp(forbidden), `the dialog must not mention ${forbidden}`);
    assert.doesNotMatch(code(model), new RegExp(forbidden), `the state model must not mention ${forbidden}`);
  }
  // The session keeps both tokens to itself and never serialises one: it may only publish a boolean.
  const statusBody = code(session.slice(session.indexOf('Map<String, Object> status()')));
  assert.doesNotMatch(statusBody, /\.put\("[^"]+",\s*(sessionToken|assetToken)\s*\)/, 'status() must not publish a token');
  assert.match(statusBody, /\.put\("hasSession", sessionToken != null\)/, 'only its presence is published');
  // The game-session token still goes to the native TCP bridge only.
  assert.match(read('public/js/main.js'), /StrongholdAndroid\?\.setAssetSessionToken\?\.\(msg\.token\)/);
  assert.doesNotMatch(activity, /startAssetUpdate/, 'the silent startup download is gone');
  assert.doesNotMatch(activity, /tcpBridge = new TcpBridge\(webView, token -> startAssetUpdate\(token\)\)/);
});

test('every phase reports its own outcome', () => {
  const line = (patch) => statusLine(describeAssetUpdate(snapshot(patch)));
  assert.equal(line({ state: 'unavailable' }), '这台设备没有可下载的运行素材配置。');
  assert.equal(line({ state: 'waiting-session' }), '登录后即可下载运行素材。');
  assert.equal(line({ state: 'preparing' }), '正在准备素材清单…');
  assert.equal(line({ state: 'ready', plan: plan(1) }), '确认后会开始下载；未确认前不会传输任何数据。');
  assert.equal(line({ state: 'downloading', packageName: 'assets-base-2.0.0.zip' }), '正在下载 assets-base-2.0.0.zip');
  assert.equal(line({ state: 'applying', packageName: 'assets-delta-1.0.0-2.0.0.zip' }), '正在校验并安装 assets-delta-1.0.0-2.0.0.zip');
  assert.equal(line({ state: 'complete' }), '素材下载完成，下次进入对局即可使用。');
  assert.equal(line({ state: 'cancelled' }), '下载已取消，已安装的素材保持不变。');
  assert.equal(line({ state: 'failed', error: 'http 503' }), '下载失败：http 503');
  assert.equal(line({ state: 'blocked', plan: plan(0, { reason: 'chain is longer than 3' }) }), 'chain is longer than 3');
  assert.equal(line({ state: 'idle', plan: plan(2) }), '本次下载共 2 个素材包，约 8 KB。');
  assert.equal(line({ state: 'idle' }), '素材已是最新，无需下载。');
});

test('the lobby shows the entry right after the guide button, and the title screen does not', () => {
  assert.match(lobby, /import \{ AssetUpdateButton \} from '\.\.\/ui\/assetUpdate\.js';/);
  const tools = lobby.slice(lobby.indexOf('<div class="topbar__tools">'), lobby.indexOf('</div>', lobby.indexOf('<div class="topbar__tools">')));
  assert.match(tools, /class="lobby-settings"/);
  assert.match(tools, /class="lobby-guide"/);
  assert.match(tools, /<\$\{AssetUpdateButton\} class="lobby-assets" \/>/, 'the entry is mounted in the tool row');
  assert.ok(tools.indexOf('lobby-guide') < tools.indexOf('AssetUpdateButton'), 'it follows the book/guide entry');
  assert.ok(tools.indexOf('AssetUpdateButton') < tools.indexOf('lobby-pwa'), 'and stays in the same row');
  assert.doesNotMatch(title, /AssetUpdateButton|asset-update-entry/, 'never on the pre-login title screen');
});

test('every new string is translated in all four packs', () => {
  const msgids = new Set([...updater.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]));
  assert.ok(msgids.size >= 13, `expected the dialog's strings, found ${msgids.size}`);
  for (const pack of ['en', 'ja', 'ko', 'zh-TW']) {
    const table = JSON.parse(read(`public/i18n/${pack}.json`));
    for (const msgid of msgids) {
      assert.ok(Object.prototype.hasOwnProperty.call(table, msgid), `${pack}.json is missing ${msgid}`);
      assert.notEqual(table[msgid], msgid, `${pack}.json still has the untranslated ${msgid}`);
    }
  }
});
