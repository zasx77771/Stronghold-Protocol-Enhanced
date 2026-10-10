// Server-address parsing and persistence for the standalone client.
//
// The web UI and all game assets can be served locally while the game socket connects to an
// independent server.  Users may enter an HTTP(S) page address or a WS(S) endpoint; the protocol
// is normalised to the server's fixed `/ws` endpoint.

import { parseTcpUrl } from './tcpSocket.js';
import { t } from '../../shared/i18n.js';

export const SERVER_ADDRESS_KEY = 'sp.server';
export const TCP_SERVER_ADDRESS_KEY = 'sp.server.tcp';
export const TRANSPORT_MODE_KEY = 'sp.transport';
export const TRANSPORT_WEBSOCKET = 'websocket';
export const TRANSPORT_TCP = 'tcp';
export const ROOM_CODE_MIN_LEN = 4;
export const ROOM_CODE_MAX_LEN = 6;
export const CLIPBOARD_PERMISSION_DENIED = 'CLIPBOARD_PERMISSION_DENIED';

export function normalizeTransportMode(raw) {
  return String(raw || '').toLowerCase() === TRANSPORT_TCP ? TRANSPORT_TCP : TRANSPORT_WEBSOCKET;
}

/** @returns {boolean} whether this page was opened by the packaged desktop shell. */
export function isDesktopClient(search = globalThis.location?.search || '') {
  try { return new URLSearchParams(search).get('desktop') === '1'; } catch { return false; }
}

/**
 * Normalise a user-entered server address.
 * @param {unknown} raw
 * @returns {{ address: string, wsUrl: string, serverKey: string }}
 * @throws {TypeError} with a user-facing Chinese message
 */
export function normalizeServerAddress(raw) {
  let input = String(raw ?? '').trim();
  if (!input) throw new TypeError('请输入服务器地址');
  if (/[\u0000-\u001f\u007f\s]/.test(input)) throw new TypeError('服务器地址不能包含空格');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `http://${input}`;

  let url;
  try { url = new URL(input); } catch { throw new TypeError('服务器地址格式不正确'); }
  const protocol = url.protocol.toLowerCase();
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) {
    throw new TypeError('服务器地址只支持 HTTP、HTTPS、WS 或 WSS');
  }
  if (!url.hostname) throw new TypeError('服务器地址缺少主机名');
  if (url.username || url.password) throw new TypeError('服务器地址不能包含用户名或密码');
  if (url.search || url.hash) throw new TypeError('服务器地址不能包含查询参数或锚点');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && path.toLowerCase() !== '/ws') {
    throw new TypeError('服务器必须部署在域名根路径');
  }

  const secure = protocol === 'https:' || protocol === 'wss:';
  const address = `${secure ? 'https:' : 'http:'}//${url.host}`;
  const wsUrl = `${secure ? 'wss:' : 'ws:'}//${url.host}/ws`;
  return { address, wsUrl, serverKey: address.toLowerCase() };
}

/** Normalise a raw TCP endpoint used only by packaged clients. */
export function normalizeTcpAddress(raw) {
  let input = String(raw ?? '').trim();
  if (!input) throw new TypeError('请输入 TCP 服务器地址');
  if (/[\u0000-\u001f\u007f\s]/.test(input)) throw new TypeError('TCP 地址不能包含空格');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `tcp://${input}`;
  if (!/^tcp:\/\//i.test(input)) throw new TypeError('TCP 直连地址必须使用 tcp://');
  let parsed;
  try { parsed = parseTcpUrl(input); }
  catch { throw new TypeError('TCP 地址必须包含有效主机和端口，例如 192.168.1.10:3001'); }
  const address = parsed.url;
  return { address, socketUrl: address, wsUrl: address, serverKey: address.toLowerCase(), transport: TRANSPORT_TCP };
}

function safeLocalStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function loadTransportMode(storage = safeLocalStorage()) {
  try { return normalizeTransportMode(storage?.getItem(TRANSPORT_MODE_KEY)); }
  catch { return TRANSPORT_WEBSOCKET; }
}

export function saveTransportMode(mode, storage = safeLocalStorage()) {
  const value = normalizeTransportMode(mode);
  try { storage?.setItem(TRANSPORT_MODE_KEY, value); } catch { /* quota / privacy mode */ }
  return value;
}

/** Default address shown on the title screen. Standalone clients intentionally ship with no server embedded. */
export function defaultServerAddress(loc = globalThis.location) {
  if (isDesktopClient(loc?.search || '')) return '';
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.host) {
    return `${loc.protocol}//${loc.host}`;
  }
  return '';
}

export function defaultEndpointAddress(mode, loc = globalThis.location) {
  return normalizeTransportMode(mode) === TRANSPORT_TCP ? '' : defaultServerAddress(loc);
}

/** Load the last address, falling back only to the origin of a server-hosted browser page. */
export function loadServerAddress(storage = safeLocalStorage(), loc = globalThis.location) {
  let saved = '';
  try { saved = storage?.getItem(SERVER_ADDRESS_KEY) || ''; } catch { /* privacy mode */ }
  if (!saved) return defaultServerAddress(loc);
  try { return normalizeServerAddress(saved).address; }
  catch { return defaultServerAddress(loc); }
}

/** Save a canonical address and return its complete normalised record. */
export function saveServerAddress(raw, storage = safeLocalStorage()) {
  const parsed = normalizeServerAddress(raw);
  try { storage?.setItem(SERVER_ADDRESS_KEY, parsed.address); } catch { /* quota / privacy mode */ }
  return parsed;
}

/** Load the separately remembered address for one transport. */
export function loadEndpointAddress(mode, storage = safeLocalStorage(), loc = globalThis.location) {
  const selected = normalizeTransportMode(mode);
  if (selected === TRANSPORT_WEBSOCKET) return loadServerAddress(storage, loc);
  let saved = '';
  try { saved = storage?.getItem(TCP_SERVER_ADDRESS_KEY) || ''; } catch { /* privacy mode */ }
  if (!saved) return defaultEndpointAddress(selected, loc);
  try { return normalizeTcpAddress(saved).address; }
  catch { return defaultEndpointAddress(selected, loc); }
}

/** Save an endpoint and return the canonical socket record used by net.js. */
export function saveEndpointAddress(raw, mode, storage = safeLocalStorage()) {
  const selected = saveTransportMode(mode, storage);
  if (selected === TRANSPORT_WEBSOCKET) {
    const endpoint = saveServerAddress(raw, storage);
    return { ...endpoint, socketUrl: endpoint.wsUrl, transport: selected };
  }
  const endpoint = normalizeTcpAddress(raw);
  try { storage?.setItem(TCP_SERVER_ADDRESS_KEY, endpoint.address); } catch { /* quota / privacy mode */ }
  return endpoint;
}

/** Build a browser invitation using the selected game server, never the local client origin. */
export function buildInviteLink(rawServer, rawCode, mode = String(rawServer || '').trim().toLowerCase().startsWith('tcp://') ? TRANSPORT_TCP : TRANSPORT_WEBSOCKET) {
  const selected = normalizeTransportMode(mode);
  const endpoint = selected === TRANSPORT_TCP ? normalizeTcpAddress(rawServer) : normalizeServerAddress(rawServer);
  const code = normalizeRoomCode(rawCode);
  if (!code) throw new TypeError('房间 Code 格式不正确');
  return `${endpoint.address}/?room=${encodeURIComponent(code)}`;
}

/** Normalise a room code accepted by the join protocol. Empty / malformed values become ''. */
export function normalizeRoomCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  return new RegExp(`^[A-Z0-9]{${ROOM_CODE_MIN_LEN},${ROOM_CODE_MAX_LEN}}$`).test(code) ? code : '';
}

function inviteUrl(text) {
  const match = text.match(/(?:https?|wss?|tcp):\/\/[^\s<>"']+/i);
  if (!match) return null;
  // Chat applications often leave sentence punctuation immediately after a copied URL.
  return match[0].replace(/[),.;!?，。；！？]+$/u, '');
}

/**
 * Parse clipboard text without retaining the original text. Recognised forms:
 * `https://host/?room=ABCD`, `host:3000 ABCD`, `ABCD`, or an address by itself.
 * A bare code must be the entire clipboard, avoiding matches inside arbitrary prose.
 */
export function parseInviteText(raw, fallbackAddress = '', fallbackTransport = TRANSPORT_WEBSOCKET) {
  const text = String(raw ?? '').trim().slice(0, 4096);
  if (!text) return null;

  const fullUrl = inviteUrl(text);
  if (fullUrl) {
    let url;
    const tcpInvite = /^tcp:\/\//i.test(fullUrl);
    // Chromium/WebView parses unknown schemes as opaque URLs, so give tcp:// invitations a
    // temporary hierarchical scheme while extracting host, port and query parameters.
    const parseableUrl = tcpInvite ? `http://${fullUrl.slice(fullUrl.indexOf('://') + 3)}` : fullUrl;
    try { url = new URL(parseableUrl); } catch { return null; }
    const code = normalizeRoomCode(url.searchParams.get('room'));
    // An URL embedded in arbitrary prose is only an invitation when it carries a room code.
    // A plain address is accepted only when it is the whole clipboard.
    if (!code && fullUrl !== text.replace(/[),.;!?，。；！？]+$/u, '')) return null;
    url.search = '';
    url.hash = '';
    const transport = tcpInvite ? TRANSPORT_TCP : TRANSPORT_WEBSOCKET;
    let endpoint;
    try { endpoint = transport === TRANSPORT_TCP ? normalizeTcpAddress(`tcp://${url.host}`) : normalizeServerAddress(url.href); } catch { return null; }
    return { ...endpoint, code, completeInvite: !!code, ...(transport === TRANSPORT_TCP ? { transport } : {}) };
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const code = normalizeRoomCode(tokens[0]);
    if (code) {
      try {
        const transport = normalizeTransportMode(fallbackTransport);
        const endpoint = transport === TRANSPORT_TCP ? normalizeTcpAddress(fallbackAddress) : normalizeServerAddress(fallbackAddress);
        return { ...endpoint, code, completeInvite: true, ...(transport === TRANSPORT_TCP ? { transport } : {}) };
      } catch { return { address: '', wsUrl: '', serverKey: '', code, completeInvite: false }; }
    }
    try {
      const transport = normalizeTransportMode(fallbackTransport);
      const endpoint = transport === TRANSPORT_TCP ? normalizeTcpAddress(tokens[0]) : normalizeServerAddress(tokens[0]);
      return { ...endpoint, code: '', completeInvite: false, ...(transport === TRANSPORT_TCP ? { transport } : {}) };
    }
    catch { return null; }
  }

  if (tokens.length === 2) {
    const code = normalizeRoomCode(tokens[1]);
    if (!code) return null;
    try {
      const transport = normalizeTransportMode(fallbackTransport);
      const endpoint = transport === TRANSPORT_TCP ? normalizeTcpAddress(tokens[0]) : normalizeServerAddress(tokens[0]);
      return { ...endpoint, code, completeInvite: true, ...(transport === TRANSPORT_TCP ? { transport } : {}) };
    }
    catch { return null; }
  }
  return null;
}

/**
 * Turn browser/WebView clipboard failures into a stable, user-facing result.
 * Android WebView commonly reports a denied read as NotAllowedError with the English message
 * "Read permission denied", while some vendor WebViews use SecurityError instead.
 */
export function describeClipboardReadError(err) {
  const name = String(err?.name || '');
  const detail = String(err?.message || err || '');
  const permissionDenied = name === 'NotAllowedError' || name === 'SecurityError'
    || /permission\s*(?:denied|not allowed)|not\s*allowed|access\s*denied|权限|拒绝/i.test(detail);
  if (permissionDenied) {
    return {
      code: CLIPBOARD_PERMISSION_DENIED,
      permissionDenied: true,
      message: t('需要获取剪贴板权限。请允许系统的剪贴板访问提示；若未弹出，请到系统设置的应用权限中允许“卫戍协议：盟约”读取剪贴板，或手动输入地址和房间 Code。'),
    };
  }
  return {
    code: 'CLIPBOARD_READ_FAILED',
    permissionDenied: false,
    message: detail || t('无法读取剪贴板，请检查权限'),
  };
}

/** Read through a packaged-client bridge when present, otherwise the browser Clipboard API. */
export async function readClipboardText() {
  try {
    const bridge = globalThis.strongholdClient;
    if (bridge && typeof bridge.readClipboardText === 'function') {
      const value = await bridge.readClipboardText();
      return typeof value === 'string' ? value : '';
    }
    const androidBridge = globalThis.StrongholdAndroid;
    if (androidBridge && typeof androidBridge.readClipboardText === 'function') {
      const value = String(androidBridge.readClipboardText() || '');
      if (value.startsWith('__SP_CLIPBOARD_DENIED__:')) {
        const error = new Error(value.slice('__SP_CLIPBOARD_DENIED__:'.length) || 'Permission denied');
        error.name = 'SecurityError';
        throw error;
      }
      if (value.startsWith('__SP_CLIPBOARD_ERROR__:')) {
        throw new Error(value.slice('__SP_CLIPBOARD_ERROR__:'.length) || '无法读取剪贴板');
      }
      return value;
    }
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard || typeof clipboard.readText !== 'function') throw new Error('当前环境不支持读取剪贴板');
    return String(await clipboard.readText() || '');
  } catch (err) {
    const info = describeClipboardReadError(err);
    const wrapped = new Error(info.message);
    wrapped.name = info.permissionDenied ? 'ClipboardPermissionError' : 'ClipboardReadError';
    wrapped.code = info.code;
    throw wrapped;
  }
}
