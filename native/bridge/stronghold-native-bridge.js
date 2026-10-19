/*
 * Native-only WebSocket facade.
 *
 * Windows and Android inject this classic script into the document they serve.  The checked-in
 * browser page never imports it.  When neither supported native host is present it intentionally
 * does nothing, so browser WebSocket and Service Worker behaviour remain upstream-owned.
 */
(function installStrongholdNativeBridge() {
  'use strict';
  if (globalThis.__strongholdNativeBridgeInstalled) return;

  const tauri = globalThis.__TAURI__;
  const android = globalThis.StrongholdAndroidTcp;
  const hasTauri = Boolean(tauri?.core?.invoke && tauri?.event?.listen);
  const hasAndroid = Boolean(android && typeof android.connect === 'function');
  if (!hasTauri && !hasAndroid) return;

  // The page's transport choice (title screen → public/js/connection.js) decides whether the native
  // socket replaces the host's WebSocket at all: `websocket` leaves it alone; `tcp`, or no choice at
  // all (an upgraded install), installs the TCP facade below.
  let transport = 'tcp';
  try {
    if (globalThis.localStorage?.getItem('sp.server.transport') === 'websocket') transport = 'websocket';
  } catch { /* private mode */ }
  if (transport === 'websocket') return;

  globalThis.__strongholdNativeBridgeInstalled = true;
  const NativeWebSocket = globalThis.WebSocket;
  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;
  const FRAME_LIMIT = 64 * 1024;
  const ADDRESS_KEY = 'sp.native.tcp';
  const NO_ENDPOINT = 'no_server_address';
  let nextSocketId = 0;
  let tauriListener = null;
  const sockets = new Map();

  function endpointFrom(value) {
    const raw = String(value || '').trim().replace(/^tcp:\/\//i, '');
    const match = raw.match(/^([^/:\[\]]+|\[[^\]]+\]):(\d{1,5})$/);
    if (!match) return null;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: match[1].replace(/^\[|\]$/g, ''), port };
  }

  function configuredEndpoint() {
    let saved = '';
    let address = '';
    try {
      saved = globalThis.localStorage?.getItem(ADDRESS_KEY) || '';
      address = globalThis.localStorage?.getItem('sp.server.address') || '';
    } catch { /* private mode */ }
    return endpointFrom(saved) || endpointFrom(address) || endpointFrom(globalThis.__STRONGHOLD_NATIVE_ENDPOINT__);
  }

  // Android calls this with one object built by `evaluateJavascript`; Tauri forwards the typed event
  // payload plus its id. Accept both shapes: a payload without `id` used to look up nothing and drop
  // every event, which left the Android client connected but permanently stuck before its hello.
  function report(idOrPayload, maybePayload) {
    let id = idOrPayload;
    let payload = maybePayload;
    if (payload === undefined && idOrPayload && typeof idOrPayload === 'object') {
      payload = idOrPayload;
      id = payload.id;
    }
    const socket = sockets.get(String(id));
    if (socket) socket._receive(payload || {});
  }

  // Android calls this with `evaluateJavascript`; the Tauri implementation wires the same name
  // to its typed event.  It is intentionally the only event entrypoint exposed to native code.
  globalThis.__strongholdNativeTcpEvent = report;

  function platform() {
    if (hasTauri) {
      return {
        connect(id, host, port) {
          // `listen` is async: invoking connect first can lose the open event on a fast local server.
          if (!tauriListener) tauriListener = tauri.event.listen('sp-tcp-event', ({ payload }) => report(payload?.id, payload));
          Promise.resolve(tauriListener)
            .then(() => tauri.core.invoke('sp_tcp_connect', { id, host, port }))
            .catch((error) => report(id, { type: 'error', message: String(error?.message || error) }));
        },
        send(id, data) { void tauri.core.invoke('sp_tcp_send', { id, data: [...new TextEncoder().encode(data)] }); },
        close(id, code, reason) { void tauri.core.invoke('sp_tcp_close', { id, code, reason }); },
      };
    }
    return {
      connect(id, host, port) { android.connect(String(id), String(host), Number(port)); },
      send(id, data) { android.send(String(id), String(data)); },
      close(id, code, reason) { android.close(String(id), Number(code), String(reason)); },
    };
  }

  const native = platform();

  function event(type, fields = {}) {
    // The upstream client uses `on*`; addEventListener consumers still receive standards-shaped events.
    if (type === 'message' && typeof MessageEvent === 'function') return new MessageEvent(type, { data: fields.data });
    if (type === 'close' && typeof CloseEvent === 'function') {
      return new CloseEvent(type, { code: fields.code, reason: fields.reason, wasClean: fields.wasClean });
    }
    if (type === 'error' && typeof ErrorEvent === 'function') return new ErrorEvent(type, { message: fields.message });
    return new Event(type);
  }

  class TcpWebSocket extends EventTarget {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = CONNECTING;
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._id = `native-tcp-${Date.now().toString(36)}-${(++nextSocketId).toString(36)}`;
      this._native = true;
      sockets.set(this._id, this);
      // Only the address the player saved is dialled. A fresh install has none, so the socket fails
      // immediately (the title screen then asks for one) instead of quietly connecting somewhere
      // the player never chose.
      const endpoint = configuredEndpoint();
      if (!endpoint) {
        this.readyState = CLOSED;
        sockets.delete(this._id);
        queueMicrotask(() => {
          this._emit('error', { message: NO_ENDPOINT });
          this._emit('close', { code: 1000, reason: NO_ENDPOINT, wasClean: true });
        });
        return;
      }
      native.connect(this._id, endpoint.host, endpoint.port);
    }

    send(data) {
      if (this.readyState !== OPEN) throw new Error('WebSocket is not open');
      const text = String(data);
      if (new TextEncoder().encode(text).byteLength > FRAME_LIMIT) throw new RangeError('TCP frame too large');
      native.send(this._id, text);
    }

    close(code = 1000, reason = '') {
      if (this.readyState === CLOSED || this.readyState === CLOSING) return;
      this.readyState = CLOSING;
      native.close(this._id, Number(code) || 1000, String(reason).slice(0, 120));
    }

    _receive(payload) {
      const type = String(payload.type || 'error');
      if (type === 'open') {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this._emit('open');
        return;
      }
      if (type === 'message') {
        if (this.readyState !== OPEN) return;
        const data = String(payload.data || '');
        if (this._control(data)) return;
        this._emit('message', { data });
        return;
      }
      if (type === 'close') {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        sockets.delete(this._id);
        this._emit('close', { code: Number(payload.code) || 1006, reason: String(payload.reason || ''), wasClean: Number(payload.code) === 1000 });
        return;
      }
      this._emit('error', { message: String(payload.message || 'TCP connection error') });
    }

    _control(data) {
      let control;
      try { control = JSON.parse(data); } catch { return false; }
      if (!control || typeof control !== 'object' || typeof control._sp !== 'string') return false;
      if (control._sp === 'ping') {
        native.send(this._id, JSON.stringify({ _sp: 'pong' }));
        return true;
      }
      if (control._sp === 'close') {
        const code = Number(control.code) || 1000;
        const reason = String(control.reason || 'server closed');
        native.close(this._id, code, reason);
        this._receive({ type: 'close', code, reason });
        return true;
      }
      return false;
    }

    _emit(type, fields) {
      const value = event(type, fields);
      this.dispatchEvent(value);
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, value);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime asset status (native only).  Bytes and versions are public release metadata; the
  // session token and the asset JWT never cross this boundary.
  // ---------------------------------------------------------------------------------------------
  const androidAssets = globalThis.StrongholdAndroidAssets;
  // Only a native shell gets the import surface.  In a plain browser neither flag is set, so no
  // picker, file API or package import exists at all.
  const nativeImportAvailable = hasTauri || Boolean(androidAssets && typeof androidAssets.importPackage === 'function');
  let assetPanel = null;
  let assetLast = null;

  function bytesText(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function assetStateLabel(status) {
    const state = String(status?.state || '');
    if (state === 'importing') return '读取本地素材包…（仅经原生文件选择器）';
    if (state === 'import-verifying') return '校验 ASSETS.json、SHA-256 与 inventory…';
    if (state === 'import-applying') return '解压到临时目录并原子切换素材层…';
    if (state === 'imported') return `已导入 ${status.current || ''}：${status.message || ''}`;
    if (state === 'import-failed') {
      if (status.cancelled || status.message === '已取消导入') return '已取消导入';
      return `导入失败：${status.error || status.message || '未知错误'}`;
    }
    return status?.current ? `当前素材：本地覆盖 ${status.current}` : '素材随安装包内嵌，可用本地素材包覆盖';
  }

  function assetProgress(status) {
    return String(status?.state || '') === 'imported' ? 1 : 0;
  }

  function assetButtons(status) {
    const state = String(status?.state || '');
    const busy = ['importing', 'import-verifying', 'import-applying'].includes(state);
    return { canImport: nativeImportAvailable && !busy, canReload: state === 'imported' };
  }

  function importAssetPackage() {
    if (!nativeImportAvailable) return;
    if (hasTauri) {
      void tauri.core.invoke('sp_import_asset_package')
        .then((result) => {
          if (result?.cancelled) renderAsset({ state: 'idle', message: '已取消导入' });
          else if (result?.error) renderAsset({ state: 'import-failed', error: String(result.error) });
        })
        .catch((error) => renderAsset({ state: 'import-failed', error: String(error?.message || error) }));
      return;
    }
    callAndroidAsset('importPackage');
  }

  function callAndroidAsset(method) {
    try {
      if (androidAssets && typeof androidAssets[method] === 'function') androidAssets[method]();
    } catch { /* the interface can disappear on navigation */ }
  }

  function ensureAssetPanel() {
    if (assetPanel || !globalThis.document || !document.body) return assetPanel;
    const panel = document.createElement('section');
    panel.id = 'sp-native-assets';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;min-width:300px;max-width:420px;padding:14px;border-radius:10px;background:#0c0f0ef2;color:#edf2ee;font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px #0008';
    panel.innerHTML = '<div style="display:flex;gap:8px;align-items:center"><strong style="flex:1">运行素材</strong><button type="button" data-sp-act="close" style="background:none;border:0;color:#9fb3a8;font-size:16px;cursor:pointer">×</button></div><p data-sp-line style="margin:8px 0;color:#cfe0d5"></p><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button type="button" data-sp-act="import">导入素材包…</button><button type="button" data-sp-act="reload" style="display:none">重新加载</button></div>';
    panel.addEventListener('click', (ev) => {
      const action = ev.target?.dataset?.spAct;
      if (!action) return;
      if (action === 'close') { panel.remove(); assetPanel = null; return; }
      if (action === 'import') { importAssetPackage(); return; }
      if (action === 'reload') { globalThis.location?.reload(); }
    });
    document.body.append(panel);
    assetPanel = panel;
    return panel;
  }

  function renderAsset(status) {
    if (!status || typeof status !== 'object') return;
    const panel = ensureAssetPanel();
    if (!panel) return;
    panel.querySelector('[data-sp-line]').textContent = assetStateLabel(status);
    const buttons = assetButtons(status);
    const importButton = panel.querySelector('[data-sp-act="import"]');
    const reloadButton = panel.querySelector('[data-sp-act="reload"]');
    if (importButton) importButton.disabled = !buttons.canImport;
    if (reloadButton) {
      reloadButton.disabled = !buttons.canReload;
      reloadButton.style.display = buttons.canReload ? '' : 'none';
    }
  }

  function receiveAssetStatus(payload) {
    let status = payload;
    if (typeof payload === 'string') {
      try { status = JSON.parse(payload); } catch { return; }
    }
    renderAsset(status);
  }

  if (hasTauri) {
    void tauri.event.listen('sp-asset-event', ({ payload }) => receiveAssetStatus(payload));
  }
  // The title screen owns 下载完整素材 / 导入素材包, so the shells only push status once an import
  // actually runs. The 3.1.0-era fixed 素材 button sat on top of the game in both native shells and
  // is gone; the status channel stays because the import path still reports through it.
  if (hasAndroid && androidAssets) globalThis.__strongholdAssetUpdate = receiveAssetStatus;

  // Only the native page replaces its socket constructor.  The retained original is useful to
  // diagnostics and makes accidental double injection observable without changing browser code.
  TcpWebSocket.nativeWebSocket = NativeWebSocket;
  globalThis.WebSocket = TcpWebSocket;
})();
