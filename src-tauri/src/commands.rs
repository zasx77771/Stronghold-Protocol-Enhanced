//! The command surface the init script calls, plus the single-instance behaviour of the app.
//!
//! Command names and payload shapes are the ones `public/js/desktopBridge.js` uses; that script is the
//! only piece of JavaScript the packaged client still carries, and it reproduces the
//! `globalThis.strongholdClient` object that `public/js/tcpSocket.js` and
//! `public/js/serverAddress.js` already look for.
//!
//! Everything that touches a secret (the R2 session token, the exchanged Worker token, the socket
//! itself) stays inside Rust. The page can only ask "connect here", "send this text", "close",
//! "read the clipboard", "take this session token" and "is the asset store ready?".

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::assets::AssetStore;
use crate::tcp::{decode_page_bytes, TcpBridge, TcpState};

/// Read the clipboard as text. Returns `""` when the clipboard is empty or holds no text, the same
/// answer the Electron preload gave.
#[tauri::command]
pub fn sp_read_clipboard(app: AppHandle) -> String {
    let clipboard = app.clipboard();
    if let Ok(text) = clipboard.read_text() {
        return text;
    }
    platform_clipboard_text().unwrap_or_default()
}

/// `globalThis.strongholdClient.platform`. Kept as a command so a page cannot be told it is running
/// on a platform the binary was not built for.
#[tauri::command]
pub fn sp_platform() -> &'static str {
    "windows"
}

/// `strongholdClient.tcpConnect(id, host, port)`. The bridge validates the endpoint and reports a
/// rejected one through the normal `error` + `close` events.
#[tauri::command]
pub async fn sp_tcp_connect(
    app: AppHandle,
    bridge: State<'_, TcpState>,
    id: String,
    host: String,
    port: Value,
) -> Result<bool, String> {
    bridge.0.connect(app, id, host, port).await;
    Ok(true)
}

/// `strongholdClient.tcpSend(id, data)`. `data` is the exact text the page wanted to write, encoded
/// as a JSON number array so the WebView cannot silently re-encode it as UTF-16.
#[tauri::command]
pub async fn sp_tcp_send(bridge: State<'_, TcpState>, id: String, data: Vec<Value>) -> Result<bool, String> {
    let bytes = decode_page_bytes(&data).map_err(|_| "TCP frame size is invalid".to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "TCP frame is not UTF-8".to_string())?;
    bridge.0.send(&id, &text).await;
    Ok(true)
}

/// `strongholdClient.tcpClose(id, code, reason)`: the `{"_sp":"close",…}` control frame, then FIN.
#[tauri::command]
pub async fn sp_tcp_close(
    bridge: State<'_, TcpState>,
    id: String,
    code: Option<u32>,
    reason: Option<String>,
) -> Result<bool, String> {
    let code = code.unwrap_or(1000).min(u32::from(u16::MAX)) as u16;
    let reason: String = reason.unwrap_or_default().chars().take(120).collect();
    bridge.0.request_close(&id, code, &reason).await;
    Ok(true)
}

/// `strongholdClient.setAssetSessionToken(token)`. The only thing the page learns is whether the
/// asset store changed enough to justify a reload — never the token that came back from the Worker.
#[tauri::command]
pub async fn sp_set_asset_session_token(app: AppHandle, token: String) -> bool {
    let store = match app.try_state::<AssetStore>() {
        Some(store) => store,
        None => return false,
    };
    store.update_session(&token).await
}

/// `strongholdClient.assetsReady()`: true when the shipped configuration was accepted. The page uses
/// it to decide whether it must wait for the private store before drawing.
#[tauri::command]
pub fn sp_assets_ready(app: AppHandle) -> bool {
    app.try_state::<AssetStore>().map(|store| store.is_enabled()).unwrap_or(false)
}

/// Used by the settings/diagnostics view so a support log can name the running payload.
#[tauri::command]
pub fn sp_client_info(app: AppHandle) -> Value {
    let store = app.try_state::<AssetStore>();
    json!({
        "platform": "windows",
        "shell": "tauri",
        "assetsReady": store.as_ref().map(|store| store.is_enabled()).unwrap_or(false),
        "assetRoot": store.as_ref().map(|store| store.root().to_string_lossy().to_string()),
    })
}

/// A clipboard fallback for the case where the platform clipboard is held by another process (the
/// WebView2 clipboard plugin reports an error then). Only the read direction is implemented, and it
/// is only reached after the plugin failed.
#[cfg(windows)]
fn platform_clipboard_text() -> Option<String> {
    use std::process::Command;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    Some(text.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(not(windows))]
fn platform_clipboard_text() -> Option<String> {
    None
}

/// Bring the existing window back to the foreground when a second process starts. Ported from the
/// Electron `second-instance` handler.
pub fn focus_existing(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Stop every socket when the window goes away, so no half-open connection survives the client.
pub fn shutdown_bridge(app: &AppHandle) {
    if let Some(state) = app.try_state::<TcpState>() {
        let bridge = std::sync::Arc::clone(&state.0);
        tauri::async_runtime::block_on(bridge.destroy_all());
    }
}
