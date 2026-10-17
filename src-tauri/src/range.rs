//! HTTP `Range` handling and response header construction.
//!
//! Direct port of `parseRange()` and the response half of `serve()` in `desktop/runtime/main.cjs`.
//! The client plays audio and downloads spine atlases with range requests, so the exact semantics
//! matter: a malformed `Range` header is *ignored* (200), a syntactically valid but unsatisfiable
//! range is a 416 with `Content-Range: bytes */<size>` and no body, and everything else is a 206 with
//! `Content-Range: bytes <start>-<end>/<size>`.

use std::path::PathBuf;

/// `TCP`/asset responses always advertise range support, exactly like the Electron server did.
pub const ACCEPT_RANGES: &str = "bytes";
/// The header the original always set so a mis-typed file cannot be sniffed into something else.
pub const NOSNIFF: &str = "nosniff";

/// Result of parsing a `Range` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// No usable header: answer 200 with the whole file.
    Whole,
    /// Serve these byte positions inclusive.
    Partial { start: u64, end: u64 },
    /// Syntactically valid but unsatisfiable: answer 416.
    Unsatisfiable,
}

/// Parses a `Range` header for a resource of `size` bytes.
///
/// Only the single `bytes=` form is understood, which is all the browser client sends. A header that
/// does not match is treated as absent (`Whole`), matching the original's `return null`.
pub fn parse(header: Option<&str>, size: u64) -> RangeOutcome {
    let Some(raw) = header else {
        return RangeOutcome::Whole;
    };
    let trimmed = raw.trim();
    // The original used `^bytes=(\d*)-(\d*)$`, so the prefix is case-sensitive while the header
    // value is trimmed first.
    let Some(spec) = trimmed.strip_prefix("bytes=") else {
        return RangeOutcome::Whole;
    };
    if spec.contains(',') {
        // Multi-range requests are not supported by the original either; treat as absent.
        return RangeOutcome::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return RangeOutcome::Whole;
    };
    if last.contains('-') {
        return RangeOutcome::Whole;
    }
    if first.is_empty() && last.is_empty() {
        return RangeOutcome::Whole;
    }
    // Both bounds must be plain digits from here on; anything else refuses the range, which the
    // original expressed as `false` -> 416.
    let start = match first.is_empty() {
        true => None,
        false => match parse_u64(first) {
            Some(value) => Some(value),
            None => return RangeOutcome::Unsatisfiable,
        },
    };
    let end = match last.is_empty() {
        true => None,
        false => match parse_u64(last) {
            Some(value) => Some(value),
            None => return RangeOutcome::Unsatisfiable,
        },
    };
    if let Some(start) = start {
        let last_index = match end {
            Some(value) => value.min(size.saturating_sub(1)),
            None => size.saturating_sub(1),
        };
        if size == 0 || start > last_index || start >= size {
            return RangeOutcome::Unsatisfiable;
        }
        return RangeOutcome::Partial { start, end: last_index };
    }
    // Suffix form: the last N bytes. A zero-byte suffix or an empty count is unsatisfiable.
    let count = end.unwrap_or(0);
    if count == 0 {
        return RangeOutcome::Unsatisfiable;
    }
    RangeOutcome::Partial { start: size.saturating_sub(count), end: size.saturating_sub(1) }
}

/// Accepts only plain non-negative decimal digits, so `1e3`, `0x10`, `+1` and whitespace fail like
/// `Number.isSafeInteger(Number(...))` did in the original for the values that reach us.
fn parse_u64(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()
}

/// The body of a response.
#[derive(Debug, Clone)]
pub enum Body {
    /// No bytes at all (HEAD, 204, 416).
    Empty,
    /// Bytes held in memory.
    Bytes(Vec<u8>),
    /// A range of an on-disk file, read on demand.
    FileRange { path: PathBuf, start: u64, end: u64 },
}

/// A fully described response: status, headers, body.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub accept_ranges: bool,
    pub cache_control: Option<String>,
    pub nosniff: bool,
    pub content_range: Option<String>,
    pub content_length: u64,
    pub body: Body,
}

impl Response {
    /// `Cache-Control: no-store` text response, used for every error case (as `plain()` did).
    pub fn plain(status: u16, text: &str) -> Response {
        let bytes = text.as_bytes().to_vec();
        Response {
            status,
            content_type: "text/plain; charset=utf-8".to_string(),
            accept_ranges: false,
            cache_control: Some("no-store".to_string()),
            nosniff: false,
            content_range: None,
            content_length: bytes.len() as u64,
            body: Body::Bytes(bytes),
        }
    }

    /// Headers as they must be written, in a stable order so tests can assert on them.
    pub fn headers(&self) -> Vec<(String, String)> {
        let mut out = vec![("Content-Type".to_string(), self.content_type.clone())];
        if self.accept_ranges {
            out.push(("Accept-Ranges".to_string(), ACCEPT_RANGES.to_string()));
        }
        if let Some(cache) = &self.cache_control {
            out.push(("Cache-Control".to_string(), cache.clone()));
        }
        if self.nosniff {
            out.push(("X-Content-Type-Options".to_string(), NOSNIFF.to_string()));
        }
        if let Some(range) = &self.content_range {
            out.push(("Content-Range".to_string(), range.clone()));
        }
        out.push(("Content-Length".to_string(), self.content_length.to_string()));
        out
    }

    /// `Some(bytes)` when the body is held in memory, `None` when it must be read from disk.
    #[cfg(test)]
    pub fn body_bytes(&self) -> Option<usize> {
        match &self.body {
            Body::Empty => Some(0),
            Body::Bytes(bytes) => Some(bytes.len()),
            Body::FileRange { .. } => None,
        }
    }
}

/// Builds the response for a file of `size` bytes named `file_name` at `path`, honouring `range`.
///
/// `head_only` reproduces the original's HEAD behaviour: the status, headers and `Content-Length` are
/// identical to the GET response, only the body is dropped.
pub fn respond(
    path: &std::path::Path,
    file_name: &str,
    size: u64,
    range: Option<&str>,
    head_only: bool,
) -> Response {
    let content_type = super::mime::content_type(file_name).to_string();
    let cache = super::mime::cache_control(file_name).to_string();
    match parse(range, size) {
        RangeOutcome::Unsatisfiable => Response {
            status: 416,
            content_type,
            accept_ranges: true,
            cache_control: None,
            nosniff: true,
            content_range: Some(format!("bytes */{size}")),
            content_length: 0,
            body: Body::Empty,
        },
        RangeOutcome::Partial { start, end } => {
            let length = end - start + 1;
            Response {
                status: 206,
                content_type,
                accept_ranges: true,
                cache_control: Some(cache),
                nosniff: true,
                content_range: Some(format!("bytes {start}-{end}/{size}")),
                content_length: length,
                body: if head_only {
                    Body::Empty
                } else {
                    Body::FileRange { path: path.to_path_buf(), start, end }
                },
            }
        }
        RangeOutcome::Whole => Response {
            status: 200,
            content_type,
            accept_ranges: true,
            cache_control: Some(cache),
            nosniff: true,
            content_range: None,
            content_length: size,
            body: if head_only || size == 0 {
                Body::Empty
            } else {
                Body::FileRange { path: path.to_path_buf(), start: 0, end: size - 1 }
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn absent_or_malformed_headers_serve_everything() {
        for header in [None, Some(""), Some("items=0-10"), Some("bytes="), Some("bytes=-")] {
            assert_eq!(parse(header, 100), RangeOutcome::Whole, "{header:?}");
        }
    }

    #[test]
    fn multi_range_and_negative_forms_are_ignored_like_the_original() {
        assert_eq!(parse(Some("bytes=1-2,3-4"), 100), RangeOutcome::Whole);
        assert_eq!(parse(Some("bytes=1-2-3"), 100), RangeOutcome::Whole);
    }

    #[test]
    fn non_numeric_bounds_are_refused() {
        assert_eq!(parse(Some("bytes=abc-def"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse(Some("bytes=1.5-2"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse(Some("bytes=+1-2"), 100), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn explicit_ranges_are_inclusive_and_clamped() {
        assert_eq!(parse(Some("bytes=0-9"), 100), RangeOutcome::Partial { start: 0, end: 9 });
        assert_eq!(parse(Some("bytes=10-"), 100), RangeOutcome::Partial { start: 10, end: 99 });
        assert_eq!(parse(Some("bytes=0-999"), 100), RangeOutcome::Partial { start: 0, end: 99 });
        assert_eq!(parse(Some("bytes=99-99"), 100), RangeOutcome::Partial { start: 99, end: 99 });
        assert_eq!(parse(Some("bytes=50-60"), 100), RangeOutcome::Partial { start: 50, end: 60 });
        // The original trimmed the header before matching.
        assert_eq!(parse(Some(" bytes=0-9 "), 100), RangeOutcome::Partial { start: 0, end: 9 });
        assert_eq!(parse(Some("BYTES=0-9"), 100), RangeOutcome::Whole);
    }

    #[test]
    fn suffix_ranges_count_from_the_end() {
        assert_eq!(parse(Some("bytes=-10"), 100), RangeOutcome::Partial { start: 90, end: 99 });
        assert_eq!(parse(Some("bytes=-1000"), 100), RangeOutcome::Partial { start: 0, end: 99 });
        assert_eq!(parse(Some("bytes=-1"), 10), RangeOutcome::Partial { start: 9, end: 9 });
        // A zero-byte suffix is unsatisfiable rather than "the whole file".
        assert_eq!(parse(Some("bytes=-0"), 100), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn unsatisfiable_ranges_are_reported_as_416() {
        assert_eq!(parse(Some("bytes=100-200"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse(Some("bytes=200-100"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse(Some("bytes=0-0"), 0), RangeOutcome::Unsatisfiable);
        assert_eq!(parse(Some("bytes=0-"), 0), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn sixteens_carry_the_expected_headers() {
        let path = Path::new("/tmp/client/audio/bgm.mp3");
        let response = respond(path, "bgm.mp3", 1000, Some("bytes=100-199"), false);
        assert_eq!(response.status, 206);
        assert_eq!(response.content_range.as_deref(), Some("bytes 100-199/1000"));
        assert_eq!(response.content_length, 100);
        assert_eq!(response.content_type, "audio/mpeg");
        assert_eq!(response.cache_control.as_deref(), Some("public, max-age=86400"));
        assert!(response.accept_ranges);
        assert!(response.nosniff);
        assert_eq!(
            response.headers(),
            vec![
                ("Content-Type".to_string(), "audio/mpeg".to_string()),
                ("Accept-Ranges".to_string(), "bytes".to_string()),
                ("Cache-Control".to_string(), "public, max-age=86400".to_string()),
                ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
                ("Content-Range".to_string(), "bytes 100-199/1000".to_string()),
                ("Content-Length".to_string(), "100".to_string()),
            ]
        );
        assert!(matches!(response.body, Body::FileRange { start: 100, end: 199, .. }));
    }

    #[test]
    fn whole_file_responses_are_200_with_a_length() {
        let path = Path::new("/tmp/client/index.html");
        let response = respond(path, "index.html", 1234, None, false);
        assert_eq!(response.status, 200);
        assert_eq!(response.content_length, 1234);
        assert_eq!(response.content_range, None);
        assert_eq!(response.cache_control.as_deref(), Some("no-cache"));
        assert_eq!(response.body_bytes(), None);
    }

    #[test]
    fn head_requests_have_no_body_but_the_same_length() {
        let path = Path::new("/tmp/client/index.html");
        let get = respond(path, "index.html", 1234, None, false);
        let head = respond(path, "index.html", 1234, None, true);
        assert_eq!(get.content_length, head.content_length);
        assert_eq!(get.headers(), head.headers());
        assert!(matches!(head.body, Body::Empty));
        let ranged = respond(path, "index.html", 1234, Some("bytes=0-9"), true);
        assert_eq!(ranged.status, 206);
        assert_eq!(ranged.content_length, 10);
        assert!(matches!(ranged.body, Body::Empty));
    }

    #[test]
    fn unsnarisfiable_headers_are_416_without_a_body() {
        let path = Path::new("/tmp/client/index.html");
        let response = respond(path, "index.html", 100, Some("bytes=100-200"), false);
        assert_eq!(response.status, 416);
        assert_eq!(response.content_range.as_deref(), Some("bytes */100"));
        assert_eq!(response.content_length, 0);
        assert!(response.cache_control.is_none());
        assert!(matches!(response.body, Body::Empty));
        assert_eq!(
            response.headers(),
            vec![
                ("Content-Type".to_string(), "text/html; charset=utf-8".to_string()),
                ("Accept-Ranges".to_string(), "bytes".to_string()),
                ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
                ("Content-Range".to_string(), "bytes */100".to_string()),
                ("Content-Length".to_string(), "0".to_string()),
            ]
        );
    }
}
