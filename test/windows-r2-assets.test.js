// Windows thin client: the R2 runtime-asset updater is native code now.
//
// Until enhanced 2.6.3 the Windows client shipped an Electron main process, and this suite loaded
// `desktop/runtime/assets.cjs` to exercise its config parsing and redirect policy in a sandbox. That
// shell is retired: the same rules are a ported, unit-tested module in `src-tauri/src/assets.rs`
// (Rust), where the behaviour checks run under `cargo test` with a real filesystem and network.
//
// What still belongs in the JavaScript test suite is the contract between the two halves:
//   * the shared tooling (`tools/assetPackages.mjs`) is what writes the index and the packages, so the
//     Rust client must keep parsing exactly those formats and limits;
//   * the page may only hand a short-lived game session token to native code — it never sees the
//     Worker JWT, and it never fetches an asset package itself;
//   * the retired Node shell must not come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_CHAIN,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DEFAULT_MAX_EXTRACT_BYTES,
  DEFAULT_MAX_INDEX_BYTES,
  INDEX_FORMAT,
} from '../tools/assetPackages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST = 'src-tauri/src/assets.rs';

const read = (relative) => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, ...relative.split('/')));

test('the Rust runtime keeps the index, config and package names the shared tooling writes', () => {
  const rust = read(RUST);

  assert.match(rust, new RegExp(`INDEX_FORMAT: &str = "${INDEX_FORMAT}"`));
  assert.match(rust, /CONFIG_FORMAT: &str = "sp-assets-config-v1"/);
  assert.match(rust, /CONFIG_FILE: &str = "asset-config\.json"/);
  assert.match(rust, /STORE_FILE|asset-store\.json/, 'the runtime store must stay a JSON pointer file');

  // The package names the Rust validator demands are the ones tools/assetPackages.mjs generates.
  assert.match(rust, /format!\("assets-base-\{to\}\.zip"\)/);
  assert.match(rust, /format!\("assets-delta-\{from\}-\{to\}\.zip"\)/);

  // Same defaults on both sides: a divergence here silently rejects or over-fetches a package.
  assert.match(rust, /DEFAULT_MAX_CHAIN: usize = 3;/);
  assert.match(rust, /DEFAULT_MAX_INDEX_BYTES: u64 = 1024 \* 1024;/);
  assert.match(rust, /DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 1536 \* 1024 \* 1024;/);
  assert.match(rust, /DEFAULT_MAX_EXTRACT_BYTES: u64 = 4096 \* 1024 \* 1024;/);
  assert.equal(DEFAULT_MAX_CHAIN, 3);
  assert.equal(DEFAULT_MAX_INDEX_BYTES, 1024 * 1024);
  assert.equal(DEFAULT_MAX_DOWNLOAD_BYTES, 1536 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_EXTRACT_BYTES, 4096 * 1024 * 1024);
});

test('the Rust downloader pins one origin and refuses unsafe URLs, redirects and digests', () => {
  const rust = read(RUST);

  for (const signature of [
    'fn is_session_token',
    'fn is_jwt',
    'fn configured_url',
    'fn configured_token_url',
    'fn asset_path_problem',
    'fn safe_join',
    'fn read_config',
    'fn check_index',
    'fn plan_route',
    'fn apply_package',
  ]) {
    assert.match(rust, new RegExp(signature.replace(/[()]/g, '\\$&')), `${signature} must stay native`);
  }

  // Redirects are followed by hand so the Worker JWT is only ever repeated to the same origin.
  assert.match(rust, /redirect::Policy::none\(\)/, 'the client must follow redirects itself');
  assert.match(rust, /const MAX_REDIRECTS: usize = 3;/);
  assert.match(
    rust,
    /cross-origin asset redirect is refused/,
    'a redirect must not hand the Worker token to another origin',
  );

  // Both the whole package and every extracted file are digest-checked before anything is applied.
  assert.match(rust, /expected_sha256/, 'the package digest must be verified before applying it');
  assert.match(rust, /if digest != expected\.sha256/, 'every file must match the index digest');
  assert.match(rust, /#\[cfg\(test\)\]/, 'the ported behaviour tests must ship with the module');
});

test('only the sandboxed bridge touches the session token and the retired Node shell is gone', () => {
  const init = read('public/js/desktopBridge.js');
  assert.match(init, /__TAURI__/, 'the bridge must be built on the Tauri IPC surface');
  assert.match(init, /setAssetSessionToken\(token\)/);
  assert.match(init, /readClipboardText\(\)/);

  const commands = read('src-tauri/src/commands.rs');
  assert.match(commands, /fn sp_set_asset_session_token/, 'the token must cross into Rust as a command');

  const page = read('public/js/main.js');
  assert.match(
    page,
    /strongholdClient\?\.setAssetSessionToken\?\.\(msg\.token\)/,
    'the page may only forward the game session token to the desktop bridge',
  );
  assert.doesNotMatch(page, /\bassetToken\b|\bBearer\b/, 'the page must never hold the Worker JWT');

  const capabilities = read('src-tauri/capabilities/default.json');
  assert.doesNotMatch(
    capabilities,
    /"(?:fs|shell|http|process|path):/,
    'the page must not receive filesystem, shell, HTTP or process permissions',
  );

  // A normal checkout deletes these three files, because Git still tracks them. This sandbox denies
  // DELETE to every child process and the write/edit tools cannot unlink, so they survive as emptied
  // placeholders (documented in the migration notes of docs/WINDOWS.md). What must hold is that no
  // Node/Electron implementation is left in them and that each one names its Rust replacement.
  for (const file of ['desktop/runtime/main.cjs', 'desktop/runtime/preload.cjs', 'desktop/runtime/assets.cjs']) {
    if (!exists(file)) continue;
    const placeholder = read(file);
    assert.doesNotMatch(
      placeholder,
      /require\s*\(|\bmodule\.exports\b|\bipcRenderer\b|\bipcMain\b|\bcontextBridge\b|\bBrowserWindow\b/,
      `${file} still holds a Node/Electron implementation`,
    );
    assert.match(placeholder, /src-tauri\//, `${file} must point at its Rust replacement (or be deleted)`);
  }
});
