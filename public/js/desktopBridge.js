// The only JavaScript the packaged Windows client still carries.
//
// `desktop/runtime/preload.cjs` used Electron's `contextBridge` to publish `strongholdClient`.
// Tauri has no preload, so index.html loads this file before the application scripts and
// `app.withGlobalTauri: true` makes `window.__TAURI__` available to it. The object it builds has the
// same shape the Electron preload published, because `public/js/tcpSocket.js` and
// `public/js/serverAddress.js` are shared with the browser and Android builds and must not change.
//
// It runs in the page's main world on purpose: the page (and only the page) needs the object, and
// everything behind it — the socket, the file system, the R2 session token — stays in Rust.
(function installStrongholdClient() {
  'use strict';
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;
  const invoke = tauri.core.invoke;
  if (globalThis.strongholdClient && globalThis.strongholdClient.tcpAvailable === true) return;

  function call(command, args) {
    return invoke(command, args).catch((error) => {
      console.error('[strongholdClient]', command, error);
      return undefined;
    });
  }

  // `tcpSend` has to move arbitrary text across the IPC boundary. A JSON number array is the
  // encoding Tauri already speaks, and it avoids any UTF-16 re-encode of the payload.
  function toBytes(text) {
    const encoded = new TextEncoder().encode(String(text));
    const bytes = new Array(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded[index];
    return bytes;
  }

  let assembling = false;
  globalThis.strongholdClient = {
    platform: 'windows',
    tcpAvailable: true,
    tcpConnect(id, host, port) {
      void call('sp_tcp_connect', { id: String(id || ''), host: String(host || ''), port: Number(port) || 0 });
    },
    tcpSend(id, data) {
      void call('sp_tcp_send', { id: String(id || ''), data: toBytes(data) });
    },
    tcpClose(id, code, reason) {
      void call('sp_tcp_close', {
        id: String(id || ''),
        code: Number(code) || 1000,
        reason: String(reason || ''),
      });
    },
    onTcpEvent(listener) {
      if (typeof listener !== 'function') return undefined;
      // `public/js/tcpSocket.js` calls this once per connection and keeps its own dispatch table, so
      // the unlisten handle is not needed; it is returned for completeness.
      return tauri.event.listen('sp-tcp-event', (event) => {
        const payload = event && event.payload;
        if (payload && typeof payload === 'object') listener(payload);
      });
    },
    readClipboardText() {
      return invoke('sp_read_clipboard').catch(() => '');
    },
    setAssetSessionToken(token) {
      // Fire and forget, exactly like the Electron preload. The token never comes back to the page.
      void invoke('sp_set_asset_session_token', { token: String(token || '') }).then((changed) => {
        if (changed === true && !assembling) {
          assembling = true;
          globalThis.location.reload();
        }
      }).catch((error) => console.error('[strongholdClient] asset session token', error));
    },
    assetsReady() {
      return invoke('sp_assets_ready').catch(() => false);
    },
    clientInfo() {
      return invoke('sp_client_info').catch(() => undefined);
    },
  };
})();
