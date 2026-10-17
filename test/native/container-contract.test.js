import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const activity = await readFile(new URL('../../android/app/src/main/java/org/strongholdprotocol/nativeclient/MainActivity.java', import.meta.url), 'utf8');
const gradle = await readFile(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');
const protocol = await readFile(new URL('../../src-tauri/src/protocol.rs', import.meta.url), 'utf8');

test('both native containers inject the same bridge only into index HTML', () => {
  assert.match(activity, /<script src=\\"\/native\/bridge\.js\\" data-sp-platform=\\"android\\">/);
  assert.match(protocol, /data-sp-platform=\\"\{platform\}\\"/);
  assert.match(protocol, /relative == Path::new\("index\.html"\)/);
});

test('native containers stage upstream module roots and deny the Node-only simulation loader', () => {
  assert.match(gradle, /from\('\.\.\/\.\.\/data'\)/);
  assert.match(gradle, /from\('\.\.\/\.\.\/shared'\)/);
  assert.match(gradle, /from\('\.\.\/\.\.\/server\/sim'\)/);
  assert.match(protocol, /nodedata\.js/);
});test('Android build stages current web files instead of carrying a fork', () => {
  assert.match(gradle, /from\('\.\.\/\.\.\/public'\)/);
  assert.match(gradle, /stronghold-native-bridge\.js/);
  assert.doesNotMatch(gradle, /src\/main\/assets\/public/);
});
