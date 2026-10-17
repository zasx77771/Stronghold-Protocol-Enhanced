//! The local static content server for the packaged Windows client.
//!
//! The Electron shell served the bundled client from a random loopback port over `http`. Tauri
//! replaces it with a custom URI scheme (`sp://localhost/...`), which keeps the same safety
//! properties and adds the `Range` behaviour the audio player and the WebView need:
//!
//! * no path escape and no directory listing (every request is resolved inside the client root);
//! * `Accept-Ranges: bytes` on every file, `206` + `Content-Range` for a satisfied range and
//!   `416` + `Content-Range: bytes */<size>` for a rejected one;
//! * the same MIME table, the same cache policy and `X-Content-Type-Options: nosniff`;
//! * the private R2 runtime store is consulted first, exactly like `runtimeAssets.lookup()` was.
//!
//! Everything here is pure and unit-tested: `cargo test` in `src-tauri/` runs the `#[cfg(test)]`
//! modules at the bottom of `range.rs`, `mime.rs`, `paths.rs` and this file.

use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

use crate::assets::AssetStore;
use crate::mime::mime_for_path;
use crate::paths::{resolve_within, PathError};
use crate::range::{parse, RangeOutcome};

/// Bytes of body carried by `416` / `204`-style responses; the client never parses them.
const EMPTY: &[u8] = b"";

/// The window fetches a few payloads through the same custom scheme instead of the assets it
/// serves from disk. They never touch the page's main world, so a page script cannot reach the
/// R2 store through them by accident.
pub const INTERNAL_PREFIX: &str = "__sp__/";

/// Resolve the directory that holds the bundled static client (`index.html`, `js/`, `vendor/`, …).
///
/// Tauri copies `bundle.resources` into the resource directory. The walk is ordered so a missing
/// resource directory degrades into "run next to the executable", which is what the portable ZIP
/// payload needs, instead of failing the whole window.
pub fn find_client_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("client"));
        candidates.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("client"));
            candidates.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("client"));
        candidates.push(cwd);
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
}

/// Serve one `sp://` request.
///
/// A `HEAD`-shaped request is not expressible in a custom scheme, so the response is always a full
/// body; the static client only ever renders GET responses.
pub fn serve(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw_path = request.uri().path();
    let decoded = match percent_decode(raw_path) {
        Ok(value) => value,
        Err(reason) => return plain(StatusCode::BAD_REQUEST, reason),
    };
    if !decoded.starts_with('/') || decoded.contains('\0') || decoded.contains('\\') {
        return plain(StatusCode::BAD_REQUEST, "Bad Request");
    }
    let parts: Vec<&str> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    if parts
        .iter()
        .any(|part| *part == "." || *part == ".." || part.starts_with('.'))
    {
        return plain(StatusCode::NOT_FOUND, "Not Found");
    }
    if parts.first().is_some_and(|part| *part == INTERNAL_PREFIX.trim_end_matches('/')) {
        return internal(parts.get(1).copied().unwrap_or(""));
    }

    let Some(client_root) = find_client_root(app) else {
        return plain(StatusCode::NOT_FOUND, "Not Found");
    };
    let mut relative: Vec<&str> = parts.clone();
    if parts.is_empty() || decoded.ends_with('/') {
        relative.push("index.html");
    }
    let bundled = match resolve_within(&client_root, &relative) {
        Ok(path) => path,
        Err(PathError::Forbidden) => return plain(StatusCode::FORBIDDEN, "Forbidden"),
        Err(PathError::BadRequest) => return plain(StatusCode::BAD_REQUEST, "Bad Request"),
    };

    // The private R2 store wins over the bundled file, exactly like the Electron server did.
    let relative_key = relative.join("/");
    let mut target = bundled;
    if let Some(store) = app.try_state::<AssetStore>() {
        if let Some(path) = store.lookup(&relative_key) {
            target = path;
        }
    }

    let metadata = match std::fs::metadata(&target) {
        Ok(value) if value.is_file() => value,
        // Missing files and directories are the same answer: the client has no directory listing.
        _ => return plain(StatusCode::NOT_FOUND, "Not Found"),
    };
    let size = metadata.len();
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let mut headers: Vec<(String, String)> = Vec::with_capacity(6);
    headers.push((
        "content-type".to_string(),
        mime_for_path(&target).to_string(),
    ));
    headers.push(("accept-ranges".to_string(), "bytes".to_string()));
    headers.push(("cache-control".to_string(), cache_control(&relative_key).to_string()));
    headers.push(("x-content-type-options".to_string(), "nosniff".to_string()));

    let rangeless = headers.clone();
    match parse(range_header, size) {
        RangeOutcome::Unsatisfiable => {
            let mut builder = Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("accept-ranges", "bytes")
                .header("content-range", format!("bytes */{size}"))
                .header("content-length", "0");
            if let Some(content_type) = request_content_type(&target) {
                builder = builder.header("content-type", content_type);
            }
            return builder.body(EMPTY.to_vec()).unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Error"));
        }
        RangeOutcome::Partial { start, end } => {
            let bytes = match read_slice(&target, start, end) {
                Ok(bytes) => bytes,
                Err(()) => return plain(StatusCode::NOT_FOUND, "Not Found"),
            };
            headers.push(("content-range".to_string(), format!("bytes {start}-{end}/{size}")));
            headers.push(("content-length".to_string(), bytes.len().to_string()));
            let mut builder = Response::builder().status(StatusCode::PARTIAL_CONTENT);
            for (name, value) in &headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            return builder
                .body(bytes)
                .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Error"));
        }
        RangeOutcome::Whole => {}
    }

    let bytes = match std::fs::read(&target) {
        Ok(bytes) => bytes,
        Err(_) => return plain(StatusCode::NOT_FOUND, "Not Found"),
    };
    let mut builder = Response::builder().status(StatusCode::OK);
    for (name, value) in &rangeless {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder = builder.header("content-length", bytes.len().to_string());
    builder
        .body(bytes)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Error"))
}

fn request_content_type(target: &Path) -> Option<&'static str> {
    if target.exists() {
        Some(mime_for_path(target))
    } else {
        None
    }
}

/// Static pages must always revalidate; binary assets may be cached for a day, as before.
pub fn cache_control(relative: &str) -> &'static str {
    let lower = relative.to_ascii_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".js") || lower.ends_with(".css") || lower.ends_with(".json") {
        "no-cache"
    } else {
        "public, max-age=86400"
    }
}

fn read_slice(target: &Path, start: u64, end: u64) -> Result<Vec<u8>, ()> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(target).map_err(|_| ())?;
    let length = end.saturating_sub(start) + 1;
    file.seek(SeekFrom::Start(start)).map_err(|_| ())?;
    let mut buffer = vec![0u8; usize::try_from(length).map_err(|_| ())?];
    file.read_exact(&mut buffer).map_err(|_| ())?;
    Ok(buffer)
}

/// The init script asks the native side for the internal URLs it is allowed to use. The R2 session
/// token is **not** part of this answer: it is only ever handed to Rust through `setAssetSessionToken`.
fn internal(name: &str) -> Response<Vec<u8>> {
    match name {
        "runtime" => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json; charset=utf-8")
            .header("cache-control", "no-store")
            .body(br#"{"scheme":"sp"}"#.to_vec())
            .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Error")),
        _ => plain(StatusCode::NOT_FOUND, "Not Found"),
    }
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("content-length", text.len().to_string())
        .header("cache-control", "no-store")
        .body(text.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(text.as_bytes().to_vec()))
}

/// Decode `%XX` escapes but keep `/` separators intact. A malformed escape or a decoded NUL is a
/// bad request: the Electron server rejected both the same way.
pub fn percent_decode(raw: &str) -> Result<String, &'static str> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Bad Request");
            }
            let high = hex_value(bytes[index + 1]).ok_or("Bad Request")?;
            let low = hex_value(bytes[index + 2]).ok_or("Bad Request")?;
            out.push((high << 4) | low);
            index += 3;
            continue;
        }
        out.push(byte);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| "Bad Request")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_keeps_separators_and_rejects_bad_escapes() {
        assert_eq!(percent_decode("/assets/a%20b.png").unwrap(), "/assets/a b.png");
        assert_eq!(percent_decode("/assets/%2e%2e/x").unwrap(), "/assets/../x");
        assert!(percent_decode("/%").is_err());
        assert_eq!(percent_decode("/%zz").unwrap_err(), "Bad Request");
        assert!(percent_decode("/%00").is_ok());
    }

    #[test]
    fn cache_control_matches_the_electron_policy() {
        assert_eq!(cache_control("index.html"), "no-cache");
        assert_eq!(cache_control("js/main.js"), "no-cache");
        assert_eq!(cache_control("css/ui.css"), "no-cache");
        assert_eq!(cache_control("data/assets.json"), "no-cache");
        assert_eq!(cache_control("assets/hero.png"), "public, max-age=86400");
        assert_eq!(cache_control("fonts/fonts.css"), "no-cache");
    }

    #[test]
    fn internal_prefix_is_reserved() {
        assert_eq!(INTERNAL_PREFIX.trim_end_matches('/'), "__sp__");
    }
}
