use std::path::{Component, Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::assets::AssetStore;

const BRIDGE: &str = include_str!("../../native/bridge/stronghold-native-bridge.js");
const BRIDGE_PATH: &str = "/native/bridge.js";
const AUDIO_EXTS: [&str; 7] = [".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav"];

pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path();
    if path == BRIDGE_PATH {
        return response(StatusCode::OK, "application/javascript; charset=utf-8", BRIDGE.as_bytes().to_vec(), "no-store");
    }
    let candidates = match resource_candidates(path) {
        Some(value) => value,
        None => return response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not Found".to_vec(), "no-store"),
    };
    // The private R2 store wins over the bundled client tree: an asset is either the applied
    // generation (native update) or the offline floor that shipped with the executable.
    if let Some(store) = app.try_state::<AssetStore>() {
        for relative in &candidates {
            if let Some(file) = store.lookup(&relative.to_string_lossy()) {
                if let Ok(bytes) = std::fs::read(&file) {
                    return response(StatusCode::OK, mime_for(relative), bytes, cache_for(relative));
                }
            }
        }
    }
    let root = match client_root(app) {
        Some(value) => value,
        None => return response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Client files unavailable".to_vec(), "no-store"),
    };
    for relative in candidates {
        let file = root.join(&relative);
        if let Ok(bytes) = std::fs::read(&file) {
            if relative == Path::new("index.html") {
                let html = String::from_utf8_lossy(&bytes);
                let injected = inject_bridge(&html, "windows");
                return response(StatusCode::OK, "text/html; charset=utf-8", injected.into_bytes(), "no-store");
            }
            return response(StatusCode::OK, mime_for(&file), bytes, cache_for(&relative));
        }
    }
    response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not Found".to_vec(), "no-store")
}

pub fn client_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() { candidates.push(dir.join("client")); }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() { candidates.push(parent.join("client")); }
    }
    candidates.into_iter().find(|path| path.join("index.html").is_file())
}

/// Native pages are unversioned (no `~hash` segment), so a replaced generation must never be
/// masked by a long-lived WebView cache entry.  Revalidate everything; only the session-token
/// handshake and the private store decide freshness.
fn cache_for(relative: &Path) -> &'static str {
    let name = relative.file_name().and_then(|part| part.to_str()).unwrap_or_default();
    if relative == Path::new("index.html") || name.eq_ignore_ascii_case("sw.js") {
        return "no-store";
    }
    "no-cache"
}

fn resource_candidates(raw: &str) -> Option<Vec<PathBuf>> {
    if raw.starts_with("/sim/") && raw.rsplit('/').next()?.eq_ignore_ascii_case("nodedata.js") { return None; }
    if let Some(rest) = raw.strip_prefix("/media/") {
        let rest = match rest.strip_prefix('~') {
            Some(hashed) => hashed.split_once('/').map(|(_, value)| value)?,
            None => rest,
        };
        let base = relative_path(&format!("/assets/audio/{rest}"))?;
        let base = base.to_string_lossy().into_owned();
        return Some(AUDIO_EXTS.iter().map(|extension| PathBuf::from(format!("{base}{extension}"))).collect());
    }
    relative_path(raw).map(|path| vec![path])
}

fn relative_path(raw: &str) -> Option<PathBuf> {
    let raw = strip_hash(raw);
    let requested = if raw == "/" || raw.ends_with('/') { "index.html" } else { raw.trim_start_matches('/') };
    let path = Path::new(requested);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) { return None; }
    Some(path.to_path_buf())
}

/// A page served from a static host may still carry the upstream `~<16 hex>` content-hash
/// segment.  The native store and the bundled tree are keyed by the plain path, so the segment
/// is dropped before lookup (the segment itself is never a file name).
fn strip_hash(raw: &str) -> String {
    for root in ["/assets/", "/fonts/"] {
        if let Some(rest) = raw.strip_prefix(root) {
            if let Some((segment, tail)) = rest.split_once('/') {
                let hashed = segment.len() == 17
                    && segment.starts_with('~')
                    && segment[1..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
                if hashed { return format!("{root}{tail}"); }
            }
        }
    }
    raw.to_owned()
}

pub fn inject_bridge(html: &str, platform: &str) -> String {
    if html.contains(BRIDGE_PATH) { return html.to_owned(); }
    let tag = format!("<script src=\"{BRIDGE_PATH}\" data-sp-platform=\"{platform}\"></script>");
    html.replacen("<head>", &format!("<head>{tag}"), 1)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|part| part.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8", "js" | "mjs" => "application/javascript; charset=utf-8", "css" => "text/css; charset=utf-8",
        "json" | "atlas" | "skel" => "application/json; charset=utf-8", "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp", "ico" => "image/x-icon", "woff2" => "font/woff2", "mp3" => "audio/mpeg", "m4a" | "aac" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg", "wav" => "audio/wav", _ => "application/octet-stream",
    }
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    Response::builder().status(status).header(header::CONTENT_TYPE, content_type).header(header::CACHE_CONTROL, cache).header("x-content-type-options", "nosniff").body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn injects_once_at_the_head_anchor() {
        let page = "<html><head><title>x</title></head><body></body></html>";
        let once = inject_bridge(page, "windows");
        assert!(once.starts_with("<html><head><script src=\"/native/bridge.js\" data-sp-platform=\"windows\"></script>"));
        assert_eq!(inject_bridge(&once, "windows"), once);
    }
    #[test]
    fn refuses_path_escape_and_private_sim_loader() {
        assert!(relative_path("/../secret").is_none());
        assert!(resource_candidates("/sim/nodeData.js").is_none());
    }
    #[test]
    fn resolves_extensionless_media() {
        let candidates = resource_candidates("/media/~0123456789abcdef/bgm/act1").unwrap();
        assert_eq!(candidates[0], PathBuf::from("assets/audio/bgm/act1.mp3"));
    }
    #[test]
    fn drops_only_the_content_hash_segment() {
        assert_eq!(strip_hash("/assets/~0123456789abcdef/char/a.png"), "/assets/char/a.png");
        assert_eq!(strip_hash("/fonts/~0123456789abcdef/x.woff2"), "/fonts/x.woff2");
        assert_eq!(strip_hash("/assets/char/a.png"), "/assets/char/a.png");
        assert_eq!(strip_hash("/assets/nothex/a.png"), "/assets/nothex/a.png");
    }
}