import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../native/bridge/stronghold-native-bridge.js', import.meta.url), 'utf8');

// Node exposes MessageEvent but not CloseEvent/ErrorEvent everywhere; these stand-ins keep the
// fields the bridge reads (`message`, `code`, `reason`, `wasClean`).
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

// The bridge is a classic script injected by the native shells, so it is exercised here the way the
// shells run it: a fresh realm with a Tauri stub and a localStorage store, no browser DOM.
function createShell({ address = '' } = {}) {
  const invoked = [];
  const store = new Map();
  if (address) store.set('sp.native.tcp', address);
  const sandbox = {
    __TAURI__: {
      core: {
        invoke: (command, args) => {
          invoked.push({ command, args });
          return Promise.resolve();
        },
      },
      event: { listen: async () => () => {} },
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    console,
    // The injected script also mounts optional DOM chrome; the real shells always provide a document,
    // so the stub only has to absorb the element creation calls.
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
  return { sandbox, invoked };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('native bridge carries no built-in server address', () => {
  assert.doesNotMatch(source, /DEFAULT_ENDPOINT/);
  assert.doesNotMatch(source, /127\.0\.0\.1/);
});

test('a fresh install fails the socket instead of dialling an address the player never chose', async () => {
  const { sandbox, invoked } = createShell();
  const errors = [];
  const closes = [];
  const socket = new sandbox.WebSocket('ws://localhost:3001');
  socket.onerror = (ev) => errors.push(ev?.message || ev?.type);
  socket.onclose = (ev) => closes.push(ev?.reason || ev?.type);
  await tick();

  assert.equal(socket.readyState, 3, 'socket is closed, not stuck connecting');
  assert.deepEqual(errors, ['no_server_address']);
  assert.deepEqual(closes, ['no_server_address']);
  assert.equal(invoked.filter((call) => call.command === 'sp_tcp_connect').length, 0);
});

test('the saved server address is the only endpoint dialled', async () => {
  const { sandbox, invoked } = createShell({ address: '10.0.0.7:4100' });
  const socket = new sandbox.WebSocket('ws://localhost:3001');
  await tick();

  const connects = invoked.filter((call) => call.command === 'sp_tcp_connect');
  assert.equal(connects.length, 1);
  assert.equal(connects[0].args.host, '10.0.0.7');
  assert.equal(connects[0].args.port, 4100);
  assert.equal(socket.readyState, 0, 'still connecting while the shell dials');
});
