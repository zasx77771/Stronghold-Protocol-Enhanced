import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ReplayStore } from '../server/replay/store.js';
import { MatchRecorder } from '../server/replay/recorder.js';
import { startSpectatorServer } from '../server/spectator.js';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-replay-'));
  return { dir, store: new ReplayStore({ file: path.join(dir, 'replays.sqlite'), log: { error() {} } }) };
}

function tcpRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    socket.once('error', reject);
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify(request));
      const frame = Buffer.allocUnsafe(4 + body.length);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      socket.write(frame);
    });
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
      const size = buffer.readUInt32BE(0);
      socket.end();
      resolve(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')));
    });
  });
}

function httpRequestHasNoResponse(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('TCP replay service did not close an HTTP request'));
    }, 1_000);
    socket.once('error', reject);
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

test('profiles keep a fixed four-digit tag and exact nickname/tag binding', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const first = store.resolveProfile('Doctor');
  assert.match(first.tag, /^\d{4}$/);
  assert.equal(store.resolveProfile('Doctor', first.tag).userId, first.userId);
  assert.equal(store.resolveProfile('Doctor', '9999') === null, true);
  assert.deepEqual(store.profileCandidates('doctor').map((p) => p.tag), [first.tag]);
});

test('recorder persists an immutable compressed replay and export can be imported', async (t) => {
  const a = await tempStore();
  const b = await tempStore();
  t.after(async () => { a.store.close(); b.store.close(); await fs.rm(a.dir, { recursive: true, force: true }); await fs.rm(b.dir, { recursive: true, force: true }); });
  const profile = a.store.resolveProfile('Doctor');
  const rec = new MatchRecorder(a.store, {
    roomCode: 'ABCD', matchNo: 1, seed: 42, mode: 'solo', difficulty: 'NORMAL', stageId: 'stage_1', dataHash: 'test',
    players: [{ userId: profile.userId, playerId: 'p_1', name: profile.name, tag: profile.tag, seat: 0, isBot: false, loadout: {} }],
  });
  rec.action('p_1', { t: 'g.ready', ready: true }, 'PREP');
  rec.frame('out', null, { t: 'm.public', phase: 'RESULT', round: 8 }, 'RESULT');
  const result = { victory: true, roundsPassed: 8, players: [{ playerId: 'p_1', roundsPassed: 8, stats: { kills: 12, leaks: 0 } }] };
  rec.finish({ victory: true, roundsPassed: 8 }, result);
  const saved = a.store.getMatch(rec.id);
  assert.equal(saved.result.victory, true);
  assert.equal(saved.replay.timeline.length, 2);
  assert.ok(saved.replayBytes > 0);
  const imported = b.store.importArchive(a.store.exportMatch(rec.id));
  assert.equal(b.store.getMatch(imported).replay.timeline[0].payload.t, 'g.ready');
});

test('spectator service accepts only framed TCP replay requests', async (t) => {
  const { dir, store } = await tempStore();
  const rec = new MatchRecorder(store, { roomCode: 'ABCD', matchNo: 1, seed: 7, mode: 'solo', difficulty: 'NORMAL', stageId: 'stage_1', dataHash: 'test', players: [] });
  rec.finish({ victory: false }, { victory: false, players: [] });
  const spectator = await startSpectatorServer({ store, host: '127.0.0.1', port: 0, log: { error() {} } });
  t.after(async () => { await spectator.close(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const list = await tcpRequest(spectator.port, { t: 'replay.list' });
  assert.equal(list.t, 'replay.list');
  assert.equal(list.matches[0].id, rec.id);
  const detail = await tcpRequest(spectator.port, { t: 'replay.get', id: rec.id });
  assert.equal(detail.match.seed, 7);
  assert.equal(detail.match.replay, undefined, 'library detail responses must not include the full timeline');
  const complete = await tcpRequest(spectator.port, { t: 'replay.get', id: rec.id, includeTimeline: true });
  assert.equal(complete.match.replay.timeline.length, 0, 'complete timelines require an explicit request');
  assert.equal(await httpRequestHasNoResponse(spectator.port), '');
});
