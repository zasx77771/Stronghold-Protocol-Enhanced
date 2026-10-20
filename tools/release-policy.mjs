import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
function fail(message) { throw new Error(`Release policy violation: ${message}`); }
function readJson(file) { return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')); }
function versionParts(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  if (!match) fail(`${label} must use X.Y.Z form, received ${value}`);
  return match.slice(1).map(Number);
}

export function validateReleasePolicy({ mainline = false } = {}) {
  const policy = readJson('release-policy.json');
  if (policy.format !== 'stronghold-release-policy-v2') fail('unsupported release-policy.json format');
  const [upstreamMajor, upstreamMinor, upstreamPatch] = versionParts(policy.upstreamMainlineVersion, 'upstreamMainlineVersion');
  if (upstreamMajor !== 0) fail(`upstreamMainlineVersion must use 0.M.N form, received ${policy.upstreamMainlineVersion}`);
  if (!Number.isInteger(policy.androidVersionCode) || policy.androidVersionCode < 1) fail('androidVersionCode must be a positive integer');
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const constants = readFileSync(resolve(ROOT, 'shared/constants.js'), 'utf8');
  const cargo = readFileSync(resolve(ROOT, 'src-tauri/Cargo.toml'), 'utf8');
  // Cargo.lock repeats the package version and silently drifts: 3.2.2 shipped a lock still saying
  // 3.2.1, and the next `cargo build` rewrote it inside the first commit that touched the crate.
  const cargoLock = readFileSync(resolve(ROOT, 'src-tauri/Cargo.lock'), 'utf8');
  const tauri = readJson('src-tauri/tauri.conf.json');
  const android = readFileSync(resolve(ROOT, 'android/app/build.gradle'), 'utf8');
  const appVersion = /export const APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(constants)?.[1];
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  const cargoLockVersion = /name = "stronghold-protocol-native"\s*\nversion = "([^"]+)"/.exec(cargoLock)?.[1];
  const androidVersion = /versionName\s+['"]([^'"]+)['"]/.exec(android)?.[1];
  const androidCode = Number(/versionCode\s+(\d+)/.exec(android)?.[1]);
  const [major, minor, revision] = versionParts(pkg.version, 'package.json version');
  if (major !== upstreamMinor || minor !== upstreamPatch) fail(`upstream ${policy.upstreamMainlineVersion} requires local ${upstreamMinor}.${upstreamPatch}.*, received ${pkg.version}`);
  if (mainline && revision !== 0) fail(`a mainline release must have revision 0, received ${pkg.version}`);
  for (const [label, value] of Object.entries({
    'package-lock.json version': lock.version,
    'package-lock.json root package version': lock.packages?.['']?.version,
    'shared/constants.js APP_VERSION': appVersion,
    'src-tauri/Cargo.toml version': cargoVersion,
    'src-tauri/Cargo.lock package version': cargoLockVersion,
    'src-tauri/tauri.conf.json version': tauri.version,
    'android/app/build.gradle versionName': androidVersion,
  })) if (value !== pkg.version) fail(`${label} must equal package.json version ${pkg.version}, received ${value ?? 'missing'}`);
  if (androidCode !== policy.androidVersionCode) fail(`android versionCode must equal release-policy.json (${policy.androidVersionCode}), received ${Number.isNaN(androidCode) ? 'missing' : androidCode}`);
  return { localVersion: pkg.version, upstreamMainlineVersion: policy.upstreamMainlineVersion, androidVersionCode: androidCode };
}

const SYNC_FILES = [
  'package.json',
  'package-lock.json',
  'shared/constants.js',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'android/app/build.gradle',
];

function replaceOnce(text, pattern, label, replacement) {
  const match = pattern.exec(text);
  if (!match) fail(`${label}: the expected version field was not found`);
  return text.replace(pattern, replacement);
}

/// Rewrites the seven places a release version lives, from one input.
///
/// The validator below already refuses a build whose copies disagree, but the only way to fix them
/// was editing six files by hand — and a missed one costs a full rebuild of both clients to find
/// out. This is the write side of the same contract: it takes the file contents it was given and
/// returns them with only the version lines changed, so formatting elsewhere survives untouched.
export function planVersionSync({ files, version, androidVersionCode }) {
  const [major, minor, revision] = versionParts(version, 'sync version');
  const out = { ...files };
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionLine = (file, label) => {
    const current = /"version"\s*:\s*"([^"]+)"/.exec(files[file])?.[1];
    if (!current) fail(`${label}: a "version" field was not found`);
    out[file] = replaceOnce(files[file], new RegExp(`("version"\\s*:\\s*")${esc(current)}(")`, 'g'), label, `$1${version}$2`);
  };
  versionLine('package.json', 'package.json');
  versionLine('package-lock.json', 'package-lock.json');
  out['shared/constants.js'] = replaceOnce(files['shared/constants.js'], /(export const APP_VERSION\s*=\s*['"])[^'"]+(['"])/, 'shared/constants.js APP_VERSION', `$1${version}$2`);
  out['src-tauri/Cargo.toml'] = replaceOnce(files['src-tauri/Cargo.toml'], /^(version\s*=\s*")[^"]+(")/m, 'src-tauri/Cargo.toml version', `$1${version}$2`);
  out['src-tauri/Cargo.lock'] = replaceOnce(files['src-tauri/Cargo.lock'], /(name = "stronghold-protocol-native"\s*\nversion = ")[^"]+(")/, 'src-tauri/Cargo.lock package version', `$1${version}$2`);
  out['src-tauri/tauri.conf.json'] = replaceOnce(files['src-tauri/tauri.conf.json'], /("version"\s*:\s*")[^"]+(")/, 'src-tauri/tauri.conf.json version', `$1${version}$2`);
  out['android/app/build.gradle'] = replaceOnce(files['android/app/build.gradle'], /(versionName\s+['"])[^'"]+(['"])/, 'android/app/build.gradle versionName', `$1${version}$2`);
  if (androidVersionCode !== undefined) {
    out['android/app/build.gradle'] = replaceOnce(out['android/app/build.gradle'], /(versionCode\s+)(\d+)/, 'android/app/build.gradle versionCode', `$1${androidVersionCode}`);
  }
  out['release-policy.json'] = androidVersionCode === undefined
    ? files['release-policy.json']
    : replaceOnce(files['release-policy.json'], /("androidVersionCode"\s*:\s*)\d+/, 'release-policy.json androidVersionCode', `$1${androidVersionCode}`);
  return { files: out, localVersion: version, upstream: `${major}.${minor}.${revision}` };
}

function runSync(argv) {
  const codeFlag = argv.indexOf('--code');
  const requested = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--code')[0];
  const policy = readJson('release-policy.json');
  const current = readJson('package.json').version;
  const version = requested ?? current;
  versionParts(version, 'sync version');
  const androidVersionCode = codeFlag >= 0 ? Number(argv[codeFlag + 1]) : undefined;
  if (androidVersionCode !== undefined && (!Number.isInteger(androidVersionCode) || androidVersionCode < 1)) fail('--code must be a positive integer');
  const files = Object.fromEntries([...SYNC_FILES, 'release-policy.json'].map((file) => [file, readFileSync(resolve(ROOT, file), 'utf8')]));
  const plan = planVersionSync({ files, version, androidVersionCode });
  const changed = Object.keys(plan.files).filter((file) => plan.files[file] !== files[file]);
  for (const file of changed) writeFileSync(resolve(ROOT, file), plan.files[file]);
  const result = validateReleasePolicy({});
  process.stdout.write(`Release version ${result.localVersion} written to ${changed.length} file(s): ${changed.join(', ') || 'nothing to change'}. Android versionCode ${result.androidVersionCode} (policy ${policy.androidVersionCode}). Upstream ${result.upstreamMainlineVersion}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--sync')) {
      runSync(argv);
    } else {
      const result = validateReleasePolicy({ mainline: argv.includes('--mainline') });
      process.stdout.write(`Release policy valid: upstream ${result.upstreamMainlineVersion}, local ${result.localVersion}, Android versionCode ${result.androidVersionCode}.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
