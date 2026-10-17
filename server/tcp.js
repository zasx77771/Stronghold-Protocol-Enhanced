// Optional raw TCP transport for packaged Windows and Android clients.
// A frame is a four-byte unsigned big-endian size followed by one UTF-8 JSON protocol message.
// The adapter deliberately exposes the subset of `ws` consumed by server/net.js so the game
// session, rate-limit and reconnect rules remain shared with browser WebSocket clients.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export const TCP_MAX_PAYLOAD = 64 * 1024;
const OPEN = 1;
const CLOSED = 3;

function encodeFrame(value) {
  const body = Buffer.from(String(value), 'utf8');
  if (body.length === 0 || body.length > TCP_MAX_PAYLOAD) throw new RangeError('invalid TCP frame size');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

class FramedSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.pending = Buffer.alloc(0);
    this.sentClose = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.finish());
  }

  get bufferedAmount() { return this.socket.writableLength || 0; }

  consume(chunk) {
    if (this.readyState !== OPEN) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32BE(0);
      if (size === 0 || size > TCP_MAX_PAYLOAD) { this.terminate(); return; }
      if (this.pending.length < size + 4) return;
      const body = this.pending.subarray(4, size + 4);
      this.pending = this.pending.subarray(size + 4);
      if (this.control(body)) continue;
      this.emit('message', body, false);
    }
  }

  control(body) {
    let message;
    try { message = JSON.parse(body.toString('utf8')); } catch { return false; }
    if (!message || typeof message !== 'object' || typeof message._sp !== 'string') return false;
    if (message._sp === 'pong') { this.emit('pong'); return true; }
    if (message._sp === 'ping') { this.sendControl({ _sp: 'pong' }); return true; }
    if (message._sp === 'close') { this.socket.end(); return true; }
    return false;
  }

  sendControl(message) {
    if (this.readyState !== OPEN || !this.socket.writable) return false;
    try { return this.socket.write(encodeFrame(JSON.stringify(message))); } catch { return false; }
  }

  send(data, done) {
    if (this.readyState !== OPEN) { done?.(new Error('socket closed')); return; }
    try { this.socket.write(encodeFrame(data), done); } catch (error) { done?.(error); }
  }

  ping() { this.sendControl({ _sp: 'ping' }); }

  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN || this.sentClose) return;
    this.sentClose = true;
    this.sendControl({ _sp: 'close', code: Number(code) || 1000, reason: String(reason).slice(0, 120) });
    this.socket.end();
  }

  terminate() { if (this.readyState !== CLOSED) this.socket.destroy(); }

  finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }
}

export function startTcpServer({ network, host, port, log = console }) {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => {
      socket.on('error', () => {});
      const request = { socket: { remoteAddress: socket.remoteAddress }, headers: {} };
      const refused = network.admission(request);
      const framed = new FramedSocket(socket);
      if (refused) { framed.close(refused === 'per-address' ? 1008 : 1013, refused); return; }
      network.handleConnection(framed, request);
    });
    const listening = () => {
      listener.off('error', failed);
      listener.on('error', (error) => log.error?.('[tcp] server error', error));
      const address = listener.address();
      resolve({ server: listener, port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise((done) => listener.listening ? listener.close(done) : done()) });
    };
    const failed = (error) => { listener.off('listening', listening); reject(error); };
    listener.once('error', failed);
    listener.once('listening', listening);
    listener.listen(port, host);
  });
}