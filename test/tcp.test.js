import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from '../server/index.js';
import { PROTOCOL_VERSION } from '../shared/constants.js';

let srv;

before(async () => { srv = await startServer({ port: 0, tcpPort: 0, host: '127.0.0.1', quiet: true }); });
after(async () => { await srv?.close(); });

function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  const out = Buffer.allocUnsafe(body.length + 4);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function tcpClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  const deliver = (msg) => {
    const index = waiters.findIndex((w) => w.test(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else messages.push(msg);
  };
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      const msg = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      if (msg._sp === 'ping') socket.write(encode({ _sp: 'pong' }));
      else deliver(msg);
    }
  });
  return {
    open: new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }),
    send: (msg) => socket.write(encode(msg)),
    next(testFn, timeout = 2000) {
      const found = messages.findIndex(testFn);
      if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { test: testFn, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('TCP response timeout'));
        }, timeout).unref();
      });
    },
    close: () => new Promise((resolve) => { socket.once('close', resolve); socket.end(); }),
  };
}

test('raw TCP transport shares hello, request and lobby protocol', async () => {
  assert.ok(Number.isInteger(srv.tcpPort) && srv.tcpPort > 0);
  const client = tcpClient(srv.tcpPort);
  await client.open;
  client.send({ t: 'hello', rid: 1, name: 'TCP Tester', version: PROTOCOL_VERSION });
  const welcome = await client.next((m) => m.t === 'welcome');
  assert.equal(welcome.rid, 1);
  assert.match(welcome.playerId, /^p_/);
  assert.equal(typeof welcome.token, 'string');

  client.send({ t: 'ping', rid: 2, c: 123 });
  const pong = await client.next((m) => m.rid === 2);
  assert.equal(pong.t, 'pong');
  assert.equal(pong.c, 123);
  assert.equal(typeof pong.s, 'number');

  client.send({ t: 'room.create', rid: 3, mode: 'coop', difficulty: 'NORMAL' });
  const ok = await client.next((m) => m.rid === 3);
  assert.equal(ok.t, 'ok');
  const room = await client.next((m) => m.t === 'room.state');
  assert.match(room.code, /^[A-Z0-9]{4,6}$/);
  await client.close();
});
