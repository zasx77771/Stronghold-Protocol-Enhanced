// 读取剪贴板 wiring: the two screens, the shared helper, and the two native shells must stay connected.
//
// The read is a three-line fallback chain that no unit test can drive end to end — the Tauri command only answers
// inside the WebView and the Android bridge only exists inside the APK — so this pins the wiring that a later
// refactor would silently drop: a screen that stops calling readText(), or a shell that stops exposing its side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const [clipboard, title, lobby, mainActivity, commands, capabilities] = await Promise.all([
  read('public/js/ui/clipboard.js'),
  read('public/js/screens/title.js'),
  read('public/js/screens/lobby.js'),
  read('android/app/src/main/java/org/strongholdprotocol/nativeclient/MainActivity.java'),
  read('src-tauri/src/commands.rs'),
  read('src-tauri/capabilities/default.json'),
]);

test('readText asks the host, and never assumes the browser API exists', () => {
  assert.match(clipboard, /export async function readText\(/);
  assert.match(clipboard, /invoke\('sp_read_clipboard'\)/);
  assert.match(clipboard, /StrongholdAndroidClipboard/);
  assert.match(clipboard, /scope\?\.navigator\?\.clipboard/);
  assert.match(clipboard, /reason: 'unsupported'/);
});

test('the title screen fills the server address from the clipboard', () => {
  assert.match(title, /import \{ readText \} from '\.\.\/ui\/clipboard\.js'/);
  assert.match(title, /const clip = await readText\(\)/);
  assert.match(title, /setAddress\(clip\.text\.trim\(\)\)/);
  // filling only: the connection is still applied by the 应用 button; the icon lives inside the field, so the
  // address box keeps its pre-change width
  assert.match(title, /trailing=\$\{html`<\$\{Button\}[^`]*class="title-connect__read"/);
});

test('the lobby fills the alliance key from the clipboard', () => {
  assert.match(lobby, /import \{ readText \} from '\.\.\/ui\/clipboard\.js'/);
  assert.match(lobby, /const pasted = clipboardCode\(clip\.text, ROOM_CODE_LEN\)/);
  assert.match(lobby, /setCode\(pasted\)/);
  assert.match(lobby, /class="join-read"/);
});

test('each native shell exposes the read side the helper calls', async () => {
  // Windows: the command exists, is registered, and the capability allows reading text
  assert.match(commands, /pub fn sp_read_clipboard/);
  const lib = await read('src-tauri/src/lib.rs');
  assert.match(lib, /commands::sp_read_clipboard/);
  assert.match(capabilities, /clipboard-manager:allow-read-text/);
  // Android: a dedicated interface, registered on the WebView under the name the helper probes
  assert.match(mainActivity, /addJavascriptInterface\(new ClipboardBridge\(\), "StrongholdAndroidClipboard"\)/);
  assert.match(mainActivity, /@JavascriptInterface public String readText\(\)/);
  assert.match(mainActivity, /getPrimaryClip\(\)/);
});
