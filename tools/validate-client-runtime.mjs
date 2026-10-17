#!/usr/bin/env node

// Client runtime validation.
//
// The packaged Windows client is now a Tauri 2 application (`src-tauri/`): the released Windows payload
// is the compiled Rust binary plus the same static client tree the browser build serves. This module is
// the one place that describes that payload, so the Windows build script, `tools/package.mjs` and
// `tools/package-update.mjs` all refuse an Electron-shaped layout (`electron.exe`, a `resources/app`
// Node main process, an `electron` dependency) instead of shipping a second runtime.
//
// The Android build shares `missingClientRuntimeFiles()` / `validateClientRuntime()`: it validates the
// assets directory it embeds, which has no binary next to it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CLIENT_RUNTIME_FILES = Object.freeze([
  'index.html',
  'js/main.js',
  'data.js',
  'vendor/preact.module.js',
  'vendor/hooks.module.js',
  'vendor/htm.module.js',
  'vendor/pixi.min.js',
  'vendor/pixi-spine.js',
  'fonts/fonts.css',
]);

/** The executable `cargo tauri build` produces in `src-tauri/target/release/` (Cargo package name). */
export const TAURI_CLIENT_BINARY = 'stronghold-protocol-client.exe';
/** The crate name behind it (`src-tauri/Cargo.toml` `[package] name`). */
export const TAURI_CLIENT_CRATE = 'stronghold-protocol-client';
/** The name the payload uses: `productName` of `src-tauri/tauri.conf.json` plus `.exe`. */
export const TAURI_CLIENT_PRODUCT_BINARY = 'Stronghold Protocol Client.exe';
/** Either name is a valid payload root; nothing else is accepted. */
export const WINDOWS_CLIENT_BINARIES = Object.freeze([TAURI_CLIENT_PRODUCT_BINARY, TAURI_CLIENT_BINARY]);
/** The static tree inside a payload root; `index.html` lives here. */
export const WINDOWS_CLIENT_DIR = 'client';
/** Files copied next to the binary. */
export const WINDOWS_CLIENT_NOTICES = Object.freeze(['README-Windows.txt', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']);

/**
 * Paths that only an Electron payload has. `resources/app/*.cjs` was the layout
 * `scripts/build-windows-client.ps1` produced before v2.6.4; the retired stubs under `desktop/runtime/`
 * are deliberately NOT listed (they hold no code and are deleted with `git rm`).
 */
export const ELECTRON_RUNTIME_PATHS = Object.freeze([
  'electron.exe',
  'desktop/electron.exe',
  'resources/electron.asar',
  'resources/app.asar',
  'resources/app/main.cjs',
  'resources/app/preload.cjs',
  'resources/app/assets.cjs',
  'desktop/resources/app/main.cjs',
]);

/** npm fields whose `electron*` entries mean a Node runtime is expected. */
const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies']);

function readJsonIfAny(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function missingClientRuntimeFiles(root) {
  return REQUIRED_CLIENT_RUNTIME_FILES.filter((relative) => {
    const target = path.join(root, ...relative.split('/'));
    try {
      const stat = fs.statSync(target);
      return !stat.isFile() || stat.size === 0;
    } catch {
      return true;
    }
  });
}

export function validateClientRuntime(root) {
  const missing = missingClientRuntimeFiles(root);
  if (missing.length) {
    throw new Error(`Incomplete client runtime in ${path.resolve(root)}:\n${missing.map((file) => `  - ${file}`).join('\n')}`);
  }
}

/**
 * Why `root` still expects an Electron runtime, if it does. Empty for a Tauri checkout.
 * @param {string} root
 * @returns {string[]}
 */
export function electronRuntimeProblems(root) {
  const problems = [];
  for (const relative of ELECTRON_RUNTIME_PATHS) {
    if (fs.existsSync(path.join(root, ...relative.split('/')))) {
      problems.push(`Electron runtime present: ${relative} (the Windows client is the Tauri binary built from src-tauri/)`);
    }
  }
  for (const relative of ['package.json', 'desktop/package.json', 'desktop/runtime/package.json']) {
    const pkg = readJsonIfAny(path.join(root, ...relative.split('/')));
    if (!pkg || typeof pkg !== 'object') continue;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps)) {
        if (/^electron(?:-|$)/i.test(name)) {
          problems.push(`${relative} still declares ${field}.${name}: the packaged Windows client must not bundle an Electron runtime`);
        }
      }
    }
  }
  return problems;
}

/**
 * What a released Windows payload is missing, or why it is not a Tauri payload. The payload root is the
 * folder holding the executable (the build script's `Stronghold-Protocol-Client-v<version>-win-x64`).
 * @param {string} root
 * @returns {string[]}
 */
export function windowsClientPayloadProblems(root) {
  const problems = [...electronRuntimeProblems(root)];
  const binary = WINDOWS_CLIENT_BINARIES.find((name) => {
    try {
      return fs.statSync(path.join(root, name)).isFile();
    } catch {
      return false;
    }
  });
  if (!binary) {
    problems.push(`missing the Tauri client binary (${WINDOWS_CLIENT_BINARIES.join(' or ')}) — build it with "cargo tauri build" (src-tauri/target/release/${TAURI_CLIENT_BINARY})`);
  }
  const clientRoot = path.join(root, WINDOWS_CLIENT_DIR);
  for (const relative of missingClientRuntimeFiles(clientRoot)) problems.push(`${WINDOWS_CLIENT_DIR}/${relative}`);
  for (const relative of WINDOWS_CLIENT_NOTICES) {
    if (!fs.existsSync(path.join(root, ...relative.split('/')))) problems.push(relative);
  }
  return problems;
}

export function validateWindowsClientPayload(root) {
  const problems = windowsClientPayloadProblems(root);
  if (problems.length) {
    throw new Error(`Incomplete Windows client payload in ${path.resolve(root)}:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  }
}

const USAGE = 'usage: node tools/validate-client-runtime.mjs <client-root> | --windows-client <payload-root>';

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const windows = argv.includes('--windows-client');
  const root = windows ? argv[argv.indexOf('--windows-client') + 1] : argv.find((arg) => !arg.startsWith('--'));
  if (!root) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    try {
      if (windows) {
        validateWindowsClientPayload(root);
        console.log(`Windows client payload verified: ${path.resolve(root)}`);
      } else {
        validateClientRuntime(root);
        console.log(`Client runtime verified: ${path.resolve(root)}`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
