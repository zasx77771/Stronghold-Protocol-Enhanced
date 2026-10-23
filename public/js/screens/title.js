// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始, the language menu
// (中文 | English | every pack in public/i18n/, ui/lang.js; a title in an alphabetic script — English — is the big one and
// the small wordmark above it hides).
//
// Pressing 开始 validates the nickname (1..NAME_MAX_UNITS display columns — 16 Latin or 8 Hanzi,
// shared/nameWidth.js — no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.
//
// The full art, under the login box: 下载完整素材 (ui/assetDownload.js — its dialog downloads from this server) and
// 导入素材包 (ui/assetImport.js — the player's own folder or zip, no server download) side by side, so an import never
// opens the download (docs/history/0.3.0.md §32.14.39).
//
// Plugins (DESIGN §32 P1a, the design study's §7.4): when the server has unofficial plugins (content.plugins of /healthz or
// welcome — content.js installedCount), the footer says 「本服务器安装了 N 个插件」 — a button that loads the list
// (ui/pluginPanel.js InstalledPlugins, which fetches the catalogue when it opens); nothing on a server without any, which
// the page never asks for its catalogue — and the title page loads none of the panel's code.

import { ResumeMatchButton } from '../ui/resumeMatch.js';
import { AssetDownloadButton } from '../ui/assetDownload.js';
import { AssetImportButton } from '../ui/assetImport.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, NAME_MAX_UNITS, APP_VERSION, DEV_BUILD } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { toast } from '../ui/toasts.js';
import { readText } from '../ui/clipboard.js';
import { net, identity } from '../net.js';
import { readSettings, parseAddress, saveSettings, inviteCode, inviteAddress, transportForAddress } from '../connection.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, PwaInstallButton, detectFeatures } from '../ui/device.js';
import { LangToggle, useLang } from '../ui/lang.js';
import { t, N_ } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { GIcon } from '../ui/gameComponents.js';
import { SettingsModal } from '../ui/settings.js';
import { installedCount } from '../content.js';
import { NoticesButton } from '../ui/notices.js';
import { sanitizeName, isValidName } from '../ui/playerName.js';

export { stripLoneSurrogates, sanitizeName, isValidName } from '../ui/playerName.js';

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
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
  idle: N_('准备连接'), connecting: N_('正在连接服务器'), connected: N_('已连接服务器'), handshaking: N_('正在验证身份'),
  online: N_('已连接服务器'), reconnecting: N_('连接中断，正在重连'), closed: N_('连接已关闭'),
};

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  useLang(); // re-render on a language switch
  // The title is a fixed entry surface: mark <html> so title.css can stop the global pan-x (no :has()).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('title-open');
    return () => root.classList.remove('title-open');
  }, []);
  const currentName = useStore((s) => s.me.name);
  const [name, setName] = useState(() => currentName || identity.loadName() || '');
  // An import may restore the current name while this screen remains behind the stats overlay.
  useEffect(() => {
    if (currentName) setName((draft) => draft || currentName);
  }, [currentName]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Server address and transport for this machine (connection.js): a browser page is always
  // WebSocket; a native shell can pick TCP in the switch above the field. A pasted invite may
  // carry its own transport (`tcp://host:port`), which wins over the switch.
  const [connection] = useState(() => readSettings());
  const [transport, setTransport] = useState(connection.transport);
  const [address, setAddress] = useState(connection.address);
  const nameRef = useRef(null);
  // the list of the server's plugins once loaded (ui/pluginPanel.js — a component in state: set through an updater)
  const [Installed, setInstalled] = useState(null);
  const openPlugins = () => {
    import('../ui/pluginPanel.js').then((m) => setInstalled(() => m.InstalledPlugins), (err) => console.warn('[plugins] the list did not load', err));
  };
  const installed = useStore(installedCount);
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

  const valid = isValidName(name);
  const start = () => {
    if (!valid) { toast(t('请输入博士代号'), 'warn'); return; }
    enterSession(name);
  };

  // Apply the address typed above. The native bridge keeps one socket facade installed and picks the transport
  // from the URL it is handed (`tcp://…` or `ws(s)://…`), so switching reconnects in place instead of reloading
  // the shell.
  const applyConnection = () => {
    const code = inviteCode(address);
    const linkedAddress = code ? inviteAddress(address) : null;
    // A bare key (or a `room: KEY` paste) belongs to the currently configured server. A full
    // invite URL additionally supplies the WebSocket/TCP address; its room query never reaches
    // the socket endpoint.
    if (code && !linkedAddress) { applyInvite(code); return; }
    const requestedAddress = linkedAddress || address;
    // The switch decides unless the pasted invite names its own transport.
    const chosen = connection.supportsTcp ? transport : 'websocket';
    const effective = linkedAddress ? transportForAddress(linkedAddress, chosen) : chosen;
    const parsed = parseAddress(requestedAddress, { transport: effective });
    if (!parsed.ok) {
      const message = parsed.error === 'invalid_endpoint'
        ? t('请输入 主机:端口，例如 192.168.1.10:3001')
        : parsed.error === 'tls_unsupported' ? t('TCP 直连没有 TLS，请改用 http:// 地址')
          : parsed.error === 'invalid_scheme'
            ? (effective === 'tcp' ? t('TCP 直连只接受 主机:端口 或 http:// 地址') : t('服务器地址必须以 ws:// 或 wss:// 开头'))
            : t('服务器地址格式无效');
      toast(message, 'warn');
      return;
    }
    saveSettings({ transport: parsed.transport, address: parsed.address });
    if (linkedAddress) setAddress(parsed.address);
    if (parsed.socketUrl) net.setUrl(parsed.socketUrl);
    net.close();
    net.connect();
    toast(t('已应用服务器地址'));
    if (code) applyInvite(code);
  };

  // A pasted invite (link, `room: CODE` or bare code) sets the deep-link state main.js auto-joins;
  // without a callsign the title asks for one first instead of navigating.
  const applyInvite = (text) => {
    const code = inviteCode(text);
    if (!code) { toast(t('未识别到同盟密钥'), 'warn'); return; }
    store.patch('ui', { pendingJoin: code });
    if (!valid) {
      toast(t('请先输入博士代号，随后自动加入同盟'), 'warn');
      nameRef.current?.focus();
      return;
    }
    if (!store.get().session.entered) enterSession(name);
  };

  // 读取剪贴板：把系统剪贴板里的服务器地址 / 邀请链接直接填进上面的地址框。只填不放行——「应用」仍由玩家点，
  // 读取本身不改连接。Windows 外壳与安卓壳读原生剪贴板；浏览器在明文 http（非安全上下文）没有 Clipboard API，
  // readText() 回 unsupported，这时提示手动粘贴。
  const fillFromClipboard = async () => {
    const clip = await readText();
    if (!clip.ok) {
      toast(clip.reason === 'empty' ? t('剪贴板里没有地址或邀请链接') : t('无法读取剪贴板，请手动粘贴'), 'warn');
      return;
    }
    setAddress(clip.text.trim());
    toast(t('已从剪贴板填入服务器地址'));
  };

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';
  // A native shell dials only the saved address (no built-in default), so an empty field means
  // nothing is attempted yet — say that instead of reporting a connection failure.
  const needsAddress = connection.supportsTcp && !String(address || '').trim();
  const statusText = needsAddress ? t('请先填写服务器地址')
    : STATUS_TEXT[conn.status] ? t(STATUS_TEXT[conn.status]) : conn.status;

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  // a title in an alphabetic script (English, French …) is the big one in the display face and the wordmark above it
  // hides; a CJK / kana / Hangul title keeps the Chinese layout (shared/i18nPacks.js scriptOf — a pack needs no flag)
  const alphabetic = scriptOf(t('卫戍协议')) === 'alphabetic';
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
      <div>
        <div class="title-corner__tools">
          <${Button} variant="ghost" size="sm" icon="chart" class="title-stats" onClick=${openStats} title=${t('统计数据')}>${t('统计')}<//>
          <${LangToggle} class="title-lang" />
        </div>
        <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
      </div>
    </div>

    <main class="title-main">
      <div class="title-hero">
        <${Emblem} />
        ${alphabetic ? null : html`<div class="title-en">
          <span class="title-en__a">STRONGHOLD PROTOCOL</span>
          <span class="title-en__b">ALLIANCE</span>
        </div>`}
        <h1 class=${`title-cn${alphabetic ? ' title-cn--latin' : ''}`}>${t('卫戍协议')}<span class="title-cn__colon">${alphabetic ? ': ' : '：'}</span><em>${t('盟约')}</em></h1>
        <p class="title-tag">${t('调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。')}</p>
      </div>

      <div class="title-side">
        <div class="title-login">
          <div class="title-connect">
            ${connection.supportsTcp ? html`<div class="title-connect__modes" role="group" aria-label=${t('连接方式')}>
              <button type="button" class=${`title-connect__mode${transport === 'websocket' ? ' is-on' : ''}`}
                aria-pressed=${transport === 'websocket'} onClick=${() => setTransport('websocket')}>WebSocket</button>
              <button type="button" class=${`title-connect__mode${transport === 'tcp' ? ' is-on' : ''}`}
                aria-pressed=${transport === 'tcp'} onClick=${() => setTransport('tcp')}>TCP</button>
            </div>` : null}
            <div class="title-connect__endpoint">
              <${TextField} class="title-connect__address" label=${t('服务器地址')} micro="SERVER" icon="globe" size="lg" value=${address}
                placeholder=${transport === 'tcp' ? '192.168.1.10:3001' : '192.168.1.10:3000'}
                onInput=${setAddress} onEnter=${applyConnection}
                trailing=${html`<${Button} variant="ghost" size="sm" square icon="paste" class="title-connect__read"
                  title=${t('读取剪贴板')} aria-label=${t('读取剪贴板')} onClick=${fillFromClipboard} />`} />
              <${Button} variant="ghost" size="sm" onClick=${applyConnection}>${t('应用')}<//>
            </div>
          </div>
          ${pendingJoin ? html`<div class="title-invite">
            <${Icon} name="key" />
            <span>${t('收到同盟邀请')}</span><b class="num">${pendingJoin}</b><span class="t-lo">${t('· 输入代号后将自动加入')}</span>
          </div>` : null}
          <${TextField} label=${t('博士代号')} micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
            placeholder=${t('输入你的代号（最多 {NAME_MAX_UNITS} 个字符，汉字算 2 个）', { NAME_MAX_UNITS })} autoFocus=${!touchUi}
            inputRef=${nameRef} onInput=${setName} onEnter=${start} />
          <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" disabled=${!valid} onClick=${start}>${t('开始')}<//>
          <div class="title-conn">
            <span class=${`status-dot ${dotClass}`}></span>
            <span>${statusText}</span>
            ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
            <${GuideButton} class="title-guide" label=${t('玩法说明')} />
            <button type="button" class="title-settings fsbtn tapx" aria-label=${t('设置')} title=${t('设置')}
              onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>
            <${FullscreenButton} class="title-fs" />
          </div>
        </div>
        <div class="title-assets">
          <${AssetDownloadButton} />
          <${AssetImportButton} />
        </div>
      </div>
    </main>

    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />
    ${Installed ? html`<${Installed} open=${true} onClose=${() => setInstalled(null)} />` : null}

    <footer class="title-foot">
      <${ResumeMatchButton} />
      <${PwaInstallButton} />
      <${NoticesButton} />
      ${installed ? html`<button type="button" class="title-plugins" data-testid="title-plugins" onClick=${openPlugins}>
        <${Icon} name="info" />${t('本服务器安装了 {n} 个插件', { n: installed })}</button>` : null}
      <span>${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}</span>
      <span class="title-foot__meta">
        <a class="title-repo" href="https://github.com/sganggs/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">${t('项目仓库')}</a>
        <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
        ${DEV_BUILD ? html`<span class="title-dev" role="note">${t('开发版 · 不稳定，请勿用于公开服务器')}</span>` : null}
      </span>
    </footer>
  </div>`;
}
