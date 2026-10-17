// Pure state model for the thin Android client's EXPLICIT runtime-asset download (enhanced 2.6.4).
//
// The native session (android/app/src/main/java/com/strongholdprotocol/covenant/assets/AssetUpdateSession.java)
// serialises one snapshot after every change; ui/assetUpdate.js renders it, tools/android-asset-tests.mjs
// exercises the same field names on the JVM. Nothing transfers a byte until the player taps the entry and
// then confirms the plan, so this module is deliberately DOM-free and import-free: it runs in the Android
// WebView, in a plain browser (where no bridge exists, so the entry stays hidden) and under `node --test`.

/** The channel the native session pushes a fresh snapshot into (one argument: the JSON string). */
export const ASSET_UPDATE_CHANNEL = '__strongholdAssetUpdate';
/** The one @JavascriptInterface object: status / prepare / start / retry / cancel, never a token. */
export const ASSET_UPDATE_BRIDGE = 'StrongholdAndroidAssets';
/** `format` of every snapshot, so a stale page never mis-reads a different native session. */
export const ASSET_UPDATE_FORMAT = 'sp-asset-update-status-v1';

/** The native states, in the order a session moves through them. */
export const ASSET_UPDATE_STATES = Object.freeze([
  'unavailable', 'unconfigured', 'waiting-session', 'idle', 'preparing', 'ready',
  'downloading', 'applying', 'complete', 'blocked', 'failed', 'cancelled',
]);

/** States in which bytes are moving (or a plan is being read): the dialog offers 取消下载 then. */
const BUSY_STATES = new Set(['preparing', 'downloading', 'applying']);

/**
 * The native bridge when this page really is the packaged Android client, else null. Everything else
 * (the browser, the desktop build, the Tauri build) has no such object, so the 运行素材 entry is hidden
 * there, and a half-built or foreign object is refused rather than trusted.
 * @param {any} [scope]
 */
export function assetUpdateBridge(scope = globalThis) {
  const bridge = scope == null ? null : scope[ASSET_UPDATE_BRIDGE];
  if (!bridge || typeof bridge.status !== 'function' || typeof bridge.start !== 'function') return null;
  if (typeof bridge.available === 'function' && !bridge.available()) return null;
  return bridge;
}

/** Native state → the phase the dialog shows. Only `waiting-session` reads differently. */
const PHASE_BY_STATE = Object.freeze({ 'waiting-session': 'waiting' });

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const str = (value) => (typeof value === 'string' ? value : '');

/**
 * The native `status()` string (or an already-parsed object) as a snapshot.
 * @param {unknown} value
 * @returns {?Record<string, any>} the snapshot, or null when it is not one of ours.
 */
export function parseAssetUpdateStatus(value) {
  let raw = value;
  if (typeof raw === 'string') {
    if (!raw) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || raw.format !== ASSET_UPDATE_FORMAT) return null;
  return raw;
}

/**
 * Whole-session and current-package progress. `announced` sizes come from the server, so the ratios
 * only use what the session actually knows.
 * @param {?Record<string, any>} status
 */
export function assetUpdateProgress(status) {
  const snapshot = status || {};
  const total = Math.max(0, num(snapshot.total));
  const done = Math.max(0, num(snapshot.done));
  const packageSize = Math.max(0, num(snapshot.packageSize));
  const packageDone = Math.max(0, num(snapshot.packageDone));
  return {
    done,
    total,
    ratio: total > 0 ? Math.min(1, done / total) : 0,
    index: num(snapshot.packageIndex),
    count: num(snapshot.packageCount),
    name: str(snapshot.packageName),
    packageDone,
    packageSize,
    packageRatio: packageSize > 0 ? Math.min(1, packageDone / packageSize) : 0,
  };
}

/**
 * The prepared plan: exactly what the confirmation dialog lists before anything is transferred.
 * @param {?Record<string, any>} status
 */
export function assetUpdatePlan(status) {
  const snapshot = status || {};
  const plan = snapshot.plan && typeof snapshot.plan === 'object' ? snapshot.plan : null;
  const packages = plan && Array.isArray(plan.packages)
    ? plan.packages.filter((item) => item && typeof item.name === 'string' && item.name)
    : [];
  return {
    status: str(plan?.status),
    reason: str(plan?.reason),
    route: str(plan?.routeKind),
    localVersion: str(plan?.localVersion),
    latest: str(plan?.latest),
    bytes: Math.max(0, num(plan?.bytes)),
    count: packages.length,
    packages,
  };
}

/**
 * One snapshot as the UI needs it. The confirmation contract of this feature lives here: a transfer may
 * only be offered while a prepared plan waits (`canConfirm`), and reading a status never starts one.
 * @param {?Record<string, any>} status
 */
export function describeAssetUpdate(status) {
  const snapshot = status || {};
  const state = ASSET_UPDATE_STATES.includes(snapshot.state) ? snapshot.state : 'unavailable';
  const progress = assetUpdateProgress(snapshot);
  const plan = assetUpdatePlan(snapshot);
  return {
    state,
    phase: PHASE_BY_STATE[state] || state,
    busy: BUSY_STATES.has(state),
    enabled: snapshot.enabled === true,
    hasSession: snapshot.hasSession === true,
    message: str(snapshot.message),
    error: str(snapshot.error),
    retryable: snapshot.retryable === true,
    progress,
    plan,
    canConfirm: state === 'ready' && plan.count > 0,
    canCancel: BUSY_STATES.has(state),
    canRetry: (state === 'failed' && snapshot.retryable === true) || state === 'cancelled',
    complete: state === 'complete',
    blocked: state === 'blocked',
  };
}

/** Bytes as the dialog shows them: MB with one decimal from a megabyte up, whole KB below it. */
export function formatBytes(bytes) {
  const n = Math.max(0, num(bytes));
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
