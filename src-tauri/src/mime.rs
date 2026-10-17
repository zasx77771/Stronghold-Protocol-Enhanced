//! Content types for the bundled client.
//!
//! Byte-for-byte port of the `MIME` table in `desktop/runtime/main.cjs`. The browser needs the exact
//! `text/javascript` type for ES modules (a wrong type is a hard module-loading failure), so the
//! table is a test-visible contract rather than a library lookup.

/// Extension (lowercase, with the dot) to `Content-Type`.
pub const MIME: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".atlas", "text/plain; charset=utf-8"),
    (".txt", "text/plain; charset=utf-8"),
    (".md", "text/markdown; charset=utf-8"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".webp", "image/webp"),
    (".gif", "image/gif"),
    (".svg", "image/svg+xml; charset=utf-8"),
    (".ico", "image/x-icon"),
    (".skel", "application/octet-stream"),
    (".bin", "application/octet-stream"),
    (".wasm", "application/wasm"),
    (".mp3", "audio/mpeg"),
    (".ogg", "audio/ogg"),
    (".oga", "audio/ogg"),
    (".opus", "audio/ogg"),
    (".wav", "audio/wav"),
    (".m4a", "audio/mp4"),
    (".aac", "audio/aac"),
    (".webm", "video/webm"),
    (".woff2", "font/woff2"),
    (".woff", "font/woff"),
    (".otf", "font/otf"),
    (".ttf", "font/ttf"),
];

/// The fallback the Electron shell used for unknown extensions.
pub const DEFAULT_MIME: &str = "application/octet-stream";

/// `Cache-Control` for markup, scripts and styles: they must not be served stale after an update.
pub const CACHE_NO_CACHE: &str = "no-cache";
/// `Cache-Control` for everything else.
pub const CACHE_LONG: &str = "public, max-age=86400";

/// Looks up the content type by file name (case-insensitive, like the `extname().toLowerCase()` call
/// in `desktop/runtime/main.cjs`).
pub fn content_type(file_name: &str) -> &'static str {
    match extension(file_name) {
        Some(ext) => extension_type(ext),
        None => DEFAULT_MIME,
    }
}

/// Looks up the content type by extension, which must include the dot.
pub fn extension_type(extension: &str) -> &'static str {
    let lowered = extension.to_ascii_lowercase();
    MIME.iter()
        .find(|(known, _)| *known == lowered)
        .map(|(_, value)| *value)
        .unwrap_or(DEFAULT_MIME)
}

/// The part of `file_name` from its last dot, dot included. `None` when there is no dot in the last
/// segment (`public/js/main` has no extension; `.hidden` counts as an extension-less name, matching
/// `path.extname`).
fn extension(file_name: &str) -> Option<&str> {
    let dot = file_name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(&file_name[dot..])
}

/// Whether the response for this file may be cached for a day (`no-cache` for markup/scripts/styles).
pub fn cache_control(file_name: &str) -> &'static str {
    let lowered = file_name.to_ascii_lowercase();
    if [".html", ".js", ".css", ".json"].iter().any(|ext| lowered.ends_with(ext)) {
        CACHE_NO_CACHE
    } else {
        CACHE_LONG
    }
}

/// Maps a file-system path to the static MIME table without introducing another MIME dependency.
pub fn mime_for_path(path: &std::path::Path) -> &'static str {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(content_type)
        .unwrap_or(DEFAULT_MIME)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_types_match_the_electron_table() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("js/main.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("vendor/preact.module.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("js/worker.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("css/app.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("asset-config.json"), "application/json; charset=utf-8");
        assert_eq!(content_type("i18n/README.md"), "text/markdown; charset=utf-8");
        assert_eq!(content_type("assets/a.png"), "image/png");
        assert_eq!(content_type("assets/a.jpeg"), "image/jpeg");
        assert_eq!(content_type("assets/a.webp"), "image/webp");
        assert_eq!(content_type("assets/a.gif"), "image/gif");
        assert_eq!(content_type("assets/a.svg"), "image/svg+xml; charset=utf-8");
        assert_eq!(content_type("favicon.ico"), "image/x-icon");
        assert_eq!(content_type("spine/skeleton.skel"), "application/octet-stream");
        assert_eq!(content_type("spine/atlas.atlas"), "text/plain; charset=utf-8");
        assert_eq!(content_type("sim/module.wasm"), "application/wasm");
        assert_eq!(content_type("audio/bgm.mp3"), "audio/mpeg");
        assert_eq!(content_type("audio/voice.ogg"), "audio/ogg");
        assert_eq!(content_type("audio/voice.oga"), "audio/ogg");
        assert_eq!(content_type("audio/voice.opus"), "audio/ogg");
        assert_eq!(content_type("audio/hit.wav"), "audio/wav");
        assert_eq!(content_type("audio/hit.m4a"), "audio/mp4");
        assert_eq!(content_type("audio/hit.aac"), "audio/aac");
        assert_eq!(content_type("video/clip.webm"), "video/webm");
        assert_eq!(content_type("fonts/a.woff2"), "font/woff2");
        assert_eq!(content_type("fonts/a.woff"), "font/woff");
        assert_eq!(content_type("fonts/a.otf"), "font/otf");
        assert_eq!(content_type("fonts/a.ttf"), "font/ttf");
    }

    #[test]
    fn extensions_are_case_insensitive() {
        assert_eq!(content_type("INDEX.HTML"), "text/html; charset=utf-8");
        assert_eq!(content_type("Assets/Picture.PNG"), "image/png");
    }

    #[test]
    fn unknown_and_absent_extensions_fall_back() {
        assert_eq!(content_type("README"), DEFAULT_MIME);
        assert_eq!(content_type("data.bin"), "application/octet-stream");
        assert_eq!(content_type("archive.7z"), DEFAULT_MIME);
        assert_eq!(content_type("js/main."), DEFAULT_MIME);
        // A dot in a directory must not leak into the extension of the file name.
        assert_eq!(content_type("main"), DEFAULT_MIME);
        assert_eq!(extension("js/main"), None);
        assert_eq!(extension(".hidden"), None);
    }

    #[test]
    fn cache_control_matches_the_original_regex() {
        assert_eq!(cache_control("index.html"), CACHE_NO_CACHE);
        assert_eq!(cache_control("js/main.js"), CACHE_NO_CACHE);
        assert_eq!(cache_control("css/app.css"), CACHE_NO_CACHE);
        assert_eq!(cache_control("data.json"), CACHE_NO_CACHE);
        assert_eq!(cache_control("index.HTML"), CACHE_NO_CACHE);
        assert_eq!(cache_control("assets/a.png"), CACHE_LONG);
        assert_eq!(cache_control("fonts/a.woff2"), CACHE_LONG);
        assert_eq!(cache_control("audio/bgm.mp3"), CACHE_LONG);
    }
}
