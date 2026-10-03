// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始.
//
// Pressing 开始 validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.

import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { toast } from '../ui/toasts.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, detectFeatures } from '../ui/device.js';
import { isTcpTransportAvailable } from '../tcpSocket.js';
import {
  CLIPBOARD_PERMISSION_DENIED, ROOM_CODE_MAX_LEN, TRANSPORT_TCP, TRANSPORT_WEBSOCKET,
  loadEndpointAddress, loadTransportMode, normalizeRoomCode, parseInviteText, readClipboardText,
  saveEndpointAddress, saveTransportMode,
} from '../serverAddress.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @param {boolean} rememberName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName, rememberName = true) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.setRememberName(rememberName);
  if (rememberName) identity.saveName(name);
  else identity.clearName();
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: '等待连接', connecting: '正在连接服务器', connected: '已连接服务器', handshaking: '正在验证身份',
  online: '已连接服务器', reconnecting: '连接中断，正在重连', closed: '连接已关闭',
};

/** Wait for the current handshake to finish while the title screen stays editable. */
export function waitForOnline(connection = net, timeoutMs = 12000) {
  if (connection.status === 'online') return Promise.resolve(connection.snapshot?.() || null);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      offStatus?.();
      offHello?.();
      fn(value);
    };
    const offStatus = connection.on('status', (snap) => {
      if (snap.status === 'online') finish(resolve, snap);
      else if (snap.status === 'closed') finish(reject, new Error(snap.lastError?.text || '连接已关闭'));
    });
    const offHello = connection.on('helloError', (err) => finish(reject, err));
    const timer = setTimeout(() => finish(reject, new Error('连接服务器超时，请检查地址和网络')), timeoutMs);
  });
}

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  const [rememberName, setRememberName] = useState(() => identity.loadRememberName());
  const [name, setName] = useState(() => store.get().me.name || (identity.loadRememberName() ? identity.loadName() : '') || '');
  const [transport, setTransport] = useState(() => loadTransportMode());
  const [server, setServer] = useState(() => loadEndpointAddress(loadTransportMode()));
  const [roomCode, setRoomCode] = useState(() => pendingJoin || '');
  const [pastedInvite, setPastedInvite] = useState(null);
  const [serverError, setServerError] = useState('');
  const [starting, setStarting] = useState(false);
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);
  const tcpAvailable = useMemo(() => isTcpTransportAvailable(), []);

  const valid = isValidName(name);
  const start = async (serverOverride = null, codeOverride = null, transportOverride = null) => {
    if (starting) return;
    if (!valid) { toast('请输入博士代号', 'warn'); return; }
    const chosenTransport = transportOverride === TRANSPORT_TCP ? TRANSPORT_TCP : transportOverride === TRANSPORT_WEBSOCKET ? TRANSPORT_WEBSOCKET : transport;
    if (chosenTransport === TRANSPORT_TCP && !tcpAvailable) {
      toast('当前环境不支持 TCP 直连，请使用 Windows/Android 客户端或改用 WebSocket', 'warn', { ttl: 7000 });
      return;
    }
    const chosenServer = typeof serverOverride === 'string' ? serverOverride : server;
    const rawCode = typeof codeOverride === 'string' ? codeOverride : roomCode;
    const code = rawCode.trim() ? normalizeRoomCode(rawCode) : '';
    if (rawCode.trim() && !code) { toast('房间 Code 应为 4–6 位字母或数字', 'warn'); return; }
    let endpoint;
    try {
      const previousTransport = loadTransportMode();
      const previous = saveEndpointAddress(loadEndpointAddress(previousTransport), previousTransport);
      endpoint = saveEndpointAddress(chosenServer, chosenTransport);
      // A reconnect token is meaningful only to the server that issued it.  Never present one
      // server's token to another when the user changes the address.
      if (previous.serverKey !== endpoint.serverKey) identity.clearToken();
      setTransport(chosenTransport);
      setServer(endpoint.address);
      setServerError('');
    } catch (err) {
      const msg = err?.message || '服务器地址格式不正确';
      setServerError(msg);
      toast(msg, 'warn');
      return;
    }
    setRoomCode(code);
    store.patch('ui', { pendingJoin: code || null });
    setStarting(true);
    try {
      net.setUrl(endpoint.socketUrl);
      // Register the waiter before setName(): injectable/fake sockets used by tests may answer synchronously.
      const ready = waitForOnline(net);
      net.setName(sanitizeName(name));
      await ready;
      enterSession(name, rememberName);
    } catch (err) {
      net.close();
      toast(err?.message || '无法连接服务器', 'error', { ttl: 6000 });
    } finally {
      setStarting(false);
    }
  };

  const applyClipboardInvite = async ({ auto = false, quiet = false } = {}) => {
    if (starting) return null;
    let text;
    try { text = await readClipboardText(); }
    catch (err) {
      // Permission denials must never disappear silently: the startup auto-read is otherwise quiet,
      // but the user still needs to know why clipboard invitations cannot be detected.
      if (!quiet || err?.code === CLIPBOARD_PERMISSION_DENIED) {
        toast(err?.message || '无法读取剪贴板，请检查权限', 'warn', { ttl: 9000 });
      }
      return null;
    }
    const invite = parseInviteText(text, server || loadEndpointAddress(transport), transport);
    if (!invite) {
      if (!quiet) toast('剪贴板中没有可识别的服务器地址或房间 Code', 'warn');
      return null;
    }
    if (invite.address) {
      const inviteTransport = invite.transport === TRANSPORT_TCP ? TRANSPORT_TCP : TRANSPORT_WEBSOCKET;
      if (inviteTransport === TRANSPORT_TCP && !tcpAvailable) {
        if (!quiet) toast('该邀请需要 TCP 直连，请使用 Windows/Android 客户端', 'warn', { ttl: 7000 });
        return null;
      }
      setTransport(inviteTransport);
      setServer(invite.address);
      setServerError('');
    }
    if (invite.code) {
      setRoomCode(invite.code);
      store.patch('ui', { pendingJoin: invite.code });
    }
    const pastedLink = /(?:https?|wss?|tcp):\/\//i.test(String(text).trim());
    if (pastedLink && invite.completeInvite && invite.address && invite.code) {
      setPastedInvite({
        address: invite.address,
        code: invite.code,
        transport: invite.transport === TRANSPORT_TCP ? TRANSPORT_TCP : TRANSPORT_WEBSOCKET,
      });
    }
    if (!quiet) toast(invite.code ? `已识别同盟邀请 ${invite.code}` : '已填入服务器地址', 'success');
    if (auto && invite.completeInvite && valid && invite.address) {
      await start(invite.address, invite.code, invite.transport === TRANSPORT_TCP ? TRANSPORT_TCP : TRANSPORT_WEBSOCKET);
    }
    return invite;
  };

  const changeTransport = (next) => {
    if (starting || next === transport) return;
    if (next === TRANSPORT_TCP && !tcpAvailable) {
      toast('浏览器不能直接使用 TCP，请安装 Windows/Android 客户端', 'warn');
      return;
    }
    const selected = saveTransportMode(next);
    setPastedInvite(null);
    setTransport(selected);
    setServer(loadEndpointAddress(selected));
    setServerError('');
  };

  const updateName = (value) => {
    setName(value);
    if (!rememberName) return;
    const clean = sanitizeName(value);
    if (clean) identity.saveName(clean);
    else identity.clearName();
  };

  const updateRememberName = (on) => {
    setRememberName(on);
    identity.setRememberName(on);
    if (on) {
      const clean = sanitizeName(name);
      if (clean) identity.saveName(clean);
    }
  };

  // Read once when the standalone client opens. An empty/unrecognised clipboard stays quiet, but a
  // permission denial is surfaced so the user knows to grant access or enter the values manually.
  useEffect(() => {
    if (!pendingJoin) applyClipboardInvite({ auto: true, quiet: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${`background-image:url("${ridges}")`}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
    </div>

    <main class="title-main">
      <${Emblem} />
      <div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>
      <h1 class="title-cn">卫戍协议<span class="title-cn__colon">：</span><em>盟约</em></h1>
      <p class="title-tag">调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。</p>

      <div class="title-login">
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>${pastedInvite ? '已识别同盟邀请' : '收到同盟邀请'}</span><b class="num">${pendingJoin}</b><span class="t-lo">· 输入代号后将自动加入</span>
          ${pastedInvite ? html`<button type="button" class="title-invite__reset" disabled=${starting}
            onClick=${() => setPastedInvite(null)}>重新填写</button>` : null}
        </div>` : null}
        ${!pastedInvite ? html`<div class="title-transport" role="group" aria-label="连接协议">
          <button type="button" class=${transport === TRANSPORT_WEBSOCKET ? 'is-active' : ''} disabled=${starting}
            onClick=${() => changeTransport(TRANSPORT_WEBSOCKET)}>WebSocket <small>HTTP</small></button>
          <button type="button" class=${transport === TRANSPORT_TCP ? 'is-active' : ''} disabled=${starting || !tcpAvailable}
            title=${tcpAvailable ? '原生 TCP 直连' : '仅 Windows/Android 客户端可用'}
            onClick=${() => changeTransport(TRANSPORT_TCP)}>TCP <small>直连</small></button>
        </div>
        <${TextField} label=${transport === TRANSPORT_TCP ? 'TCP 服务器地址' : '服务器地址'} micro="SERVER" size="lg" icon="link" value=${server} maxLength=${256}
          placeholder=${transport === TRANSPORT_TCP ? '例如 192.168.1.10:3001' : '例如 192.168.1.10:3000'} disabled=${starting} invalid=${!!serverError} hint=${serverError || null}
          onInput=${(v) => { setPastedInvite(null); setServer(v); if (serverError) setServerError(''); }} onEnter=${() => start()} />` : null}
        <${TextField} label="博士代号" micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
          placeholder="输入你的代号（最多 ${NAME_MAX_LEN} 字）" autoFocus=${!touchUi} disabled=${starting}
          onInput=${updateName} onEnter=${() => start()} />
        <button type="button" class=${`title-remember${rememberName ? ' is-on' : ''}`} role="switch"
          aria-checked=${rememberName ? 'true' : 'false'} disabled=${starting}
          onClick=${() => updateRememberName(!rememberName)}>
          <i aria-hidden="true">${rememberName ? '✓' : ''}</i><span>记住博士代号</span><small>保存在此设备</small>
        </button>
        ${!pastedInvite ? html`<div class="title-code-row">
          <${TextField} label="房间 Code（可选）" micro="ROOM" size="code" icon="key" value=${roomCode}
            maxLength=${ROOM_CODE_MAX_LEN} placeholder="留空进入大厅" disabled=${starting}
            transform=${(v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_MAX_LEN)}
            onInput=${(v) => { setPastedInvite(null); setRoomCode(v); store.patch('ui', { pendingJoin: normalizeRoomCode(v) || null }); }}
            onEnter=${() => start()} />
          <${Button} variant="secondary" size="lg" icon="copy" class="title-paste" disabled=${starting}
            onClick=${() => applyClipboardInvite({ auto: true })}>粘贴邀请<//>
        </div>` : null}
        <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${starting}
          disabled=${!valid || !server.trim()} onClick=${() => start()}>${starting ? '正在连接' : roomCode ? '连接并加入' : '连接服务器'}<//>
        <div class="title-conn">
          <span class=${`status-dot ${dotClass}`}></span>
          <span>${STATUS_TEXT[conn.status] || conn.status}</span>
          ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          <${GuideButton} class="title-guide" />
          <${FullscreenButton} class="title-fs" />
        </div>
      </div>
    </main>

    <footer class="title-foot">
      <span>非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有</span>
      <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
    </footer>
  </div>`;
}
