// Connection settings and invite parsing (title screen + boot).
//
// The browser page talks WebSocket to the host it was served from. The native shells (Tauri on
// Windows, the Android WebView) can also use their own TCP socket through the bridge: that bridge
// replaces `globalThis.WebSocket` only when the saved transport is `tcp` (the default, so an
// upgraded install keeps working with no setting at all). The address a player types is stored in
// localStorage on that machine — it is never sent to the server.
//
// Pure helpers so the parsing rules are testable without a DOM.

export const TRANSPORT_KEY = 'sp.server.transport';
export const ADDRESS_KEY = 'sp.server.address';
export const TCP_ENDPOINT_KEY = 'sp.native.tcp';
export const TRANSPORTS = Object.freeze(['websocket', 'tcp']);
export const DEFAULT_TCP_ADDRESS = '127.0.0.1:3001';

/** Parse `host:port` (also `tcp://host:port`, IPv6 in brackets) into `{host, port}`, else null. */
export function parseEndpoint(value) {
  const raw = String(value ?? '').trim().replace(/^tcp:\/\//i, '');
  const match = raw.match(/^([^/:\s[\]]+|\[[^\]\s]+\]):(\d{1,5})$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = match[1].replace(/^\[|\]$/g, '');
  if (!host) return null;
  return { host, port };
}

/** The WebSocket URL for this page (`ws(s)://host/ws`), the same rule as net.js defaultWsUrl. */
export function defaultSocketUrl(loc = globalThis.location) {
  if (!loc || !loc.host) return 'ws://localhost:3000/ws';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/**
 * Normalise what the player typed for the chosen transport.
 * Returns `{ok: true, transport, address, socketUrl?, endpoint?}` or `{ok: false, error}` where
 * `error` is a code the screen translates (`invalid_endpoint` / `invalid_address` / `invalid_scheme`).
 */
export function parseAddress(text, { transport = 'websocket', loc = globalThis.location } = {}) {
  const raw = String(text ?? '').trim();
  if (transport === 'tcp') {
    const endpoint = parseEndpoint(raw);
    if (!endpoint) return { ok: false, error: 'invalid_endpoint' };
    return { ok: true, transport, address: `${endpoint.host}:${endpoint.port}`, endpoint };
  }
  if (!raw) return { ok: true, transport, address: '', socketUrl: defaultSocketUrl(loc) };
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `ws://${raw}`);
  } catch {
    return { ok: false, error: 'invalid_address' };
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return { ok: false, error: 'invalid_scheme' };
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return { ok: true, transport, address: url.toString(), socketUrl: url.toString() };
}

/** Which native host this page is running in, or null for a plain browser. */
export function nativePlatform(scope = globalThis) {
  if (scope?.__TAURI__?.core?.invoke && scope?.__TAURI__?.event?.listen) return 'windows';
  if (scope?.StrongholdAndroidTcp && typeof scope.StrongholdAndroidTcp.connect === 'function') return 'android';
  return null;
}

/** Saved transport/address for this machine. A browser is always `websocket`; a native host defaults to `tcp`. */
export function readSettings(storage = globalThis.localStorage, scope = globalThis) {
  const native = nativePlatform(scope);
  const get = (key) => {
    try { return storage?.getItem(key) || ''; } catch { return ''; }
  };
  const saved = get(TRANSPORT_KEY);
  const transport = !native || saved === 'websocket' ? 'websocket' : 'tcp';
  const address = transport === 'tcp' ? get(ADDRESS_KEY) || get(TCP_ENDPOINT_KEY) : get(ADDRESS_KEY);
  return { transport, address, native, supportsTcp: Boolean(native) };
}

/** Persist the choice (a TCP endpoint is mirrored into the bridge's own key). */
export function saveSettings({ transport, address } = {}, storage = globalThis.localStorage) {
  const chosen = transport === 'tcp' ? 'tcp' : 'websocket';
  const value = String(address ?? '').trim();
  try {
    storage?.setItem(TRANSPORT_KEY, chosen);
    if (value) {
      storage.setItem(ADDRESS_KEY, value);
      if (chosen === 'tcp') storage.setItem(TCP_ENDPOINT_KEY, value.replace(/^tcp:\/\//i, ''));
    }
  } catch { /* private mode: the choice only lives in this tab */ }
  return { transport: chosen, address: value };
}

/**
 * The room code in a pasted invite — a full link (`…?room=ABCD`), `room: ABCD`, or a bare code.
 * Room codes are 4..6 alphanumerics (the protocol's join limit); anything else returns null.
 */
export function inviteCode(text, codeLen = 4) {
  const raw = String(text ?? '').trim();
  const link = raw.match(/[?&]room=([A-Za-z0-9]+)/) || raw.match(/\broom\s*[:：=]\s*([A-Za-z0-9]+)/i);
  const code = (link ? link[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return null;
  return code.length >= codeLen && code.length <= codeLen + 2 ? code : null;
}
