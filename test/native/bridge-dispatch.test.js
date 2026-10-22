import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../native/bridge/stronghold-native-bridge.js', import.meta.url), 'utf8');

// A shell that has both a TCP channel and its own WebSocket (Tauri and Android both do): the page must be
// able to switch between them without reloading, so the facade picks the transport from the URL it gets.
function createDualShell({ transport = 'tcp', address = '10.0.0.7:4100' } = {}) {
  const calls = [];
  const store = new Map([['sp.native.tcp', address], ['sp.server.transport', transport]]);
  const android = {
    connect: (id, host, port) => calls.push({ type: 'connect', id, host, port }),
    send: (id, data) => calls.push({ type: 'send', id, data }),
    close: (id, code, reason) => calls.push({ type: 'close', id, code, reason }),
  };
  const hostSockets = [];
  class HostWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      hostSockets.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(data) { calls.push({ type: 'ws-send', url: this.url, data }); }
    close(code, reason) { calls.push({ type: 'ws-close', url: this.url, code, reason }); }
    emit(type, event) { const listener = this.listeners.get(type); if (listener) listener(event); }
  }
  const sandbox = {
    StrongholdAndroidTcp: android,
    WebSocket: HostWebSocket,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    console,
    document: { readyState: 'complete', body: null, addEventListener() {} },
    EventTarget,
    Event,
    MessageEvent,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'stronghold-native-bridge.js' });
  return { sandbox, calls, hostSockets };
}

test('a ws:// URL goes to the host WebSocket, not the TCP channel', async () => {
  const { sandbox, calls, hostSockets } = createDualShell();
  const socket = new sandbox.WebSocket('ws://game.example:3000/ws');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.filter((call) => call.type === 'connect'), [], 'no TCP dial for a WebSocket URL');
  assert.equal(hostSockets.length, 1);
  assert.equal(hostSockets[0].url, 'ws://game.example:3000/ws');
  socket.send('hello');
  assert.deepEqual(calls.filter((call) => call.type === 'ws-send'), [{ type: 'ws-send', url: 'ws://game.example:3000/ws', data: 'hello' }]);
});

test('a tcp:// URL dials that endpoint even when the saved transport says websocket', async () => {
  // Upgraded installs keep a saved WebSocket choice; the switch must still reach TCP without a reload.
  const { sandbox, calls, hostSockets } = createDualShell({ transport: 'websocket', address: '10.0.0.7:4100' });
  new sandbox.WebSocket('tcp://10.0.0.9:9999');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(hostSockets, [], 'a tcp:// URL never touches the host WebSocket');
  const connect = calls.find((call) => call.type === 'connect');
  assert.equal(connect.host, '10.0.0.9', 'the URL wins over the saved address');
  assert.equal(connect.port, 9999);
});

test('a tcp:// URL without an endpoint falls back to the saved address', async () => {
  const { sandbox, calls } = createDualShell({ transport: 'tcp', address: '192.168.1.10:3001' });
  new sandbox.WebSocket('tcp://');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const connect = calls.find((call) => call.type === 'connect');
  assert.equal(connect.host, '192.168.1.10');
  assert.equal(connect.port, 3001);
});

test('the facade is installed even when the saved choice is WebSocket', async () => {
  const { sandbox } = createDualShell({ transport: 'websocket' });
  assert.equal(typeof sandbox.__strongholdNativeTcpEvent, 'function', 'page reloads must still reach the same facade');
  assert.notEqual(sandbox.WebSocket.name, 'WebSocket', 'the host constructor is replaced by the facade');
});
