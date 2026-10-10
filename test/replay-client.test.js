import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { guessReplayAddress, normalizeReplayAddress } from '../public/js/replayClient.js';
import { requestReplay } from '../public/js/replayClient.js';
import { ReplayStore } from '../server/replay/store.js';
import { MatchRecorder } from '../server/replay/recorder.js';
import { startSpectatorServer } from '../server/spectator.js';

test('native replay endpoint uses TCP port 3002 and keeps IPv6 brackets valid', () => {
  assert.equal(guessReplayAddress('http://192.168.1.10:3000'), 'tcp://192.168.1.10:3002');
  assert.equal(guessReplayAddress('tcp://192.168.1.10:3001'), 'tcp://192.168.1.10:3002');
  assert.equal(guessReplayAddress('tcp://[::1]:3001'), 'tcp://[::1]:3002');
  assert.deepEqual(normalizeReplayAddress('192.168.1.10:3002'), {
    address: 'tcp://192.168.1.10:3002', socketUrl: 'tcp://192.168.1.10:3002',
  });
});

test('packaged-client TCP bridge reads a replay list', async (t) => {
  const listeners = new Set();
  const sockets = new Map();
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const frame = (text) => {
    const body = Buffer.from(text);
    const out = Buffer.allocUnsafe(body.length + 4);
    out.writeUInt32BE(body.length, 0);
    body.copy(out, 4);
    return out;
  };
  globalThis.strongholdClient = {
    tcpAvailable: true,
    onTcpEvent(listener) { listeners.add(listener); },
    tcpConnect(id, host, port) {
      const socket = net.createConnection({ host, port });
      const entry = { socket, buffer: Buffer.alloc(0) };
      sockets.set(id, entry);
      socket.on('connect', () => emit({ id, type: 'open' }));
      socket.on('data', (chunk) => {
        entry.buffer = entry.buffer.length ? Buffer.concat([entry.buffer, chunk]) : chunk;
        while (entry.buffer.length >= 4 && entry.buffer.length >= 4 + entry.buffer.readUInt32BE(0)) {
          const length = entry.buffer.readUInt32BE(0);
          emit({ id, type: 'message', data: entry.buffer.subarray(4, 4 + length).toString('utf8') });
          entry.buffer = entry.buffer.subarray(4 + length);
        }
      });
      socket.on('error', (error) => emit({ id, type: 'error', message: String(error.message) }));
      socket.on('close', () => { sockets.delete(id); emit({ id, type: 'close', code: 1000, reason: '' }); });
    },
    tcpSend(id, data) { sockets.get(id)?.socket.write(frame(data)); },
    tcpClose(id) { sockets.get(id)?.socket.end(); },
  };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-replay-client-'));
  const store = new ReplayStore({ file: path.join(dir, 'replays.sqlite'), log: { error() {} } });
  const recorder = new MatchRecorder(store, { roomCode: 'ABCD', matchNo: 1, seed: 99, players: [] });
  recorder.finish({ victory: true }, { victory: true, players: [] });
  const server = await startSpectatorServer({ store, host: '127.0.0.1', port: 0, log: { error() {} } });
  t.after(async () => {
    await server.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
    delete globalThis.strongholdClient;
  });

  const response = await requestReplay(`tcp://127.0.0.1:${server.port}`, { t: 'replay.list' });
  assert.equal(response.t, 'replay.list');
  assert.equal(response.matches[0].id, recorder.id);
});
