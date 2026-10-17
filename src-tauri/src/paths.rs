//! Static-file request parsing for the private `sp://localhost` protocol.
//!
//! This is the Rust port of the path half of `desktop/runtime/main.cjs` `serve()`. The safety
//! properties are the same, and they are enforced *before* any file-system call:
//!
//! * the URL is percent-decoded, and an invalid escape is refused;
//! * the decoded path must start with `/`, must not contain a NUL or a backslash;
//! * a NUL, a backslash, a query-only URL or a `..` segment is a refusal, never a fallback;
//! * any segment that is `.`, `..` or starts with `.` is refused, which is also what makes a
//!   directory listing impossible: `.`-prefixed entries and directory URLs cannot be reached;
//! * an empty segment is dropped, and a directory URL (empty or trailing `/`) resolves to
//!   `index.html`.
//!
//! The result of a safe parse is a relative POSIX path such as `js/main.js`. `resolve` then maps it
//! into the client root and re-checks that the result is still inside that root, so a mistake in the
//! parser cannot turn into a path escape.

use std::path::{Path, PathBuf};

/// A path that survived [`safe_request_path`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafePath {
    /// POSIX, relative, no leading slash, no empty/`.`/`..`/dot-prefixed segment.
    pub relative: String,
}

/// Why a request path was refused. The caller maps this to a status code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathRefusal {
    /// `decodeURIComponent` equivalent failed (a stray `%` or invalid UTF-8 escape).
    BadEncoding,
    /// `new URL()` equivalent failed (no path at all).
    BadUrl,
    /// Not rooted at `/`, contained a NUL or a backslash.
    BadShape,
    /// A `.`, `..` or `.`-prefixed segment; the original answered 404 for this.
    HiddenSegment,
}

impl PathRefusal {
    /// The status the Electron shell answered with, kept byte-compatible.
    pub fn status(self) -> u16 {
        match self {
            PathRefusal::BadEncoding | PathRefusal::BadUrl | PathRefusal::BadShape => 400,
            PathRefusal::HiddenSegment => 404,
        }
    }
}

/// Percent-decodes a URL path the way `decodeURIComponent` does for the byte sequences that matter
/// here: `%XX` becomes the raw byte, and the result must be valid UTF-8.
pub fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_string());
    }
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Reduces a request URI to the path part, mirroring `new URL(req.url, 'http://localhost')`.
///
/// Accepts a bare path (`/js/main.js?x=1`), an authority form (`sp://localhost/js/main.js`) and the
/// Windows/macOS custom-scheme normalisation (`http://sp.localhost/js/main.js`). Anything else,
/// including a scheme with a userinfo part, is refused.
pub fn request_path(uri: &str) -> Option<&str> {
    if uri.starts_with('/') {
        let end = uri.find(['?', '#']).unwrap_or(uri.len());
        return uri.get(..end);
    }
    let scheme_end = uri.find("://")?;
    let scheme = &uri[..scheme_end];
    if scheme.is_empty() || !scheme.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.') {
        return None;
    }
    let after_scheme = &uri[scheme_end + 3..];
    let path_start = after_scheme.find('/')?;
    let authority = &after_scheme[..path_start];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let path_and_more = &after_scheme[path_start..];
    let path = path_and_more.split(['?', '#']).next()?;
    Some(path)
}

/// Parses a request URI into a [`SafePath`], or explains the refusal.
pub fn safe_request_path(uri: &str) -> Result<SafePath, PathRefusal> {
    let raw_path = request_path(uri).ok_or(PathRefusal::BadUrl)?;
    let decoded = percent_decode(raw_path).ok_or(PathRefusal::BadEncoding)?;
    if !decoded.starts_with('/') || decoded.contains('\0') || decoded.contains('\\') {
        return Err(PathRefusal::BadShape);
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in decoded.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." || part.starts_with('.') {
            return Err(PathRefusal::HiddenSegment);
        }
        parts.push(part);
    }
    // An empty path (or a trailing slash) is a directory request: the original appended index.html.
    if parts.is_empty() || decoded.ends_with('/') {
        parts.push("index.html");
    }
    Ok(SafePath { relative: parts.join("/") })
}

/// Joins a relative path under `root`, refusing anything that leaves it.
///
/// `relative` is expected to come from [`safe_request_path`]; the check is repeated here so this
/// function is safe on its own.
pub fn resolve(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.ends_with('/')
        || relative.contains('\\')
        || relative.contains('\0')
    {
        return None;
    }
    let mut target = root.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\0') {
            return None;
        }
        target.push(segment);
    }
    // Both sides of the containment check must describe the same filesystem. Canonicalising only
    // the root (a symlinked, UNC or 8.3 spelling, which is what the kernel hands back on Windows
    // and what a system temp dir expands to on Unix) and comparing it against a lexically joined
    // candidate compares two different names for the same place, so every request is refused.
    // The candidate is canonicalised too. It exists by construction: each segment above is a plain
    // name appended under `root`, so a failed canonicalisation means the path is not inside it.
    let Ok(base) = root.canonicalize() else {
        return None;
    };
    let Ok(resolved) = target.canonicalize() else {
        return None;
    };
    if !resolved.starts_with(&base) {
        return None;
    }
    Some(target)
}

/// Compatibility adapter for the protocol layer: join already validated POSIX segments under root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathError {
    Forbidden,
    BadRequest,
}

pub fn resolve_within(root: &Path, segments: &[&str]) -> Result<PathBuf, PathError> {
    resolve(root, &segments.join("/")).ok_or(PathError::Forbidden)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooted_and_authority_urls_parse_the_same_way() {
        for uri in [
            "/js/main.js",
            "/js/main.js?cache=1",
            "sp://localhost/js/main.js",
            "http://sp.localhost/js/main.js",
        ] {
            assert_eq!(
                safe_request_path(uri).unwrap(),
                SafePath { relative: "js/main.js".to_string() },
                "{uri}"
            );
        }
    }

    #[test]
    fn directory_requests_become_index_html() {
        for uri in ["/", "sp://localhost/", "/?desktop=1"] {
            assert_eq!(safe_request_path(uri).unwrap().relative, "index.html", "{uri}");
        }
        assert_eq!(safe_request_path("/app/").unwrap().relative, "app/index.html");
    }

    #[test]
    fn parent_segments_are_refused() {
        assert_eq!(safe_request_path("/../secret").unwrap_err(), PathRefusal::HiddenSegment);
        assert_eq!(safe_request_path("/a/../../etc/passwd").unwrap_err(), PathRefusal::HiddenSegment);
        assert_eq!(safe_request_path("/a/..").unwrap_err(), PathRefusal::HiddenSegment);
        assert_eq!(safe_request_path("/.git/config").unwrap_err(), PathRefusal::HiddenSegment);
        assert_eq!(safe_request_path("/.env").unwrap_err(), PathRefusal::HiddenSegment);
    }

    #[test]
    fn encoded_traversal_is_refused() {
        // %2e%2e must be decoded before the segment check, or the traversal would survive.
        assert_eq!(safe_request_path("/%2e%2e/secret").unwrap_err(), PathRefusal::HiddenSegment);
        assert_eq!(safe_request_path("/%2E%2E/%2E%2E/secret").unwrap_err(), PathRefusal::HiddenSegment);
    }

    #[test]
    fn backslash_nul_and_bad_escapes_are_refused() {
        assert_eq!(safe_request_path("/js\\main.js").unwrap_err(), PathRefusal::BadShape);
        assert_eq!(safe_request_path("/js%5cmain.js").unwrap_err(), PathRefusal::BadShape);
        assert_eq!(safe_request_path("/js%00.js").unwrap_err(), PathRefusal::BadShape);
        assert_eq!(safe_request_path("/100%").unwrap_err(), PathRefusal::BadEncoding);
        assert_eq!(safe_request_path("/%zz").unwrap_err(), PathRefusal::BadEncoding);
        assert_eq!(safe_request_path("js/main.js").unwrap_err(), PathRefusal::BadUrl);
    }

    #[test]
    fn refusals_map_to_the_original_status_codes() {
        assert_eq!(PathRefusal::HiddenSegment.status(), 404);
        assert_eq!(PathRefusal::BadShape.status(), 400);
        assert_eq!(PathRefusal::BadUrl.status(), 400);
        assert_eq!(PathRefusal::BadEncoding.status(), 400);
    }

    /// A root that really exists, because the containment check canonicalises both sides.
    fn test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("sp-protocol-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("js")).unwrap();
        std::fs::write(root.join("js").join("main.js"), b"client").unwrap();
        root
    }

    #[test]
    fn resolve_stays_inside_a_real_root() {
        let root = test_root("resolve");
        assert_eq!(resolve(&root, "js/main.js").unwrap(), root.join("js").join("main.js"));
        assert!(resolve(&root, "").is_none());
        assert!(resolve(&root, "/etc/passwd").is_none());
        assert!(resolve(&root, "js/../../etc/passwd").is_none());
        assert!(resolve(&root, "js\\main.js").is_none());
        assert!(resolve(&root, "a//b").is_none());
        // A candidate that cannot be canonicalised cannot be shown to stay inside the root.
        assert!(resolve(&root, "js/missing.js").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_compares_like_with_like_when_the_root_spelling_differs() {
        let root = test_root("canonical");
        // `root/js/..` names the root through a `..`; the old code compared the canonicalised root
        // against this lexically normalised candidate and refused everything.
        let alias = root.join("js").join("..");
        assert_eq!(resolve(&alias, "js/main.js").unwrap(), alias.join("js").join("main.js"));
        assert!(resolve(&alias, "../etc/passwd").is_none());

        // The same holds for the canonical spelling, which on Windows carries the `\\?\` prefix.
        let canonical = root.canonicalize().unwrap();
        assert_eq!(resolve(&canonical, "js/main.js").unwrap(), canonical.join("js").join("main.js"));
        assert!(resolve(&canonical, "../escape.js").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_within_keeps_the_rooted_segments_inside_the_root() {
        let root = test_root("within");
        assert_eq!(
            resolve_within(&root, &["js", "main.js"]).unwrap(),
            root.join("js").join("main.js")
        );
        assert_eq!(resolve_within(&root, &["..", "escape.js"]), Err(PathError::Forbidden));
        assert_eq!(resolve_within(&root, &["js", "", "main.js"]), Err(PathError::Forbidden));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn utf8_paths_survive_decoding() {
        assert_eq!(safe_request_path("/i18n/%E7%AE%80%E4%BD%93.json").unwrap().relative, "i18n/简体.json");
        assert_eq!(percent_decode("%41%2Fb").unwrap(), "A/b");
        assert_eq!(percent_decode("plain"), Some("plain".to_string()));
    }
}
