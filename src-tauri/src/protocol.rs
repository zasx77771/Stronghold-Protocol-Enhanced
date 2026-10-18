use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tauri::http::{header, Method, Request, Response, StatusCode};
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
    // The private store wins over the bundled client tree: an asset is either the applied local
    // generation (an imported pack, if one is active) or the artwork that shipped with the installer.
    if let Some(store) = app.try_state::<AssetStore>() {
        for relative in &candidates {
            if let Some(file) = store.lookup(&relative.to_string_lossy()) {
                if let Some(served) = serve_file(request, &file, cache_for(relative)) { return served; }
            }
        }
    }
    let root = match client_root(app) {
        Some(value) => value,
        None => return response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Client files unavailable".to_vec(), "no-store"),
    };
    for relative in candidates {
        let file = root.join(&relative);
        if !file.is_file() { continue; }
        if relative == Path::new("index.html") {
            let Ok(bytes) = std::fs::read(&file) else { continue; };
            let html = String::from_utf8_lossy(&bytes);
            let injected = inject_bridge(&html, "windows");
            return response(StatusCode::OK, "text/html; charset=utf-8", injected.into_bytes(), "no-store");
        }
        if let Some(served) = serve_file(request, &file, cache_for(&relative)) { return served; }
    }
    response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not Found".to_vec(), "no-store")
}

/// Serve one file, honouring a single byte range (a seek in an audio element) and HEAD.
///
/// A full-file response is the old behaviour; a `Range` request answers 206 with `Content-Range`
/// and reads only the requested slice, and an unsatisfiable one answers 416 with `bytes */<size>`.
/// Without ranges Chromium cannot seek inside the long battle music, and a whole-file read of a
/// 60 MB track stalls the page.
fn serve_file(request: &Request<Vec<u8>>, file: &Path, cache: &str) -> Option<Response<Vec<u8>>> {
    let size = std::fs::metadata(file).ok()?.len();
    let content_type = mime_for(file);
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .header(header::ACCEPT_RANGES, "bytes")
        .header("x-content-type-options", "nosniff");
    if request.method() == Method::HEAD {
        return builder.header(header::CONTENT_LENGTH, size).body(Vec::new()).ok();
    }
    let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    match range {
        Some(raw) => match parse_range(raw, size) {
            Some((start, end)) => {
                let mut bytes = Vec::with_capacity(usize::try_from(end - start + 1).unwrap_or(0));
                let mut handle = std::fs::File::open(file).ok()?;
                handle.seek(SeekFrom::Start(start)).ok()?;
                handle.take(end - start + 1).read_to_end(&mut bytes).ok()?;
                builder
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                    .header(header::CONTENT_LENGTH, bytes.len() as u64)
                    .body(bytes)
                    .ok()
            }
            None => Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::CONTENT_LENGTH, 0u64)
                .body(Vec::new())
                .ok(),
        },
        None => {
            let bytes = std::fs::read(file).ok()?;
            builder.header(header::CONTENT_LENGTH, bytes.len() as u64).body(bytes).ok()
        }
    }
}

/// First byte range of a `Range` header: `bytes=a-b`, `bytes=a-` or the suffix form `bytes=-n`.
/// Multiple ranges are collapsed to the first one (the player only asks for one). `None` means the
/// range is unsatisfiable (`a` past the end, empty file, `-0`, `b < a`).
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start, end) = first.split_once('-')?;
    if size == 0 { return None; }
    let start = start.trim();
    let end = end.trim();
    if start.is_empty() {
        let count: u64 = end.parse().ok()?;
        if count == 0 { return None; }
        let count = count.min(size);
        return Some((size - count, size - 1));
    }
    let first_byte: u64 = start.parse().ok()?;
    if first_byte >= size { return None; }
    let last_byte = if end.is_empty() { size - 1 } else { end.parse::<u64>().ok()?.min(size - 1) };
    if last_byte < first_byte { return None; }
    Some((first_byte, last_byte))
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
    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-9999", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-0, 5-9", 1000), Some((0, 0)));
        assert_eq!(parse_range("Bytes=10-20", 1000), None);
    }
    #[test]
    fn refuses_unsatisfiable_ranges() {
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-4", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=abc-def", 1000), None);
    }
}