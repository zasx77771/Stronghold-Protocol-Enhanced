import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
const bridge = await read('native/bridge/stronghold-native-bridge.js');
const rustAssets = await read('src-tauri/src/assets.rs');
const rustCommands = await read('src-tauri/src/commands.rs');
const rustCargo = await read('src-tauri/Cargo.toml');
const capability = await read('src-tauri/capabilities/default.json');
const javaMain = await read('android/app/src/main/java/org/strongholdprotocol/nativeclient/MainActivity.java');
const gradle = await read('android/app/build.gradle');
const routes = await read('server/http/routes.js');
const serverIndex = await read('server/index.js');
const assetsDir = await readdir(new URL('../../android/app/src/main/java/org/strongholdprotocol/nativeclient/assets/', import.meta.url));

test('Windows import is picker-only: the command accepts no page-supplied path', () => {
  const start = rustCommands.indexOf('pub fn sp_import_asset_package');
  assert.ok(start > 0, 'the import command exists');
  const signature = rustCommands.slice(start, rustCommands.indexOf('->', start));
  assert.match(signature, /app:\s*AppHandle/);
  assert.doesNotMatch(signature, /path|file|url/i);
  assert.match(rustCommands, /\.pick_file\(/);
  assert.doesNotMatch(rustCommands, /blocking_pick_file/);
  assert.match(rustCommands, /try_state::<AssetStore>/);
  assert.match(rustCommands, /store\.import_package\(path, &digest\)/);
  assert.doesNotMatch(rustCommands, /sp_set_asset_session_token|sp_assets_ready/);
});

test('Windows import reuses the validated AssetStore commit path and never writes files itself', () => {
  assert.match(rustAssets, /pub fn import_package\(&self[\s\S]*?apply_package\(/);
  assert.match(rustAssets, /pub fn file_sha256\(/);
  assert.doesNotMatch(rustCommands, /File::create|std::fs::write|extract_zip/);
  assert.match(rustCargo, /tauri-plugin-dialog\s*=\s*"2"/);
  assert.match(capability, /"dialog:allow-open"/);
});

test('the remote asset pipeline is gone from both shells and the server', () => {
  assert.doesNotMatch(rustAssets, /AssetIndex|plan_route|check_mirrors|MAX_MIRRORS|token_url|index_url/);
  assert.doesNotMatch(rustAssets, /asset-index|runtime-assets|assets-base|assets-delta/);
  assert.doesNotMatch(rustCargo, /reqwest/);
  for (const name of ['AssetConfig.java', 'AssetIndex.java', 'AssetUpdater.java', 'AssetUpdateSession.java']) {
    assert.ok(!assetsDir.includes(name), `${name} must be removed`);
  }
  assert.ok(assetsDir.includes('AssetStore.java'), 'the local override store stays');
  assert.doesNotMatch(javaMain, /AssetConfig|AssetUpdateSession|AssetUpdater|AssetIndex|setAssetSessionToken/);
  assert.doesNotMatch(gradle, /SP_ASSET_INDEX_URL|SP_ASSET_TOKEN_URL|writeAssetConfig/);
  assert.doesNotMatch(bridge, /assetToken|observeAssetToken|sp_set_asset_session_token/);
  assert.doesNotMatch(bridge, /assets-index\.json|runtime-assets/);
  assert.doesNotMatch(routes, /\/api\/assets\/token/);
  assert.doesNotMatch(serverIndex, /assetToken|SP_ASSET_TOKEN_SECRET/);
});

test('Android import goes through the system picker, app cache and AssetStore.apply', () => {
  assert.match(javaMain, /ACTION_OPEN_DOCUMENT/);
  assert.match(javaMain, /CATEGORY_OPENABLE/);
  assert.match(javaMain, /new File\(getCacheDir\(\), "import-package.zip"\)/);
  assert.match(javaMain, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(javaMain, /store\.apply\(temporary, digest, maxExtract\)/);
  assert.match(javaMain, /@JavascriptInterface public void importPackage\(\)/);
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

test('the status panel only offers the local import and says the art is embedded', () => {
  assert.match(bridge, /素材随安装包内嵌/);
  assert.match(bridge, /data-sp-act="import"/);
  assert.doesNotMatch(bridge, /data-sp-act="start"|data-sp-act="prepare"|data-sp-act="retry"|data-sp-mirrors/);
  assert.doesNotMatch(bridge, /开始下载|镜像/);
  assert.match(rustAssets, /"mode": "embedded"/);
  assert.match(javaMain, /"mode", "embedded"/);
});
