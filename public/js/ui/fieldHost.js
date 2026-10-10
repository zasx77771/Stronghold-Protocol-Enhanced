// Field view loader: mounts the Pixi render engine (public/js/render/app.js → createFieldView, DESIGN §9)
// into a host element, falling back to the DOM view (fallbackField.js) when the engine is missing, times
// out or throws. Every call into the view goes through a guard so a render bug can never crash the HUD.
// The shared asset store gets the game data's copy of the asset manifest (`seedAssets`, public issue #8 item 5), and the
// prep cameras the HUD bands they keep clear (`hudBands`; the folded shop's band: public issue #5).
//
// `?render=fallback` (or globalThis.__SP_RENDER__ = 'fallback') skips the engine (dev / mock harness);
// `?render=engine` never falls back silently (errors are logged and the fallback still mounts).

// relative, like every other client module (the import map only resolves to this same URL; no bare specifier here)
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { createFallbackView } from './fallbackField.js';
import { data } from '../data.js';
import { audio } from '../audio.js';
import { settingsStore } from './settings.js';

const LOAD_TIMEOUT_MS = 12000;
const METHODS = ['setStage', 'setCamera', 'setPrep', 'enterBattle', 'pushSnapshot', 'pushEvents', 'highlightTiles', 'on', 'resize', 'destroy'];
// direction-step hooks (ui/facingWheel.js): optional — the wheel falls back to the engine's dev hooks when absent;
// setPen (enemy preview pen list), prepField ({ kind, side, mirror } of the Final Assault prep), stripesUnder (the view
// stripes range previews under the units itself) — render/app.js; the DOM fallback lacks them (→ null)
const OPTIONAL = ['pieceScreenRect', 'setSettings', 'off', 'tileScreen', 'holdPiece', 'setPieceDir', 'setPen', 'prepField', 'stripesUnder'];

/**
 * Camera padding (px) that keeps the field clear of the DOM HUD (top bar + bond strip, team panel, shop bar /
 * combat switcher, effects column). Sizes follow the rem scale of css/theme.css.
 * The Final Assault prep ('bossPrep') has the prep HUD (shop bar below) on the boss field: prep padding; the enemy pen
 * ('pen') is viewed with the shop collapsed.
 * @param {string} kind 'prep'|'bossPrep'|'pen'|'normal'|'unite'|'boss'|'hidden'
 * @param {{ width: number, height: number }} size
 */
export function hudPadding(kind, size) {
  let rem = 100;
  try { rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100; } catch { /* ignore */ }
  const h = size?.height || 1080;
  const clampH = (v) => Math.min(v, h * 0.4);
  if (kind === 'prep' || kind === 'bossPrep') return { top: clampH(rem * 1.95), bottom: clampH(rem * 3.2), left: rem * 2.25, right: rem * 0.9 };
  if (kind === 'boss' || kind === 'hidden' || kind === 'unite') return { top: clampH(rem * 1.9), bottom: clampH(rem * 0.95), left: rem * 2.1, right: rem * 0.95 };
  return { top: clampH(rem * 1.95), bottom: clampH(rem * 1.0), left: rem * 2.25, right: rem * 1.05 };
}

/**
 * HUD geometry (rem) the prep cameras keep clear (they mirror the CSS; test/ui/playtest5-ui.test.js checks the rules):
 * the bond strip's bottom edge (css/screens/game.css .gm__bonds top 1.36rem + a .bslot: disc .52rem + name ≈
 * 2.15rem measured) and a conservative fallback for the complete shop bar (tools + gap + card row). hudBands reads
 * the live bar rectangle when it exists, so future CSS changes cannot silently put the bench behind the controls. The
 * folded Android shop keeps only its tab and the bottom-corner touch targets clear.
 */
export const HUD_REM = Object.freeze({
  bondStripBottom: 2.16, shopBarTop: 3.8, shopBarBorderPx: 0, shopTabTop: 0.8, shopTabBorderPx: 3, cornerTop: 0.8,
});

/**
 * The packaged Android client keeps the original open-shop framing. Measuring the whole shop bar made the board too
 * small on short landscape phones. This remains Android-only: desktop and ordinary browser clients retain the
 * measured HUD avoidance above and do not change camera merely because the shop was folded.
 */
export const ANDROID_LEGACY_HUD_REM = Object.freeze({ bondStripBottom: 2.16, shopBarTop: 2.64, shopBarBorderPx: 3 });

export function isPackagedAndroidHost(loc = globalThis.location, bridge = globalThis.StrongholdAndroid) {
  if (bridge) return true;
  try { return new URLSearchParams(loc?.search || '').get('android') === '1'; } catch { return false; }
}

/**
 * Connect the Android shop's collapsed state to the official no-shop prep camera. Browser and desktop clients keep
 * their existing camera options, so collapsing their shop remains a HUD-only operation.
 */
export function prepCameraShopOptions(options, { android, collapsed = false, shopVisible = true } = {}) {
  const base = options && typeof options === 'object' ? options : {};
  const packaged = android ?? isPackagedAndroidHost();
  if (!packaged || !shopVisible) return base;
  return { ...base, shop: !collapsed };
}

/**
 * CSS px of HUD along the top and bottom edges during prep. On packaged Android, a folded shop uses the official
 * no-shop camera and reserves only the folded tab / corner touch targets; desktop and ordinary browser clients keep
 * their existing prep camera. Scouting a teammate's board uses the normal camera and therefore no band.
 * @param {string} kind
 * @param {{ width: number, height: number }} size
 * @param {{ android?: boolean, shop?: boolean }} [runtime] explicit runtime/camera override for tests
 * @returns {{ top: number, bottom: number }|null}
 */
export function hudBands(kind, size, runtime) {
  if (kind !== 'prep' && kind !== 'bossPrep') return null;
  const android = runtime?.android ?? isPackagedAndroidHost();
  const folded = android && runtime?.shop === false;
  const h = size?.height || 1080;
  let rem = 100;
  let safeTop = 0;
  let safeBottom = 0;
  let corner = 0;
  let measuredBottom = 0;
  try {
    rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100;
    const hud = document.querySelector('.gm__hud')?.getBoundingClientRect();
    safeTop = Math.max(0, hud?.top || 0);
    if (folded) {
      if (hud && hud.bottom > 0) safeBottom = Math.max(0, h - hud.bottom);
      corner = cornerBand(h);
    }
    if (!android) {
      const fieldRect = document.querySelector('.gm__field')?.getBoundingClientRect();
      const shopRect = document.querySelector('.gm__hud > .shopbar')?.getBoundingClientRect();
      if (fieldRect && shopRect && shopRect.width > 0 && shopRect.height > 0) {
        measuredBottom = Math.max(0, fieldRect.bottom - shopRect.top);
      }
    }
  } catch { /* ignore */ }
  const geometry = android ? ANDROID_LEGACY_HUD_REM : HUD_REM;
  const bottom = folded
    ? Math.max(safeBottom + rem * HUD_REM.shopTabTop + HUD_REM.shopTabBorderPx, corner || safeBottom + rem * HUD_REM.cornerTop)
    : measuredBottom || rem * geometry.shopBarTop + geometry.shopBarBorderPx;
  return {
    top: Math.min(h * 0.4, safeTop + rem * geometry.bondStripBottom),
    bottom: Math.min(h * (android ? 0.4 : 0.49), bottom),
  };
}

/**
 * CSS px from the viewport's bottom edge (`h` high) up to the top of the corner buttons' hit areas (交流 / ⚙ / 📖 / ⛶,
 * .gm__corner), 0 when they are not on the page. On a touch screen every one of them takes taps from an invisible area
 * of at least --tap-min (44 px) centred on it (css/devices.css touch targets), 5 px above a 34 px phone button — a bench
 * pad edge there is not pressable.
 * @param {number} h
 */
function cornerBand(h) {
  const btns = document.querySelectorAll('.gm__corner .gm__gear, .gm__corner .ewheel__btn');
  if (!btns || !btns.length) return 0;
  const root = document.documentElement;
  const tap = root?.classList?.contains('sp-coarse') ? parseFloat(getComputedStyle(root).getPropertyValue('--tap-min')) || 0 : 0;
  let top = Infinity;
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (r && r.height > 0) top = Math.min(top, r.top + r.height / 2 - Math.max(r.height, tap) / 2);
  }
  return top < Infinity ? Math.max(0, h - top) : 0;
}

function renderPref() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('render');
    if (q === 'fallback' || q === 'engine') return q;
  } catch { /* ignore */ }
  return globalThis.__SP_RENDER__ === 'fallback' ? 'fallback' : 'auto';
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('Field view initialization cancelled', 'AbortError');
}

function checkActive(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function withTimeout(p, ms, what, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (done, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(reject, new Error(`${what} timed out`)), ms);
    // Keep a rejection handler attached even when cancellation wins before this promise settles.
    Promise.resolve(p).then((value) => finish(resolve, value), (err) => finish(reject, err));
    if (signal?.aborted) onAbort();
  });
}

/**
 * Wrap a view so no method can throw into the UI (each failing method is logged once).
 * @param {any} view
 * @param {'engine'|'fallback'} kind
 */
export function guardView(view, kind) {
  const warned = new Set();
  const safe = { kind, raw: view };
  for (const name of [...METHODS, ...OPTIONAL]) {
    safe[name] = (...args) => {
      const fn = view && view[name];
      if (typeof fn !== 'function') return name === 'on' ? () => {} : null;
      try {
        const out = fn.apply(view, args);
        if (out && typeof out.then === 'function') out.catch((err) => { if (!warned.has(name)) { warned.add(name); console.warn(`[field] ${name} failed`, err); } });
        if (name === 'on') return typeof out === 'function' ? out : () => { try { view.off?.(args[0], args[1]); } catch { /* ignore */ } };
        return out;
      } catch (err) {
        if (!warned.has(name)) { warned.add(name); console.warn(`[field] ${kind} view ${name} failed`, err); }
        return name === 'on' ? () => {} : null;
      }
    };
  }
  return safe;
}

/**
 * Hand the game data's copies of /data/assets.json and /data/local-assets.json (data.js 'assets' / 'local': the match
 * screen waits for them, gameComponents GAME_FILES) to the asset store, now or when they land: it then never downloads
 * the manifest a second time — after a page reload (a phone browser discarding a background tab, Chrome's Memory Saver)
 * that second download was the one createFieldView waited ≤ 4 s for, and a slow or failed one left every operator the
 * image-less placeholder (public issue #8 item 5). Without a copy the store fetches and retries by itself.
 * @param {{ seed?: (m: any) => boolean, seedLocal?: (m: any) => boolean }} store public/js/assets.js store
 */
export function seedAssets(store) {
  if (!store) return;
  const give = (name, fn) => {
    if (typeof fn !== 'function') return;
    const now = data.get(name);
    if (now) { fn(now); return; }
    // still loading (or failed): adopt it if it lands; a later success of the store's own fetch makes this a no-op
    Promise.resolve(data.load(name)).then((m) => { if (m) fn(m); }, () => {});
  };
  give('assets', store.seed?.bind(store));
  give('local', store.seedLocal?.bind(store));
}

/**
 * Create a field view in `host`: the render engine when available, else the DOM fallback.
 * @param {HTMLElement} host
 * @param {{ signal?: AbortSignal }} [options] Cancels a pending mount without creating a fallback.
 * @returns {Promise<ReturnType<typeof guardView>>}
 */
export async function mountFieldView(host, { signal } = {}) {
  checkActive(signal);
  const pref = renderPref();
  const opts = { data, assets: data.get('assets'), audio, settings: settingsStore.get(), padding: hudPadding, hud: hudBands };
  if (pref !== 'fallback') {
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let engineView = null;
    const dispose = (view) => { try { view?.destroy?.(); } catch { /* ignore */ } };
    try {
      checkActive(controller.signal);
      // the shared asset store (public/js/assets.js) keeps its Spine cache across remounts (next match, reconnect)
      const am = await withTimeout(import('../assets.js'), LOAD_TIMEOUT_MS, 'asset store import', controller.signal).catch(() => {
        checkActive(controller.signal);
        return null;
      });
      checkActive(controller.signal);
      if (am?.assets && typeof am.assets.ready === 'function') {
        opts.assets = am.assets;
        seedAssets(am.assets);
      }
      const mod = await withTimeout(import('../render/app.js'), LOAD_TIMEOUT_MS, 'render engine import', controller.signal);
      checkActive(controller.signal);
      if (typeof mod?.createFieldView !== 'function') throw new Error('createFieldView missing');
      // A factory that ignores cancellation still belongs to this attempt when it eventually returns.
      const pending = Promise.resolve(mod.createFieldView(host, { ...opts, signal: controller.signal })).then((view) => {
        if (controller.signal.aborted) dispose(view); else engineView = view;
        return view;
      });
      const view = await withTimeout(pending, LOAD_TIMEOUT_MS, 'createFieldView', controller.signal);
      checkActive(controller.signal);
      const missing = METHODS.filter((k) => typeof view?.[k] !== 'function');
      if (missing.length) throw new Error(`view lacks ${missing.join(', ')}`);
      return guardView(view, 'engine');
    } catch (err) {
      controller.abort();
      dispose(engineView);
      checkActive(signal);
      console.warn('[field] render engine unavailable, using the simplified view:', err?.message || err);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  checkActive(signal);
  return guardView(createFallbackView(host, { ...opts, assets: data.get('assets') }), 'fallback');
}

/**
 * Preact hook: mount a field view into `hostRef` once; returns { view, kind } (view null while loading).
 * @param {{ current: HTMLElement|null }} hostRef
 */
export function useFieldView(hostRef) {
  const [state, setState] = useState({ view: null, kind: 'loading' });
  const viewRef = useRef(null);
  useEffect(() => {
    let dead = false;
    const host = hostRef.current;
    if (!host) return undefined;
    const controller = new AbortController();
    mountFieldView(host, { signal: controller.signal }).then((view) => {
      if (dead) { view.destroy(); return; }
      viewRef.current = view;
      globalThis.__SP_VIEW__ = view; // dev / E2E introspection (view.raw.stats?.())
      setState({ view, kind: view.kind });
    }, (err) => { if (!dead && !controller.signal.aborted) console.error('[field] mount failed', err); });
    const unsub = settingsStore.subscribe((s) => viewRef.current?.setSettings?.(s));
    const onResize = () => viewRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      dead = true;
      controller.abort();
      unsub();
      window.removeEventListener('resize', onResize);
      // the dev hook must not keep the destroyed view — and through its host the whole detached match screen — alive
      if (viewRef.current && globalThis.__SP_VIEW__ === viewRef.current) globalThis.__SP_VIEW__ = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);
  return state;
}
