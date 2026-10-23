// 读取剪贴板 (public/js/ui/clipboard.js readText): one entry point, three hosts, never throws.
//
// The buttons on the title screen (server address) and the lobby (alliance key) both go through this, so the
// fallbacks matter: a plain-HTTP deployment has no async Clipboard API at all and must report `unsupported`
// instead of silently doing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readText } from '../../public/js/ui/clipboard.js';

test('the Windows shell reads the clipboard through its registered Tauri command', async () => {
  const calls = [];
  const scope = {
    __TAURI__: { core: { invoke: async (name) => { calls.push(name); return '192.168.1.10:3001'; } } },
  };
  assert.deepEqual(await readText(scope), { ok: true, text: '192.168.1.10:3001' });
  assert.deepEqual(calls, ['sp_read_clipboard']);
});

test('the Android shell reads the clipboard through its own bridge', async () => {
  // addJavascriptInterface methods are synchronous: the value comes back directly, not as a promise
  const scope = { StrongholdAndroidClipboard: { readText: () => 'tcp://192.168.1.10:3001/?room=PAAP' } };
  assert.deepEqual(await readText(scope), { ok: true, text: 'tcp://192.168.1.10:3001/?room=PAAP' });
});

test('the Tauri shell wins over the Android bridge when both are somehow present', async () => {
  const scope = {
    __TAURI__: { core: { invoke: async () => 'tauri' } },
    StrongholdAndroidClipboard: { readText: () => 'android' },
  };
  assert.deepEqual(await readText(scope), { ok: true, text: 'tauri' });
});

test('a secure-context browser uses the async Clipboard API', async () => {
  const scope = { isSecureContext: true, navigator: { clipboard: { readText: async () => '  PAAP  ' } } };
  assert.deepEqual(await readText(scope), { ok: true, text: '  PAAP  ' });
});

test('a plain-http page reports unsupported instead of pretending to read', async () => {
  // http://host:3000 is not a secure context, so navigator.clipboard does not exist at all
  assert.deepEqual(await readText({ navigator: {} }), { ok: false, text: '', reason: 'unsupported' });
  // ... and a page that has the API but no secure context does not call it
  let called = false;
  const scope = { isSecureContext: false, navigator: { clipboard: { readText: () => { called = true; return 'x'; } } } };
  assert.deepEqual(await readText(scope), { ok: false, text: '', reason: 'unsupported' });
  assert.equal(called, false);
});

test('an empty clipboard is empty, not a failure', async () => {
  assert.deepEqual(await readText({ __TAURI__: { core: { invoke: async () => '' } } }), { ok: false, text: '', reason: 'empty' });
  assert.deepEqual(await readText({ __TAURI__: { core: { invoke: async () => '   \n' } } }), { ok: false, text: '', reason: 'empty' });
  assert.deepEqual(await readText({ StrongholdAndroidClipboard: { readText: () => null } }), { ok: false, text: '', reason: 'empty' });
});

test('a refused read is reported, never thrown', async () => {
  const denied = { ok: false, text: '', reason: 'denied' };
  assert.deepEqual(await readText({ __TAURI__: { core: { invoke: async () => { throw new Error('denied'); } } } }), denied);
  assert.deepEqual(await readText({ StrongholdAndroidClipboard: { readText: () => { throw new Error('denied'); } } }), denied);
  assert.deepEqual(
    await readText({ isSecureContext: true, navigator: { clipboard: { readText: async () => { throw new Error('NotAllowedError'); } } } }),
    denied,
  );
});
