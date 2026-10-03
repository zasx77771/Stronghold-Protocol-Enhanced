// Raw TCP transport for packaged clients.
//
// Frames are: 4-byte unsigned big-endian payload length followed by one UTF-8 JSON message.
// The payload is the exact JSON text used by the WebSocket transport, so both transports share
// server/net.js validation, authentication, rate limiting, reconnect and lobby/match handling.

import net from 'node:net';
import { EventEmitter } from 'node:events';

export const TCP_MAX_PAYLOAD = 64 * 1024;
const OPEN = 1;
const CLOSED = 3;

function frame(text) {
  const body = Buffer.from(String(text), 'utf8');
  if (body.length > TCP_MAX_PAYLOAD) throw new RangeError('TCP frame too large');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** A WebSocket-compatible adapter consumed by server/net.js. */
class TcpJsonSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.buffer = Buffer.alloc(0);
    this.closeSent = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.emit('close');
    });
  }

  get bufferedAmount() { return this.socket.writableLength || 0; }

  writeControl(payload) {
    if (this.readyState !== OPEN || !this.socket.writable) return false;
    try { this.socket.write(frame(JSON.stringify(payload))); return true; }
    catch { return false; }
  }

  onData(chunk) {
    if (this.readyState !== OPEN) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > TCP_MAX_PAYLOAD) { this.terminate(); return; }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let control = null;
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (parsed && typeof parsed === 'object' && typeof parsed._sp === 'string') control = parsed;
      } catch { /* server/net.js returns the normal BAD_MSG response */ }
      if (control?._sp === 'pong') { this.emit('pong'); continue; }
      if (control?._sp === 'close') { this.socket.end(); continue; }
      if (control?._sp === 'ping') { this.writeControl({ _sp: 'pong' }); continue; }
      this.emit('message', body, false);
    }
  }

  send(data, callback) {
    if (this.readyState !== OPEN || typeof data !== 'string') {
      callback?.(new Error('socket closed'));
      return;
    }
    try { this.socket.write(frame(data), callback); }
    catch (err) { callback?.(err); }
  }

  ping() { this.writeControl({ _sp: 'ping' }); }

  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN || this.closeSent) return;
    this.closeSent = true;
    this.writeControl({ _sp: 'close', code: Number(code) || 1000, reason: String(reason).slice(0, 120) });
    this.socket.end();
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.socket.destroy();
  }
}

/**
 * Start the raw TCP listener and route accepted sockets into the shared Network.
 * @returns {Promise<{server: import('node:net').Server, port: number, close: () => Promise<void>}>}
 */
export function startTcpServer({ network, host, port, log }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      const req = { socket: { remoteAddress: socket.remoteAddress }, headers: {} };
      const refused = network.admission(req);
      if (refused) {
        const wrapped = new TcpJsonSocket(socket);
        wrapped.close(refused === 'per-address' ? 1008 : 1013, refused);
        return;
      }
      network.handleConnection(new TcpJsonSocket(socket), req);
    });
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => {
      server.off('error', onError);
      server.on('error', (err) => log?.error?.('[tcp] server error', err));
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((done) => {
          if (!server.listening) { done(); return; }
          server.close(() => done());
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
