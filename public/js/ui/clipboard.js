// Shared by invite links, loadouts and settings exports, including LAN / insecure contexts.
// `copyText()` writes; `readText()` feeds the 读取剪贴板 buttons (server address, alliance key).
/** @param {string} text @returns {Promise<boolean>} */
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* use the selected-text fallback */ }
  let ta, prev;
  try {
    prev = document.activeElement;
    ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Keep the temporary selection inside the active focus trap (#433). The 16 px readonly field avoids iOS zoom
    // and its keyboard; do not disable the dialog's focus protection or copy a selection redirected to another field.
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px';
    const host = prev?.closest?.('[role="dialog"][aria-modal="true"], .guide') || document.body;
    host.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, ta.value.length); // iOS Safari ignores select() alone
    if (document.activeElement !== ta || ta.selectionStart !== 0 || ta.selectionEnd !== ta.value.length) return false;
    return !!document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta?.remove();
    if (prev?.isConnected) prev.focus?.({ preventScroll: true });
  }
}

/**
 * 读取剪贴板里的文本（「读取剪贴板」按钮；标题页的服务器地址、大厅的同盟密钥都用它）。
 *
 * 三条路按宿主挑：Windows 外壳走已经注册的 `sp_read_clipboard` 命令（clipboard-manager 插件与
 * `allow-read-text` 权限早就在了），安卓外壳走自己注入的 `StrongholdAndroidClipboard` 接口，普通浏览器
 * 用异步 Clipboard API——它只在安全上下文里存在，所以 `http://host:3000` 这种明文部署会返回
 * `unsupported`，由调用方提示手动粘贴。剪贴板为空、被系统拒绝、宿主不支持都只是「没读到」，
 * 绝不抛出：按钮点了没反应比报错更难查。
 *
 * @param {any} [scope] 测试注入用；默认全局
 * @returns {Promise<{ ok: boolean, text: string, reason?: 'empty'|'denied'|'unsupported' }>}
 */
export async function readText(scope = globalThis) {
  const invoke = scope?.__TAURI__?.core?.invoke;
  if (typeof invoke === 'function') {
    try { return readResult(await invoke('sp_read_clipboard')); } catch { return { ok: false, text: '', reason: 'denied' }; }
  }
  const android = scope?.StrongholdAndroidClipboard;
  if (android && typeof android.readText === 'function') {
    try { return readResult(android.readText()); } catch { return { ok: false, text: '', reason: 'denied' }; }
  }
  const browser = scope?.navigator?.clipboard;
  if (browser && typeof browser.readText === 'function' && scope.isSecureContext) {
    try { return readResult(await browser.readText()); } catch { return { ok: false, text: '', reason: 'denied' }; }
  }
  return { ok: false, text: '', reason: 'unsupported' };
}

/** @param {any} value @returns {{ ok: boolean, text: string, reason?: string }} */
function readResult(value) {
  const text = String(value ?? '');
  return text.trim() ? { ok: true, text } : { ok: false, text: '', reason: 'empty' };
}
