#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const file = (...parts) => readFile(resolve(root, ...parts), 'utf8');
const required = async (path, pattern, detail) => {
  const value = await file(...path);
  if (!pattern.test(value)) throw new Error(`${path.join('/')}: ${detail}`);
};

try {
  const index = await file('public', 'index.html');
  if (!/<head>/i.test(index) || !/<\/head>/i.test(index)) throw new Error('public/index.html: missing stable native injection anchor');
  if (/stronghold-native-bridge|data-sp-platform/.test(index)) throw new Error('public/index.html: native bridge must not be committed into the upstream page');
  await required(['native', 'bridge', 'stronghold-native-bridge.js'], /if \(!hasTauri && !hasAndroid\) return/, 'bridge must remain browser-inert');
  await required(['src-tauri', 'src', 'protocol.rs'], /include_str!\("\.\.\/\.\.\/native\/bridge\/stronghold-native-bridge\.js"\)/, 'Windows must use the shared bridge');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'MainActivity.java'], /data-sp-platform=\\"android\\"/, 'Android must inject the shared bridge');
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/public'\)/, 'Android must stage current public files at build time');

  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/data'\)/, 'Android must stage upstream data modules');
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/shared'\)/, 'Android must stage upstream shared modules');
  await required(['android', 'app', 'build.gradle'], /from\('\.\.\/\.\.\/server\/sim'\)/, 'Android must stage upstream simulation modules');
  await required(['src-tauri', 'tauri.conf.json'], /"\.\.\/server\/sim": "client\/sim"/, 'Windows must package upstream simulation modules');
  await required(['src-tauri', 'src', 'protocol.rs'], /nodedata\.js/, 'Windows must deny Node-only simulation modules');
  await required(['server', 'tcp.js'], /_sp: 'pong'/, 'TCP transport must consume heartbeat control frames');
  await required(['server', 'http', 'routes.js'], /'\/api\/assets\/token'/, 'the server must exchange session tokens for asset JWTs');
  await required(['server', 'http', 'routes.js'], /asset_token_unavailable/, 'the token endpoint must answer 503 when unconfigured');
  await required(['src-tauri', 'Cargo.toml'], /sha2\s*=/, 'Windows needs SHA-256 verification');
  await required(['src-tauri', 'Cargo.toml'], /reqwest\s*=/, 'Windows needs an HTTPS client for runtime assets');
  await required(['src-tauri', 'src', 'protocol.rs'], /try_state::<AssetStore>/, 'Windows must serve the private asset store before bundled files');
  await required(['native', 'bridge', 'stronghold-native-bridge.js'], /const token = message\.token;/, 'the bridge must read the session token from the welcome frame');
  await required(['native', 'bridge', 'stronghold-native-bridge.js'], /__strongholdAssetUpdate/, 'the bridge must show native asset progress');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'MainActivity.java'], /StrongholdAndroidAssets/, 'Android must expose the asset update bridge');
  await required(['android', 'app', 'build.gradle'], /SP_ASSET_INDEX_URL/, 'Android must package its runtime asset configuration at build time');
  await required(['src-tauri', 'src', 'commands.rs'], /pub fn sp_import_asset_package\(app: AppHandle\)/, 'Windows import must be a picker-only native command');
  await required(['src-tauri', 'src', 'commands.rs'], /\.pick_file\(/, 'Windows import must use the native dialog plugin');
  await required(['src-tauri', 'Cargo.toml'], /tauri-plugin-dialog\s*=/, 'Windows import needs the dialog plugin');
  await required(['src-tauri', 'capabilities', 'default.json'], /"dialog:allow-open"/, 'Windows import needs the dialog permission');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'MainActivity.java'], /ACTION_OPEN_DOCUMENT/, 'Android import must use the system document picker');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'MainActivity.java'], /public void importPackage\(\)/, 'Android must expose a picker-only import method');
  await required(['native', 'bridge', 'stronghold-native-bridge.js'], /typeof androidAssets\.importPackage === 'function'/, 'the import button must require the native import method');
  await required(['native', 'bridge', 'stronghold-native-bridge.js'], /invoke\('sp_import_asset_package'\)/, 'the bridge must ask the native shell for a local package');
  await required(['src-tauri', 'src', 'assets.rs'], /pub fn check_mirrors\(/, 'mirror entries must be validated without changing the R2 route');
  await required(['src-tauri', 'src', 'assets.rs'], /MAX_MIRRORS:\s*usize\s*=\s*4/, 'mirror configuration must stay bounded');
  await required(['src-tauri', 'src', 'assets.rs'], /"importAvailable": true/, 'asset status must advertise native import');
  if ((await file('src-tauri', 'src', 'assets.rs')).includes('"storeRoot"')) throw new Error('src-tauri/src/assets.rs: asset status must not expose storeRoot');
  if ((await file('src-tauri', 'src', 'commands.rs')).includes('"assetRoot"')) throw new Error('src-tauri/src/commands.rs: client info must not expose assetRoot');
  await required(['tools', 'assetPackages.mjs'], /MAX_ZIP_ENTRIES = 60_000/, 'the native package generator must bound ZIP entries');
  await required(['tools', 'assetPackages.mjs'], /larger than \$\{MAX_ZIP_BYTES\} bytes/, 'the native package generator must bound package size');
  await required(['tools', 'assetPackages.mjs'], /maxOutputLength: Math\.max\(1, size\)/, 'package verification must bound decompression');
  await required(['tools', 'assetPackages.mjs'], /hashed web path in native package/, 'the generator must reject hashed web paths');
  await required(['tools', 'assetPackages.mjs'], /refusing to write native packages into a release folder/, 'the generator must refuse release folders');
  await required(['tools', 'assetPackages.mjs'], /a package cannot both ship and remove/, 'the generator must reject files/removed overlap');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'assets', 'AssetPackage.java'], /a package cannot both ship and remove/, 'Android must reject files/removed overlap');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'assets', 'AssetPackage.java'], /private static long writeEntry\(/, 'Android must stream package entries instead of buffering them');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'assets', 'AssetPackage.java'], /MAX_FILE_BYTES = 512L \* 1024 \* 1024/, 'Android must bound one package file to the generator limit');
  await required(['src-tauri', 'src', 'assets.rs'], /a package cannot both ship and remove/, 'Windows must reject files/removed overlap');
  await required(['src-tauri', 'src', 'assets.rs'], /MAX_FILE_BYTES: u64 = 512 \* 1024 \* 1024/, 'Windows must bound one package file to the generator limit');
  await required(['android', 'app', 'src', 'main', 'java', 'org', 'strongholdprotocol', 'nativeclient', 'MainActivity.java'], /\(\?:storage\|sdcard\|mnt\)/, 'Android import errors must redact shared storage paths');
  await stat(resolve(root, 'src-tauri', 'Cargo.toml'));
  console.log('native compatibility contract: OK');
} catch (error) {
  console.error(`native compatibility contract: FAILED — ${error.message}`);
  process.exitCode = 1;
}
