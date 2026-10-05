// Read-only client for the separate native TCP replay endpoint. The browser never calls this:
// TcpSocket is available only through the packaged Windows/Android bridges.

import { TcpSocket, parseTcpUrl } from './tcpSocket.js';

export const REPLAY_ADDRESS_KEY = 'sp.replay.tcp';
export const DEFAULT_REPLAY_PORT = 3002;

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function normalizeReplayAddress(raw) {
  let input = String(raw ?? '').trim();
  if (!input) throw new TypeError('请输入回放 TCP 地址');
  if (/[\u0000-\u001f\u007f\s]/.test(input)) throw new TypeError('回放 TCP 地址不能包含空格');
  if (!/^tcp:\/\//i.test(input)) input = `tcp://${input}`;
  try {
    const parsed = parseTcpUrl(input);
    return { address: parsed.url, socketUrl: parsed.url };
  } catch {
    throw new TypeError('回放 TCP 地址格式不正确，例如 192.168.1.10:3002');
  }
}

/** Infer the default 3002 endpoint from either the game's web or native-TCP address. */
export function guessReplayAddress(serverAddress) {
  const raw = String(serverAddress ?? '').trim();
  if (!raw) return `tcp://127.0.0.1:${DEFAULT_REPLAY_PORT}`;
  try {
    const parseable = /^tcp:\/\//i.test(raw) ? `http://${raw.slice(raw.indexOf('://') + 3)}` : (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const parsed = new URL(parseable);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname) throw new Error('missing host');
    return `tcp://${hostname.includes(':') ? `[${hostname}]` : hostname}:${DEFAULT_REPLAY_PORT}`;
  } catch {
    return `tcp://127.0.0.1:${DEFAULT_REPLAY_PORT}`;
  }
}

export function loadReplayAddress(fallback = '') {
  try {
    const saved = storage()?.getItem(REPLAY_ADDRESS_KEY) || '';
    return saved ? normalizeReplayAddress(saved).address : guessReplayAddress(fallback);
  } catch { return guessReplayAddress(fallback); }
}

export function saveReplayAddress(raw) {
  const endpoint = normalizeReplayAddress(raw);
  try { storage()?.setItem(REPLAY_ADDRESS_KEY, endpoint.address); } catch { /* local storage unavailable */ }
  return endpoint;
}

/** Send one framed request and resolve its first JSON response. */
export function requestReplay(rawAddress, request, { timeoutMs = 12_000 } = {}) {
  const endpoint = normalizeReplayAddress(rawAddress);
  return new Promise((resolve, reject) => {
    let done = false;
    let socket = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.close(1000, 'complete'); } catch { /* ignore */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('读取回放超时，请检查地址和端口')), timeoutMs);
    try { socket = new TcpSocket(endpoint.socketUrl); }
    catch (error) { finish(reject, error); return; }
    socket.onopen = () => {
      try { socket.send(JSON.stringify(request)); }
      catch (error) { finish(reject, error); }
    };
    socket.onmessage = (event) => {
      try { finish(resolve, JSON.parse(String(event.data || ''))); }
      catch { finish(reject, new Error('回放服务返回了无效数据')); }
    };
    socket.onerror = (event) => finish(reject, new Error(event?.message || '无法连接回放服务'));
    socket.onclose = (event) => {
      if (!done) finish(reject, new Error(event?.reason || '回放连接已关闭'));
    };
  });
}
