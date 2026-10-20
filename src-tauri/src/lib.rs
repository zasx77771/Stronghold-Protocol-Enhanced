pub mod assets;
pub mod commands;
pub mod protocol;
pub mod tcp;

use tauri::{Manager, Emitter};
use tcp::TcpState;

/// Where the client keeps its runtime files (log, WebView2 profile).
/// A plain per-user folder, deliberately *not* the legacy `Stronghold Protocol` folder an earlier
/// installer may have left behind with its own ACLs, client copy and WebView2 profile: that tree is
/// outside this app's control and has already cost a silent white-window crash.
#[cfg(windows)]
fn runtime_dir() -> std::path::PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Stronghold Protocol Enhanced")
}

/// Where an operator renames the client without a rebuild: `client.json` next to the runtime folder
/// the installer already owns.
#[cfg(windows)]
fn client_config_path() -> std::path::PathBuf {
    runtime_dir().join("client.json")
}

/// Decides the window title from the runtime sources, in order: `SP_WINDOW_TITLE`, then
/// `windowTitle` in `client.json`. A blank or unparseable value is not a title, so the caller keeps
/// the one compiled into `tauri.conf.json`.
///
/// The name used to be a build input — renaming the client meant repacking and reinstalling both
/// clients for one string. The compiled value stays as the default; this is the override.
fn pick_window_title(env_value: Option<&str>, config_text: Option<&str>) -> Option<String> {
    if let Some(raw) = env_value {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let parsed: serde_json::Value = serde_json::from_str(config_text?.trim()).ok()?;
    let title = parsed.get("windowTitle")?.as_str()?.trim();
    if title.is_empty() { None } else { Some(title.to_string()) }
}

/// The runtime override, if any: environment first, then the client config file.
fn window_title_override() -> Option<String> {
    let env_value = std::env::var("SP_WINDOW_TITLE").ok();
    #[cfg(windows)]
    let config_text = std::fs::read_to_string(client_config_path()).ok();
    #[cfg(not(windows))]
    let config_text: Option<String> = None;
    pick_window_title(env_value.as_deref(), config_text.as_deref())
}

fn append_log(path: &std::path::Path, text: &str) -> bool {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(text.as_bytes()).is_ok()
        }
        Err(_) => false,
    }
}

/// Every place a launch line goes. The program folder comes first because a portable copy keeps its
/// evidence next to the exe; a per-user folder and the temp folder are the fallbacks for a read-only
/// install. The first writable one wins, so no single locked-down folder swallows the reason a launch
/// failed.
fn log_targets() -> Vec<std::path::PathBuf> {
    let mut targets = Vec::new();
    #[cfg(windows)]
    {
        if let Some(dir) = exe_dir() {
            targets.push(dir.join("client.log"));
        }
        targets.push(runtime_dir().join("client.log"));
        targets.push(std::env::temp_dir().join("Stronghold Protocol Enhanced").join("client.log"));
    }
    targets
}

#[cfg(windows)]
fn exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
}

/// WebView2 profile folders to try, best first: an explicit override, then the portable program
/// folder (a copy the user extracted themselves), then the per-user folder, then a unique temp
/// folder. WebView2 refuses some per-user profiles with `0x800700AA` ("resource in use"), so a single
/// hard-coded path can brick every later start.
#[cfg(windows)]
fn profile_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        if !explicit.is_empty() {
            candidates.push(std::path::PathBuf::from(explicit));
        }
    }
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("webview2-profile"));
    }
    candidates.push(runtime_dir().join("WebView2"));
    candidates.push(
        std::env::temp_dir()
            .join("Stronghold Protocol Enhanced")
            .join(format!("WebView2-{}", std::process::id())),
    );
    candidates
}

fn append_log_any(text: &str) {
    for path in log_targets() {
        if append_log(&path, text) {
            return;
        }
    }
}

fn log_display() -> String {
    log_targets()
        .first()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| String::from("(no log path)"))
}

#[cfg(windows)]
fn message_box(text: &str) {
    use std::os::windows::ffi::OsStrExt;
    // Win32 is linked already (Tauri depends on it); declare the one symbol we need so the client
    // can show a native dialog even when the webview never came up.
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    let wide = |value: &str| -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    };
    let body = wide(text);
    let caption = wide("Stronghold Protocol");
    // MB_OK | MB_ICONERROR | MB_SETFOREGROUND
    unsafe { MessageBoxW(std::ptr::null_mut(), body.as_ptr(), caption.as_ptr(), 0x0000_0010 | 0x0000_0001 | 0x0001_0000) };
}

/// Runs before Tauri touches any window: picks the first usable WebView2 profile folder, writes launch
/// failures to `client.log` (program folder, then the per-user folder, then the temp folder) and turns
/// every panic into a log line. Returns the profile candidates so `run` can retry the next one.
pub fn prepare_runtime() -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        let candidates = profile_candidates();
        if let Some(first) = candidates.first() {
            if std::fs::create_dir_all(first).is_ok() {
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", first);
            }
        }
        append_log_any(&format!("\n[launch] starting pid={}\n", std::process::id()));
        append_log_any(&format!(
            "[profile] {}\n",
            std::env::var("WEBVIEW2_USER_DATA_FOLDER").unwrap_or_else(|_| String::from("(default)"))
        ));
        std::panic::set_hook(Box::new(move |info| {
            append_log_any(&format!("[panic] {info}\n"));
        }));
        candidates
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    String::from("unknown panic")
}

fn report_failure(message: &str) {
    let line = format!("[error] {message}\n");
    #[cfg(windows)]
    {
        append_log_any(&line);
        message_box(&format!("{message}\n\n日志：{}", log_display()));
    }
    #[cfg(not(windows))]
    eprintln!("native client start failed: {message}");
}

fn build_app() -> tauri::Result<tauri::App> {
    let state = TcpState::default();
    tauri::Builder::default()
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
            // A title from `SP_WINDOW_TITLE` or `client.json` wins over the compiled one; see
            // `window_title_override`. The window exists by the time setup runs.
            if let Some(title) = window_title_override() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&title);
                }
            }
            let _ = app.emit("sp-native-ready", serde_json::json!({ "platform": "windows" }));
            Ok(())
        })
        .build(tauri::generate_context!())
}

/// Starts the client. A failed first attempt is retried with the next WebView2 profile folder in a
/// fresh process: WebView2 can refuse a profile with `0x800700AA` and Tauri then panics inside
/// `build` instead of returning an error, so `catch_unwind` plus a re-exec is what keeps a usable
/// profile from turning into a silent white window.
pub fn run(profiles: Vec<std::path::PathBuf>) -> i32 {
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(build_app));
    match built {
        Ok(Ok(app)) => {
            app.run(|_, _| {});
            0
        }
        Ok(Err(error)) => start_failed(&format!("原生客户端启动失败：{error}"), &profiles),
        Err(payload) => start_failed(&format!("原生客户端启动失败：{}", panic_text(payload)), &profiles),
    }
}

fn start_failed(message: &str, profiles: &[std::path::PathBuf]) -> i32 {
    append_log_any(&format!("[error] {message}\n"));
    #[cfg(windows)]
    {
        // One re-exec with the next candidate, guarded by an env marker so it cannot loop.
        let retried = std::env::var_os("SP_NATIVE_PROFILE_RETRY").is_some();
        if !retried {
            if let Some(next) = profiles.iter().find(|path| {
                std::env::var_os("WEBVIEW2_USER_DATA_FOLDER")
                    .map(|current| std::path::PathBuf::from(current) != **path)
                    .unwrap_or(true)
            }) {
                if std::fs::create_dir_all(next).is_ok() {
                    if let Ok(exe) = std::env::current_exe() {
                        append_log_any(&format!("[retry] re-exec with WebView2 profile {}\n", next.display()));
                        let status = std::process::Command::new(exe)
                            .env("WEBVIEW2_USER_DATA_FOLDER", next)
                            .env("SP_NATIVE_PROFILE_RETRY", "1")
                            .status();
                        if let Ok(status) = status {
                            if status.success() {
                                return 0;
                            }
                        }
                    }
                }
            }
        }
    }
    report_failure(message);
    1
}

#[cfg(test)]
mod title_tests {
    use super::pick_window_title;

    #[test]
    fn environment_wins_over_the_config_file() {
        assert_eq!(
            pick_window_title(Some("卫戍协议：盟约"), Some(r#"{"windowTitle":"Other"}"#)).as_deref(),
            Some("卫戍协议：盟约")
        );
    }

    #[test]
    fn a_blank_environment_value_falls_through_to_the_file() {
        assert_eq!(
            pick_window_title(Some("   "), Some(r#"{"windowTitle":"From file"}"#)).as_deref(),
            Some("From file")
        );
    }

    #[test]
    fn the_file_supplies_the_title_when_the_environment_is_unset() {
        assert_eq!(
            pick_window_title(None, Some(r#"{"windowTitle":"  卫戍协议  "}"#)).as_deref(),
            Some("卫戍协议")
        );
    }

    #[test]
    fn a_missing_or_broken_file_keeps_the_compiled_title() {
        assert_eq!(pick_window_title(None, None), None);
        assert_eq!(pick_window_title(None, Some("not json")), None);
        assert_eq!(pick_window_title(None, Some(r#"{"windowTitle":""}"#)), None);
        assert_eq!(pick_window_title(None, Some(r#"{"windowTitle":42}"#)), None);
        assert_eq!(pick_window_title(None, Some(r#"{"other":"x"}"#)), None);
    }

    /// 端到端走一遍真实取值：环境变量 → `%LOCALAPPDATA%\Stronghold Protocol Enhanced\client.json`。
    /// 改的是进程级环境变量，所以这个用例自己建临时目录、结束时还原，不与其他用例共享状态。
    #[cfg(windows)]
    #[test]
    fn the_runtime_file_is_found_where_the_installer_puts_it() {
        use super::window_title_override;

        let sandbox = std::env::temp_dir().join(format!("sp-title-{}", std::process::id()));
        let runtime = sandbox.join("Stronghold Protocol Enhanced");
        std::fs::create_dir_all(&runtime).unwrap();
        let previous_local = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", &sandbox);

        // 没有环境变量、也没有文件：返回 None，窗口保持 tauri.conf.json 的编译标题
        std::env::remove_var("SP_WINDOW_TITLE");
        assert_eq!(window_title_override(), None);

        // 文件存在：用文件里的标题
        std::fs::write(runtime.join("client.json"), r#"{"windowTitle":"文件标题"}"#).unwrap();
        assert_eq!(window_title_override().as_deref(), Some("文件标题"));

        // 环境变量优先
        std::env::set_var("SP_WINDOW_TITLE", "环境标题");
        assert_eq!(window_title_override().as_deref(), Some("环境标题"));
        std::env::remove_var("SP_WINDOW_TITLE");

        match previous_local {
            Some(value) => std::env::set_var("LOCALAPPDATA", value),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        std::fs::remove_dir_all(&sandbox).ok();
    }
}
