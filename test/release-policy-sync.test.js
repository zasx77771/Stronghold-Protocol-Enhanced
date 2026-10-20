// One version, one write: `tools/release-policy.mjs --sync` restores the six copies the release
// policy already refuses to publish apart (package.json, package-lock.json, shared/constants.js,
// src-tauri/Cargo.toml, tauri.conf.json, android/app/build.gradle versionName, plus the Android
// versionCode in release-policy.json). These tests pin the write side to the same fields the
// validator reads, and pin it to *only* those fields: a sync that reformatted a lockfile would be a
// worse trade than editing by hand.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planVersionSync } from '../tools/release-policy.mjs';

const FILES = {
  'package.json': '{\n  "name": "stronghold-protocol",\n  "version": "3.2.2",\n  "private": true\n}\n',
  'package-lock.json': '{\n  "name": "stronghold-protocol",\n  "version": "3.2.2",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "stronghold-protocol",\n      "version": "3.2.2"\n    }\n  }\n}\n',
  'shared/constants.js': "// Shared constants.\nexport const APP_VERSION = '3.2.2';\nexport const PROTOCOL = 3;\n",
  'src-tauri/Cargo.toml': '[package]\nname = "stronghold-protocol-native"\nversion = "3.2.2"\nedition = "2021"\n',
  'src-tauri/Cargo.lock': 'version = 4\n\n[[package]]\nname = "stronghold-protocol-native"\nversion = "3.2.2"\ndependencies = [\n "hex",\n]\n\n[[package]]\nname = "hex"\nversion = "0.4.3"\n',
  'src-tauri/tauri.conf.json': '{\n  "productName": "Stronghold Protocol",\n  "version": "3.2.2"\n}\n',
  'android/app/build.gradle': "android {\n  defaultConfig {\n    versionCode 33\n    versionName '3.2.2'\n  }\n}\n",
  'release-policy.json': '{\n  "format": "stronghold-release-policy-v2",\n  "upstreamMainlineVersion": "0.3.2",\n  "androidVersionCode": 33\n}\n',
};

const synced = (version, androidVersionCode) => planVersionSync({ files: FILES, version, androidVersionCode }).files;

describe('planVersionSync', () => {
  test('writes the version into every file the validator compares', () => {
    const out = synced('3.2.3');
    assert.match(out['package.json'], /"version": "3\.2\.3"/);
    assert.match(out['package-lock.json'], /"version": "3\.2\.3",\n  "lockfileVersion"/);
    assert.match(out['package-lock.json'], /"version": "3\.2\.3"\n    \}/);
    assert.match(out['shared/constants.js'], /APP_VERSION = '3\.2\.3'/);
    assert.match(out['src-tauri/Cargo.toml'], /^version = "3\.2\.3"$/m);
    assert.match(out['src-tauri/tauri.conf.json'], /"version": "3\.2\.3"/);
    assert.match(out['android/app/build.gradle'], /versionName '3\.2\.3'/);
    assert.match(out['src-tauri/Cargo.lock'], /name = "stronghold-protocol-native"\nversion = "3\.2\.3"/);
    assert.match(out['src-tauri/Cargo.lock'], /name = "hex"\nversion = "0\.4\.3"/);
    for (const [file, text] of Object.entries(out)) if (file !== 'release-policy.json') assert.doesNotMatch(text, /3\.2\.2/, file);
  });

  test('keeps every other line byte for byte', () => {
    const out = synced('3.2.3');
    assert.equal(out['package.json'], FILES['package.json'].replace('"3.2.2"', '"3.2.3"'));
    assert.equal(out['shared/constants.js'], FILES['shared/constants.js'].replace("'3.2.2'", "'3.2.3'"));
    assert.equal(out['src-tauri/Cargo.toml'], FILES['src-tauri/Cargo.toml'].replace('"3.2.2"', '"3.2.3"'));
    assert.equal(out['android/app/build.gradle'], FILES['android/app/build.gradle'].replace("'3.2.2'", "'3.2.3'"));
  });

  test('bumps the Android versionCode only when one is given', () => {
    assert.match(synced('3.2.3', 34)['android/app/build.gradle'], /versionCode 34/);
    assert.match(synced('3.2.3', 34)['release-policy.json'], /"androidVersionCode": 34/);
    assert.match(synced('3.2.3')['android/app/build.gradle'], /versionCode 33/);
    assert.equal(synced('3.2.3')['release-policy.json'], FILES['release-policy.json']);
  });

  test('the same version changes nothing', () => {
    const out = synced('3.2.2');
    for (const file of Object.keys(FILES)) assert.equal(out[file], FILES[file], file);
  });

  test('refuses to guess when a version field is missing', () => {
    const broken = { ...FILES, 'android/app/build.gradle': "android {\n  defaultConfig {\n    versionCode 33\n  }\n}\n" };
    assert.throws(() => planVersionSync({ files: broken, version: '3.2.3' }), /versionName/);
    assert.throws(() => planVersionSync({ files: { ...FILES, 'shared/constants.js': 'export const X = 1;\n' }, version: '3.2.3' }), /APP_VERSION/);
  });

  test('rejects a version that is not X.Y.Z', () => {
    assert.throws(() => planVersionSync({ files: FILES, version: '3.2' }), /X\.Y\.Z/);
  });
});
