// WebSocket-shaped adapter for the native raw-TCP bridges in the packaged Windows/Android clients.
// Browser pages cannot open raw TCP sockets; callers should hide/disable TCP when this bridge is absent.

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const sockets = new Map();
let nextId = 0;
let desktopListenerInstalled = false;

/** Parse tcp://host:port consistently: Chromium treats unknown schemes as opaque URLs. */
export function parseTcpUrl(raw) {
  const input = String(raw ?? '').trim();
  if (!/^tcp:\/\//i.test(input)) throw new TypeError('TCP 地址格式应为 tcp://主机:端口');
  let parsed;
  try { parsed = new URL(`http://${input.slice(input.indexOf('://') + 3)}`); }
  catch { throw new TypeError('TCP 地址格式应为 tcp://主机:端口'); }
  if (!parsed.hostname || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
      || !['', '/'].includes(parsed.pathname)) throw new TypeError('TCP 地址格式应为 tcp://主机:端口');
  return {
    url: `tcp://${parsed.host}`,
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(parsed.port),
  };
}

function desktopBridge() { return globalThis.strongholdClient || null; }
function androidBridge() { return globalThis.StrongholdAndroidTcp || null; }

export function isTcpTransportAvailable() {
  const desktop = desktopBridge();
  if (desktop?.tcpAvailable === true && typeof desktop.tcpConnect === 'function') return true;
  const android = androidBridge();
  try { return !!android && typeof android.connect === 'function' && android.available(); }
  catch { return false; }
}

function dispatch(event) {
  const socket = event && sockets.get(String(event.id));
  if (!socket) return;
  socket._nativeEvent(event);
}

// Android calls this function with a plain JSON object via evaluateJavascript.
globalThis.__strongholdTcpDispatch = dispatch;

function ensureDesktopListener() {
  const desktop = desktopBridge();
  if (desktopListenerInstalled || typeof desktop?.onTcpEvent !== 'function') return;
  desktop.onTcpEvent(dispatch);
  desktopListenerInstalled = true;
}

function connectNative(id, host, port) {
  const desktop = desktopBridge();
  if (desktop?.tcpAvailable === true && typeof desktop.tcpConnect === 'function') {
    ensureDesktopListener();
    desktop.tcpConnect(id, host, port);
    return;
  }
  const android = androidBridge();
  if (android && typeof android.connect === 'function' && android.available()) {
    android.connect(id, host, port);
    return;
  }
  throw new Error('当前客户端不支持 TCP 直连，请改用 WebSocket');
}

function sendNative(id, data) {
  const desktop = desktopBridge();
  if (desktop?.tcpAvailable === true) { desktop.tcpSend(id, data); return; }
  androidBridge()?.send(id, data);
}

function closeNative(id, code, reason) {
  const desktop = desktopBridge();
  if (desktop?.tcpAvailable === true) { desktop.tcpClose(id, code, reason); return; }
  androidBridge()?.close(id, code, reason);
}

/** Minimal WHATWG WebSocket-compatible surface used by public/js/net.js. */
export class TcpSocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(url) {
    const parsed = parseTcpUrl(url);
    this.url = parsed.url;
    this.readyState = CONNECTING;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._id = `tcp-${Date.now().toString(36)}-${(++nextId).toString(36)}`;
    sockets.set(this._id, this);
    try { connectNative(this._id, parsed.host, parsed.port); }
    catch (err) { sockets.delete(this._id); this.readyState = CLOSED; throw err; }
  }

  send(data) {
    if (this.readyState !== OPEN) throw new Error('TCP socket is not open');
    const text = String(data);
    if (new TextEncoder().encode(text).length > 64 * 1024) throw new RangeError('TCP frame too large');
    sendNative(this._id, text);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    try { closeNative(this._id, Number(code) || 1000, String(reason).slice(0, 120)); }
    catch { this._nativeEvent({ id: this._id, type: 'close', code, reason }); }
  }

  _nativeEvent(event) {
    if (event.type === 'open') {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.({ type: 'open', target: this });
      return;
    }
    if (event.type === 'message') {
      if (this.readyState === OPEN) this.onmessage?.({ type: 'message', target: this, data: String(event.data ?? '') });
      return;
    }
    if (event.type === 'error') {
      this.onerror?.({ type: 'error', target: this, message: String(event.message || 'TCP connection error') });
      return;
    }
    if (event.type === 'close') {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      sockets.delete(this._id);
      this.onclose?.({
        type: 'close', target: this, code: Number(event.code) || 1006,
        reason: String(event.reason || ''), wasClean: Number(event.code) === 1000,
      });
    }
  }
}
