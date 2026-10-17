pub mod assets;
pub mod commands;
pub mod protocol;
pub mod tcp;

use tauri::{Manager, Emitter};
use tcp::TcpState;

pub fn run() -> i32 {
    let state = TcpState::default();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .register_asynchronous_uri_scheme_protocol("sp", move |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move { responder.respond(protocol::serve(&app, &request)); });
        })
        .invoke_handler(tauri::generate_handler![
            commands::sp_platform,
            commands::sp_read_clipboard,
            commands::sp_tcp_connect,
            commands::sp_tcp_send,
            commands::sp_tcp_close,
            commands::sp_set_asset_session_token,
            commands::sp_assets_ready,
            commands::sp_client_info,
            commands::sp_asset_status,
            commands::sp_import_asset_package,
        ])
        .setup(|app| {
            let store_root = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("stronghold-protocol-native"))
                .join("asset-runtime");
            let client_root = protocol::client_root(app.handle())
                .unwrap_or_else(|| std::path::PathBuf::from("client"));
            app.manage(assets::AssetStore::open(store_root, &client_root));
            let _ = app.emit("sp-native-ready", serde_json::json!({ "platform": "windows" }));
            Ok(())
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => { app.run(|_, _| {}); 0 }
        Err(error) => { eprintln!("native client start failed: {error}"); 1 }
    }
}
