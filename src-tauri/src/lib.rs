//! The Tauri 2 desktop client runtime for the packaged Windows build.
//!
//! This crate replaces `desktop/runtime/main.cjs` + `desktop/runtime/preload.cjs`. Everything those
//! two Electron files did now lives here:
//!
//! | Electron responsibility | Where it lives now |
//! | --- | --- |
//! | `http` server on a random loopback port | [`protocol`], registered as the `sp://` custom scheme |
//! | `RuntimeAssetUpdater` | [`assets`], with the session token kept inside Rust |
//! | `sp-tcp-*` IPC + framing | [`tcp`] |
//! | `sp-read-clipboard` | [`commands::sp_read_clipboard`] |
//! | `requestSingleInstanceLock()` | `tauri-plugin-single-instance`, wired in [`run`] |
//! | `BrowserWindow` options | `tauri.conf.json` (`app.windows[0]`) |
//! | `contextBridge` surface | `public/js/desktopBridge.js`, loaded before the app scripts |
//!
//! There is no Node.js integration: the page only ever sees `window.__TAURI__` and the
//! `strongholdClient` object built from it.

pub mod assets;
pub mod commands;
pub mod mime;
pub mod paths;
pub mod protocol;
pub mod range;
pub mod tcp;

use std::sync::Arc;

use tauri::Manager;

use crate::assets::AssetStore;
use crate::tcp::TcpState;

/// The page bridge that rebuilds `globalThis.strongholdClient`.
///
/// `app.withGlobalTauri: true` in `tauri.conf.json` publishes `window.__TAURI__`; index.html loads
/// this source before boot.js so the page contract stays byte-compatible with the Electron preload
/// (`desktop/runtime/preload.cjs`), which is what keeps `public/js/tcpSocket.js`,
/// `public/js/serverAddress.js` and Android on one code path.
pub const INIT_SCRIPT: &str = include_str!("../../public/js/desktopBridge.js");

/// The `?desktop=1` marker `public/js/serverAddress.js::isDesktopClient()` looks for.
pub const DESKTOP_QUERY: &str = "desktop=1";

/// Build and run the desktop app. Returns the process exit code.
pub fn run() -> i32 {
    let tcp_state = TcpState::new();

    let built = tauri::Builder::default()
        // Must be the first plugin: it decides whether this process owns the app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            commands::focus_existing(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(tcp_state)
        .register_asynchronous_uri_scheme_protocol("sp", move |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = protocol::serve(&app, &request);
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::sp_read_clipboard,
            commands::sp_platform,
            commands::sp_tcp_connect,
            commands::sp_tcp_send,
            commands::sp_tcp_close,
            commands::sp_set_asset_session_token,
            commands::sp_assets_ready,
            commands::sp_client_info,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // The private R2 store lives outside the bundle so an update survives a reinstall.
            let state_root = handle
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("stronghold-protocol-client"))
                .join("asset-runtime");
            let client_root = protocol::find_client_root(&handle)
                .unwrap_or_else(|| std::env::temp_dir().join("stronghold-protocol-client"));
            let store = AssetStore::open(state_root, &client_root);
            eprintln!(
                "[assets] private R2 {}",
                if store.is_enabled() { "enabled" } else { "disabled (no configuration)" }
            );
            app.manage(store);

            // The window comes from `tauri.conf.json`, which already points it at
            // `sp://localhost/index.html?desktop=1`. The page loads INIT_SCRIPT before its own app
            // scripts. `?desktop=1` is what `public/js/serverAddress.js` tests for.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                commands::shutdown_bridge(window.app_handle());
            }
        })
        .build(tauri::generate_context!());

    match built {
        Ok(app) => {
            app.run(|_handle, _event| {});
            0
        }
        Err(error) => {
            eprintln!("failed to start the Stronghold Protocol client: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_init_script_installs_the_page_contract() {
        for needle in [
            "strongholdClient",
            "tcpAvailable",
            "tcpConnect",
            "tcpSend",
            "tcpClose",
            "onTcpEvent",
            "readClipboardText",
            "setAssetSessionToken",
            "sp-tcp-event",
        ] {
            assert!(INIT_SCRIPT.contains(needle), "init script is missing {needle}");
        }
    }

    #[test]
    fn the_desktop_marker_matches_the_frontend_check() {
        // `public/js/serverAddress.js::isDesktopClient()` compares the parameter to the string "1".
        assert_eq!(DESKTOP_QUERY, "desktop=1");
    }

    #[test]
    fn the_bridge_is_managed_under_a_state_commands_can_take() {
        let state = TcpState::new();
        assert!(Arc::strong_count(&state.0) == 1);
    }
}
