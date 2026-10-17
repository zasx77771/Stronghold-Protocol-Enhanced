// Migration contract for the packaged Windows client: it ships as a Tauri 2 app, not Electron.
//
// What can be proven without a Rust toolchain lives here. The behaviour that needs `cargo` (the safe
// path rules, the HTTP Range responder, the R2 store) is unit-tested inside `src-tauri/src/*.rs`
// under `#[cfg(test)]`; this file only checks the project structure, the configuration policy and the
// build/package wiring around it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ICON_FILES, encodeIco, encodePng, iconBytes, renderIcon } from '../tools/tauri-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const exists = (relative) => fs.existsSync(path.join(ROOT, ...relative.split('/')));

/** Every `.ps1`/`.bat`/`.mjs`/`.js` under the Windows client build and packaging surface. */
function buildSurface() {
  const files = [];
  const collect = (directory, extensions) => {
    if (!exists(directory)) return;
    for (const entry of fs.readdirSync(path.join(ROOT, ...directory.split('/')), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      files.push(`${directory}/${entry.name}`);
    }
  };
  collect('scripts', ['.ps1', '.bat', '.mjs', '.js']);
  collect('desktop', ['.ps1', '.bat', '.cjs', '.js', '.mjs']);
  collect('tools', ['.ps1', '.mjs']);
  return files;
}

test('the packaged Windows client is a Tauri 2 project with no Electron dependency', () => {
  assert.ok(exists('src-tauri/Cargo.toml'), 'src-tauri/Cargo.toml is missing');
  assert.ok(exists('src-tauri/build.rs'), 'src-tauri/build.rs is missing');
  assert.ok(exists('src-tauri/src/main.rs'), 'src-tauri/src/main.rs is missing');
  assert.ok(exists('src-tauri/src/lib.rs'), 'src-tauri/src/lib.rs is missing');

  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /^tauri = \{ version = "2"/m, 'the tauri crate must be pinned to major version 2');
  assert.match(cargo, /^tauri-build = \{ version = "2"/m, 'tauri-build must be pinned to major version 2');
  assert.match(cargo, /tauri-plugin-single-instance = "2"/, 'the single-instance plugin must be a dependency');
  assert.doesNotMatch(cargo, /\belectron\b/i, 'Cargo.toml must not mention Electron');
  assert.doesNotMatch(cargo, /\bnode[-_]?js\b|\bneon\b|\bnapi\b/i, 'the client must not link a Node integration');

  const config = readJson('src-tauri/tauri.conf.json');
  assert.equal(config.$schema, 'https://schema.tauri.app/config/2', 'the config must declare the Tauri 2 schema');
  assert.equal(typeof config.identifier, 'string');
  assert.match(
    config.identifier,
    /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/,
    'identifier must be reverse-DNS and lowercase',
  );
  assert.equal(config.productName, 'Stronghold Protocol Client');

  const packageVersion = readJson('package.json').version;
  assert.equal(config.version, packageVersion, 'tauri.conf.json version must track package.json');
  const cargoVersion = /^version = "([^"]+)"/m.exec(cargo);
  assert.ok(cargoVersion, 'Cargo.toml must declare a version');
  assert.equal(cargoVersion[1], packageVersion, 'Cargo.toml version must track package.json');
});

test('the window contract keeps the frontend desktop marker and the R2-less static root', () => {
  const config = readJson('src-tauri/tauri.conf.json');
  const window = config.app.windows[0];
  assert.equal(window.label, 'main');
  assert.equal(window.title, '卫戍协议：盟约');
  assert.equal(window.width, 1440);
  assert.equal(window.height, 810);
  assert.equal(window.minWidth, 960);
  assert.equal(window.minHeight, 540);
  assert.equal(window.backgroundColor, '#0c0f0e');
  assert.equal(window.resizable, true);
  assert.equal(window.decorations, true);

  // The page contract is query-string based (`public/js/serverAddress.js::isDesktopClient()`), so the
  // window URL has to carry it.
  assert.match(window.url, /\?desktop=1$/, 'the window must load the app with ?desktop=1');
  assert.match(window.url, /^sp:\/\/localhost\//, 'the app is served over the private `sp:` scheme');
  assert.match(window.url, /\/index\.html$|\/index\.html\?/, 'the window must load index.html explicitly');

  // `withGlobalTauri` plus an initialization script is how `globalThis.strongholdClient` comes back.
  assert.equal(config.app.withGlobalTauri, true, 'withGlobalTauri must be on for the injected bridge');

  const index = read('public/index.html');
  assert.match(index, /desktopBridge\.js/);
  assert.ok(exists('public/js/desktopBridge.js'), 'the page bridge file is missing');

  const csp = config.app.security.csp;
  assert.equal(typeof csp, 'string', 'a CSP must be declared explicitly');
  assert.match(csp, /'unsafe-eval'/, 'PixiJS/SES compile shaders and need unsafe-eval');
  assert.match(csp, /sp: http:\/\/sp\.localhost/, 'the page must be able to fetch from the custom scheme');
});

test('the bundle ships the static client and the R2-free runtime layout, with an icon set', () => {
  const config = readJson('src-tauri/tauri.conf.json');
  const resources = config.bundle.resources;
  assert.equal(resources['../public'], 'client', 'public/ is the served client root');
  assert.equal(resources['../data'], 'client/data', 'the sim reads /data/*.json from inside the client root');
  assert.equal(resources['../shared'], 'client/shared', 'the page imports /shared/*.js from inside the client root');
  assert.equal(resources['../desktop/runtime/data.js'], 'client/data.js', 'the client data.js stand-in must be shipped');
  assert.equal(resources['../server/sim'], 'client/sim', 'the deterministic sim is shipped next to the client');
  assert.equal(resources['../desktop/README-Windows.txt'], 'README-Windows.txt');
  assert.equal(resources['../NOTICE.md'], 'NOTICE.md');
  assert.equal(resources['../THIRD-PARTY-NOTICES.md'], 'THIRD-PARTY-NOTICES.md');

  assert.equal(config.bundle.active, true);
  assert.ok(config.bundle.targets.includes('nsis'), 'the Windows installer target must be NSIS');
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');

  assert.ok(Array.isArray(config.bundle.icon) && config.bundle.icon.length >= 3, 'an icon set is required');
  assert.ok(config.bundle.icon.some((icon) => icon.endsWith('.ico')), 'Windows needs an .ico');
  assert.deepEqual(
    config.bundle.icon.map((icon) => path.basename(icon)),
    [...ICON_FILES],
    'bundle.icon and tools/tauri-icons.mjs ICON_FILES must stay in step',
  );
  assert.ok(!JSON.stringify(resources).includes('electron'), 'nothing Electron-shaped may be bundled');
});

test('the generated application icons are real PNG and ICO containers', () => {
  // The files themselves are produced by `node tools/tauri-icons.mjs --write` (the build script runs
  // it); only their bytes are asserted here, so this test needs no network and no committed blob.
  const png = encodePng(renderIcon(32), 32);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 32, 'PNG width');
  assert.equal(png.readUInt32BE(20), 32, 'PNG height');
  assert.equal(png[25], 6, 'PNG colour type must be truecolour with alpha');
  assert.ok(png.length > 100, 'the encoded PNG must carry image data');

  const ico = iconBytes('icon.ico');
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type must be 1 (icon)');
  assert.ok(ico.readUInt16LE(4) >= 4, 'the ICO must carry several sizes');
  assert.ok(ico.length > 1024, 'the ICO must not be a stub');
  assert.equal(iconBytes('32x32.png').readUInt32BE(16), 32);
  assert.equal(iconBytes('128x128.png').readUInt32BE(16), 128);
  assert.equal(encodeIco([{ size: 16, rgba: renderIcon(16) }]).readUInt16LE(4), 1);
});

test('the Rust runtime registers the custom protocol, the single-instance plugin and the bridge', () => {
  const lib = read('src-tauri/src/lib.rs');
  assert.match(
    lib,
    /register_asynchronous_uri_scheme_protocol\(\s*"sp"/,
    'the `sp` custom protocol must be registered',
  );
  assert.match(lib, /tauri_plugin_single_instance::init/, 'single-instance behaviour must be wired');
  assert.match(lib, /tauri_plugin_clipboard_manager::init/, 'the clipboard plugin must be wired');
  assert.match(lib, /desktopBridge\.js/, 'the bridge source must be compile-checked');
  assert.match(lib, /app_data_dir\(\)/, 'the R2 store must live outside the install directory');

  const init = read('public/js/desktopBridge.js');
  assert.match(init, /__TAURI__/, 'the bridge must be built on window.__TAURI__');
  for (const method of ['tcpConnect', 'tcpSend', 'tcpClose', 'onTcpEvent', 'readClipboardText', 'setAssetSessionToken']) {
    assert.match(init, new RegExp(`\\b${method}\\b`), `the bridge must expose ${method}`);
  }
  assert.match(init, /tcpAvailable:\s*true/);
  assert.match(init, /platform:\s*'windows'/);
  assert.match(init, /'sp-tcp-event'/, 'incoming frames must arrive through the sp-tcp-event channel');

  // The token exchange happens in Rust; the page only ever hands the short-lived session token down.
  const commands = read('src-tauri/src/commands.rs');
  assert.match(commands, /fn sp_set_asset_session_token/);
  assert.match(commands, /fn sp_read_clipboard/);

  const capabilities = readJson('src-tauri/capabilities/default.json');
  const permissions = capabilities.permissions.join('\n');
  assert.match(permissions, /clipboard-manager:allow-read-text/, 'the clipboard read must be permitted');
  assert.match(permissions, /core:event:allow-listen/, 'the TCP event channel must be permitted');
  assert.doesNotMatch(
    permissions,
    /(?:^|\n)(?:fs|shell|http|process)[:-]/,
    'the page must not receive filesystem, shell, HTTP or process permissions',
  );
});

test('the Windows build and packaging surface no longer downloads or packages Electron', () => {
  const surface = buildSurface();
  assert.ok(surface.includes('scripts/build-windows-client.ps1'));
  assert.ok(surface.length > 8, `expected a real build surface, saw ${surface.length} files`);

  // These three may only mention Electron in a negative assertion ("refuse to package a runtime that
  // is not the Tauri binary"); every other file may not mention it at all.
  const allowedToExplain = new Set([
    'tools/package.mjs',
    'tools/package-update.mjs',
    'tools/validate-client-runtime.mjs',
  ]);

  const offenders = [];
  for (const file of surface) {
    const text = read(file);
    if (!/\belectron\b/i.test(text)) continue;
    if (allowedToExplain.has(file)) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, [], `Electron is still referenced by: ${offenders.join(', ')}`);

  const build = read('scripts/build-windows-client.ps1');
  assert.match(build, /cargo tauri build/, 'the build must run cargo tauri build');
  assert.match(build, /src-tauri/, 'the build must operate on the src-tauri project');
  assert.doesNotMatch(build, /github\.com\/electron/i, 'no Electron download URL may remain');

  // The client runtime therefore no longer has a Node main process to ship. A normal checkout deletes
  // these three files, because Git still tracks them. This sandbox denies DELETE to every child process
  // and the write/edit tools cannot unlink, so they survive as emptied placeholders (documented in the
  // migration notes of docs/WINDOWS.md). What must hold here and now is that no implementation is left
  // behind in them, and that each one points at its Rust replacement.
  for (const file of ['desktop/runtime/main.cjs', 'desktop/runtime/preload.cjs', 'desktop/runtime/assets.cjs']) {
    if (!exists(file)) continue;
    const placeholder = read(file);
    assert.doesNotMatch(
      placeholder,
      /require\s*\(|\bmodule\.exports\b|\bipcRenderer\b|\bipcMain\b|\bcontextBridge\b|\bBrowserWindow\b|\bapp\.whenReady\b/,
      `${file} still holds a Node/Electron implementation`,
    );
    assert.match(placeholder, /src-tauri\//, `${file} must point at its Rust replacement (or be deleted)`);
  }
});

test('the packaged Windows payload is the Tauri binary plus static assets', () => {
  const validate = read('tools/validate-client-runtime.mjs');
  assert.match(validate, /stronghold-protocol-client\.exe|TAURI_CLIENT_BINARY|tauriBinary/i);

  const pack = read('tools/package.mjs');
  const update = read('tools/package-update.mjs');
  assert.match(pack, /tauri/i, 'tools/package.mjs must understand the Tauri payload');
  assert.match(update, /tauri/i, 'tools/package-update.mjs must understand the Tauri payload');
  assert.match(
    `${pack}\n${update}`,
    /electron/i,
    'both packagers must refuse an Electron runtime explicitly',
  );
});

test('the Windows build scripts and documentation describe the Tauri output path', () => {
  const build = read('scripts/build-windows-client.ps1');
  assert.match(
    build,
    /target[\\/]release[\\/]stronghold-protocol-client\.exe/,
    'the build must state the produced executable path',
  );
  assert.match(build, /tauri-icons\.mjs/, 'the build must generate the icons before bundling');

  const docs = read('docs/WINDOWS.md');
  assert.match(docs, /cargo tauri build/, 'docs/WINDOWS.md must document the Tauri build command');
  assert.doesNotMatch(docs, /Electron/i, 'docs/WINDOWS.md must not describe the Electron build any more');

  const clientUpdates = read('scripts/CLIENT-UPDATES.md');
  assert.doesNotMatch(clientUpdates, /Electron runtime support/i, 'the thin-ZIP description must be reworded');

  const notices = read('THIRD-PARTY-NOTICES.md');
  assert.match(notices, /Tauri/i, 'THIRD-PARTY-NOTICES.md must list the Tauri licence');

  const rules = read('docs/PROJECT-RULES.md');
  assert.doesNotMatch(rules, /Electron user data/, 'docs/PROJECT-RULES.md still points at Electron user data');

  const desktopReadme = read('desktop/README-Windows.txt');
  assert.doesNotMatch(desktopReadme, /Electron/i, 'desktop/README-Windows.txt must not mention Electron');
});
