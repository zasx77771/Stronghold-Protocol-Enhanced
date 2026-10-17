#!/usr/bin/env node
// Runnable JVM test for the Android runtime asset store.
//
// Two jobs:
//   1. build a fixture with the real release tooling (tools/assetPackages.mjs): a stamped floor
//      tree, one base package, one delta package and a release index;
//   2. compile the Android asset classes that have no Android dependency plus the self-test, and run
//      it on the JVM (JDK 17 from the Android toolchain, or whatever JAVA_HOME/SP_JDK_HOME names).
//
// The JVM test then proves that Node's writer and Java's reader agree byte for byte, and that every
// failure path leaves the previous cache untouched. Nothing here needs an emulator, an APK or a
// network connection, and nothing is committed: the fixtures live in the system temp directory.
//
// usage: node tools/android-asset-tests.mjs [--keep] [--fixture <dir>] [--java <dir>] [--report <file>]

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  KIND_BASE, KIND_DELTA, buildIndex, inventoryDigest, inventoryStats,
  planPackage, planRoute, scanAssetFiles, stampRoot, writeIndex, writePackage
} from './assetPackages.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA_ROOT = path.join(REPO, 'android/app/src/main/java/com/strongholdprotocol/covenant/assets');
const TEST_SOURCE = path.join(REPO, 'android/app/src/test/java/com/strongholdprotocol/covenant/assets/AssetSelfTest.java');

// The classes the JVM test needs: everything that does not touch the Android SDK. AssetApkSource and
// RuntimeAssetHandler need android.jar and androidx.webkit, so they are compiled by the Gradle build
// and exercised on a device; the logic they delegate to (AssetPaths, AssetStore) is covered here.
const PURE_SOURCES = [
  'AssetJson.java',
  'AssetInventory.java',
  'AssetPaths.java',
  'AssetPackage.java',
  'AssetIndex.java',
  'AssetStore.java',
  'AssetSource.java',
  'DirectoryAssetSource.java',
  'AssetConfig.java',
  'AssetUpdater.java',
  'AssetUpdateSession.java'
];

const say = (message) => console.log(`android-asset-tests: ${message}`);
const fail = (message) => {
  console.error(`android-asset-tests: ${message}`);
  process.exit(1);
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const [key, inline] = item.slice(2).split('=');
    if (inline !== undefined) { args[key] = inline; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

/** Locate a JDK 17: an explicit path first, then the Android toolchain the release scripts use. */
export function findJdk(explicit = null) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const roots = [];
  for (const root of [explicit, process.env.SP_JDK_HOME, process.env.SP_ANDROID_JDK, process.env.JAVA_HOME]) {
    if (root) roots.push(root);
  }
  // The convention keeps the Android toolchain outside the source tree, next to the checkout (and one
  // level above the main worktree when this runs from a worktree), so walk the ancestors and look.
  const toolchain = ['enhanced-client-servers', '06-构建环境与缓存', 'android-toolchain', 'jdk-17'];
  let here = REPO;
  for (let level = 0; level < 4; level += 1) {
    roots.push(path.join(here, ...toolchain));
    const parent = path.dirname(here);
    if (parent === here) break;
    here = parent;
  }
  for (const root of roots) {
    const javac = path.join(root, 'bin', `javac${exe}`);
    const java = path.join(root, 'bin', `java${exe}`);
    if (existsSync(javac) && existsSync(java)) return { root, javac, java };
  }
  for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const javac = path.join(entry, `javac${exe}`);
    const java = path.join(entry, `java${exe}`);
    if (existsSync(javac) && existsSync(java)) return { root: path.dirname(entry), javac, java };
  }
  return null;
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Build the cross-language fixture: the same shapes the release tooling produces, in miniature. Every
 * file is a few bytes of text so the fixture stays a temp-directory artifact.
 */
export function buildFixture(dir) {
  const floor = path.join(dir, 'floor');
  const tree2 = path.join(dir, 'trees/v2.0.0');
  const tree3 = path.join(dir, 'trees/v2.0.1');
  const packages = path.join(dir, 'packages');
  const indexDir = path.join(dir, 'index');

  const floorContent = {
    'data/assets.json': '{"version":1,"chars":{"char_002_amiya":{"avatar":"/assets/char/avatar/char_002_amiya.png"}}}',
    'data/local-assets.json': '{"version":1,"scenes":[]}',
    'assets/char/avatar/char_002_amiya.png': 'amiya-v1',
    'assets/ui/panel.png': 'panel-v1',
    'fonts/fonts.css': 'body{color:#fff}'
  };
  const v2Content = {
    'data/assets.json': '{"version":1,"chars":{"char_002_amiya":{"avatar":"/assets/char/avatar/char_002_amiya.png"},"char_003_kalts":{"avatar":"/assets/char/avatar/char_003_kalts.png"}}}',
    'data/local-assets.json': '{"version":1,"scenes":[]}',
    'assets/char/avatar/char_002_amiya.png': 'amiya-v2',
    'assets/char/avatar/char_003_kalts.png': 'kalts-v2',
    'fonts/fonts.css': 'body{color:#fff}'
  };
  const v3Content = {
    'data/assets.json': v2Content['data/assets.json'],
    'assets/char/avatar/char_002_amiya.png': 'amiya-v2',
    'assets/char/avatar/char_003_kalts.png': 'kalts-v3',
    'assets/ui/banner.png': 'banner-v3',
    'fonts/fonts.css': 'body{color:#000}'
  };

  for (const [rel, text] of Object.entries(floorContent)) write(path.join(floor, rel), text);
  for (const [rel, text] of Object.entries(v2Content)) write(path.join(tree2, rel), text);
  for (const [rel, text] of Object.entries(v3Content)) write(path.join(tree3, rel), text);

  stampRoot(floor, '1.0.0');
  const inv1 = scanAssetFiles(floor);
  const inv2 = scanAssetFiles(tree2);
  const inv3 = scanAssetFiles(tree3);

  const baseName = 'assets-base-2.0.0.zip';
  const deltaName = 'assets-delta-2.0.0-2.0.1.zip';
  const base = writePackage({
    out: path.join(packages, baseName),
    manifest: planPackage({ kind: KIND_BASE, version: '2.0.0', after: inv2 }),
    root: tree2
  });
  const delta = writePackage({
    out: path.join(packages, deltaName),
    manifest: planPackage({ kind: KIND_DELTA, version: '2.0.1', from: '2.0.0', before: inv2, after: inv3 }),
    root: tree3
  });

  const stat2 = inventoryStats(inv2);
  const stat3 = inventoryStats(inv3);
  const stat1 = inventoryStats(inv1);
  const index = buildIndex({
    latest: '2.0.1',
    packages: [
      { name: baseName, size: base.size, sha256: base.sha256, version: '2.0.0', inventory: inventoryDigest(inv2), count: stat2.count, bytes: stat2.bytes },
      { name: deltaName, size: delta.size, sha256: delta.sha256, version: '2.0.1', from: '2.0.0', inventory: inventoryDigest(inv3), count: stat3.count, bytes: stat3.bytes }
    ]
  });
  // The floor version is published too (older clients are still supported) even though its package is
  // no longer kept, which is exactly the case a base package exists for.
  index.versions['1.0.0'] = { inventory: inventoryDigest(inv1), count: stat1.count, bytes: stat1.bytes };
  writeIndex(path.join(indexDir, 'assets-index.json'), index);

  const locals = [
    { label: 'floor', version: '1.0.0', inventory: inventoryDigest(inv1), maxChain: 3 },
    { label: 'base', version: '2.0.0', inventory: inventoryDigest(inv2), maxChain: 3 },
    { label: 'latest', version: '2.0.1', inventory: inventoryDigest(inv3), maxChain: 3 },
    { label: 'mismatch', version: '2.0.0', inventory: '9'.repeat(64), maxChain: 3 },
    { label: 'fresh', version: null, inventory: null, maxChain: 3 },
    { label: 'blocked', version: '1.0.0', inventory: inventoryDigest(inv1), maxChain: 0 }
  ];
  const routes = locals.map((local) => {
    const plan = planRoute(index, { version: local.version, inventory: local.inventory }, { maxChain: local.maxChain });
    return {
      label: local.label,
      localVersion: local.version,
      localInventory: local.inventory,
      maxChain: local.maxChain,
      status: plan.status,
      routeKind: plan.route ? plan.route.kind : null,
      names: plan.route ? plan.route.steps.map((step) => step.name) : []
    };
  });

  const filesOf = (content, pick) => Object.fromEntries(pick.map((rel) => [rel, content[rel]]));
  const manifest = {
    format: 'sp-asset-selftest-fixture-v1',
    floor: { version: '1.0.0', inventory: inventoryDigest(inv1), count: stat1.count, bytes: stat1.bytes },
    base: { name: baseName, sha256: base.sha256, version: '2.0.0', inventory: inventoryDigest(inv2), count: stat2.count, bytes: stat2.bytes },
    delta: { name: deltaName, sha256: delta.sha256, from: '2.0.0', to: '2.0.1', inventory: inventoryDigest(inv3), count: stat3.count, bytes: stat3.bytes },
    indexName: 'assets-index.json',
    floorFiles: filesOf(floorContent, ['assets/char/avatar/char_002_amiya.png', 'assets/ui/panel.png', 'fonts/fonts.css']),
    baseFiles: filesOf(v2Content, ['assets/char/avatar/char_002_amiya.png', 'assets/char/avatar/char_003_kalts.png', 'data/assets.json']),
    baseAbsent: ['assets/ui/panel.png'],
    deltaFiles: filesOf(v3Content, ['assets/char/avatar/char_003_kalts.png', 'assets/ui/banner.png', 'fonts/fonts.css', 'data/assets.json']),
    deltaAbsent: ['data/local-assets.json'],
    routes
  };
  write(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}

/** Compile and run the JVM self-test with an explicit JDK. Output is inherited: no pipes involved. */
export function runJvm(jdk, { fixture, report, classes, quiet = false }) {
  mkdirSync(classes, { recursive: true });
  const sources = PURE_SOURCES.map((name) => path.join(JAVA_ROOT, name));
  const missing = [...sources, TEST_SOURCE].filter((file) => !existsSync(file));
  if (missing.length) fail(`missing source file(s): ${missing.join(', ')}`);
  const compile = spawnSync(jdk.javac, ['-encoding', 'UTF-8', '-Xlint:all', '-d', classes, ...sources, TEST_SOURCE], {
    stdio: quiet ? 'ignore' : 'inherit'
  });
  if (compile.status !== 0) fail(`javac failed with exit code ${compile.status}`);
  const args = ['-cp', classes, 'com.strongholdprotocol.covenant.assets.AssetSelfTest', fixture];
  if (report) args.push('--report', report);
  const run = spawnSync(jdk.java, args, { stdio: quiet ? 'ignore' : 'inherit' });
  if (run.status !== 0) fail(`the JVM self-test failed with exit code ${run.status}`);
  return { status: run.status, report: report && existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null };
}

function main(argv) {
  const args = parseArgs(argv);
  const jdk = findJdk(typeof args.java === 'string' ? args.java : null);
  if (!jdk) {
    // No JDK: report it instead of failing a machine that cannot run the JVM part at all. The caller
    // (test/asset-package.test.js) turns this into a skip, never into a silent pass.
    say('SKIP no JDK 17 found (set SP_JDK_HOME or run scripts/install-android-toolchain.ps1)');
    process.exit(0);
  }
  say(`JDK ${jdk.root}`);
  const work = typeof args.fixture === 'string' ? path.resolve(args.fixture) : mkdtempSync(path.join(tmpdir(), 'sp-asset-fixture-'));
  try {
    if (!existsSync(path.join(work, 'manifest.json'))) buildFixture(work);
    say(`fixture ${work}`);
    const result = runJvm(jdk, {
      fixture: work,
      report: path.join(work, 'asset-selftest-report.json'),
      classes: path.join(work, 'classes')
    });
    if (result.report) say(`${result.report.checks} check(s), ${result.report.failures} failure(s)`);
    say('PASS');
  } finally {
    if (!args.keep && typeof args.fixture !== 'string') rmSync(work, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
