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

  globalThis.__strongholdNativeBridgeInstalled = true;
  const NativeWebSocket = globalThis.WebSocket;
  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;
  const FRAME_LIMIT = 64 * 1024;
  const ADDRESS_KEY = 'sp.native.tcp';
  let nextSocketId = 0;
  let tauriListener = null;
  let assetReloaded = false;
  let setupShown = false;
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
    try { saved = globalThis.localStorage?.getItem(ADDRESS_KEY) || ''; } catch { /* private mode */ }
    return endpointFrom(saved) || endpointFrom(globalThis.__STRONGHOLD_NATIVE_ENDPOINT__);
  }

  function showEndpointSetup() {
    if (setupShown || !globalThis.document) return;
    setupShown = true;
    const mount = () => {
      if (document.getElementById('sp-native-endpoint-setup')) return;
      const panel = document.createElement('form');
      panel.id = 'sp-native-endpoint-setup';
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;gap:12px;padding:24px;background:#0c0f0ef2;color:#edf2ee;font:16px system-ui,sans-serif';
      panel.innerHTML = '<strong>连接服务器</strong><label>TCP 地址 <input name="endpoint" autocomplete="off" placeholder="127.0.0.1:3001" style="display:block;margin-top:6px;padding:8px;min-width:260px" /></label><small>此地址仅保存在本机客户端。</small><button type="submit">连接</button><output aria-live="polite"></output>';
      panel.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const raw = new FormData(panel).get('endpoint');
        if (!endpointFrom(raw)) {
          panel.querySelector('output').textContent = '请输入主机:端口，例如 192.168.1.10:3001。';
          return;
        }
        try { globalThis.localStorage?.setItem(ADDRESS_KEY, String(raw).trim().replace(/^tcp:\/\//i, '')); } catch { /* private mode */ }
        globalThis.location.reload();
      });
      document.body.append(panel);
      panel.querySelector('input')?.focus();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }
  function report(id, event) {
    const socket = sockets.get(String(id));
    if (socket) socket._receive(event || {});
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
        assetToken(token) {
          // Windows keeps the "session token arrives → check automatically" behaviour; a changed
          // generation reloads the page once so the new manifest and store are what it renders.
          void tauri.core.invoke('sp_set_asset_session_token', { token }).then((changed) => {
            if (changed === true && !assetReloaded) {
              assetReloaded = true;
              globalThis.location?.reload();
            }
          }).catch(() => {});
        },
      };
    }
    return {
      connect(id, host, port) { android.connect(String(id), String(host), Number(port)); },
      send(id, data) { android.send(String(id), String(data)); },
      close(id, code, reason) { android.close(String(id), Number(code), String(reason)); },
      assetToken(token) { if (typeof android.setAssetSessionToken === 'function') android.setAssetSessionToken(String(token)); },
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

  function observeAssetToken(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.t !== 'welcome') return;
    // The game server puts the 32-hex session token in `token` (server/net.js welcome); the native
    // side exchanges it for the short-lived asset JWT and never returns that JWT to the page.
    const token = message.token;
    if (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)) native.assetToken(token);
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
      const endpoint = configuredEndpoint();
      if (!endpoint) {
        showEndpointSetup();
        queueMicrotask(() => this._receive({ type: 'error', message: '未配置原生 TCP 服务器地址' }));
        queueMicrotask(() => this._receive({ type: 'close', code: 1006, reason: 'native endpoint unavailable' }));
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
        observeAssetToken(data);
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
    }    _emit(type, fields) {
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
    const plan = status.plan || {};
    const state = String(status.state || '');
    if (state === 'checking' || state === 'preparing') return '正在检查素材更新…';
    if (state === 'waiting' || state === 'waiting-session') return '等待登录会话后检查素材…';
    if (state === 'unconfigured') return `未配置素材源：${status.message || status.disabledReason || 'asset-config.json'}`;
    if (state === 'unavailable') return '素材存储不可用';
    if (state === 'idle') return `当前素材 ${status.current || plan.localVersion || '未安装'}`;
    if (state === 'ready') {
      const count = Number(plan.count || 0);
      const latest = plan.latest || status.latest || '新版本';
      return count > 0 ? `可下载 ${latest}：${count} 个包，共 ${bytesText(plan.bytes)}` : `素材已是最新 ${status.current || latest}`;
    }
    if (state === 'downloading') {
      const index = Number(status.packageIndex || status.index || 0);
      const count = Number(status.packageCount || status.count || plan.count || 0);
      const name = status.packageName || status.name || '';
      const done = Number(status.packageDone || status.done || 0);
      const size = Number(status.packageSize || status.size || 0);
      return `下载中 ${index + 1}/${count || 1} ${name} ${bytesText(done)} / ${bytesText(size)}`;
    }
    if (state === 'verifying') return '校验下载包 SHA-256…';
    if (state === 'applying') return '解压并原子安装…';
    if (state === 'complete') return `素材已更新到 ${status.latest || plan.latest || status.current || ''}`;
    if (state === 'importing') return '读取本地素材包…（仅经原生文件选择器）';
    if (state === 'import-verifying') return '校验 ASSETS.json、SHA-256 与 inventory…';
    if (state === 'import-applying') return '解压到临时目录并原子切换素材层…';
    if (state === 'imported') return `已导入 ${status.current || ''}：${status.message || ''}`;
    if (state === 'import-failed') {
      if (status.cancelled || status.message === '已取消导入') return '已取消导入';
      return `导入失败：${status.error || status.message || '未知错误'}`;
    }
    if (state === 'cancelled') return '已取消下载';
    if (state === 'blocked') return `无法更新：${status.error || status.message || '被阻止'}`;
    if (state === 'failed') return `更新失败：${status.error || status.message || '未知错误'}`;
    return status.message || '素材状态未知';
  }

  function assetProgress(status) {
    const plan = status.plan || {};
    const state = String(status.state || '');
    if (state === 'complete' || state === 'imported') return 1;
    const total = Number(status.total || plan.bytes || 0);
    const done = Number(status.done || 0);
    const packageTotal = Number(status.packageSize || 0);
    const packageDone = Number(status.packageDone || 0);
    const ratio = total > 0 ? done / total : packageTotal > 0 ? packageDone / packageTotal : 0;
    return Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  }

  function assetButtons(status) {
    const state = String(status.state || '');
    const busy = ['preparing', 'downloading', 'verifying', 'applying', 'importing', 'import-verifying', 'import-applying'].includes(state);
    const canPrepare = !busy && ['idle', 'unconfigured', 'waiting-session', 'complete', 'failed', 'cancelled', 'blocked'].includes(state);
    const canStart = state === 'ready';
    const canCancel = ['preparing', 'downloading', 'verifying', 'applying'].includes(state);
    const canRetry = state === 'failed' || state === 'cancelled';
    const canImport = nativeImportAvailable && !busy;
    const canReload = state === 'imported';
    return { canPrepare, canStart, canCancel, canRetry, canImport, canReload };
  }

  function callAndroidAsset(method) {
    try {
      if (androidAssets && typeof androidAssets[method] === 'function') androidAssets[method]();
    } catch { /* the interface can disappear on navigation */ }
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

  function mirrorLine(status) {
    const mirrors = Array.isArray(status.mirrors) ? status.mirrors : [];
    const problems = Array.isArray(status.mirrorProblems) ? status.mirrorProblems : [];
    if (!mirrors.length && !problems.length) return '镜像：未配置（预留入口，默认仍走 R2）';
    const names = mirrors.map((entry) => entry.name || entry.url).join('、');
    const suffix = problems.length ? `；${problems.length} 条配置无效` : '';
    return `镜像（预留，不自动使用）：${names}${suffix}`;
  }

  function ensureAssetPanel() {
    if (assetPanel || !globalThis.document || !document.body) return assetPanel;
    const panel = document.createElement('section');
    panel.id = 'sp-native-assets';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;min-width:300px;max-width:420px;padding:14px;border-radius:10px;background:#0c0f0ef2;color:#edf2ee;font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px #0008';
    panel.innerHTML = '<div style="display:flex;gap:8px;align-items:center"><strong style="flex:1">运行素材</strong><button type="button" data-sp-act="close" style="background:none;border:0;color:#9fb3a8;font-size:16px;cursor:pointer">×</button></div><p data-sp-line style="margin:8px 0;color:#cfe0d5"></p><div style="height:6px;background:#24302a;border-radius:3px;overflow:hidden"><div data-sp-bar style="height:100%;width:0;background:#6fd08c;transition:width .2s"></div></div><p data-sp-mirrors style="margin:8px 0 0;color:#9fb3a8;font-size:12px"></p><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button type="button" data-sp-act="prepare">准备</button><button type="button" data-sp-act="start">开始下载</button><button type="button" data-sp-act="cancel">取消</button><button type="button" data-sp-act="retry">重试</button><button type="button" data-sp-act="import">导入素材包…</button><button type="button" data-sp-act="reload" style="display:none">重新加载</button></div>';
    panel.addEventListener('click', (ev) => {
      const action = ev.target?.dataset?.spAct;
      if (!action) return;
      if (action === 'close') { panel.remove(); assetPanel = null; return; }
      if (action === 'import') { importAssetPackage(); return; }
      if (action === 'reload') { globalThis.location?.reload(); return; }
      callAndroidAsset(action);
    });
    document.body.append(panel);
    assetPanel = panel;
    return panel;
  }

  function renderAsset(status) {
    if (!status || typeof status !== 'object') return;
    assetLast = status;
    const panel = ensureAssetPanel();
    if (!panel) return;
    panel.querySelector('[data-sp-line]').textContent = assetStateLabel(status);
    panel.querySelector('[data-sp-bar]').style.width = `${Math.round(assetProgress(status) * 100)}%`;
    const mirrors = panel.querySelector('[data-sp-mirrors]');
    if (mirrors) mirrors.textContent = mirrorLine(status);
    const buttons = assetButtons(status);
    const enabledByAction = {
      prepare: buttons.canPrepare,
      start: buttons.canStart,
      cancel: buttons.canCancel,
      retry: buttons.canRetry,
      import: buttons.canImport,
      reload: buttons.canReload,
    };
    for (const [action, enabled] of Object.entries(enabledByAction)) {
      const button = panel.querySelector(`[data-sp-act="${action}"]`);
      if (!button) continue;
      button.disabled = !enabled;
      if (action === 'reload') {
        button.style.display = enabled ? '' : 'none';
      } else if (action === 'import') {
        button.style.display = '';
      } else {
        // Windows updates automatically after `welcome`; only Android has explicit transfer actions.
        button.style.display = hasTauri ? 'none' : '';
      }
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
  if (hasTauri || (hasAndroid && androidAssets && typeof androidAssets.status === 'function')) {
    if (hasAndroid && androidAssets) globalThis.__strongholdAssetUpdate = receiveAssetStatus;
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.textContent = '素材';
    launch.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;padding:8px 12px;border-radius:8px;border:1px solid #3d5447;background:#18211c;color:#dce9e0;font:13px system-ui,sans-serif;cursor:pointer';
    launch.addEventListener('click', () => {
      const panel = ensureAssetPanel();
      if (panel) panel.style.display = '';
      if (hasTauri) {
        void tauri.core.invoke('sp_asset_status')
          .then((status) => receiveAssetStatus(status))
          .catch(() => { /* status is diagnostic only */ });
        return;
      }
      let current = null;
      try { current = androidAssets.status(); } catch { current = null; }
      if (current) receiveAssetStatus(current);
    });
    const mountLaunch = () => document.body?.append(launch);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLaunch, { once: true });
    else mountLaunch();
  }

  // Only the native page replaces its socket constructor.  The retained original is useful to
  // diagnostics and makes accidental double injection observable without changing browser code.
  TcpWebSocket.nativeWebSocket = NativeWebSocket;
  globalThis.WebSocket = TcpWebSocket;
})();
