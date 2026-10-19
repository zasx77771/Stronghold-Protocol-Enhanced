use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::assets::AssetStore;
use crate::tcp::TcpState;

#[tauri::command]
pub fn sp_platform() -> &'static str { "windows" }

#[tauri::command]
pub fn sp_read_clipboard(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
pub async fn sp_tcp_connect(app: AppHandle, state: State<'_, TcpState>, id: String, host: String, port: u16) -> Result<(), String> {
    state.connect(app, id, host, port).await
}

#[tauri::command]
pub async fn sp_tcp_send(state: State<'_, TcpState>, id: String, data: Vec<u8>) -> Result<(), String> {
    state.send(&id, data).await
}

#[tauri::command]
pub async fn sp_tcp_close(state: State<'_, TcpState>, id: String, code: u16, reason: String) -> Result<(), String> {
    state.close(&id, code, reason).await
}

#[tauri::command]
pub fn sp_client_info(app: AppHandle) -> serde_json::Value {
    let store = app.try_state::<AssetStore>();
    serde_json::json!({
        "platform": "windows",
        "shell": "tauri",
        "assetsReady": store.as_ref().map(|value| value.is_enabled()).unwrap_or(false),
    })
}

#[tauri::command]
pub fn sp_asset_status(app: AppHandle) -> serde_json::Value {
    match app.try_state::<AssetStore>() {
        Some(store) => store.status(),
        None => serde_json::json!({
            "format": "sp-asset-status-v1",
            "platform": "windows",
            "mode": "embedded",
            "enabled": false,
            "current": "",
            "files": 0,
            "importAvailable": true,
        }),
    }
}

/// Opens the OS picker for one explicitly chosen native asset package (`assets-base-*.zip` or
/// `assets-delta-*.zip`) and imports it on a worker thread.  The command takes no path argument on
/// purpose: page JavaScript can neither name nor read a local file, and the native picker is the
/// only source.  `apply_package` still validates manifest, inventory, entry hashes and paths.
#[tauri::command]
pub fn sp_import_asset_package(app: AppHandle) -> serde_json::Value {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("导入原生素材包")
        .add_filter("Stronghold asset package", &["zip"])
        .pick_file(move |picked| {
            let Some(picked) = picked else {
                let _ = handle.emit("sp-asset-event", serde_json::json!({
                    "state": "import-failed",
                    "cancelled": true,
                    "message": "已取消导入",
                }));
                return;
            };
            let path = match picked.into_path() {
                Ok(path) => path,
                Err(_) => {
                    let _ = handle.emit("sp-asset-event", serde_json::json!({
                        "state": "import-failed",
                        "error": "无法读取所选文件",
                    }));
                    return;
                }
            };
            let worker = handle.clone();
            std::thread::spawn(move || import_picked_package(&worker, &path));
        });
    serde_json::json!({ "started": true })
}

fn import_picked_package(handle: &AppHandle, path: &std::path::Path) {
    let emit = |value: serde_json::Value| {
        let _ = handle.emit("sp-asset-event", value);
    };
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    emit(serde_json::json!({
        "state": "importing",
        "message": "正在读取本地素材包",
        "bytes": size,
    }));
    let digest = match crate::assets::file_sha256(path) {
        Ok(digest) => digest,
        Err(error) => {
            emit(serde_json::json!({ "state": "import-failed", "error": error }));
            return;
        }
    };
    emit(serde_json::json!({
        "state": "import-verifying",
        "message": "校验 ASSETS.json、SHA-256 与 inventory",
    }));
    emit(serde_json::json!({
        "state": "import-applying",
        "message": "解压并原子切换素材层",
    }));
    let Some(store) = handle.try_state::<AssetStore>() else {
        emit(serde_json::json!({ "state": "import-failed", "error": "asset store is not mounted" }));
        return;
    };
    let applied = store.import_package(path, &digest);
    match applied {
        Ok(summary) => {
            let current = store.status().get("current").cloned().unwrap_or_default();
            emit(serde_json::json!({
                "state": "imported",
                "message": summary,
                "current": current,
            }));
        }
        Err(error) => {
            emit(serde_json::json!({ "state": "import-failed", "error": error }));
        }
    }
}
