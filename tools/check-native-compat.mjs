#!/usr/bin/env node
// Contract check for the native shells after the R2 retirement: the official art ships inside the
// Windows installer and the Android APK, and no native code path may reach a remote asset service.
// It reads tracked sources only, so it runs before a build and in CI without assets on disk.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const file = (...parts) => readFile(resolve(root, ...parts), 'utf8');
const required = async (path, pattern, detail) => {
  const value = await file(...path);
  if (!pattern.test(value)) throw new Error(`${path.join('/')}: ${detail}`);
};
const forbidden = async (path, pattern, detail) => {
  const value = await file(...path);
  if (pattern.test(value)) throw new Error(`${path.join('/')}: ${detail}`);
};

const BRIDGE = ['native', 'bridge', 'stronghold-native-bridge.js'];
const MAIN = ['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'MainActivity.java'];
const ASSETS_DIR = ['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'assets'];

try {
  // ---- the shared bridge stays browser-inert and is injected by both shells -------------------
  const index = await file('public', 'index.html');
  if (!/<head>/i.test(index) || !/<\/head>/i.test(index)) throw new Error('public/index.html: missing stable native injection anchor');
  if (/stronghold-native-bridge|data-sp-platform/.test(index)) throw new Error('public/index.html: native bridge must not be committed into the upstream page');
  await required(BRIDGE, /if \(!hasTauri && !hasAndroid\) return/, 'bridge must remain browser-inert');
  await required(['src-tauri', 'src', 'protocol.rs'], /include_str!\("\.\.\/\.\.\/native\/bridge\/stronghold-native-bridge\.js"\)/, 'Windows must use the shared bridge');
  await required(MAIN, /data-sp-platform=\\"android\\"/, 'Android must inject the shared bridge');

  // ---- both shells package the same upstream tree ---------------------------------------------
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/public'\)/, 'Android must stage current public files at build time');
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/data'\)/, 'Android must stage upstream data modules');
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/shared'\)/, 'Android must stage upstream shared modules');
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/server\/sim'\)/, 'Android must stage upstream simulation modules');
  await required(['src-tauri', 'tauri.conf.json'], /"\.\.\/server\/sim": "client\/sim"/, 'Windows must package upstream simulation modules');
  await required(['src-tauri', 'src', 'protocol.rs'], /nodedata\.js/, 'Windows must deny Node-only simulation modules');
  await required(['server', 'tcp.js'], /_sp: 'pong'/, 'TCP transport must consume heartbeat control frames');

  // ---- embedded art is checked at build time, never downloaded --------------------------------
  await stat(resolve(root, 'tools', 'check-embedded-assets.mjs'));
  await required(['src-tauri', 'build.rs'], /check-embedded-assets\.mjs/, 'Windows release builds must verify the embedded art');
  await required(['android', 'app', 'build.gradle'], /checkEmbeddedAssets/, 'Android builds must verify the embedded art');
  await required(['android', 'app', 'build.gradle'], /dependsOn\(tasks\.named\('checkEmbeddedAssets'\)\)/, 'the Android web stage must depend on the embedded-art check');
  await forbidden(['android', 'app', 'build.gradle'], /SP_ASSET_INDEX_URL|SP_ASSET_TOKEN_URL|writeAssetConfig/, 'Android must not write a remote asset configuration');

  // ---- no remote asset service anywhere in the runtime or its tooling -------------------------
  await forbidden(['server', 'http', 'routes.js'], /\/api\/assets\/token/, 'the server must not expose an asset token endpoint');
  await forbidden(['server', 'index.js'], /assetToken|SP_ASSET_TOKEN_SECRET/, 'the server must not build an asset token issuer');
  await forbidden(['src-tauri', 'Cargo.toml'], /reqwest/, 'the Windows shell must not carry an HTTPS client for asset downloads');
  await forbidden(['src-tauri', 'src', 'assets.rs'], /asset-index|runtime-assets|token_url|index_url|assets-base|assets-delta/, 'the Windows store must not know remote index or package names');
  await forbidden(['src-tauri', 'src', 'assets.rs'], /check_mirrors|MAX_MIRRORS/, 'mirror configuration is retired');
  await forbidden(MAIN, /AssetConfig|AssetUpdateSession|AssetUpdater|AssetIndex|setAssetSessionToken/, 'Android must not keep the remote asset session');
  await forbidden(BRIDGE, /assetToken|observeAssetToken|sp_set_asset_session_token/, 'the bridge must not hand a session token to native code');
  await forbidden(BRIDGE, /assets-index\.json|runtime-assets/, 'the bridge must not know the R2 object layout');
  await forbidden(['src-tauri', 'src', 'commands.rs'], /sp_set_asset_session_token|sp_assets_ready/, 'Windows must not expose a remote update command');
  let entries = [];
  try { entries = await readFileDir(resolve(root, ...ASSETS_DIR)); } catch { entries = []; }
  for (const name of ['AssetConfig.java', 'AssetIndex.java', 'AssetUpdater.java', 'AssetUpdateSession.java']) {
    if (entries.includes(name)) throw new Error(`${ASSETS_DIR.join('/')}/${name}: the remote asset class must be removed`);
  }
  if (!entries.includes('AssetStore.java')) throw new Error('the local override store must stay');

  // ---- the local override path still works ---------------------------------------------------
  await required(['src-tauri', 'src', 'commands.rs'], /pub fn sp_import_asset_package\(app: AppHandle\)/, 'Windows import must be a picker-only native command');
  await required(['src-tauri', 'src', 'commands.rs'], /\.pick_file\(/, 'Windows import must use the native dialog plugin');
  await required(['src-tauri', 'Cargo.toml'], /tauri-plugin-dialog\s*=/, 'Windows import needs the dialog plugin');
  await required(['src-tauri', 'capabilities', 'default.json'], /"dialog:allow-open"/, 'Windows import needs the dialog permission');
  await required(MAIN, /ACTION_OPEN_DOCUMENT/, 'Android import must use the system document picker');
  await required(MAIN, /public void importPackage\(\)/, 'Android must expose a picker-only import method');
  await required(BRIDGE, /typeof androidAssets\.importPackage === 'function'/, 'the import button must require the native import method');
  await required(BRIDGE, /invoke\('sp_import_asset_package'\)/, 'the bridge must ask the native shell for a local package');
  await required(['src-tauri', 'src', 'assets.rs'], /"importAvailable": true/, 'asset status must advertise native import');
  await required(['src-tauri', 'src', 'assets.rs'], /"mode": "embedded"/, 'asset status must say the art is embedded');
  await required(MAIN, /"mode", "embedded"/, 'Android status must say the art is embedded');
  await required(['src-tauri', 'Cargo.toml'], /sha2\s*=/, 'Windows needs SHA-256 verification');
  await required(['src-tauri', 'src', 'protocol.rs'], /try_state::<AssetStore>/, 'Windows must serve the local override store before bundled files');
  await required(BRIDGE, /__strongholdAssetUpdate/, 'the bridge must show native asset status');
  await required(MAIN, /StrongholdAndroidAssets/, 'Android must expose the asset bridge');
  await required(MAIN, /\(\?:storage\|sdcard\|mnt\)/, 'Android import errors must redact shared storage paths');
  await forbidden(BRIDGE, /sp-asset-event.*token|token.*sp-asset-event/, 'status events must never carry a token');

  await stat(resolve(root, 'src-tauri', 'Cargo.toml'));
  console.log('native compatibility contract: OK');
} catch (error) {
  console.error(`native compatibility contract: FAILED — ${error.message}`);
  process.exitCode = 1;
}

async function readFileDir(dir) {
  const { readdir } = await import('node:fs/promises');
  return readdir(dir);
}
