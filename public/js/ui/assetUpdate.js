// The packaged Android client's 运行素材 entry (enhanced 2.6.4): a square download button in the lobby's
// tool row, immediately beside the guide/book button, and the dialog behind it.
//
// 2.6.3 checked the release index at every launch and started downloading as soon as a game-session token
// arrived — silent background traffic the player neither asked for nor could stop. Now:
//
//   1. the entry exists only where the native bridge does (the thin APK), so the browser, the desktop and
//      the Tauri client are untouched;
//   2. tapping it asks the native session to PREPARE (exchange the session token, read the release index,
//      compute the plan) — no package is transferred — and the dialog lists exactly what would come down;
//   3. the download starts only from 开始下载 after that positive confirmation, and 取消下载 stops it;
//   4. progress, verification/application, completion and failures with 重试下载 all come back from the
//      session through one read-only push channel.
//
// Secrets never cross this boundary: the session token and the exchanged asset token stay in
// AssetUpdateSession.java, and this file only ever calls status / prepare / start / retry / cancel.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Fragment, Modal, ProgressBar } from './components.js';
import { t } from '../../../shared/i18n.js';
import {
  ASSET_UPDATE_CHANNEL,
  assetUpdateBridge,
  describeAssetUpdate,
  formatBytes,
  parseAssetUpdateStatus,
} from './assetUpdateStatus.js';

/**
 * One line per phase: what is happening now, and what the player can do about it.
 * Exported for the phase/outcome assertions in test/asset-update.test.js.
 */
export function statusLine(info) {
  switch (info.phase) {
    case 'unavailable':
    case 'unconfigured':
      return t('这台设备没有可下载的运行素材配置。');
    case 'waiting':
      return t('登录后即可下载运行素材。');
    case 'preparing':
      return t('正在准备素材清单…');
    case 'ready':
      return t('确认后会开始下载；未确认前不会传输任何数据。');
    case 'downloading':
      return t('正在下载 {name}', { name: info.progress.name });
    case 'applying':
      return t('正在校验并安装 {name}', { name: info.progress.name });
    case 'complete':
      return t('素材下载完成，下次进入对局即可使用。');
    case 'blocked':
      return info.plan.reason || t('素材已是最新，无需下载。');
    case 'cancelled':
      return t('下载已取消，已安装的素材保持不变。');
    case 'failed':
      return t('下载失败：{reason}', { reason: info.error || info.message });
    default:
      return info.plan.count > 0
        ? t('本次下载共 {n} 个素材包，约 {size}。', { n: info.plan.count, size: formatBytes(info.plan.bytes) })
        : t('素材已是最新，无需下载。');
  }
}

/** 运行素材: the lobby's square entry, and the confirmation/progress dialog behind it. */
export function AssetUpdateButton({ class: cls }) {
  const [bridge] = useState(() => assetUpdateBridge());
  const [status, setStatus] = useState(() => (bridge ? parseAssetUpdateStatus(bridge.status()) : null));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const active = assetUpdateBridge();
    if (!active) return undefined;
    const onState = (json) => {
      const next = parseAssetUpdateStatus(json);
      if (next) setStatus(next);
    };
    globalThis[ASSET_UPDATE_CHANNEL] = onState;
    onState(active.status());
    return () => {
      if (globalThis[ASSET_UPDATE_CHANNEL] === onState) delete globalThis[ASSET_UPDATE_CHANNEL];
    };
  }, []);
  if (!bridge) return null;

  const info = describeAssetUpdate(status);
  const progress = info.progress;
  const plan = info.plan;
  const openDialog = () => {
    setOpen(true);
    // Read the plan (token exchange + index) so the dialog can say what a download would install.
    // This transfers no package; nothing downloads without the confirmation below.
    if (!info.busy && !info.complete) bridge.prepare();
  };
  const actions = html`
    ${info.busy ? html`<${Button} data-testid="asset-update-cancel" onClick=${() => bridge.cancel()}>${t('取消下载')}<//>`
      : info.canRetry ? html`<${Button} variant="primary" data-testid="asset-update-retry" onClick=${() => bridge.retry()}>${t('重试下载')}<//>`
        : info.canConfirm ? html`<${Button} variant="primary" data-testid="asset-update-confirm" onClick=${() => bridge.start()}>${t('开始下载')}<//>`
          : null}
    <${Button} data-testid="asset-update-close" onClick=${() => setOpen(false)}>${t('关闭')}<//>`;

  return html`<${Fragment}>
    <${Button} class=${cls} variant="secondary" square=${true} size="sm" icon="download" loading=${info.busy}
      title=${t('下载运行素材')} aria-label=${t('下载运行素材')} data-testid="asset-update-entry" onClick=${openDialog} />
    ${open ? html`<${Modal} open=${true} onClose=${() => setOpen(false)} title=${t('下载运行素材')} class="asset-update" actions=${actions}>
      <p role="status" data-testid="asset-update-status">${statusLine(info)}</p>
      ${plan.count > 0 ? html`<div class="asset-update__plan">
        <p>${t('本次下载共 {n} 个素材包，约 {size}。', { n: plan.count, size: formatBytes(plan.bytes) })}</p>
        <ul data-testid="asset-update-packages">
          ${plan.packages.map((item) => html`<li key=${item.name}><code>${item.name}</code> ${formatBytes(item.size)}</li>`)}
        </ul>
      </div>` : null}
      ${info.busy || progress.total > 0 ? html`<${ProgressBar}
        value=${progress.done}
        max=${Math.max(1, progress.total)}
        label=${`${progress.index} / ${progress.count}`}
        showValue=${true} />` : null}
      ${progress.name && progress.packageSize > 0 ? html`<p class="asset-update__bytes">
        <code>${progress.name}</code> ${formatBytes(progress.packageDone)} / ${formatBytes(progress.packageSize)}
      </p>` : null}
      ${info.error ? html`<p class="asset-update__error" data-testid="asset-update-error">${info.error}</p>` : null}
    <//>` : null}
  <//>`;
}
