// Dedicated TCP-only replay endpoint. It deliberately does not speak HTTP or WebSocket, so
// browsers cannot open port 3002. Packaged clients use the same length-prefixed JSON framing as
// server/tcp.js, with a separate read-only replay command namespace.

import net from 'node:net';

export const SPECTATOR_TCP_MAX_PAYLOAD = 32 << 20;

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > SPECTATOR_TCP_MAX_PAYLOAD) throw new RangeError('replay response too large');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function reply(socket, message) {
  if (!socket.destroyed && socket.writable) socket.write(encode(message));
}

function handle(store, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return { t: 'replay.error', code: 'BAD_MSG' };
  switch (request.t) {
    case 'replay.health': return { t: 'replay.health', ok: true, ...store.stats() };
    case 'replay.list': {
      const stats = store.stats();
      return {
        t: 'replay.list',
        matches: store.listMatches({ q: typeof request.q === 'string' ? request.q : '' }),
        totalMatches: stats.matches,
        bytes: stats.bytes,
        retention: stats.retention,
      };
    }
    case 'replay.get': {
      const match = store.getMatch(request.id);
      return match ? { t: 'replay.get', match } : { t: 'replay.error', code: 'NOT_FOUND' };
    }
    case 'replay.export': {
      const archive = store.exportMatch(request.id);
      return archive ? { t: 'replay.export', archive } : { t: 'replay.error', code: 'NOT_FOUND' };
    }
    case 'replay.import': {
      try { return { t: 'replay.import', id: store.importArchive(request.archive) }; }
      catch { return { t: 'replay.error', code: 'BAD_ARCHIVE' }; }
    }
    case 'replay.delete': return { t: 'replay.delete', deleted: store.deleteMatch(request.id) };
    default: return { t: 'replay.error', code: 'BAD_MSG' };
  }
}

/** Start the client-only TCP replay endpoint (default port 3002). */
export function startSpectatorServer({ store, port = 3002, host = '0.0.0.0', log = console } = {}) {
  if (!store) return Promise.reject(new TypeError('spectator server requires ReplayStore'));
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.setNoDelay(true);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (length === 0 || length > SPECTATOR_TCP_MAX_PAYLOAD) { socket.destroy(); return; }
          if (buffer.length < 4 + length) return;
          const body = buffer.subarray(4, 4 + length);
          buffer = buffer.subarray(4 + length);
          let request;
          try { request = JSON.parse(body.toString('utf8')); }
          catch { reply(socket, { t: 'replay.error', code: 'BAD_JSON' }); continue; }
          try { reply(socket, handle(store, request)); }
          catch (err) {
            log.error?.('[spectator-tcp] request failed', err);
            try { reply(socket, { t: 'replay.error', code: 'INTERNAL' }); } catch { socket.destroy(); }
          }
        }
      });
    });
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => {
      server.off('error', onError);
      server.on('error', (err) => log.error?.('[spectator-tcp] server error', err));
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, port: actualPort, host, close: () => new Promise((done) => server.close(() => done())) });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
