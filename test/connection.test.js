// Connection settings and invite parsing (public/js/connection.js). Pure helpers: no DOM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDRESS_KEY, TCP_ENDPOINT_KEY, TRANSPORT_KEY,
  parseEndpoint, parseAddress, defaultSocketUrl, readSettings, saveSettings, inviteCode, inviteAddress, nativePlatform, transportForAddress,
  buildInviteLink,
} from '../public/js/connection.js';

/** Minimal localStorage stand-in. */
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    get: (k) => map.get(k),
  };
}

const browser = {};
const windows = { __TAURI__: { core: { invoke() {} }, event: { listen() {} } } };
const android = { StrongholdAndroidTcp: { connect() {} } };

test('parseEndpoint accepts host:port, tcp:// and bracketed IPv6', () => {
  assert.deepEqual(parseEndpoint('127.0.0.1:3001'), { host: '127.0.0.1', port: 3001 });
  assert.deepEqual(parseEndpoint('tcp://lan.example:7000'), { host: 'lan.example', port: 7000 });
  assert.deepEqual(parseEndpoint('[::1]:3001'), { host: '::1', port: 3001 });
  assert.equal(parseEndpoint('127.0.0.1'), null);
  assert.equal(parseEndpoint('127.0.0.1:0'), null);
  assert.equal(parseEndpoint('127.0.0.1:99999'), null);
  assert.equal(parseEndpoint(''), null);
});

test('transportForAddress selects TCP only for an explicit TCP endpoint', () => {
  assert.equal(transportForAddress('192.168.1.10:3001'), 'tcp');
  assert.equal(transportForAddress('tcp://[::1]:3001'), 'tcp');
  assert.equal(transportForAddress('https://game.example/ws'), 'websocket');
  assert.equal(transportForAddress('wss://game.example/ws'), 'websocket');
  assert.equal(transportForAddress('game.example'), 'websocket');
  assert.equal(transportForAddress('', 'tcp'), 'tcp');
  assert.equal(transportForAddress('', 'websocket'), 'websocket');
});

test('parseAddress: TCP needs a host:port', () => {
  const ok = parseAddress('192.168.1.10:3001', { transport: 'tcp' });
  assert.equal(ok.ok, true);
  assert.equal(ok.transport, 'tcp');
  assert.equal(ok.address, '192.168.1.10:3001');
  assert.deepEqual(ok.endpoint, { host: '192.168.1.10', port: 3001 });
  // The socket URL names the transport, so the native facade can pick TCP from the URL alone (the title
  // screen swaps TCP/WebSocket without reloading the shell).
  assert.equal(ok.socketUrl, 'tcp://192.168.1.10:3001');

  const bad = parseAddress('192.168.1.10', { transport: 'tcp' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_endpoint');
});

test('parseAddress: TCP also takes the http:// spelling of the same host:port', () => {
  const ok = parseAddress('http://39.98.53.210:3001', { transport: 'tcp' });
  assert.equal(ok.ok, true);
  assert.equal(ok.transport, 'tcp');
  assert.equal(ok.address, '39.98.53.210:3001');
  assert.deepEqual(ok.endpoint, { host: '39.98.53.210', port: 3001 });
  assert.equal(ok.socketUrl, 'tcp://39.98.53.210:3001');

  // a path or query in the web address never reaches the frame endpoint
  const path = parseAddress('http://game.example:3001/ws?room=ABCD', { transport: 'tcp' });
  assert.deepEqual(path.endpoint, { host: 'game.example', port: 3001 });

  const v6 = parseAddress('http://[::1]:3001', { transport: 'tcp' });
  assert.deepEqual(v6.endpoint, { host: '::1', port: 3001 });
  assert.equal(v6.socketUrl, 'tcp://[::1]:3001');

  // no TLS on the native socket, and port 80 is the HTTP server, not the frame endpoint
  assert.equal(parseAddress('https://game.example:3001', { transport: 'tcp' }).error, 'tls_unsupported');
  assert.equal(parseAddress('http://game.example', { transport: 'tcp' }).error, 'invalid_endpoint');
  assert.equal(parseAddress('http://game.example:0', { transport: 'tcp' }).ok, false);
  // ws:// is not a TCP spelling
  assert.equal(parseAddress('ws://game.example:3001', { transport: 'tcp' }).error, 'invalid_scheme');
});

test('parseAddress: WebSocket URLs keep their path, default to /ws', () => {
  const bare = parseAddress('wss://game.example', {});
  assert.equal(bare.ok, true);
  assert.equal(bare.socketUrl, 'wss://game.example/ws');

  const kept = parseAddress('ws://game.example:3000/ws', {});
  assert.equal(kept.socketUrl, 'ws://game.example:3000/ws');

  const http = parseAddress('https://game.example/ws', {});
  assert.equal(http.socketUrl, 'wss://game.example/ws');

  const shorthand = parseAddress('game.example:3000', {});
  assert.equal(shorthand.socketUrl, 'ws://game.example:3000/ws');
});

test('parseAddress: blank WebSocket address falls back to this page', () => {
  const loc = { protocol: 'https:', host: 'app.example' };
  const parsed = parseAddress('', { transport: 'websocket', loc });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.address, '');
  assert.equal(parsed.socketUrl, 'wss://app.example/ws');
  assert.equal(defaultSocketUrl(loc), 'wss://app.example/ws');
  assert.equal(defaultSocketUrl({ protocol: 'http:', host: '127.0.0.1:3000' }), 'ws://127.0.0.1:3000/ws');
});

test('parseAddress: rejects other schemes and malformed input', () => {
  assert.equal(parseAddress('ftp://game.example', {}).error, 'invalid_scheme');
  assert.equal(parseAddress('http://[broken', {}).error, 'invalid_address');
});

test('nativePlatform only recognises the two shells', () => {
  assert.equal(nativePlatform(browser), null);
  assert.equal(nativePlatform(windows), 'windows');
  assert.equal(nativePlatform(android), 'android');
});

test('readSettings: browser is WebSocket, native defaults to TCP and remembers the choice', () => {
  const empty = storage();
  assert.deepEqual(readSettings(empty, browser), { transport: 'websocket', address: '', native: null, supportsTcp: false });

  const native = storage({ [TRANSPORT_KEY]: 'tcp', [ADDRESS_KEY]: '192.168.1.10:3001' });
  assert.equal(readSettings(native, windows).transport, 'tcp');
  assert.equal(readSettings(native, windows).address, '192.168.1.10:3001');
  assert.equal(readSettings(native, windows).supportsTcp, true);

  // No saved choice in a native shell: TCP (an upgraded install keeps its old behaviour).
  assert.equal(readSettings(storage(), android).transport, 'tcp');

  // An explicit WebSocket choice in a native shell is honoured.
  assert.equal(readSettings(storage({ [TRANSPORT_KEY]: 'websocket' }), windows).transport, 'websocket');

  // The bridge's own key still fills in the TCP address.
  assert.equal(readSettings(storage({ [TCP_ENDPOINT_KEY]: '10.0.0.5:3001' }), android).address, '10.0.0.5:3001');
});

test('saveSettings mirrors a TCP endpoint into the bridge key and clears nothing else', () => {
  const store = storage();
  assert.deepEqual(saveSettings({ transport: 'tcp', address: ' tcp://10.0.0.5:3001 ' }, store), { transport: 'tcp', address: 'tcp://10.0.0.5:3001' });
  assert.equal(store.get(TRANSPORT_KEY), 'tcp');
  assert.equal(store.get(TCP_ENDPOINT_KEY), '10.0.0.5:3001');

  saveSettings({ transport: 'websocket', address: 'wss://game.example/ws' }, store);
  assert.equal(store.get(TRANSPORT_KEY), 'websocket');
  assert.equal(store.get(ADDRESS_KEY), 'wss://game.example/ws');
});

test('inviteCode reads links, prefixed codes and bare codes', () => {
  assert.equal(inviteCode('https://game.example/?room=ABCD'), 'ABCD');
  assert.equal(inviteCode('https://game.example/rooms/join?x=1&room=ab12'), 'AB12');
  assert.equal(inviteCode('room: WXYZ'), 'WXYZ');
  assert.equal(inviteCode('同盟密钥：EFGH'), 'EFGH');
  assert.equal(inviteCode('abcd'), 'ABCD');
  assert.equal(inviteCode('ABCD12'), 'ABCD12');
  assert.equal(inviteCode('ABCD123'), null);
});

test('inviteCode refuses text without a usable code', () => {
  assert.equal(inviteCode(''), null);
  assert.equal(inviteCode('加入我的同盟'), null);
  assert.equal(inviteCode('AB'), null);
  assert.equal(inviteCode('ABCD1234'), null);
  assert.equal(inviteCode('https://game.example/?room=toolong123'), null);
});

test('inviteAddress removes a room query before reconnecting, but keeps a bare key on the current server', () => {
  assert.equal(inviteAddress('https://game.example/?room=ABCD'), 'https://game.example');
  assert.equal(inviteAddress('wss://game.example/rooms/join?room=ABCD#share'), 'wss://game.example/rooms/join');
  assert.equal(inviteAddress('tcp://[::1]:3001?room=ABCD'), '[::1]:3001');
  assert.equal(inviteAddress('room: ABCD'), null);
  assert.equal(inviteAddress('ABCD'), null);
  assert.equal(inviteAddress('https://game.example/?room=TOOLONG123'), null);
});

test('buildInviteLink shares the page URL in a browser', () => {
  const loc = { origin: 'https://game.example', pathname: '/play/index.html' };
  assert.equal(buildInviteLink('ABCD', { loc }), 'https://game.example/play/index.html?room=ABCD');
  // an empty address/key has nothing to share
  assert.equal(buildInviteLink('', { loc }), '');
});

test('buildInviteLink shares the TCP endpoint in the native shells, never the shell origin', () => {
  // Android WebView: location.origin is the asset loader, so the link has to name the TCP endpoint instead
  const androidLoc = { origin: 'https://appassets.androidplatform.net', pathname: '/index.html' };
  assert.equal(
    buildInviteLink('PAAP', { transport: 'tcp', address: '10.0.2.2:3001', loc: androidLoc }),
    'tcp://10.0.2.2:3001/?room=PAAP',
  );
  // Tauri window: sp://localhost is just as unreachable for the other player
  assert.equal(
    buildInviteLink('PAAP', { transport: 'tcp', address: '[::1]:3001', loc: { origin: 'sp://localhost', pathname: '/' } }),
    'tcp://[::1]:3001/?room=PAAP',
  );
  // a shell without a server address shares nothing: its own origin is unreachable, and inventing an
  // address would send the receiver somewhere the host never chose (the room screen asks for one instead)
  assert.equal(
    buildInviteLink('PAAP', { transport: 'tcp', address: '', loc: androidLoc }),
    '',
  );
  assert.equal(buildInviteLink('PAAP', { transport: 'tcp', address: '', loc: androidLoc, native: true }), '');
});

test('buildInviteLink shares the WebSocket server, never the shell origin', () => {
  // Windows shell in WebSocket mode used to hand out `http://sp.localhost/?room=…`, which nobody can open
  const tauriLoc = { origin: 'sp://localhost', pathname: '/' };
  assert.equal(
    buildInviteLink('PAAP', { transport: 'websocket', address: '39.98.53.210:3000', loc: tauriLoc }),
    'http://39.98.53.210:3000/?room=PAAP',
  );
  assert.equal(
    buildInviteLink('PAAP', { transport: 'websocket', address: 'wss://game.example/ws', loc: tauriLoc }),
    'https://game.example/?room=PAAP',
  );
  // the receiver reads the web address back as a WebSocket server
  assert.equal(inviteAddress('http://39.98.53.210:3000/?room=PAAP'), 'http://39.98.53.210:3000');
  assert.equal(transportForAddress('http://39.98.53.210:3000'), 'websocket');
  // and a browser pointing at another server shares that server rather than its own page
  assert.equal(
    buildInviteLink('PAAP', {
      transport: 'websocket', address: '39.98.53.210:3000', loc: { origin: 'https://game.example', pathname: '/' },
    }),
    'http://39.98.53.210:3000/?room=PAAP',
  );
  // ... while a browser on its own server keeps its page URL
  assert.equal(
    buildInviteLink('PAAP', {
      transport: 'websocket', address: 'game.example:3000', loc: { origin: 'http://game.example:3000', pathname: '/play/' },
    }),
    'http://game.example:3000/play/?room=PAAP',
  );
});

test('a shared TCP invite round-trips into address and room code', () => {
  const text = buildInviteLink('PAAP', { transport: 'tcp', address: '192.168.1.10:3001' });
  assert.equal(text, 'tcp://192.168.1.10:3001/?room=PAAP');
  assert.equal(inviteAddress(text), '192.168.1.10:3001');
  assert.equal(inviteCode(text), 'PAAP');
});
