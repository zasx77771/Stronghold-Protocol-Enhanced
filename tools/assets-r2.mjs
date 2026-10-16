#!/usr/bin/env node
/**
 * CLI for the runtime asset packages published to Cloudflare R2.
 *
 * `node tools/assets-r2.mjs --help` lists the commands. Nothing in here touches the network: it
 * builds packages, writes the release index, verifies packages exactly like the Android client and
 * prints the upload commands an operator runs with their own R2 credentials.
 *
 * Typical release:
 *   node tools/assets-r2.mjs state --root <android-embedded-assets> --version 2.6.2
 *   node tools/assets-r2.mjs release --dir .../03-素材增量包 --version 2.6.2 \
 *     --after <android-embedded-assets> --from 2.6.1 --before <previous full client dir>
 *   node tools/assets-r2.mjs verify --package .../assets-delta-2.6.1-2.6.2.zip
 *   node tools/assets-r2.mjs upload-plan --dir .../03-素材增量包 --endpoint <https://…r2…/assets>
 * The single-package commands (`pack`, `index`) stay available for repairs and manual work.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FORMAT, DEFAULT_MAX_CHAIN, INDEX_FILE, KIND_BASE, KIND_DELTA, PACKAGE_FORMAT, STATE_FILE,
  applyPackage, basePackageName, buildIndex, checkConfig, compareVersions, deltaPackageName,
  formatBytes, inventoryDigest, inventoryStats, isAssetPath, loadInventory, loadRootState, makeConfig,
  packageNameInfo, planPackage, planRelease, planRoute, readIndex, readPackageManifest, scanAssetFiles,
  sha256File, stampRoot, stateFromInventory, strandedVersions, verifyPackage, writeIndex, writePackage, writeState
} from './assetPackages.mjs';

const USAGE = `usage: node tools/assets-r2.mjs <command> [options]

commands:
  state        scan an asset tree and write its state file (the APK floor)
                 --root <dir> --version <M.N.R> [--out <file>]

  pack         write one base or delta package
                 --kind base|delta --version <version> --after <dir> --out <dir>
                 [--from <version>] [--before <dir> | --before-package <zip> | --before-state <file>]
                 [--name <file>] [--allow-empty]

  index        read every package in a directory and write the release index
                 --dir <dir> [--latest <version>] [--max-chain <n>] [--out <file>]

  release      build this release's packages and refresh the index (baseline when needed)
                 --dir <channel dir> --version <M.N.R> --after <dir>
                 [--from <version> --before <dir>] [--mainline] [--force-base]
                 [--max-chain <n>]

  route        print the route a client with a given state would take
                 (--index <file> | --dir <dir>) [--root <dir> | --version <v> --inventory <sha256>]
                 [--max-chain <n>]

  verify       verify one package the way the client does
                 --package <zip> [--sha256 <hex>] [--before-package <zip>] [--json]

  apply        apply a package to an asset tree (reference applier used by the tests)
                 --root <dir> --package <zip> [--sha256 <hex>]

  config       write the public runtime configuration (index URL + limits)
                 --index-url <url> [--out <file>] [--allow-http] [--max-chain <n>]
                 [--max-download-bytes <n>] [--max-extract-bytes <n>] [--check <file>]

  upload-plan  print the operator upload commands for the R2 bucket
                 --dir <dir> [--endpoint <url>] [--public-base <url>] [--json]`;

const fail = (message) => {
  console.error(`assets-r2: ${message}`);
  process.exit(1);
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--help' || item === '-h') { args.help = true; continue; }
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) { args[key] = inline; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

const need = (args, key, hint) => {
  if (!args[key] || args[key] === true) fail(`${hint || `--${key} is required`}`);
  return String(args[key]);
};

const json = (value) => console.log(JSON.stringify(value, null, 2));

/**
 * Accept either an asset root itself (`assets/`, `fonts/`, `data/assets.json`) or a released client
 * directory that carries those files under `public/` (the full Windows client). A released client can
 * therefore be the previous state of a delta without being copied anywhere.
 */
function resolveAssetRoot(input, flag) {
  const dir = path.resolve(input);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`${flag} ${input} is not a directory`);
  if (existsSync(path.join(dir, 'assets')) || existsSync(path.join(dir, 'data', 'assets.json'))) return dir;
  const inner = path.join(dir, 'public');
  if (existsSync(path.join(inner, 'assets')) || existsSync(path.join(inner, 'data', 'assets.json'))) return inner;
  fail(`${flag} ${input} is neither an asset root nor a client directory with public/assets`);
  return null;
}

/** Inventory of a source tree, refusing to guess when a state file disagrees with the files. */
function inventoryOfTree(root, { version = null } = {}) {
  const state = loadRootState(root);
  const files = scanAssetFiles(root);
  const stats = inventoryStats(files);
  if (state && state.version !== version && version) {
    fail(`${root} carries state version ${state.version}, but ${version} was requested; build the tree first`);
  }
  if (state) {
    const digest = inventoryDigest(files);
    if (digest !== state.inventory) {
      fail(`${root}/${STATE_FILE} does not match the files on disk (${digest} != ${state.inventory}); run state again`);
    }
  }
  return { files, stats, state, version: version || (state && state.version) || null };
}

function inventoryOfBeforePackage(file) {
  const manifest = readPackageManifest(file);
  if (manifest.format !== PACKAGE_FORMAT) fail(`${file} is not an asset package`);
  if (manifest.kind !== KIND_BASE) {
    fail(`${file} is a delta package; pass the published base package as --before-package`);
  }
  return { files: manifest.files, version: manifest.version, stats: inventoryStats(manifest.files) };
}

function commandState(args) {
  const input = need(args, 'root');
  const root = resolveAssetRoot(input, '--root');
  const version = need(args, 'version', '--version is required (the public M.N.R version)');
  const nested = path.resolve(input) !== root;
  if (!args.out && nested) {
    fail('--out is required when --root names a client directory; a released tree is never modified');
  }
  const out = args.out ? String(args.out) : path.join(root, STATE_FILE);
  const files = scanAssetFiles(root);
  const state = stateFromInventory(version, files);
  if (!Object.keys(files).length) fail(`${root} contains no asset files; check --root`);
  writeState(out, state);
  const stats = inventoryStats(files);
  json({ state: out, root, version, count: stats.count, bytes: stats.bytes, inventory: state.inventory });
}

function commandPack(args) {
  const kind = need(args, 'kind');
  if (kind !== KIND_BASE && kind !== KIND_DELTA) fail('--kind must be base or delta');
  const version = need(args, 'version');
  const afterRoot = resolveAssetRoot(need(args, 'after', '--after is required (the asset tree of the new version)'), '--after');
  const outDir = need(args, 'out');
  const from = args.from ? String(args.from) : null;
  if (kind === KIND_DELTA && !from) fail('a delta package needs --from');
  const after = inventoryOfTree(afterRoot, { version });
  if (!after.stats.count) fail(`${afterRoot} contains no asset files`);
  let before = null;
  if (kind === KIND_DELTA) {
    if (args.beforePackage) before = inventoryOfBeforePackage(String(args.beforePackage));
    else if (args.beforeState) {
      const state = JSON.parse(readFileSync(String(args.beforeState), 'utf8'));
      before = { files: state.files, version: state.version, stats: inventoryStats(state.files) };
    } else if (args.before) {
      before = inventoryOfTree(resolveAssetRoot(String(args.before), '--before'), { version: from });
    } else {
      fail('a delta package needs --before, --before-state or --before-package');
    }
    if (before.version && before.version !== from) {
      fail(`the previous state is ${before.version}, but --from is ${from}`);
    }
    if (inventoryDigest(after.files) === inventoryDigest(before.files) && !args.allowEmpty) {
      fail(`no change between ${from} and ${version}; refusing to write an empty delta (use --allow-empty)`);
    }
  }
  const manifest = planPackage({ kind, version, from, before: before && before.files, after: after.files });
  const name = args.name ? String(args.name) : (kind === KIND_BASE ? basePackageName(version) : deltaPackageName(from, version));
  mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, name);
  if (existsSync(target)) fail(`${target} already exists; published packages are never replaced`);
  const written = writePackage({ out: target, manifest, root: afterRoot });
  json({
    package: target,
    kind,
    version,
    from,
    size: written.size,
    sha256: written.sha256,
    entries: written.entries,
    shipped: manifest.shipped,
    total: { count: manifest.count, bytes: manifest.bytes },
    inventory: manifest.inventory,
    removed: (manifest.removed || []).length
  });
}

function loadIndexFrom(args) {
  if (args.index) return { index: readIndex(String(args.index)), file: String(args.index) };
  const dir = need(args, 'dir', '--index or --dir is required');
  const file = path.join(dir, INDEX_FILE);
  if (existsSync(file)) return { index: readIndex(file), file };
  return { index: buildIndexFromDir(dir, args), file: null };
}

function packageEntries(dir, { maxChain }) {
  const packages = [];
  for (const name of readdirSync(dir).sort()) {
    const info = packageNameInfo(name);
    if (!info) continue;
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    const manifest = readPackageManifest(file);
    packages.push({
      name,
      kind: info.kind,
      version: manifest.version,
      from: manifest.from,
      fromInventory: manifest.fromInventory || null,
      size: statSync(file).size,
      sha256: sha256File(file),
      inventory: manifest.inventory,
      count: manifest.count,
      bytes: manifest.bytes
    });
  }
  return buildIndex({ packages, maxChain, latest: null });
}

function buildIndexFromDir(dir, args) {
  const index = packageEntries(dir, { maxChain: Number(args.maxChain || DEFAULT_MAX_CHAIN) });
  if (args.latest) index.latest = String(args.latest);
  return index;
}

function commandIndex(args) {
  const dir = need(args, 'dir');
  const out = args.out ? String(args.out) : path.join(dir, INDEX_FILE);
  const index = packageEntries(dir, { maxChain: Number(args.maxChain || DEFAULT_MAX_CHAIN) });
  if (args.latest) index.latest = String(args.latest);
  if (!index.bases.length && !index.deltas.length) fail(`${dir} holds no assets-base-*.zip or assets-delta-*.zip`);
  if (!index.latest) fail('no --latest and no package version to infer it from');
  writeIndex(out, index);
  json({
    index: out,
    latest: index.latest,
    maxChain: index.maxChain,
    bases: index.bases.length,
    deltas: index.deltas.length,
    versions: Object.keys(index.versions).length,
    bytes: readFileSync(out).length
  });
}

/** Write one release package, keeping an already published file untouched. */
function writeReleasePackage({ kind, version, from = null, afterRoot, after, before = null, dir, notes }) {
  const name = kind === KIND_BASE ? basePackageName(version) : deltaPackageName(from, version);
  const target = path.join(dir, name);
  if (existsSync(target)) {
    const manifest = readPackageManifest(target);
    notes.push(`${name} already exists and stays as published`);
    return {
      name,
      path: target,
      size: statSync(target).size,
      sha256: sha256File(target),
      kept: true,
      shipped: manifest.shipped,
      total: { count: manifest.count, bytes: manifest.bytes },
      inventory: manifest.inventory
    };
  }
  const manifest = planPackage({ kind, version, from, before, after });
  const written = writePackage({ out: target, manifest, root: afterRoot });
  if (kind === KIND_DELTA && !Object.keys(manifest.files || {}).length) {
    notes.push(`${name} ships no file; it only moves the published version to ${version}`);
  }
  return {
    name,
    path: target,
    ...written,
    kept: false,
    shipped: manifest.shipped,
    total: { count: manifest.count, bytes: manifest.bytes },
    inventory: manifest.inventory
  };
}

/**
 * Publish one release and refresh the index.
 *
 * The index keeps the shortest safe path from every published version: a client whose local inventory
 * still matches what was published for its version takes the delta chain, anything else takes the
 * newest baseline that still reaches the target. A baseline is written when the release crosses an
 * upstream baseline (`--mainline`), when none is published yet, when the previous tree no longer
 * matches what was published for it (the delta would reach nobody), when the chain out of the newest
 * baseline would exceed the client limit, or when a published version would otherwise be stranded.
 */
function commandRelease(args) {
  const dir = path.resolve(need(args, 'dir', '--dir is required (the channel directory holding the published packages)'));
  const version = need(args, 'version', '--version is required (the M.N.R version being published)');
  const afterRoot = resolveAssetRoot(need(args, 'after', '--after is required (the asset tree of the new version)'), '--after');
  const from = args.from ? String(args.from) : null;
  const maxChain = args.maxChain ? Number(args.maxChain) : DEFAULT_MAX_CHAIN;
  if (!Number.isInteger(maxChain) || maxChain < 1) fail('--max-chain must be a positive integer');
  mkdirSync(dir, { recursive: true });

  const after = inventoryOfTree(afterRoot, { version });
  if (!after.stats.count) fail(`${afterRoot} contains no asset files`);
  const afterDigest = inventoryDigest(after.files);

  let before = null;
  if (from && args.before) {
    before = inventoryOfTree(resolveAssetRoot(String(args.before), '--before'), { version: from });
    if (before.version && before.version !== from) fail(`the previous tree is ${before.version}, but --from is ${from}`);
  }

  const indexPath = path.join(dir, INDEX_FILE);
  const published = existsSync(indexPath) ? readIndex(indexPath) : null;
  const notes = [];
  const wrote = { base: null, delta: null };

  const decision = planRelease({
    index: published,
    afterDigest,
    beforeDigest: before ? inventoryDigest(before.files) : null,
    from,
    to: version,
    mainline: Boolean(args.mainline),
    forceBase: Boolean(args.forceBase),
    maxChain
  });
  notes.push(...decision.notes);
  const base = decision.base;
  const delta = decision.delta;

  if (base) wrote.base = writeReleasePackage({ kind: KIND_BASE, version, afterRoot, after: after.files, dir, notes });
  if (delta) {
    wrote.delta = writeReleasePackage({
      kind: KIND_DELTA, version, from, afterRoot, after: after.files, before: before.files, dir, notes
    });
  }
  if (!wrote.base && !wrote.delta) fail('nothing to publish: pass --after and either --from/--before or --mainline');

  const refresh = () => {
    const index = packageEntries(dir, { maxChain });
    index.latest = version;
    writeIndex(indexPath, index);
    return index;
  };
  let index = refresh();
  let stranded = strandedVersions(index, maxChain);
  if (stranded.length && !wrote.base) {
    notes.push(`${stranded.join(', ')} could no longer reach ${version}; publishing a baseline`);
    wrote.base = writeReleasePackage({ kind: KIND_BASE, version, afterRoot, after: after.files, dir, notes });
    index = refresh();
    stranded = strandedVersions(index, maxChain);
  }

  for (const item of [wrote.base, wrote.delta]) {
    if (!item) continue;
    const problems = verifyPackage(item.path, { expectedSha256: item.sha256 }).problems;
    if (problems.length) fail(problems.join('; '));
  }

  const describe = (item) => (item ? {
    name: item.name,
    size: item.size,
    sha256: item.sha256,
    kept: item.kept,
    shipped: item.shipped,
    total: item.total,
    inventory: item.inventory
  } : null);
  json({
    dir,
    index: indexPath,
    latest: version,
    maxChain,
    base: describe(wrote.base),
    delta: describe(wrote.delta),
    versions: Object.keys(index.versions).length,
    stranded,
    notes
  });
}

function localState(args) {
  if (args.root) {
    const info = loadInventory(String(args.root));
    return { version: info.version, inventory: info.inventory, floor: info.floor, layers: info.layers.length };
  }
  if (args.version) {
    return { version: String(args.version), inventory: args.inventory ? String(args.inventory) : null, floor: 'none', layers: 0 };
  }
  return { version: null, inventory: null, floor: 'none', layers: 0 };
}

function commandRoute(args) {
  const { index, file } = loadIndexFrom(args);
  const local = localState(args);
  const plan = planRoute(index, local, { maxChain: Number(args.maxChain || index.maxChain || DEFAULT_MAX_CHAIN) });
  json({ index: file, local, ...plan });
  if (plan.status === 'blocked') process.exit(1);
}

function commandVerify(args) {
  const file = need(args, 'package');
  let before = null;
  if (args.beforePackage) before = inventoryOfBeforePackage(String(args.beforePackage)).files;
  const result = verifyPackage(file, {
    expectedSha256: args.sha256 ? String(args.sha256) : null,
    before
  });
  const summary = {
    package: file,
    sha256: result.sha256,
    kind: result.manifest.kind,
    version: result.manifest.version,
    from: result.manifest.from || null,
    shipped: result.manifest.shipped,
    total: { count: result.manifest.count, bytes: result.manifest.bytes },
    inventory: result.manifest.inventory,
    problems: result.problems
  };
  if (args.json) json(summary);
  else {
    console.log(`${file}`);
    console.log(`  ${summary.kind} ${summary.from ? `${summary.from} -> ` : ''}${summary.version}`);
    console.log(`  sha256 ${summary.sha256}`);
    console.log(`  ships ${summary.shipped.count} files (${formatBytes(summary.shipped.bytes)}), state ${summary.total.count} files (${formatBytes(summary.total.bytes)})`);
    console.log(`  inventory ${summary.inventory}`);
    if (summary.problems.length) for (const problem of summary.problems) console.log(`  problem: ${problem}`);
    else console.log('  ok');
  }
  if (summary.problems.length) process.exit(1);
}

function commandApply(args) {
  const root = need(args, 'root');
  const file = need(args, 'package');
  const result = applyPackage(root, file, { expectedSha256: args.sha256 ? String(args.sha256) : null });
  const after = loadInventory(root);
  json({
    applied: result.applied,
    version: after.version,
    inventory: after.inventory,
    layers: result.layers.length,
    files: result.files,
    removed: result.removed
  });
}

function commandConfig(args) {
  if (args.check) {
    const config = JSON.parse(readFileSync(String(args.check), 'utf8'));
    const problems = checkConfig(config);
    if (problems.length) fail(problems.join('; '));
    console.log(`${args.check}: ok (${config.indexUrl})`);
    return;
  }
  const indexUrl = need(args, 'indexUrl', '--index-url is required (https://…/assets-index.json)');
  const config = makeConfig({
    indexUrl,
    maxChain: Number(args.maxChain || DEFAULT_MAX_CHAIN),
    maxDownloadBytes: args.maxDownloadBytes ? Number(args.maxDownloadBytes) : undefined,
    maxExtractBytes: args.maxExtractBytes ? Number(args.maxExtractBytes) : undefined,
    allowHttp: Boolean(args.allowHttp)
  });
  for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
  if (args.tokenUrl) {
    let tokenUrl;
    try { tokenUrl = new URL(String(args.tokenUrl)); } catch { fail("--token-url must be a valid https URL"); }
    if (tokenUrl.protocol !== "https:" || tokenUrl.username || tokenUrl.password || tokenUrl.search) fail("--token-url must be https without credentials or query");
    config.tokenUrl = tokenUrl.toString();
  }
  const problems = checkConfig(config);
  if (problems.length) fail(problems.join('; '));
  const out = args.out ? String(args.out) : null;
  if (out) {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`${out}\n${JSON.stringify(config, null, 2)}`);
  } else {
    json(config);
  }
  if (config.format !== CONFIG_FORMAT) fail('unexpected config format');
}

function commandUploadPlan(args) {
  const dir = need(args, 'dir');
  const endpoint = args.endpoint ? String(args.endpoint).replace(/\/+$/, '') : '';
  const publicBase = args.publicBase ? String(args.publicBase).replace(/\/+$/, '') : endpoint;
  const files = readdirSync(dir).filter((name) => packageNameInfo(name) || name === INDEX_FILE).sort();
  if (!files.length) fail(`${dir} holds no asset packages or index`);
  if (files.includes(INDEX_FILE)) {
    const index = readIndex(path.join(dir, INDEX_FILE));
    const problems = [];
    for (const item of [...index.bases, ...index.deltas]) {
      const file = path.join(dir, item.name);
      if (!existsSync(file)) problems.push(`${item.name} is listed in the index but missing in ${dir}`);
      else if (statSync(file).size !== Number(item.size)) problems.push(`${item.name} size changed after the index was written`);
    }
    if (problems.length) fail(problems.join('; '));
  }
  const commands = [];
  for (const name of files) {
    const target = endpoint ? `${endpoint}/${name}` : `<R2-BUCKET>/${name}`;
    const cache = name === INDEX_FILE ? 'public, max-age=60, must-revalidate' : 'public, max-age=31536000, immutable';
    const type = name === INDEX_FILE ? 'application/json' : 'application/zip';
    commands.push(`aws s3 cp "${name}" "${target}" --content-type ${type} --cache-control "${cache}"`);
  }
  const urls = publicBase ? files.map((name) => `${publicBase}/${name}`) : [];
  if (args.json) json({ dir, files, commands, urls });
  else {
    console.log('# upload with your own R2 credentials; never commit them');
    for (const command of commands) console.log(command);
    if (urls.length) {
      console.log('# verify these public URLs');
      for (const url of urls) console.log(url);
    }
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (args.help || !command) { console.log(USAGE); return; }
  if (command === 'state') commandState(args);
  else if (command === 'pack') commandPack(args);
  else if (command === 'index') commandIndex(args);
  else if (command === 'release') commandRelease(args);
  else if (command === 'route') commandRoute(args);
  else if (command === 'verify') commandVerify(args);
  else if (command === 'apply') commandApply(args);
  else if (command === 'config') commandConfig(args);
  else if (command === 'upload-plan') commandUploadPlan(args);
  else fail(`unknown command ${command}\n\n${USAGE}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));

export { parseArgs, compareVersions, isAssetPath, stampRoot, makeConfig, main };
