import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fail(message) {
  throw new Error(`Release policy violation: ${message}`);
}

function readJson(root, file) {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function versionParts(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  if (!match) fail(`${label} must use X.Y.Z form, received ${value}`);
  return match.slice(1).map(Number);
}

export function assertLocalVersionFor(upstreamVersion, localVersion, policy, { mainline = false } = {}) {
  const [upstreamMajor, upstreamMinor, upstreamPatch] = versionParts(upstreamVersion, 'upstreamMainlineVersion');
  if (upstreamMajor !== 0) fail(`upstreamMainlineVersion must use 0.M.N form, received ${upstreamVersion}`);

  let expectedMajor = upstreamMinor;
  let expectedMinor = upstreamPatch;
  const legacy = policy.legacyVersionLine;
  if (legacy && upstreamVersion === legacy.upstreamVersion) {
    const match = /^(\d+)\.(\d+)$/.exec(String(legacy.localLine));
    if (!match) fail(`legacyVersionLine.localLine must use X.Y form, received ${legacy.localLine}`);
    expectedMajor = Number(match[1]);
    expectedMinor = Number(match[2]);
  }

  const [major, minor, revision] = versionParts(localVersion, 'package.json version');
  if (major !== expectedMajor || minor !== expectedMinor) {
    fail(`upstream ${upstreamVersion} requires local version ${expectedMajor}.${expectedMinor}.*, received ${localVersion}`);
  }
  if (mainline && revision !== 0) {
    fail(`a mainline release for upstream ${upstreamVersion} must be ${expectedMajor}.${expectedMinor}.0, received ${localVersion}`);
  }
  return { expectedMajor, expectedMinor, revision };
}

export function validateReleasePolicy({ root = ROOT, upstreamMainlineVersion = null, mainline = false } = {}) {
  const policy = readJson(root, 'release-policy.json');
  if (policy.format !== 'stronghold-release-policy-v2') fail('unsupported release-policy.json format');
  const upstream = policy.upstreamMainlineVersion;
  versionParts(upstream, 'release-policy.json upstreamMainlineVersion');
  if (upstreamMainlineVersion && upstreamMainlineVersion !== upstream) {
    fail(`command upstream ${upstreamMainlineVersion} does not match release-policy.json upstream ${upstream}`);
  }
  if (!Number.isInteger(policy.androidVersionCode) || policy.androidVersionCode < 1) {
    fail('release-policy.json androidVersionCode must be a positive integer');
  }

  const pkg = readJson(root, 'package.json');
  const lock = readJson(root, 'package-lock.json');
  const desktop = readJson(root, 'desktop/runtime/package.json');
  const constants = readFileSync(resolve(root, 'shared/constants.js'), 'utf8');
  const androidGradle = readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8');
  const appVersion = /export const APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(constants)?.[1];
  const androidVersion = /versionName\s+['"]([^'"]+)['"]/.exec(androidGradle)?.[1];
  const androidCode = Number(/versionCode\s+(\d+)/.exec(androidGradle)?.[1]);

  assertLocalVersionFor(upstream, pkg.version, policy, { mainline });
  for (const [label, value] of Object.entries({
    'package-lock.json version': lock.version,
    'package-lock.json root package version': lock.packages?.['']?.version,
    'shared/constants.js APP_VERSION': appVersion,
    'desktop/runtime/package.json version': desktop.version,
    'android/app/build.gradle versionName': androidVersion,
  })) {
    if (value !== pkg.version) fail(`${label} must equal package.json version ${pkg.version}, received ${value ?? 'missing'}`);
  }
  if (androidCode !== policy.androidVersionCode) {
    fail(`android/app/build.gradle versionCode must equal release-policy.json androidVersionCode ${policy.androidVersionCode}, received ${Number.isNaN(androidCode) ? 'missing' : androidCode}`);
  }
  return { localVersion: pkg.version, upstreamMainlineVersion: upstream, androidVersionCode: androidCode, mainline };
}

function parseArgs(args) {
  const options = { mainline: false, upstreamMainlineVersion: null };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--mainline') options.mainline = true;
    else if (args[index] === '--upstream') options.upstreamMainlineVersion = args[++index] || null;
    else fail(`unknown argument: ${args[index]}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateReleasePolicy(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Release policy valid: upstream ${result.upstreamMainlineVersion}, local ${result.localVersion}, Android versionCode ${result.androidVersionCode}.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
