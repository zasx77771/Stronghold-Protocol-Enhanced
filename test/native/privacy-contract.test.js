import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rustAssets = await readFile(new URL('../../src-tauri/src/assets.rs', import.meta.url), 'utf8');
const rustCommands = await readFile(new URL('../../src-tauri/src/commands.rs', import.meta.url), 'utf8');
const activity = await readFile(new URL('../../android/app/src/main/java/org/strongholdprotocol/nativeclient/MainActivity.java', import.meta.url), 'utf8');
const androidPackage = await readFile(new URL('../../android/app/src/main/java/org/strongholdprotocol/nativeclient/assets/AssetPackage.java', import.meta.url), 'utf8');
const packages = await readFile(new URL('../../tools/assetPackages.mjs', import.meta.url), 'utf8');

test('asset status and client info never carry a private filesystem path into page JavaScript', () => {
  assert.doesNotMatch(rustAssets, /"storeRoot"/);
  assert.doesNotMatch(rustCommands, /"assetRoot"/);
  assert.doesNotMatch(rustCommands, /"storeRoot"/);
  assert.match(rustCommands, /"assetsReady": store\.as_ref\(\)\.map\(\|value\| value\.is_enabled\(\)\)/);
});

test('the native import command accepts no page-supplied path and reports no picked filename', () => {
  assert.match(rustCommands, /pub fn sp_import_asset_package\(app: AppHandle\)/);
  assert.doesNotMatch(rustCommands, /pub fn sp_import_asset_package\([^)]*path/i);
  assert.doesNotMatch(rustCommands, /"name": name/);
  assert.doesNotMatch(rustCommands, /path\.file_name\(\)/);
});

test('Android import errors redact private directories, content URIs and absolute paths', () => {
  assert.match(activity, /message\.replace\(cache, "<应用私有目录>"\)/);
  assert.match(activity, /\[a-z\]:\\\\\\\\\[\^\\\\s/);
  assert.match(activity, /\/data\/\[\^\\\\s/);
  assert.match(activity, /\(\?:storage\|sdcard\|mnt\)/);
  assert.match(activity, /content:\/\/\[\^\\\\s/);
  assert.match(activity, /已有导入任务在进行/);
});

test('the generator bounds ZIP entry counts and rejects hashed web paths and release folders', () => {
  assert.match(packages, /export const MAX_ZIP_ENTRIES = 60_000/);
  assert.match(packages, /entries\.length >= MAX_ZIP_ENTRIES/);
  assert.match(packages, /hashed web path in native package/);
  assert.match(packages, /enhanced-client-servers/);
  assert.match(packages, /成果文件/);
  assert.match(packages, /a package cannot both ship and remove/);
  assert.match(androidPackage, /a package cannot both ship and remove/);
  assert.match(rustAssets, /a package cannot both ship and remove/);
});
