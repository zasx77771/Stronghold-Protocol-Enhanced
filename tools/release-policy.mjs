import { readFileSync } from 'node:fs';
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
  const tauri = readJson('src-tauri/tauri.conf.json');
  const android = readFileSync(resolve(ROOT, 'android/app/build.gradle'), 'utf8');
  const appVersion = /export const APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(constants)?.[1];
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
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
    'src-tauri/tauri.conf.json version': tauri.version,
    'android/app/build.gradle versionName': androidVersion,
  })) if (value !== pkg.version) fail(`${label} must equal package.json version ${pkg.version}, received ${value ?? 'missing'}`);
  if (androidCode !== policy.androidVersionCode) fail(`android versionCode must equal release-policy.json (${policy.androidVersionCode}), received ${Number.isNaN(androidCode) ? 'missing' : androidCode}`);
  return { localVersion: pkg.version, upstreamMainlineVersion: policy.upstreamMainlineVersion, androidVersionCode: androidCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateReleasePolicy({ mainline: process.argv.slice(2).includes('--mainline') });
    process.stdout.write(`Release policy valid: upstream ${result.upstreamMainlineVersion}, local ${result.localVersion}, Android versionCode ${result.androidVersionCode}.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
