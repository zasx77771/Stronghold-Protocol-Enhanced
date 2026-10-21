import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../native/bridge/stronghold-native-bridge.js', import.meta.url), 'utf8');

class ShellCloseEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.code = init.code;
    this.reason = init.reason;
    this.wasClean = init.wasClean;
  }
}

class ShellErrorEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.message = init.message;
  }
}

// The Android shell offers one WebMessagePort per document; the bridge asks for it with
// `channelReady()` and every inbound frame then arrives as a message on that port.
function createAndroidShell() {
  const listeners = new Map();
  const store = new Map([['sp.native.tcp', '10.0.0.7:4100']]);
  const calls = [];
  const android = {
    connect: (id, host, port) => calls.push({ type: 'connect', id, host, port }),
    send: (id, data) => calls.push({ type: 'send', id, data }),
    close: (id, code, reason) => calls.push({ type: 'close', id, code, reason }),
    channelReady: () => calls.push({ type: 'channelReady' }),
  };
  const sandbox = {
    StrongholdAndroidTcp: android,
    addEventListener: (type, listener) => listeners.set(type, listener),
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    console,
    document: {
      readyState: 'complete',
      body: null,
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {} },
        append() {},
        appendChild() {},
        addEventListener() {},
        setAttribute() {},
        removeEventListener() {},
        remove() {},
      }),
      addEventListener() {},
    },
    EventTarget,
    Event,
    MessageEvent,
    CloseEvent: ShellCloseEvent,
    ErrorEvent: ShellErrorEvent,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'stronghold-native-bridge.js' });
  return { sandbox, listeners, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the android shell is asked for the inbound channel once the bridge is installed', async () => {
  const { listeners, calls } = createAndroidShell();
  assert.deepEqual(calls.filter((call) => call.type === 'channelReady'), [{ type: 'channelReady' }]);
  assert.equal(typeof listeners.get('message'), 'function');
  assert.deepEqual(calls.filter((call) => call.type === 'connect'), []);
});

test('frames delivered on the channel reach the socket without evaluateJavascript', async () => {
  const { sandbox, listeners, calls } = createAndroidShell();
  const socket = new sandbox.WebSocket('ws://localhost:3001');
  await tick();
  assert.equal(socket.readyState, 0, 'the shell dials while the page waits');
  const connect = calls.find((call) => call.type === 'connect');
  assert.equal(connect.host, '10.0.0.7');
  assert.equal(connect.port, 4100);

  const frames = [];
  const opened = [];
  socket.onopen = () => opened.push(true);
  socket.onmessage = (event) => frames.push(event.data);
  const posted = [];
  const port = { onmessage: null, start() { posted.push('started'); } };
  listeners.get('message')({ ports: [port] });
  assert.equal(typeof port.onmessage, 'function');
  assert.deepEqual(posted, ['started']);

  port.onmessage({ data: JSON.stringify({ id: connect.id, type: 'open' }) });
  port.onmessage({ data: JSON.stringify({ id: connect.id, type: 'message', data: '{"t":"pong"}' }) });
  port.onmessage({ data: 'not json' });

  assert.deepEqual(opened, [true]);
  assert.deepEqual(frames, ['{"t":"pong"}']);
  assert.equal(socket.readyState, 1);
});
