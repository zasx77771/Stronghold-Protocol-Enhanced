import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_CLIENT_RUNTIME_FILES,
  missingClientRuntimeFiles,
  validateClientRuntime,
} from '../tools/validate-client-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_APP = 'android/app/src/main/java/com/strongholdprotocol/covenant';

/** Source text without comments, so a doc line can never satisfy an assertion about code. */
function withoutComments(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-android-runtime-'));
  for (const relative of REQUIRED_CLIENT_RUNTIME_FILES) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'runtime');
  }
  return root;
}

test('Android embedded runtime validation accepts a complete module graph', () => {
  const root = runtimeFixture();
  try {
    assert.deepEqual(missingClientRuntimeFiles(root), []);
    assert.doesNotThrow(() => validateClientRuntime(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Android embedded runtime validation reports every missing generated dependency', () => {
  const root = runtimeFixture();
  try {
    for (const relative of ['vendor/preact.module.js', 'vendor/pixi.min.js', 'fonts/fonts.css']) {
      fs.rmSync(path.join(root, ...relative.split('/')));
    }
    assert.deepEqual(missingClientRuntimeFiles(root), [
      'vendor/preact.module.js',
      'vendor/pixi.min.js',
      'fonts/fonts.css',
    ]);
    assert.throws(() => validateClientRuntime(root), /vendor\/preact\.module\.js[\s\S]*fonts\/fonts\.css/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Android build prepares vendors and validates the copied runtime before Gradle', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/build-android-client.ps1'), 'utf8');
  const releaseScript = fs.readFileSync(path.join(ROOT, 'scripts/publish-client-release.ps1'), 'utf8');
  const vendor = script.indexOf('tools\\vendor.mjs');
  const validate = script.indexOf('tools\\validate-client-runtime.mjs');
  const gradle = script.indexOf('assembleDebug');
  assert.ok(vendor >= 0, 'the Android build generates ignored vendor files');
  assert.ok(validate > vendor, 'validation runs after vendor preparation');
  assert.ok(gradle > validate, 'validation runs before Gradle packages the APK');
  assert.match(script, /ResourceSourceDir/, 'a release worktree can reuse the prepared assets and fonts');
  assert.match(releaseScript, /AndroidResourceSourceDir/, 'the release entry point exposes the resource source');
  assert.match(releaseScript, /AndroidArguments\.ResourceSourceDir = \$AndroidResourceSourceDir/,
    'the release entry point forwards the resource source to the Android build');
});

// The APK is the only copy of the client program the WebView has: START_URL loads index.html from the
// appassets host and RuntimeAssetHandler answers every other request from the APK when the layered store
// cannot. `android/app/src/main/assets` is not in the repository, so a Gradle run without the staged
// client directory packs nothing and the whole window reads "not found" (404 body). These two tests keep
// the build from packaging such an APK and keep the entry point one fact instead of three.
test('Android build refuses to package an APK that carries no client runtime', () => {
  const gradle = withoutComments('android/app/build.gradle');
  const declared = gradle.match(/def requiredPackagedClientFiles = \[([^\]]*)\]/);
  assert.ok(declared, 'the build names the client files an APK must carry');
  const packaged = [...declared[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(packaged.includes('index.html'), 'index.html is the entry point START_URL loads');
  for (const relative of packaged) {
    assert.ok(REQUIRED_CLIENT_RUNTIME_FILES.includes(relative),
      `${relative} must also be one of REQUIRED_CLIENT_RUNTIME_FILES, so the guard and the build script cannot drift`);
  }
  assert.match(gradle, /sourceSets\.main\.assets\.srcDirs = \[file\(externalAssetsDirectory\)\]/,
    'the guard checks the assets source set Gradle really packages');
  assert.match(gradle, /tasks\.register\('verifyPackagedClient'\)/, 'the guard is a task, not a comment');
  assert.match(gradle, /throw new GradleException\(/, 'the guard fails the build instead of packaging the APK');
  assert.match(gradle, /SP_ANDROID_ASSETS_DIR/, 'the failure names the staged-assets variable');
  assert.match(gradle, /scripts\/build-android-client\.ps1/, 'the failure names the build entry point');
  assert.match(gradle, /def packagedClientGuard = tasks\.named\('verifyPackagedClient'\)/,
    'the packaging tasks depend on the guard');
  assert.match(gradle, /dependsOn packagedClientGuard/, 'the guard is wired into the task graph');
  for (const task of ['preBuild', 'mergeDebugAssets', 'packageDebug']) {
    assert.ok(gradle.includes(`'${task}'`), `${task} is guarded, so every route to an APK checks the assets`);
  }
});

test('Android entry point stays one fact across AssetPaths, MainActivity and the build guard', () => {
  const paths = withoutComments(`${ANDROID_APP}/assets/AssetPaths.java`);
  const entry = paths.match(/public static final String ENTRY_FILE = "([^"]+)"/);
  assert.ok(entry, 'AssetPaths owns the entry point name');
  assert.equal(entry[1], 'index.html', 'START_URL loads the client entry point');
  assert.ok(REQUIRED_CLIENT_RUNTIME_FILES.includes(entry[1]),
    'the entry point is the first file the runtime validator requires');

  const activity = withoutComments(`${ANDROID_APP}/MainActivity.java`);
  assert.match(activity, /private static final String CLIENT_ENTRY = AssetPaths\.ENTRY_FILE;/,
    'MainActivity takes the name from AssetPaths instead of restating it');
  assert.match(activity, /"https:\/\/appassets\.androidplatform\.net\/" \+ CLIENT_ENTRY \+ "\?desktop=1&android=1"/,
    'START_URL is built from that single name');
  assert.doesNotMatch(activity, /CLIENT_ENTRY = "/, 'the entry point name is not written out a second time');
  const check = activity.indexOf('.has(CLIENT_ENTRY)');
  const load = activity.indexOf('loadUrl(START_URL)');
  assert.ok(check >= 0, 'the activity asks the APK for the entry point');
  assert.ok(load > check, 'the check runs before the WebView loads the start URL');
  assert.match(activity, /Log\.e\(TAG, "this APK carries no " \+ CLIENT_ENTRY/,
    'an APK without the client is logged as an error instead of ending in a bare 404');
  assert.match(activity, /scripts\/build-android-client\.ps1/, 'the log entry names the build that packages the client');

  const gradle = withoutComments('android/app/build.gradle');
  assert.ok(gradle.includes(`'${entry[1]}'`), 'the packaging guard requires the same entry point');
});
