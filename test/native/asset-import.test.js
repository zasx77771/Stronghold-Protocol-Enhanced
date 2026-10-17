import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
const bridge = await read('native/bridge/stronghold-native-bridge.js');
const rustAssets = await read('src-tauri/src/assets.rs');
const rustCommands = await read('src-tauri/src/commands.rs');
const rustCargo = await read('src-tauri/Cargo.toml');
const capability = await read('src-tauri/capabilities/default.json');
const javaConfig = await read('android/app/src/main/java/org/strongholdprotocol/nativeclient/assets/AssetConfig.java');
const javaMain = await read('android/app/src/main/java/org/strongholdprotocol/nativeclient/MainActivity.java');

test('Windows import is picker-only: the command accepts no page-supplied path', () => {
  const start = rustCommands.indexOf('pub fn sp_import_asset_package');
  assert.ok(start > 0, 'the import command exists');
  const signature = rustCommands.slice(start, rustCommands.indexOf('->', start));
  assert.match(signature, /app:\s*AppHandle/);
  assert.doesNotMatch(signature, /path|file|url/i);
  assert.match(rustCommands, /\.pick_file\(/);
  assert.doesNotMatch(rustCommands, /blocking_pick_file/);
  assert.match(rustCommands, /try_state::<AssetStore>/);
  assert.match(rustCommands, /store\.import_package_locked\(path, &digest\)/);
});

test('Windows import reuses the validated AssetStore commit path and never writes files itself', () => {
  assert.match(rustAssets, /pub fn import_package\(&self[\s\S]*?apply_package\(/);
  assert.match(rustAssets, /pub async fn import_package_locked\([\s\S]*?lock\.lock\(\)\.await/);
  assert.match(rustAssets, /pub fn file_sha256\(/);
  assert.doesNotMatch(rustCommands, /File::create|std::fs::write|extract_zip/);
  assert.match(rustCargo, /tauri-plugin-dialog\s*=\s*"2"/);
  assert.match(capability, /"dialog:allow-open"/);
});

test('mirror configuration is reserved, validated and never a default download source', () => {
  assert.match(rustAssets, /pub const MAX_MIRRORS:\s*usize\s*=\s*4/);
  assert.match(rustAssets, /pub fn check_mirrors\(/);
  assert.match(rustAssets, /mirrors:\s*Vec<Mirror>/);
  // No mirror is ever synthesized: the only source is the JSON field.
  assert.match(rustAssets, /check_mirrors\(&value, allow_http\)/);
  assert.doesNotMatch(rustAssets, /DEFAULT_MIRROR|mirror_url:\s*Some|https:\/\/[a-z0-9.-]*\/mirror/i);
  assert.match(javaConfig, /MAX_MIRRORS\s*=\s*4/);
  assert.match(javaConfig, /checkMirrors\(/);
  assert.match(javaConfig, /checkMirrors\(AssetJson\.get\(json, "mirrors"\)/);
});

test('Android import goes through the system picker, app cache and AssetStore.apply', () => {
  assert.match(javaMain, /ACTION_OPEN_DOCUMENT/);
  assert.match(javaMain, /CATEGORY_OPENABLE/);
  assert.match(javaMain, /new File\(getCacheDir\(\), "import-package.zip"\)/);
  assert.match(javaMain, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(javaMain, /store\.apply\(temporary, digest, maxExtract\)/);
  assert.match(javaMain, /@JavascriptInterface public void importPackage\(\)/);
  // The chosen URI is copied and hashed, never handed to the page or to a second writer.
  assert.doesNotMatch(javaMain, /loadUrl\("javascript:.*uri/i);
  assert.doesNotMatch(javaMain, /openInputStream\([^)]*\)\s*\.transferTo/);
});

test('native import surface is hidden from the plain browser', () => {
  assert.match(bridge, /const nativeImportAvailable = hasTauri \|\| Boolean\(/);
  assert.match(bridge, /typeof androidAssets\.importPackage === 'function'/);
  assert.match(bridge, /if \(!hasTauri && !hasAndroid\) return/);
  assert.match(bridge, /invoke\('sp_import_asset_package'\)/);
  assert.match(bridge, /callAndroidAsset\('importPackage'\)/);
  assert.doesNotMatch(bridge, /<input[^>]*type=["']file/);
  assert.doesNotMatch(bridge, /showOpenFilePicker|webkitdirectory|DataTransfer/);
});

test('mirror status is informational and does not alter the online route', () => {
  assert.match(bridge, /function mirrorLine\(status\)/);
  assert.match(bridge, /镜像：未配置（预留入口，默认仍走 R2）/);
  assert.match(bridge, /镜像（预留，不自动使用）/);
  assert.match(bridge, /data-sp-mirrors/);
  // No automatic fallback or mirror selection exists in the bridge.
  assert.doesNotMatch(bridge, /fetch\([^)]*mirror/i);
  assert.doesNotMatch(bridge, /mirrors\[[^\]]*\]\.url/);
});
