import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { startTcpServer } from '../../server/tcp.js';

function frame(value) {
  const body = Buffer.from(value, 'utf8');
  const out = Buffer.allocUnsafe(body.length + 4);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function nextFrame(socket) {
  let pending = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for TCP frame')), 1000);
    socket.on('data', function onData(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4 || pending.length < pending.readUInt32BE(0) + 4) return;
      socket.off('data', onData);
      clearTimeout(timeout);
      resolve(pending.subarray(4, pending.readUInt32BE(0) + 4).toString('utf8'));
    });
  });
}

test('native TCP adapter preserves framed protocol and consumes control frames', async () => {
  let received = null;
  let ponged = false;
  const network = {
    admission() { return null; },
    handleConnection(ws) {
      ws.on('message', (body) => { received = body.toString('utf8'); });
      ws.on('pong', () => { ponged = true; });
      ws.ping();
    },
  };
  const listener = await startTcpServer({ network, host: '127.0.0.1', port: 0, log: { error() {} } });
  const client = net.connect({ host: '127.0.0.1', port: listener.port });
  try {
    await once(client, 'connect');
    assert.deepEqual(JSON.parse(await nextFrame(client)), { _sp: 'ping' });
    client.write(frame(JSON.stringify({ _sp: 'pong' })));
    client.write(frame(JSON.stringify({ t: 'hello', rid: 1 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ponged, true);
    assert.equal(received, '{"t":"hello","rid":1}');
  } finally {
    client.destroy();
    await listener.close();
  }
});