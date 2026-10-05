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
import { html, Button, Icon, MicroLabel, Modal, TextField, PingPill } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { toast } from '../ui/toasts.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, detectFeatures } from '../ui/device.js';
import { GIcon, isPackagedAndroid } from '../ui/gameComponents.js';
import { SettingsModal } from '../ui/settings.js';
import { isTcpTransportAvailable } from '../tcpSocket.js';
import {
  CLIPBOARD_PERMISSION_DENIED, TRANSPORT_TCP, TRANSPORT_WEBSOCKET,
  isDesktopClient, loadEndpointAddress, loadTransportMode, normalizeRoomCode, parseInviteText, readClipboardText,
  saveEndpointAddress, saveTransportMode,
} from '../serverAddress.js';
import { loadReplayAddress, requestReplay, saveReplayAddress } from '../replayClient.js';

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

/** Split the optional fixed `#1234` suffix without counting it against the nickname limit. */
export function parseDoctorIdentity(raw) {
  const value = String(raw ?? '').trim();
  const match = /^(.*)#(\d{4})$/.exec(value);
  return { name: sanitizeName(match ? match[1] : value), tag: match ? match[2] : null };
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => parseDoctorIdentity(raw).name.length > 0;

// TitleScreen may be unmounted when the player enters the lobby and mounted again after signing out.
// Keep this gate at module scope so automatic clipboard access happens at most once per page/app run.
let startupClipboardProbeClaimed = false;
export function claimStartupClipboardProbe() {
  if (startupClipboardProbeClaimed) return false;
  startupClipboardProbeClaimed = true;
  return true;
}
export function skipStartupClipboardProbe() { startupClipboardProbeClaimed = true; }

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @param {boolean} rememberName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName, rememberName = true) {
  const { name, tag } = parseDoctorIdentity(rawName);
  if (!name) return false;
  identity.setRememberName(rememberName);
  if (rememberName) identity.saveName(name);
  else identity.clearName();
  if (tag) identity.saveProfileTag(tag);
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name, tag: tag || s.me.tag || null }, session: { ...s.session, entered: true } }));
  net.setIdentity(name, tag || identity.loadProfileTag());
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

function ConnectionStatus({ conn, dotClass, compact = false }) {
  return html`<div class=${`title-conn${compact ? ' title-conn--compact' : ''}`}>
    <span class=${`status-dot ${dotClass}`}></span>
    <span class="title-conn__label">${STATUS_TEXT[conn.status] || conn.status}</span>
    ${!compact && conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
  </div>`;
}

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

const replayTime = (value) => {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间未知';
};

function ReplayLibrary({ open, onClose, serverAddress }) {
  const [address, setAddress] = useState(() => loadReplayAddress(serverAddress));
  const [records, setRecords] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAddress(loadReplayAddress(serverAddress));
    setRecords(null);
    setSelected(null);
    setError('');
  }, [open, serverAddress]);

  const list = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const endpoint = saveReplayAddress(address);
      setAddress(endpoint.address);
      const response = await requestReplay(endpoint.address, { t: 'replay.list' });
      if (response?.t !== 'replay.list' || !Array.isArray(response.matches)) throw new Error('回放服务未返回记录列表');
      setRecords(response.matches);
      setSelected(null);
    } catch (reason) {
      setError(reason?.message || '无法读取对局记录');
    } finally { setBusy(false); }
  };

  const detail = async (id) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const endpoint = saveReplayAddress(address);
      setAddress(endpoint.address);
      // The library displays metadata, not a battle player. Do not download a complete
      // action timeline in one TCP response.
      const response = await requestReplay(endpoint.address, { t: 'replay.get', id, includeTimeline: false });
      if (response?.t !== 'replay.get' || !response.match) throw new Error(response?.code === 'NOT_FOUND' ? '该记录已不存在' : '无法读取对局详情');
      setSelected(response.match);
    } catch (reason) {
      setError(reason?.message || '无法读取对局详情');
    } finally { setBusy(false); }
  };

  const result = selected?.result || {};
  const timeline = selected?.replay?.timeline;
  return html`<${Modal} open=${open} onClose=${onClose} title="对局记录" micro="NATIVE TCP REPLAY // PORT 3002" width="8.2rem"
    actions=${html`<${Button} variant="secondary" onClick=${onClose}>关闭<//>`}>
    <div class="replay-library">
      <${TextField} label="回放 TCP 地址" micro="REPLAY ENDPOINT" size="lg" icon="link" value=${address} maxLength=${256}
        placeholder="例如 192.168.1.10:3002" disabled=${busy} onInput=${setAddress} onEnter=${list} />
      <div class="replay-library__tools">
        <${Button} variant="primary" icon="refresh" loading=${busy} onClick=${list}>读取记录<//>
        <span>仅 Windows 原生客户端可访问此 TCP 端口</span>
      </div>
      ${error ? html`<p class="replay-library__error"><${Icon} name="warn" />${error}</p>` : null}
      ${selected ? html`<section class="replay-detail">
        <header><div><${MicroLabel} tone="mint">MATCH DETAIL<//><h3>${result.victory === true ? '作战胜利' : result.victory === false ? '作战结束' : '对局详情'}</h3></div>
          <${Button} variant="secondary" size="sm" onClick=${() => setSelected(null)}>返回列表<//></header>
        <dl>
          <div><dt>开始时间</dt><dd>${replayTime(selected.startedAt)}</dd></div>
          <div><dt>模式 / 难度</dt><dd>${selected.mode || '--'} / ${selected.difficulty || '--'}</dd></div>
          <div><dt>关卡 / 种子</dt><dd>${selected.stageId || '--'} / <span class="num">${selected.seed ?? '--'}</span></dd></div>
          <div><dt>完成层数</dt><dd>${result.roundsPassed ?? selected.summary?.roundsPassed ?? '--'}</dd></div>
          <div><dt>记录操作</dt><dd>${Array.isArray(timeline) ? timeline.length : '--'} 条</dd></div>
        </dl>
        <div class="replay-detail__players"><${MicroLabel}>PLAYERS<//>${(selected.players || []).map((player) => html`<span key=${player.playerId}>${player.name}${player.tag ? ` #${player.tag}` : ''}${player.isBot ? ' · AI' : ''}</span>`)}</div>
        <p class="replay-detail__note">该记录已包含本局种子、参与者、结算数据和操作时间线；战场画面回放将在后续客户端版本接入。</p>
      </section>` : html`<div class="replay-library__list">
        ${records == null ? html`<p class="t-lo">输入服务器地址后读取已保存的对局记录。</p>` : records.length === 0 ? html`<p class="t-lo">该服务器尚无已完成的对局记录。</p>` : records.map((record) => html`<button type="button" class="replay-row" key=${record.id} disabled=${busy} onClick=${() => detail(record.id)}>
          <span class="replay-row__result">${record.result?.victory === true ? '胜利' : record.result?.victory === false ? '结束' : '记录中'}</span>
          <span class="replay-row__main"><b>${record.players?.join(' · ') || '未知参与者'}</b><small>${replayTime(record.startedAt)} · ${record.mode || '--'} · ${record.difficulty || '--'}</small></span>
          <span class="replay-row__round">${record.summary?.roundsPassed ?? record.result?.roundsPassed ?? '--'} 层</span>
          <${Icon} name="chevronRight" />
        </button>`)}</div>`}
    </div>
  <//>`;
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
  const [profileChoices, setProfileChoices] = useState([]);
  const [replayOpen, setReplayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const desktopClient = useMemo(() => isDesktopClient(), []);
  const androidClient = useMemo(() => isPackagedAndroid(), []);

  const callsign = parseDoctorIdentity(name);
  const valid = callsign.name.length > 0;
  const start = async (serverOverride = null, codeOverride = null, transportOverride = null, tagOverride = null, createNew = false) => {
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
      const previousKey = loadEndpointAddress(previousTransport).toLowerCase();
      endpoint = saveEndpointAddress(chosenServer, chosenTransport);
      // A reconnect token is meaningful only to the server that issued it.  Never present one
      // server's token to another when the user changes the address.
      if (previousKey !== endpoint.serverKey) identity.clearToken();
      setTransport(chosenTransport);
      setServer(endpoint.address);
      setServerError('');
    } catch (err) {
      const msg = err?.message || '服务器地址格式不正确';
      setServerError(msg);
      toast(msg, 'warn');
      return;
    }
    const requestedTag = typeof tagOverride === 'string' ? tagOverride : callsign.tag;
    // A local HTTP server can list same-name records before creating a new profile. TCP clients
    // retain the direct `昵称#编号` route; their saved reconnect token still restores automatically.
    if (!requestedTag && !createNew && chosenTransport === TRANSPORT_WEBSOCKET) {
      try {
        const response = await fetch(`${endpoint.address}/api/profiles?name=${encodeURIComponent(callsign.name)}`);
        const payload = response.ok ? await response.json() : null;
        const choices = Array.isArray(payload?.profiles) ? payload.profiles.filter((p) => /^\d{4}$/.test(p?.tag)) : [];
        if (choices.length) { setProfileChoices(choices); return; }
      } catch { /* An older/remote server simply creates a new local profile. */ }
    }
    setRoomCode(code);
    store.patch('ui', { pendingJoin: code || null });
    setStarting(true);
    try {
      net.setUrl(endpoint.socketUrl);
      // Register the waiter before setName(): injectable/fake sockets used by tests may answer synchronously.
      const ready = waitForOnline(net);
      net.setIdentity(callsign.name, requestedTag);
      await ready;
      enterSession(requestedTag ? `${callsign.name}#${requestedTag}` : callsign.name, rememberName);
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
    setProfileChoices([]);
    if (!rememberName) return;
    const clean = parseDoctorIdentity(value).name;
    if (clean) identity.saveName(clean);
    else identity.clearName();
  };

  const updateRememberName = (on) => {
    setRememberName(on);
    identity.setRememberName(on);
    if (on) {
      const clean = parseDoctorIdentity(name).name;
      if (clean) identity.saveName(clean);
    }
  };

  // Read only on the initial title entry in this page/app run. Returning from the lobby/game must
  // not access the clipboard again; the explicit “粘贴邀请链接” button remains available.
  useEffect(() => {
    if (claimStartupClipboardProbe() && !pendingJoin) applyClipboardInvite({ auto: true, quiet: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  return html`<div class=${`screen title-screen${androidClient ? ' title-screen--android' : ''}`}>
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
      <section class="title-hero">
        <${Emblem} />
        <div class="title-en">
          <span class="title-en__a">STRONGHOLD PROTOCOL</span>
          <span class="title-en__b">ALLIANCE</span>
        </div>
        <h1 class="title-cn">卫戍协议<span class="title-cn__colon">：</span><em>盟约</em></h1>
        <p class="title-tag">调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。</p>
      </section>

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
        </div>` : null}
        ${!pastedInvite ? html`<div class="title-server-row">
          <${TextField} label=${transport === TRANSPORT_TCP ? 'TCP 服务器地址' : '服务器地址'} micro="SERVER" size="lg" icon="link" value=${server} maxLength=${256}
            placeholder=${transport === TRANSPORT_TCP ? '例如 192.168.1.10:3001' : '例如 192.168.1.10:3000'} disabled=${starting} invalid=${!!serverError} hint=${serverError || null}
            labelEnd=${transport === TRANSPORT_TCP ? html`<${ConnectionStatus} conn=${conn} dotClass=${dotClass} compact=${true} />` : null}
            onInput=${(v) => { setPastedInvite(null); setServer(v); if (serverError) setServerError(''); }} onEnter=${() => start()} />
        </div>` : null}
        <${TextField} label="博士代号" micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN + 5}
          placeholder="输入代号或 代号#编号（昵称最多 ${NAME_MAX_LEN} 字）" autoFocus=${!touchUi} disabled=${starting}
          onInput=${updateName} onEnter=${() => start()} />
        ${profileChoices.length ? html`<div class="title-invite">
          <${Icon} name="user" /><span>发现同名博士，请选择已有编号或继续新建</span>
          ${profileChoices.map((p) => html`<button type="button" class="title-invite__reset" disabled=${starting}
            onClick=${() => start(null, null, null, p.tag)}>#${p.tag}<//>`)}
          <button type="button" class="title-invite__reset" disabled=${starting} onClick=${() => start(null, null, null, null, true)}>创建新档案<//>
        </div>` : null}
        <button type="button" class=${`title-remember${rememberName ? ' is-on' : ''}`} role="switch"
          aria-checked=${rememberName ? 'true' : 'false'} disabled=${starting}
          onClick=${() => updateRememberName(!rememberName)}>
          <i aria-hidden="true">${rememberName ? '✓' : ''}</i><span>记住博士代号</span><small>保存在此设备</small>
        </button>
        ${!pastedInvite || desktopClient ? html`<div class=${`title-actions${!pastedInvite && desktopClient ? ' has-replay' : ''}`}>
          ${!pastedInvite ? html`<${Button} variant="secondary" size="lg" block=${true} icon="copy"
            class="title-paste" disabled=${starting}
            onClick=${() => applyClipboardInvite({ auto: true })}>粘贴邀请链接<//>` : null}
          ${desktopClient ? html`<${Button} variant="secondary" size="lg" block=${true} icon="book"
            class="title-replay" disabled=${starting} onClick=${() => setReplayOpen(true)}>对局记录<//>` : null}
        </div>` : null}
        <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${starting}
          disabled=${!valid || !server.trim()} onClick=${() => start()}>${starting ? '正在连接' : roomCode ? '连接并加入' : '连接服务器'}<//>
        <div class="title-bottom-tools">
          ${transport !== TRANSPORT_TCP ? html`<${ConnectionStatus} conn=${conn} dotClass=${dotClass} />` : null}
          <${GuideButton} class="title-guide" />
          <button type="button" class="title-settings fsbtn tapx" aria-label="设置" title="设置"
            onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>
          ${!androidClient ? html`<${FullscreenButton} class="title-fs" />` : null}
        </div>
      </div>
    </main>

    ${desktopClient ? html`<${ReplayLibrary} open=${replayOpen} onClose=${() => setReplayOpen(false)} serverAddress=${server} />` : null}
    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />

    <footer class="title-foot">
      <span>非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有</span>
      <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
    </footer>
  </div>`;
}
