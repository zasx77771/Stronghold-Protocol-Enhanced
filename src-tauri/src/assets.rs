//! Private R2 runtime assets: the client-side half of the session-protected asset pipeline.
//!
//! Port of `desktop/runtime/assets.cjs` (the Electron main-process module) plus the client-relevant
//! subset of `tools/assetPackages.mjs`. The security properties are the ones the release policy
//! depends on and they are all enforced here, in native code:
//!
//! * the page only ever hands over the 32-hex **session token** it received from the game server;
//! * the native side exchanges that token for the short-lived **Worker JWT** over HTTPS, and the JWT
//!   never enters the webview — it is not returned from any command, logged or stored;
//! * the JWT is sent to exactly one origin: a redirect to another origin is refused *before* the
//!   request is repeated;
//! * `tokenUrl` must be HTTPS with no credentials and no query string, whatever `allowHttp` says;
//! * every downloaded byte is accounted against a byte limit, and every extracted entry must be
//!   listed in the signed-package manifest with a matching SHA-256.
//!
//! Everything that can be decided without the network is a pure function with `#[cfg(test)]` tests,
//! so `cargo test` covers the whole safety surface without a toolchain-less environment.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------------------------
// Formats and limits (mirrors tools/assetPackages.mjs)
// ---------------------------------------------------------------------------------------------

pub const CONFIG_FORMAT: &str = "sp-assets-config-v1";
pub const INDEX_FORMAT: &str = "sp-assets-index-v1";
pub const STORE_FORMAT: &str = "sp-assets-store-v1";
pub const PACKAGE_FORMAT: &str = "sp-assets-package-v1";
pub const STATE_FORMAT: &str = "sp-assets-state-v1";

pub const CONFIG_FILE: &str = "asset-config.json";
pub const STORE_FILE: &str = "asset-store.json";
pub const INDEX_FILE: &str = "asset-index.json";
pub const LAYER_DIR: &str = "asset-layers";
pub const STAGING_DIR: &str = "asset-staging";
pub const RETIRED_DIR: &str = "asset-retired";
pub const PACKAGE_MANIFEST: &str = "ASSETS.json";
pub const PACKAGE_FILE: &str = "asset-package.zip";

pub const KIND_BASE: &str = "base";
pub const KIND_DELTA: &str = "delta";

pub const DEFAULT_MAX_CHAIN: usize = 3;
pub const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 1536 * 1024 * 1024;
pub const DEFAULT_MAX_EXTRACT_BYTES: u64 = 4096 * 1024 * 1024;
pub const DEFAULT_MAX_INDEX_BYTES: u64 = 1024 * 1024;

/// Directories that a package may ship, and single files that always belong to the store.
pub const ASSET_DIRS: [&str; 2] = ["assets/", "fonts/"];
pub const ASSET_FILES: [&str; 2] = ["data/assets.json", "data/local-assets.json"];

const MAX_REDIRECTS: usize = 3;
const USER_AGENT: &str = "StrongholdProtocolAssets/1";
const TOKEN_TIMEOUT: Duration = Duration::from_secs(20);

/// Defensive ceiling on the entries one package may declare, independent of the byte budget: a zip
/// header is attacker-controlled and can name millions of entries without shipping any bytes.
const MAX_EXTRACT_ENTRIES: usize = 100_000;

// ---------------------------------------------------------------------------------------------
// Small JSON helpers (the manifests are read from disk and from the network, so nothing is trusted)
// ---------------------------------------------------------------------------------------------

fn field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    value.as_object()?.get(key)
}

fn string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    field(value, key)?.as_str().map(str::to_string)
}

fn u64_field(value: &serde_json::Value, key: &str) -> Option<u64> {
    field(value, key)?.as_u64()
}

/// A file entry in a package manifest or a store layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub size: u64,
    pub sha256: String,
}

// ---------------------------------------------------------------------------------------------
// Token shapes
// ---------------------------------------------------------------------------------------------

/// The game server hands the page a 32-hex session token. Anything else is ignored, exactly like
/// `SESSION_TOKEN.test()` in `desktop/runtime/assets.cjs`.
pub fn is_session_token(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// The Worker answers with a short-lived JWT. `header.payload.signature`, base64url alphabet.
pub fn is_jwt(value: &str) -> bool {
    let mut parts = value.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    [header, payload, signature].iter().all(|part| {
        !part.is_empty()
            && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

// ---------------------------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------------------------

/// The `configuredUrl()` rule: HTTPS (or HTTP only when `allowHttp`), a host, no credentials, no
/// query string, no fragment.
pub fn configured_url(value: &str, allow_http: bool) -> Option<url::Url> {
    let parsed = url::Url::parse(value).ok()?;
    let scheme = parsed.scheme();
    let allowed = scheme == "https" || (allow_http && scheme == "http");
    if !allowed {
        return None;
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return None;
    }
    Some(parsed)
}

/// The `tokenUrl` rule: always HTTPS, never HTTP, whatever the index allows.
pub fn configured_token_url(value: &str) -> Option<url::Url> {
    configured_url(value, false)
}

// ---------------------------------------------------------------------------------------------
// Path rules (port of isAssetPath / assetPathProblem / safeJoin)
// ---------------------------------------------------------------------------------------------

/// Whether a client-relative path belongs to the runtime asset store.
pub fn is_asset_path(relative: &str) -> bool {
    if relative.is_empty() || relative.starts_with('/') || relative.ends_with('/') {
        return false;
    }
    if ASSET_FILES.contains(&relative) {
        return true;
    }
    ASSET_DIRS.iter().any(|dir| relative.starts_with(dir) && relative.len() > dir.len())
}

/// The exact problems `assetPathProblem()` reported, in the same order.
pub fn asset_path_problem(relative: &str) -> Option<&'static str> {
    if relative.is_empty() {
        return Some("empty path");
    }
    if relative.contains('\\') {
        return Some("backslash in path");
    }
    if relative.starts_with('/') {
        return Some("absolute path");
    }
    if relative.ends_with('/') {
        return Some("trailing slash");
    }
    let bytes = relative.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some("drive-letter path");
    }
    if relative.contains("//") {
        return Some("empty path segment");
    }
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Some("unsafe path segment");
        }
    }
    if relative.chars().any(|c| c.is_ascii_control() || c == '\u{7f}') {
        return Some("control character in path");
    }
    if relative.chars().any(|c| !matches!(c, '\u{20}'..='\u{7e}')) {
        return Some("non-ASCII path");
    }
    if relative.ends_with(char::is_whitespace) {
        return Some("trailing whitespace in path");
    }
    None
}

/// `safeJoin()`: join and prove the result stays inside `root`.
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if let Some(problem) = asset_path_problem(relative) {
        return Err(format!("asset path {relative}: {problem}"));
    }
    let mut target = root.to_path_buf();
    for segment in relative.split('/') {
        target.push(segment);
    }
    let base = root.to_path_buf();
    if target != base && !target.starts_with(&base) {
        return Err(format!("asset path escapes the tree: {relative}"));
    }
    Ok(target)
}

// ---------------------------------------------------------------------------------------------
// Inventory digest (shared byte-for-byte with the Android client and the release tooling)
// ---------------------------------------------------------------------------------------------

/// `inventoryLines()`: sorted keys, `key\tsize\tsha256\n`.
pub fn inventory_lines(files: &BTreeMap<String, FileEntry>) -> String {
    let mut out = String::new();
    for (path, entry) in files {
        out.push_str(&format!("{}\t{}\t{}\n", path, entry.size, entry.sha256.to_ascii_lowercase()));
    }
    out
}

/// `inventoryDigest()`: SHA-256 hex of [`inventory_lines`].
pub fn inventory_digest(files: &BTreeMap<String, FileEntry>) -> String {
    hex::encode(Sha256::digest(inventory_lines(files).as_bytes()))
}

/// `sha256Hex()` for a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

// ---------------------------------------------------------------------------------------------
// Versions and route planning
// ---------------------------------------------------------------------------------------------

/// `compareVersions()`: numeric per dot-segment.
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let l: Vec<u64> = left.split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect();
    let r: Vec<u64> = right.split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect();
    for index in 0..l.len().max(r.len()) {
        let a = l.get(index).copied().unwrap_or(0);
        let b = r.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// One published package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageStep {
    pub kind: String,
    pub from: Option<String>,
    pub to: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// Published metadata for a version's runtime asset set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionInfo {
    pub inventory: String,
    /// A metadata-only release may delegate to the version whose packages carry identical bytes.
    pub reused: Option<String>,
}

/// The published index (`assets-index.json`).
#[derive(Debug, Clone, Default)]
pub struct AssetIndex {
    pub latest: String,
    /// version -> published inventory and optional payload provider
    pub versions: BTreeMap<String, VersionInfo>,
    /// base packages by version
    pub bases: BTreeMap<String, PackageStep>,
    /// `(from, to)` -> delta package
    pub deltas: BTreeMap<(String, String), PackageStep>,
}

/// Why the index was refused.
pub fn check_index(value: &serde_json::Value) -> Result<AssetIndex, Vec<String>> {
    let mut problems = Vec::new();
    if !value.is_object() {
        return Err(vec!["index: not an object".to_string()]);
    }
    if string_field(value, "format").as_deref() != Some(INDEX_FORMAT) {
        problems.push(format!("index: format {}", string_field(value, "format").unwrap_or_default()));
    }
    let latest = string_field(value, "latest").unwrap_or_default();
    if latest.is_empty() {
        problems.push("index: latest is required".to_string());
    }
    let mut versions = BTreeMap::new();
    if let Some(map) = field(value, "versions").and_then(|v| v.as_object()) {
        for (version, entry) in map {
            match string_field(entry, "inventory") {
                Some(inventory) => {
                    versions.insert(version.clone(), VersionInfo {
                        inventory: inventory.to_ascii_lowercase(),
                        reused: string_field(entry, "reused"),
                    });
                }
                None => problems.push(format!("index: version {version} is missing an inventory digest")),
            }
        }
    } else {
        problems.push("index: versions is required".to_string());
    }

    let mut bases = BTreeMap::new();
    let mut deltas = BTreeMap::new();
    for (kind, list) in [(KIND_BASE, field(value, "bases")), (KIND_DELTA, field(value, "deltas"))] {
        let Some(items) = list.and_then(|v| v.as_array()) else {
            problems.push(format!("index: {kind}s is required"));
            continue;
        };
        for item in items {
            let name = string_field(item, "name").unwrap_or_default();
            let sha256 = string_field(item, "sha256").unwrap_or_default().to_ascii_lowercase();
            let from = string_field(item, "from");
            let to = string_field(item, "to").unwrap_or_default();
            let size = u64_field(item, "size").unwrap_or(0);
            if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                problems.push(format!("index: {name} has no sha256 digest"));
                continue;
            }
            if kind == KIND_BASE {
                let expected = format!("assets-base-{to}.zip");
                if name != expected {
                    problems.push(format!("index: base package {name} must be {expected}"));
                    continue;
                }
                bases.insert(to.clone(), PackageStep {
                    kind: KIND_BASE.to_string(),
                    from: None,
                    to,
                    name,
                    size,
                    sha256,
                });
            } else {
                let from = from.unwrap_or_default();
                let expected = format!("assets-delta-{from}-{to}.zip");
                if name != expected {
                    problems.push(format!("index: delta package {name} must be {expected}"));
                    continue;
                }
                deltas.insert((from.clone(), to.clone()), PackageStep {
                    kind: KIND_DELTA.to_string(),
                    from: Some(from),
                    to,
                    name,
                    size,
                    sha256,
                });
            }
        }
    }
    if problems.is_empty() {
        Ok(AssetIndex { latest, versions, bases, deltas })
    } else {
        Err(problems)
    }
}

/// Reads the index from disk.
pub fn read_index(path: &Path) -> Result<AssetIndex, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("asset index unreadable: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("asset index is not JSON: {error}"))?;
    check_index(&value).map_err(|problems| format!("asset index is invalid: {}", problems.join("; ")))
}

/// Local state as `loadInventory()` computes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalInventory {
    pub version: Option<String>,
    pub inventory: Option<String>,
}

/// What to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub status: String,
    pub reason: String,
    pub steps: Vec<PackageStep>,
    pub bytes: u64,
    pub verification: String,
}

/// True when an index still publishes a payload under this version (directly or as a delta target).
fn version_provides(index: &AssetIndex, version: &str) -> bool {
    index.bases.contains_key(version) || index.deltas.keys().any(|(_, to)| to == version)
}

/// Resolve a metadata-only release to the version that actually publishes its identical bytes.
/// Cycles and missing providers deliberately resolve to the original version, matching the Node planner.
fn resolve_provider_version(index: &AssetIndex, version: &str) -> String {
    let original = version.to_string();
    let mut current = original.clone();
    let mut seen = vec![current.clone()];
    for _ in 0..8 {
        let Some(next) = index.versions.get(&current).and_then(|info| info.reused.clone()) else { break; };
        if seen.contains(&next) || !version_provides(index, &next) { return original; }
        seen.push(next.clone());
        current = next;
    }
    current
}

/// `planRoute()`: decide between "nothing to do", a delta chain and a fresh base.
pub fn plan_route(index: &AssetIndex, local: &LocalInventory, max_chain: usize) -> Route {
    let latest = index.latest.clone();
    let mut verification = match (&local.version, &local.inventory) {
        (Some(version), Some(inventory)) => match index.versions.get(version) {
            Some(published) if published.inventory == *inventory => "ok",
            Some(_) => "mismatch",
            None => "unpublished",
        },
        (Some(version), None) => if index.versions.contains_key(version) { "mismatch" } else { "unpublished" },
        _ => "unknown",
    };
    let provider = local.version.as_deref().map(|version| resolve_provider_version(index, version));
    if provider.as_ref() != local.version.as_ref() {
        if let (Some(_provider), Some(inventory), Some(published)) = (&provider, &local.inventory, provider.as_ref().and_then(|version| index.versions.get(version))) {
            verification = if published.inventory == *inventory { "ok" } else { "mismatch" };
        }
    }
    let target = resolve_provider_version(index, &latest);

    if provider.as_deref() == Some(target.as_str()) && verification != "mismatch" {
        let reason = if provider == local.version {
            if target == latest { format!("already on {latest}") } else { format!("already on the asset set published for {latest}") }
        } else {
            format!("{} reuses the payload published for {}", local.version.as_deref().unwrap_or_default(), provider.as_deref().unwrap_or_default())
        };
        return Route { status: "current".to_string(), reason, steps: Vec::new(), bytes: 0, verification: verification.to_string() };
    }

    if let Some(provider) = &provider {
        if verification == "ok" {
            if let Some(chain) = shortest_delta_chain(index, provider, &target, max_chain) {
                if !chain.is_empty() {
                    let bytes = chain.iter().map(|step| step.size).sum();
                    return Route { status: "update".to_string(), reason: format!("{} delta package(s) from {provider}", chain.len()), steps: chain, bytes, verification: verification.to_string() };
                }
            }
        }
    }

    if let Some(base) = best_base_route(index, &target, max_chain) {
        let bytes = base.iter().map(|step| step.size).sum();
        let base_version = base[0].to.clone();
        let (status, reason) = match (&local.version, verification) {
            (Some(version), "mismatch") => ("repair", format!("local state does not match published {version}; using a fresh base")),
            (None, _) => ("update", "no local state; using a base package".to_string()),
            _ => ("update", format!("no usable delta chain; base {base_version}")),
        };
        return Route { status: status.to_string(), reason, steps: base, bytes, verification: verification.to_string() };
    }

    if provider.as_deref() == Some(target.as_str()) {
        return Route { status: "current".to_string(), reason: format!("already on {latest}"), steps: Vec::new(), bytes: 0, verification: verification.to_string() };
    }
    Route { status: "blocked".to_string(), reason: "the index has no route to the latest version".to_string(), steps: Vec::new(), bytes: 0, verification: verification.to_string() }
}

/// Breadth-first search over delta packages, at most `max_chain` steps.
fn shortest_delta_chain(index: &AssetIndex, from: &str, to: &str, max_chain: usize) -> Option<Vec<PackageStep>> {
    if from == to { return Some(Vec::new()); }
    if max_chain == 0 { return None; }
    let mut frontier: Vec<(String, Vec<PackageStep>)> = vec![(from.to_string(), Vec::new())];
    let mut visited: Vec<String> = vec![from.to_string()];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for (version, path) in frontier {
            if path.len() >= max_chain { continue; }
            for ((delta_from, delta_to), step) in &index.deltas {
                if delta_from != &version || visited.contains(delta_to) { continue; }
                let mut extended = path.clone();
                extended.push(step.clone());
                if delta_to == to { return Some(extended); }
                visited.push(delta_to.clone());
                next.push((delta_to.clone(), extended));
            }
        }
        frontier = next;
    }
    None
}

/// A base package plus the shortest delta chain from it to `to`.
fn best_base_route(index: &AssetIndex, to: &str, max_chain: usize) -> Option<Vec<PackageStep>> {
    let mut best: Option<Vec<PackageStep>> = None;
    for (version, base) in &index.bases {
        let mut route = vec![base.clone()];
        if version != to {
            match shortest_delta_chain(index, version, to, max_chain) {
                Some(chain) => route.extend(chain),
                None => continue,
            }
        }
        if best.as_ref().map(|current| route.len() < current.len()).unwrap_or(true) { best = Some(route); }
    }
    best
}
// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/// The validated runtime configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub index_url: url::Url,
    pub token_url: url::Url,
    pub allow_http: bool,
    pub max_chain: usize,
    pub max_index_bytes: u64,
    pub max_download_bytes: u64,
    pub max_extract_bytes: u64,
}

/// Outcome of reading `asset-config.json`.
#[derive(Debug, Clone)]
pub enum ConfigOutcome {
    Disabled { reason: String },
    Enabled(Box<RuntimeConfig>),
}

/// `checkConfig()` from `tools/assetPackages.mjs`.
pub fn check_config(value: &serde_json::Value) -> Vec<String> {
    let mut problems = Vec::new();
    if !value.is_object() {
        return vec!["config: not an object".to_string()];
    }
    if string_field(value, "format").as_deref() != Some(CONFIG_FORMAT) {
        problems.push(format!("config: format {}", string_field(value, "format").unwrap_or_default()));
    }
    let Some(index_url) = string_field(value, "indexUrl") else {
        problems.push("config: indexUrl is required".to_string());
        return problems;
    };
    if !index_url.starts_with("http://") && !index_url.starts_with("https://") {
        problems.push("config: indexUrl must be an http(s) URL".to_string());
    } else {
        match url::Url::parse(&index_url) {
            Ok(parsed) => {
                if !parsed.username().is_empty() || parsed.password().is_some() {
                    problems.push("config: indexUrl must not carry credentials".to_string());
                }
                let allow_http = field(value, "allowHttp").and_then(|v| v.as_bool()).unwrap_or(false);
                if !allow_http && parsed.scheme() != "https" {
                    problems.push("config: indexUrl must use https".to_string());
                }
                if let Some(query) = parsed.query() {
                    let lowered = query.to_ascii_lowercase();
                    for banned in ["sig", "signature", "token", "key", "secret", "x-amz-"] {
                        if lowered.contains(banned) {
                            problems.push(
                                "config: indexUrl must not carry signature or token parameters".to_string(),
                            );
                            break;
                        }
                    }
                }
            }
            Err(_) => problems.push("config: indexUrl is not a valid URL".to_string()),
        }
    }
    for key in ["maxChain", "maxDownloadBytes", "maxExtractBytes"] {
        if let Some(entry) = field(value, key) {
            let ok = entry.as_f64().map(|number| number.is_finite() && number > 0.0).unwrap_or(false);
            if !ok {
                problems.push(format!("config: {key} must be a positive number"));
            }
        }
    }
    problems
}

/// `readConfig()`: read `<client_root>/asset-config.json` and validate it.
pub fn read_config(client_root: &Path) -> ConfigOutcome {
    let path = client_root.join(CONFIG_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => {
            return ConfigOutcome::Disabled { reason: "no configuration".to_string() };
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            return ConfigOutcome::Disabled { reason: "invalid configuration".to_string() };
        }
    };
    let problems = check_config(&value);
    if !problems.is_empty() {
        return ConfigOutcome::Disabled { reason: problems.join("; ") };
    }
    let allow_http = field(&value, "allowHttp").and_then(|v| v.as_bool()).unwrap_or(false);
    let index_url = string_field(&value, "indexUrl").unwrap_or_default();
    let Some(index_url) = configured_url(&index_url, allow_http) else {
        return ConfigOutcome::Disabled { reason: "invalid index URL".to_string() };
    };
    let token_url = string_field(&value, "tokenUrl").unwrap_or_default();
    let Some(token_url) = configured_token_url(&token_url) else {
        return ConfigOutcome::Disabled {
            reason: "config: tokenUrl must be an HTTPS URL without credentials or query".to_string(),
        };
    };
    ConfigOutcome::Enabled(Box::new(RuntimeConfig {
        index_url,
        token_url,
        allow_http,
        max_chain: u64_field(&value, "maxChain").unwrap_or(DEFAULT_MAX_CHAIN as u64) as usize,
        max_index_bytes: u64_field(&value, "maxIndexBytes").unwrap_or(DEFAULT_MAX_INDEX_BYTES),
        max_download_bytes: u64_field(&value, "maxDownloadBytes").unwrap_or(DEFAULT_MAX_DOWNLOAD_BYTES),
        max_extract_bytes: u64_field(&value, "maxExtractBytes").unwrap_or(DEFAULT_MAX_EXTRACT_BYTES),
    }))
}

// ---------------------------------------------------------------------------------------------
// Store: layers, manifests, lookup
// ---------------------------------------------------------------------------------------------

/// A store layer on disk, newest last.
#[derive(Debug, Clone)]
pub struct Layer {
    pub dir: PathBuf,
    pub generation: u32,
    pub kind: String,
    pub version: String,
    pub files: BTreeMap<String, FileEntry>,
}

/// The merged local state.
#[derive(Debug, Clone, Default)]
pub struct StoreState {
    pub version: Option<String>,
    pub inventory: Option<String>,
    pub files: BTreeMap<String, FileEntry>,
    pub layers: Vec<Layer>,
}

/// Reads one layer manifest (`<layer>/ASSETS.json`).
fn read_layer(dir: &Path, generation: u32) -> Option<Layer> {
    let text = std::fs::read_to_string(dir.join(PACKAGE_MANIFEST)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let files = manifest_files(&value)?;
    Some(Layer {
        dir: dir.to_path_buf(),
        generation,
        kind: string_field(&value, "kind").unwrap_or_else(|| KIND_DELTA.to_string()),
        version: string_field(&value, "version").unwrap_or_default(),
        files,
    })
}

/// Extracts `files` from a manifest, refusing unusable entries.
pub fn manifest_files(value: &serde_json::Value) -> Option<BTreeMap<String, FileEntry>> {
    let map = field(value, "files")?.as_object()?;
    let mut files = BTreeMap::new();
    for (path, entry) in map {
        let size = u64_field(entry, "size")?;
        let sha256 = string_field(entry, "sha256")?;
        files.insert(path.clone(), FileEntry { size, sha256: sha256.to_ascii_lowercase() });
    }
    Some(files)
}

/// `readStore()` + `loadInventory()`: merge the store layers into one inventory.
pub fn load_store(root: &Path) -> Result<StoreState, String> {
    let mut state = StoreState::default();
    let layer_root = root.join(LAYER_DIR);
    let mut layers: Vec<Layer> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&layer_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let generation = name
                .split('-')
                .next()
                .and_then(|prefix| prefix.parse::<u32>().ok())
                .unwrap_or(u32::MAX);
            if let Some(layer) = read_layer(&entry.path(), generation) {
                layers.push(layer);
            }
        }
    }
    layers.sort_by(|left, right| left.generation.cmp(&right.generation));

    for layer in &layers {
        if layer.kind == KIND_BASE {
            state.files.clear();
        }
        for (path, entry) in &layer.files {
            state.files.insert(path.clone(), entry.clone());
        }
        state.version = Some(layer.version.clone());
    }
    if !state.files.is_empty() {
        state.inventory = Some(inventory_digest(&state.files));
    }
    state.layers = layers;
    Ok(state)
}

/// `lookupAsset()`: newest layer first, then the floor tree.
pub fn lookup_asset(root: &Path, relative: &str) -> Option<PathBuf> {
    if let Some(problem) = asset_path_problem(relative) {
        let _ = problem;
        return None;
    }
    let state = load_store(root).ok()?;
    if !state.files.contains_key(relative) {
        return None;
    }
    for layer in state.layers.iter().rev() {
        if layer.files.contains_key(relative) {
            let candidate = layer.dir.join("files").join(relative);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let retired = root.join(RETIRED_DIR).join(relative);
    if retired.is_file() {
        return Some(retired);
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Package extraction
// ---------------------------------------------------------------------------------------------

/// Entries a package may declare. Every written entry costs at least one byte of the extraction
/// budget, so the budget bounds the count as well; [`MAX_EXTRACT_ENTRIES`] keeps a huge budget from
/// trusting a huge archive header.
fn max_extract_entries(max_extract_bytes: u64) -> usize {
    usize::try_from(max_extract_bytes.min(MAX_EXTRACT_ENTRIES as u64)).unwrap_or(MAX_EXTRACT_ENTRIES)
}

/// Extracts a verified package into `destination/files`.
pub fn extract_package(
    package_file: &Path,
    manifest: &serde_json::Value,
    destination: &Path,
    max_extract_bytes: u64,
) -> Result<Vec<String>, String> {
    let files = manifest_files(manifest)
        .ok_or_else(|| "package manifest is invalid".to_string())?;
    let declared: u64 = files.values().map(|entry| entry.size).sum();
    if declared > max_extract_bytes {
        return Err(format!(
            "package extracts {declared} bytes, above the {max_extract_bytes} byte limit"
        ));
    }
    let file = std::fs::File::open(package_file).map_err(|error| format!("package unreadable: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("package is not a zip archive: {error}"))?;
    std::fs::create_dir_all(destination).map_err(|error| format!("cannot create staging: {error}"))?;
    let entry_limit = max_extract_entries(max_extract_bytes);
    if archive.len() > entry_limit {
        return Err(format!(
            "package holds {} entries, above the {entry_limit} entry limit",
            archive.len()
        ));
    }
    let mut written: Vec<String> = Vec::new();
    let mut extracted: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("package entry error: {error}"))?;
        let name = entry.name().to_string();
        if name == PACKAGE_MANIFEST || name == "STATE.json" {
            continue;
        }
        if entry.is_dir() {
            continue;
        }
        if let Some(problem) = asset_path_problem(&name) {
            return Err(format!("package ships junk file {name} ({problem})"));
        }
        let Some(expected) = files.get(&name) else {
            return Err(format!("package ships {name}, which the manifest does not list"));
        };
        // The entry is streamed straight to its target. The manifest's declared size is the bound it
        // is allowed to use, and the whole-package budget is checked as the bytes arrive, so an
        // entry that delivers more than either limit is stopped before anything is buffered: a
        // `read_to_end` here let one entry (or a compression bomb) allocate the entire extract budget.
        let target = safe_join(destination, &name)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("cannot create {name}: {error}"))?;
        }
        let mut sink = std::fs::File::create(&target).map_err(|error| format!("cannot create {name}: {error}"))?;
        let mut hasher = Sha256::new();
        let mut entry_bytes: u64 = 0;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = std::io::Read::read(&mut entry, &mut chunk)
                .map_err(|error| format!("package entry {name} is unreadable: {error}"))?;
            if read == 0 {
                break;
            }
            entry_bytes += read as u64;
            extracted += read as u64;
            if entry_bytes > expected.size {
                return Err(format!(
                    "{name} is larger than the {} bytes the manifest declares",
                    expected.size
                ));
            }
            if extracted > max_extract_bytes {
                return Err(format!("package extracts more than the {max_extract_bytes} byte limit"));
            }
            hasher.update(&chunk[..read]);
            std::io::Write::write_all(&mut sink, &chunk[..read])
                .map_err(|error| format!("cannot write {name}: {error}"))?;
        }
        let digest = hex::encode(hasher.finalize());
        if digest != expected.sha256 {
            return Err(format!("{name} hashes to {digest}, expected {}", expected.sha256));
        }
        if entry_bytes != expected.size {
            return Err(format!("{name} is {entry_bytes} bytes, expected {}", expected.size));
        }
        written.push(name);
    }
    for path in files.keys() {
        if !written.contains(path) {
            return Err(format!("package is missing {path}"));
        }
    }
    Ok(written)
}

/// `applyPackage()`: verify, extract, install as the next generation and update the store file.
pub fn apply_package(
    root: &Path,
    package_file: &Path,
    expected_sha256: Option<&str>,
    max_extract_bytes: u64,
) -> Result<String, String> {
    let digest = sha256_hex(&std::fs::read(package_file).map_err(|error| format!("package unreadable: {error}"))?);
    if let Some(expected) = expected_sha256 {
        if !expected.is_empty() && digest != expected.to_ascii_lowercase() {
            return Err(format!("package digest {digest} does not match {expected}"));
        }
    }
    let file = std::fs::File::open(package_file).map_err(|error| format!("package unreadable: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("package is not a zip archive: {error}"))?;
    let manifest: serde_json::Value = {
        let mut text = String::new();
        let mut entry = archive
            .by_name(PACKAGE_MANIFEST)
            .map_err(|_| "package has no ASSETS.json manifest".to_string())?;
        std::io::Read::read_to_string(&mut entry, &mut text)
            .map_err(|error| format!("package manifest is unreadable: {error}"))?;
        serde_json::from_str(&text).map_err(|error| format!("package manifest is not JSON: {error}"))?
    };
    drop(archive);
    if string_field(&manifest, "format").as_deref() != Some(PACKAGE_FORMAT) {
        return Err(format!(
            "refusing to apply: package format {}",
            string_field(&manifest, "format").unwrap_or_default()
        ));
    }
    let kind = string_field(&manifest, "kind").unwrap_or_default();
    let version = string_field(&manifest, "version").unwrap_or_default();
    let declared_inventory = string_field(&manifest, "inventory").unwrap_or_default().to_ascii_lowercase();

    let before = load_store(root)?;
    let mut next: BTreeMap<String, FileEntry> = if kind == KIND_BASE { BTreeMap::new() } else { before.files.clone() };
    let manifest_entries = manifest_files(&manifest).ok_or_else(|| "package manifest is invalid".to_string())?;
    for (path, entry) in &manifest_entries {
        next.insert(path.clone(), entry.clone());
    }
    if let Some(removed) = field(&manifest, "removed").and_then(|v| v.as_array()) {
        for item in removed {
            if let Some(path) = string_field(item, "path") {
                next.remove(&path);
            }
        }
    }
    let landed = inventory_digest(&next);
    if landed != declared_inventory {
        return Err(format!("package lands on inventory {landed}, the manifest declares {declared_inventory}"));
    }

    let staging = root.join(STAGING_DIR);
    let _ = std::fs::remove_dir_all(&staging);
    let written = extract_package(package_file, &manifest, &staging.join("files"), max_extract_bytes)?;

    let next_generation = before.layers.iter().map(|layer| layer.generation).max().unwrap_or(0) + 1;
    let layer_name = match &kind[..] {
        KIND_BASE => format!("{:04}-{KIND_BASE}-{version}-{version}", next_generation.max(1)),
        _ => {
            let from = string_field(&manifest, "from").unwrap_or_default();
            format!("{:04}-{KIND_DELTA}-{from}-{version}", next_generation.max(1))
        }
    };
    let layer_dir = root.join(LAYER_DIR).join(&layer_name);
    // The new generation is published completely before the old one is touched: the layer lands,
    // then its manifest, then the store pointer. Every failure in that sequence leaves the previous
    // layers and the previous store file exactly as they were, so a retry starts from a working
    // install. A base package therefore must not delete its predecessors first — that window left
    // the store with neither the old art nor the new one.
    let install = || -> Result<(), String> {
        std::fs::rename(&staging, &layer_dir)
            .or_else(|_| {
                // Cross-volume renames are not possible; copy instead.
                copy_tree(&staging, &layer_dir)
            })
            .map_err(|error| format!("cannot install layer: {error}"))?;
        std::fs::create_dir_all(&layer_dir).map_err(|error| format!("cannot create layer: {error}"))?;
        std::fs::write(
            layer_dir.join(PACKAGE_MANIFEST),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("cannot write layer manifest: {error}"))?;
        Ok(())
    };
    if let Err(error) = install() {
        let _ = std::fs::remove_dir_all(&layer_dir);
        return Err(error);
    }
    let store = serde_json::json!({
        "format": STORE_FORMAT,
        "generation": next_generation.max(1),
        "version": version,
        "layers": [{ "name": layer_name, "kind": kind }],
    });
    let target = root.join(STORE_FILE);
    let temporary = root.join(format!("{STORE_FILE}.tmp"));
    let published = std::fs::write(&temporary, serde_json::to_vec_pretty(&store).map_err(|error| error.to_string())?)
        .map_err(|error| format!("cannot write store: {error}"))
        .and_then(|()| std::fs::rename(&temporary, &target).map_err(|error| format!("cannot publish store: {error}")));
    if let Err(error) = published {
        let _ = std::fs::remove_file(&temporary);
        // The store pointer still names the previous generation; the freshly installed layer goes
        // with it, so a retry does not stack a second copy of the same generation.
        let _ = std::fs::remove_dir_all(&layer_dir);
        return Err(error);
    }
    // Only now that the new generation is published is the old art retired. A base package replaces
    // its predecessors, and until this point they were still the install that would be served.
    if kind == KIND_BASE {
        for layer in &before.layers {
            let _ = std::fs::remove_dir_all(&layer.dir);
        }
    }
    Ok(format!("{kind} {version} ({})", written.len()))
}

/// Recursive copy, used only when a rename crosses a volume boundary.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// HTTP client: token exchange and downloads
// ---------------------------------------------------------------------------------------------

/// The result of running the updater once.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateOutcome {
    pub status: String,
    pub changed: bool,
    pub message: String,
}

/// Everything the updater needs to run.
pub struct RuntimeAssets {
    pub client_root: PathBuf,
    pub store_root: PathBuf,
    config: ConfigOutcome,
    lock: Mutex<()>,
    /// The only HTTP client the updater may use. `None` when it could not be built: requests then
    /// fail with [`RuntimeAssets::client_error`] rather than quietly using a default client, which
    /// follows redirects and would replay the Worker token to another origin.
    client: Option<reqwest::Client>,
    client_error: Option<String>,
}

/// Builds the client the updater must use.
///
/// The settings are not optional: no automatic redirects (so [`RuntimeAssets::request`] is the only
/// redirect logic and can keep the token on one origin) and the same deadlines the downloads rely
/// on. A failed build is reported through [`RuntimeAssets::client_error`]; it is never replaced by
/// a default client, which follows redirects and replays the request headers to the new origin.
fn build_http_client() -> (Option<reqwest::Client>, Option<String>) {
    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(TOKEN_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build();
    match built {
        Ok(client) => (Some(client), None),
        Err(error) => {
            let reason = format!("asset HTTP client could not be built: {error}");
            eprintln!("{reason}");
            (None, Some(reason))
        }
    }
}

impl RuntimeAssets {
    /// Creates the updater and reads `asset-config.json`.
    pub fn new(client_root: PathBuf, store_root: PathBuf) -> Arc<RuntimeAssets> {
        let config = read_config(&client_root);
        let (client, client_error) = build_http_client();
        Arc::new(RuntimeAssets { client_root, store_root, config, lock: Mutex::new(()), client, client_error })
    }

    /// The pinned HTTP client, or the reason it is unavailable.
    fn http_client(&self) -> Result<&reqwest::Client, String> {
        self.client.as_ref().ok_or_else(|| {
            self.client_error
                .clone()
                .unwrap_or_else(|| "asset HTTP client unavailable".to_string())
        })
    }

    /// Whether a private asset configuration is present and usable.
    pub fn enabled(&self) -> bool {
        matches!(self.config, ConfigOutcome::Enabled(_))
    }

    /// A human-readable reason when the updater is disabled.
    pub fn disabled_reason(&self) -> Option<&str> {
        match &self.config {
            ConfigOutcome::Disabled { reason } => Some(reason.as_str()),
            ConfigOutcome::Enabled(_) => None,
        }
    }

    /// Resolves a client-relative asset path into the store, if the store owns it.
    pub fn lookup(&self, relative: &str) -> Option<PathBuf> {
        if !self.enabled() || !is_asset_path(relative) {
            return None;
        }
        lookup_asset(&self.store_root, relative)
    }

    /// `update()`: validate the session token, exchange it, and apply any route.
    pub async fn update(&self, session_token: &str) -> UpdateOutcome {
        if !is_session_token(session_token) {
            return UpdateOutcome {
                status: "waiting".to_string(),
                changed: false,
                message: "session token is not ready".to_string(),
            };
        }
        let _guard = self.lock.lock().await;
        self.update_once(session_token).await
    }

    async fn update_once(&self, session_token: &str) -> UpdateOutcome {
        let ConfigOutcome::Enabled(config) = &self.config else {
            return UpdateOutcome {
                status: "disabled".to_string(),
                changed: false,
                message: self.disabled_reason().unwrap_or("no configuration").to_string(),
            };
        };
        match self.update_inner(config, session_token).await {
            Ok(outcome) => outcome,
            Err(error) => UpdateOutcome { status: "failed".to_string(), changed: false, message: error },
        }
    }

    async fn update_inner(&self, config: &RuntimeConfig, session_token: &str) -> Result<UpdateOutcome, String> {
        let jwt = self.exchange_token(config, session_token).await?;
        let index_bytes = self.fetch_bytes(config.index_url.as_str(), config.max_index_bytes, Some(&jwt)).await?;
        std::fs::create_dir_all(&self.store_root).map_err(|error| format!("cannot create store: {error}"))?;
        let index_path = self.store_root.join(INDEX_FILE);
        let temporary = self.store_root.join(format!("{INDEX_FILE}.tmp"));
        std::fs::write(&temporary, &index_bytes).map_err(|error| format!("cannot write index: {error}"))?;
        std::fs::rename(&temporary, &index_path).map_err(|error| format!("cannot publish index: {error}"))?;

        let index = read_index(&index_path)?;
        let store = load_store(&self.store_root)?;
        let route = plan_route(
            &index,
            &LocalInventory { version: store.version.clone(), inventory: store.inventory.clone() },
            config.max_chain,
        );
        if route.steps.is_empty() {
            return Ok(UpdateOutcome {
                status: route.status,
                changed: false,
                message: route.reason,
            });
        }
        for step in &route.steps {
            let package_url = config
                .index_url
                .join(&step.name)
                .map_err(|error| format!("invalid package URL: {error}"))?;
            let package_file = self.store_root.join(PACKAGE_FILE);
            let result = self
                .fetch_file(package_url.as_str(), &package_file, config.max_download_bytes, Some(&jwt))
                .await;
            let applied = match result {
                Ok(()) => apply_package(
                    &self.store_root,
                    &package_file,
                    Some(&step.sha256),
                    config.max_extract_bytes,
                ),
                Err(error) => Err(error),
            };
            let _ = std::fs::remove_file(&package_file);
            applied?;
        }
        Ok(UpdateOutcome { status: route.status, changed: true, message: route.reason })
    }

    /// Exchanges the session token for the short-lived Worker JWT.
    ///
    /// The JWT is used and dropped inside this process; it is never returned, logged or stored.
    async fn exchange_token(&self, config: &RuntimeConfig, session_token: &str) -> Result<String, String> {
        let client = self.http_client()?;
        let response = client
            .get(config.token_url.clone())
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {session_token}"))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(TOKEN_TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("asset token request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("asset token endpoint answered {}", response.status().as_u16()));
        }
        let body = response.text().await.map_err(|error| format!("asset token response unreadable: {error}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "asset token response is invalid".to_string())?;
        let token = string_field(&value, "token").unwrap_or_default();
        if !is_jwt(&token) {
            return Err("asset token response is invalid".to_string());
        }
        Ok(token)
    }

    /// Fetches a document, following at most [`MAX_REDIRECTS`] same-origin redirects.
    async fn fetch_bytes(
        &self,
        url: &str,
        limit: u64,
        authorization: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let response = self.request(url, authorization).await?;
        if let Some(length) = response.content_length() {
            if length > limit {
                return Err(format!("document is {length} bytes, above the {limit} byte limit"));
            }
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("document could not be read: {error}"))?;
        if bytes.len() as u64 > limit {
            return Err(format!("document is {} bytes, above the {limit} byte limit", bytes.len()));
        }
        Ok(bytes.to_vec())
    }

    /// Streams a package to disk, aborting as soon as the byte limit is exceeded.
    async fn fetch_file(
        &self,
        url: &str,
        target: &Path,
        limit: u64,
        authorization: Option<&str>,
    ) -> Result<(), String> {
        use futures_util::StreamExt;
        let response = self.request(url, authorization).await?;
        let declared = response.content_length();
        if let Some(length) = declared {
            if length > limit {
                return Err(format!("package is {length} bytes, above the {limit} byte limit"));
            }
        }
        let mut file = std::fs::File::create(target).map_err(|error| format!("cannot create package file: {error}"))?;
        let mut total: u64 = 0;
        let mut stream = response.bytes_stream();
        let write_result: Result<(), String> = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| format!("package download failed: {error}"))?;
                total += chunk.len() as u64;
                if total > limit {
                    return Err(format!("package is larger than the {limit} byte limit"));
                }
                std::io::Write::write_all(&mut file, &chunk)
                    .map_err(|error| format!("cannot write package: {error}"))?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(target);
            return Err(error);
        }
        if let Some(declared) = declared {
            if total != declared {
                let _ = std::fs::remove_file(target);
                return Err(format!("package is {total} bytes, the server announced {declared}"));
            }
        }
        Ok(())
    }

    /// One request with a pinned origin and manual redirects.
    async fn request(&self, url: &str, authorization: Option<&str>) -> Result<reqwest::Response, String> {
        let client = self.http_client()?;
        let mut current = url::Url::parse(url).map_err(|_| format!("invalid asset URL: {url}"))?;
        let origin = origin_of(&current);
        for _hop in 0..=MAX_REDIRECTS {
            let mut request = client
                .get(current.clone())
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .header(reqwest::header::USER_AGENT, USER_AGENT);
            if let Some(token) = authorization {
                request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let response = request
                .send()
                .await
                .map_err(|error| format!("asset request failed: {error}"))?;
            let status = response.status();
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let Some(location) = location else {
                    return Err(format!("redirect without a location from {current}"));
                };
                let next = current
                    .join(&location)
                    .map_err(|_| format!("invalid redirect target from {current}"))?;
                if origin_of(&next) != origin {
                    // Refused before the request is repeated, so the Worker token never reaches
                    // another origin.
                    return Err(format!("cross-origin asset redirect is refused from {current}"));
                }
                current = next;
                continue;
            }
            if !status.is_success() {
                return Err(format!("HTTP {} from {current}", status.as_u16()));
            }
            return Ok(response);
        }
        Err(format!("too many redirects from {url}"))
    }
}

/// `origin` of a URL: scheme + host + port, what "same origin" means for the pinned redirect rule.
fn origin_of(url: &url::Url) -> String {
    match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), url.host_str().unwrap_or_default(), port),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
    }
}

/// Managed application state for the private runtime-asset store.
///
/// The wrapper owns no token: every update receives the game session token as an argument,
/// exchanges it inside [`RuntimeAssets`], and returns only whether files changed.
pub struct AssetStore {
    runtime: Arc<RuntimeAssets>,
}

impl AssetStore {
    pub fn open(store_root: PathBuf, client_root: &Path) -> Self {
        Self { runtime: RuntimeAssets::new(client_root.to_path_buf(), store_root) }
    }

    pub fn is_enabled(&self) -> bool {
        self.runtime.enabled()
    }

    pub fn lookup(&self, relative: &str) -> Option<PathBuf> {
        self.runtime.lookup(relative)
    }

    pub fn root(&self) -> &Path {
        &self.runtime.store_root
    }

    pub async fn update_session(&self, session_token: &str) -> bool {
        self.runtime.update(session_token).await.changed
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn index_fixture() -> AssetIndex {
        let value = serde_json::json!({
            "format": INDEX_FORMAT,
            "latest": "2.6.3",
            "versions": {
                "2.6.2": { "inventory": "a".repeat(64) },
                "2.6.3": { "inventory": "b".repeat(64) },
            },
            "bases": [
                { "name": "assets-base-2.6.2.zip", "to": "2.6.2", "size": 100, "sha256": "1".repeat(64) },
                { "name": "assets-base-2.6.3.zip", "to": "2.6.3", "size": 120, "sha256": "2".repeat(64) },
            ],
            "deltas": [
                { "name": "assets-delta-2.6.2-2.6.3.zip", "from": "2.6.2", "to": "2.6.3", "size": 5, "sha256": "3".repeat(64) },
                { "name": "assets-delta-2.6.0-2.6.2.zip", "from": "2.6.0", "to": "2.6.2", "size": 6, "sha256": "4".repeat(64) },
            ],
        });
        check_index(&value).expect("fixture index is valid")
    }

    #[test]
    fn session_tokens_are_exactly_32_lowercase_hex() {
        assert!(is_session_token("0123456789abcdef0123456789abcdef"));
        assert!(!is_session_token("0123456789ABCDEF0123456789abcdef"));
        assert!(!is_session_token("0123456789abcdef0123456789abcde"));
        assert!(!is_session_token("0123456789abcdef0123456789abcdeg"));
        assert!(!is_session_token(""));
    }

    #[test]
    fn jwts_need_three_base64url_parts() {
        assert!(is_jwt("aaa.bbb.ccc"));
        assert!(is_jwt("a-b_c.d-e_f.g-h_i"));
        assert!(!is_jwt("aaa.bbb"));
        assert!(!is_jwt("aaa.bbb.ccc.ddd"));
        assert!(!is_jwt(".."));
        assert!(!is_jwt("aaa.bbb."));
        assert!(!is_jwt("aaa.bb+b.ccc"));
    }

    #[test]
    fn configured_urls_refuse_credentials_queries_and_plain_http() {
        assert!(configured_url("https://assets.example.test/index.json", false).is_some());
        assert!(configured_url("http://assets.example.test/index.json", false).is_none());
        assert!(configured_url("http://assets.example.test/index.json", true).is_some());
        assert!(configured_url("https://user:secret@assets.example.test/i.json", false).is_none());
        assert!(configured_url("https://assets.example.test/i.json?token=secret", false).is_none());
        assert!(configured_url("https://assets.example.test/i.json#x", false).is_none());
        assert!(configured_url("ftp://assets.example.test/i.json", true).is_none());
        // The token endpoint is HTTPS whatever `allowHttp` says.
        assert!(configured_token_url("http://game.example.test/token").is_none());
        assert!(configured_token_url("https://game.example.test/api/assets/token").is_some());
    }

    #[test]
    fn config_validation_matches_the_tooling() {
        let good = serde_json::json!({
            "format": CONFIG_FORMAT,
            "indexUrl": "https://assets.example.test/assets-index.json",
            "tokenUrl": "https://game.example.test/api/assets/token",
        });
        assert!(check_config(&good).is_empty());
        let bad_format = serde_json::json!({ "format": "sp-assets-config-v0", "indexUrl": "https://a.test/i.json" });
        assert!(check_config(&bad_format).iter().any(|p| p == "config: format sp-assets-config-v0"));
        let no_index = serde_json::json!({ "format": CONFIG_FORMAT });
        assert!(check_config(&no_index).iter().any(|p| p == "config: indexUrl is required"));
        let credentials = serde_json::json!({
            "format": CONFIG_FORMAT,
            "indexUrl": "https://user:pass@a.test/i.json",
        });
        assert!(check_config(&credentials).iter().any(|p| p == "config: indexUrl must not carry credentials"));
        let signature = serde_json::json!({
            "format": CONFIG_FORMAT,
            "indexUrl": "https://a.test/i.json?X-Amz-Signature=abc",
        });
        assert!(check_config(&signature)
            .iter()
            .any(|p| p == "config: indexUrl must not carry signature or token parameters"));
        let plain_http = serde_json::json!({ "format": CONFIG_FORMAT, "indexUrl": "http://a.test/i.json" });
        assert!(check_config(&plain_http).iter().any(|p| p == "config: indexUrl must use https"));
        let allow_http = serde_json::json!({
            "format": CONFIG_FORMAT,
            "indexUrl": "http://a.test/i.json",
            "allowHttp": true,
        });
        assert!(check_config(&allow_http).is_empty());
        let negative = serde_json::json!({
            "format": CONFIG_FORMAT,
            "indexUrl": "https://a.test/i.json",
            "maxChain": -1,
        });
        assert!(check_config(&negative).iter().any(|p| p == "config: maxChain must be a positive number"));
    }

    #[test]
    fn read_config_reports_each_disabled_reason() {
        let root = std::env::temp_dir().join("sp-assets-read-config");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        match read_config(&root) {
            ConfigOutcome::Disabled { reason } => assert_eq!(reason, "no configuration"),
            ConfigOutcome::Enabled(_) => panic!("an empty directory must not enable the updater"),
        }
    }

    #[test]
    fn asset_paths_are_classified_like_the_tooling() {
        assert!(is_asset_path("assets/logo.png"));
        assert!(is_asset_path("fonts/main.woff2"));
        assert!(is_asset_path("data/assets.json"));
        assert!(is_asset_path("data/local-assets.json"));
        assert!(!is_asset_path("assets/"));
        assert!(!is_asset_path("assets"));
        assert!(!is_asset_path("/assets/logo.png"));
        assert!(!is_asset_path("js/main.js"));
        assert!(!is_asset_path("databases/assets.json"));
        assert!(!is_asset_path(""));
    }

    #[test]
    fn asset_path_problems_are_exact() {
        assert_eq!(asset_path_problem(""), Some("empty path"));
        assert_eq!(asset_path_problem("a\\b"), Some("backslash in path"));
        assert_eq!(asset_path_problem("/a"), Some("absolute path"));
        assert_eq!(asset_path_problem("a/"), Some("trailing slash"));
        assert_eq!(asset_path_problem("C:/a"), Some("drive-letter path"));
        assert_eq!(asset_path_problem("a//b"), Some("empty path segment"));
        assert_eq!(asset_path_problem("a/../b"), Some("unsafe path segment"));
        assert_eq!(asset_path_problem("a/./b"), Some("unsafe path segment"));
        assert_eq!(asset_path_problem("a\u{1}b"), Some("control character in path"));
        assert_eq!(asset_path_problem("资产/a.png"), Some("non-ASCII path"));
        assert_eq!(asset_path_problem("a/b "), Some("trailing whitespace in path"));
        assert_eq!(asset_path_problem("assets/logo.png"), None);
    }

    #[test]
    fn safe_join_refuses_escapes() {
        let root = Path::new("/tmp/asset-runtime");
        assert_eq!(safe_join(root, "assets/a.png").unwrap(), root.join("assets").join("a.png"));
        assert!(safe_join(root, "../escape").is_err());
        assert!(safe_join(root, "assets/../../escape").is_err());
        assert!(safe_join(root, "").is_err());
        assert!(safe_join(root, "C:/escape").is_err());
    }

    #[test]
    fn inventory_digest_is_stable_and_sorted() {
        let mut files = BTreeMap::new();
        files.insert("assets/b.png".to_string(), FileEntry { size: 2, sha256: "BB".to_string() });
        files.insert("assets/a.png".to_string(), FileEntry { size: 1, sha256: "AA".to_string() });
        assert_eq!(inventory_lines(&files), "assets/a.png\t1\taa\nassets/b.png\t2\tbb\n");
        let mut reordered = BTreeMap::new();
        reordered.insert("assets/b.png".to_string(), FileEntry { size: 2, sha256: "bb".to_string() });
        reordered.insert("assets/a.png".to_string(), FileEntry { size: 1, sha256: "aa".to_string() });
        assert_eq!(inventory_digest(&files), inventory_digest(&reordered));
        // The digest is the SHA-256 of the exact line text (known-answer check).
        assert_eq!(inventory_digest(&files), sha256_hex(inventory_lines(&files).as_bytes()));
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare_versions("2.6.3", "2.6.3"), std::cmp::Ordering::Equal);
        assert_eq!(compare_versions("2.6.10", "2.6.9"), std::cmp::Ordering::Greater);
        assert_eq!(compare_versions("2.10.0", "2.9.9"), std::cmp::Ordering::Greater);
        assert_eq!(compare_versions("2.6", "2.6.0"), std::cmp::Ordering::Equal);
        assert_eq!(compare_versions("1.0.0", "2.0.0"), std::cmp::Ordering::Less);
    }

    #[test]
    fn index_validation_names_the_expected_package_files() {
        let bad = serde_json::json!({
            "format": INDEX_FORMAT,
            "latest": "2.6.3",
            "versions": { "2.6.3": "bb" },
            "bases": [{ "name": "assets-base-2.6.4.zip", "to": "2.6.3", "sha256": "1".repeat(64) }],
            "deltas": [{ "name": "wrong.zip", "from": "2.6.2", "to": "2.6.3", "sha256": "2".repeat(64) }],
        });
        let problems = check_index(&bad).unwrap_err();
        assert!(problems.iter().any(|p| p == "index: base package assets-base-2.6.4.zip must be assets-base-2.6.3.zip"));
        assert!(problems.iter().any(|p| p == "index: delta package wrong.zip must be assets-delta-2.6.2-2.6.3.zip"));
        let short_digest = serde_json::json!({
            "format": INDEX_FORMAT,
            "latest": "2.6.3",
            "versions": { "2.6.3": "bb" },
            "bases": [{ "name": "assets-base-2.6.3.zip", "to": "2.6.3", "sha256": "abc" }],
            "deltas": [],
        });
        assert!(check_index(&short_digest)
            .unwrap_err()
            .iter()
            .any(|p| p == "index: assets-base-2.6.3.zip has no sha256 digest"));
    }

    #[test]
    fn plan_route_is_current_when_versions_and_inventory_agree() {
        let index = index_fixture();
        let route = plan_route(
            &index,
            &LocalInventory { version: Some("2.6.3".to_string()), inventory: Some("b".repeat(64)) },
            DEFAULT_MAX_CHAIN,
        );
        assert_eq!(route.status, "current");
        assert_eq!(route.verification, "ok");
        assert!(route.steps.is_empty());
    }

    #[test]
    fn plan_route_prefers_a_delta_chain() {
        let index = index_fixture();
        let route = plan_route(
            &index,
            &LocalInventory { version: Some("2.6.2".to_string()), inventory: Some("a".repeat(64)) },
            DEFAULT_MAX_CHAIN,
        );
        assert_eq!(route.status, "update");
        assert_eq!(route.steps.len(), 1);
        assert_eq!(route.steps[0].name, "assets-delta-2.6.2-2.6.3.zip");
        assert_eq!(route.bytes, 5);
    }

    #[test]
    fn plan_route_repairs_a_mismatched_inventory_with_a_base() {
        let index = index_fixture();
        let route = plan_route(
            &index,
            &LocalInventory { version: Some("2.6.2".to_string()), inventory: Some("z".repeat(64)) },
            DEFAULT_MAX_CHAIN,
        );
        assert_eq!(route.status, "repair");
        assert_eq!(route.verification, "mismatch");
        assert_eq!(route.steps[0].kind, KIND_BASE);
        assert_eq!(route.steps[0].name, "assets-base-2.6.3.zip");
    }

    #[test]
    fn plan_route_without_local_state_uses_a_base() {
        let index = index_fixture();
        let route = plan_route(&index, &LocalInventory::default(), DEFAULT_MAX_CHAIN);
        assert_eq!(route.status, "update");
        assert_eq!(route.reason, "no local state; using a base package");
        assert_eq!(route.steps.len(), 1);
        assert_eq!(route.steps[0].kind, KIND_BASE);
    }

    #[test]
    fn plan_route_chains_a_multi_step_delta_when_allowed() {
        let index = index_fixture();
        let route = plan_route(
            &index,
            &LocalInventory { version: Some("2.6.0".to_string()), inventory: Some("c".repeat(64)) },
            DEFAULT_MAX_CHAIN,
        );
        // 2.6.0 has no published inventory, so it is 'unpublished'; the base route wins.
        assert_eq!(route.verification, "unpublished");
        assert_eq!(route.steps[0].kind, KIND_BASE);

        // With a published inventory the chain 2.6.0 -> 2.6.2 -> 2.6.3 becomes usable.
        let mut index = index_fixture();
        index.versions.insert("2.6.0".to_string(), VersionInfo { inventory: "c".repeat(64), reused: None });
        let route = plan_route(
            &index,
            &LocalInventory { version: Some("2.6.0".to_string()), inventory: Some("c".repeat(64)) },
            DEFAULT_MAX_CHAIN,
        );
        assert_eq!(route.status, "update");
        assert_eq!(route.steps.len(), 2);
        assert_eq!(route.steps[0].name, "assets-delta-2.6.0-2.6.2.zip");
        assert_eq!(route.steps[1].name, "assets-delta-2.6.2-2.6.3.zip");
        assert_eq!(route.bytes, 11);
    }

    #[test]
    fn plan_route_respects_max_chain() {
        let mut index = index_fixture();
        index.versions.insert("2.6.0".to_string(), VersionInfo { inventory: "c".repeat(64), reused: None });
        let route = plan_route(
            &index,
            &LocalInventory { version: Some("2.6.0".to_string()), inventory: Some("c".repeat(64)) },
            1,
        );
        // A one-step chain to 2.6.3 does not exist, so a base package is used instead.
        assert_eq!(route.steps[0].kind, KIND_BASE);
    }

    #[test]
    fn plan_route_resolves_a_reused_latest_payload() {
        let value = serde_json::json!({
            "format": INDEX_FORMAT,
            "latest": "2.6.4",
            "versions": {
                "2.6.3": { "inventory": "b".repeat(64) },
                "2.6.4": { "inventory": "b".repeat(64), "reused": "2.6.3" },
            },
            "bases": [{ "name": "assets-base-2.6.3.zip", "to": "2.6.3", "size": 120, "sha256": "2".repeat(64) }],
            "deltas": [],
        });
        let index = check_index(&value).expect("reused fixture index is valid");
        let route = plan_route(&index, &LocalInventory { version: Some("2.6.3".to_string()), inventory: Some("b".repeat(64)) }, DEFAULT_MAX_CHAIN);
        assert_eq!(route.status, "current");
        assert_eq!(route.reason, "already on the asset set published for 2.6.4");
    }
    #[test]
    fn plan_route_blocks_when_the_index_has_no_route() {
        let empty = AssetIndex { latest: "9.9.9".to_string(), ..AssetIndex::default() };
        let route = plan_route(&empty, &LocalInventory::default(), DEFAULT_MAX_CHAIN);
        assert_eq!(route.status, "blocked");
        assert!(route.steps.is_empty());
    }

    #[test]
    fn origin_pinning_ignores_the_port_only_when_absent() {
        assert_eq!(origin_of(&url::Url::parse("https://a.test/x").unwrap()), "https://a.test");
        assert_eq!(origin_of(&url::Url::parse("https://a.test:8443/x").unwrap()), "https://a.test:8443");
        assert_ne!(
            origin_of(&url::Url::parse("https://a.test/x").unwrap()),
            origin_of(&url::Url::parse("https://b.test/x").unwrap())
        );
    }

    #[test]
    fn extract_package_refuses_unlisted_and_mismatched_entries() {
        let root = std::env::temp_dir().join("sp-assets-extract");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("package.zip");
        write_zip(
            &archive_path,
            &[
                (PACKAGE_MANIFEST, build_manifest("delta", "2.6.2", "2.6.3", &[("assets/a.png", b"hello")]).as_bytes()),
                ("assets/a.png", b"hello"),
            ],
        );
        let manifest = build_manifest_value("delta", "2.6.2", "2.6.3", &[("assets/a.png", b"hello")]);
        let destination = root.join("staging/files");
        let written = extract_package(&archive_path, &manifest, &destination, DEFAULT_MAX_EXTRACT_BYTES)
            .expect("a matching package extracts");
        assert_eq!(written, vec!["assets/a.png".to_string()]);
        assert_eq!(std::fs::read(destination.join("assets/a.png")).unwrap(), b"hello");

        // An unlisted extra entry is refused.
        let extra = root.join("extra.zip");
        write_zip(
            &extra,
            &[
                (PACKAGE_MANIFEST, build_manifest("delta", "2.6.2", "2.6.3", &[("assets/a.png", b"hello")]).as_bytes()),
                ("assets/a.png", b"hello"),
                ("assets/secret.png", b"nope"),
            ],
        );
        let error = extract_package(&extra, &manifest, &root.join("staging2/files"), DEFAULT_MAX_EXTRACT_BYTES)
            .unwrap_err();
        assert_eq!(error, "package ships assets/secret.png, which the manifest does not list");

        // A mismatched digest is refused.
        let tampered = root.join("tampered.zip");
        write_zip(
            &tampered,
            &[
                (PACKAGE_MANIFEST, build_manifest("delta", "2.6.2", "2.6.3", &[("assets/a.png", b"hello")]).as_bytes()),
                ("assets/a.png", b"HELLO"),
            ],
        );
        let error = extract_package(&tampered, &manifest, &root.join("staging3/files"), DEFAULT_MAX_EXTRACT_BYTES)
            .unwrap_err();
        assert!(error.starts_with("assets/a.png hashes to"), "{error}");

        // A missing manifest entry is refused.
        let missing = root.join("missing.zip");
        write_zip(&missing, &[(PACKAGE_MANIFEST, build_manifest("delta", "2.6.2", "2.6.3", &[("assets/a.png", b"hello")]).as_bytes())]);
        assert_eq!(
            extract_package(&missing, &manifest, &root.join("staging4/files"), DEFAULT_MAX_EXTRACT_BYTES).unwrap_err(),
            "package is missing assets/a.png"
        );

        // An extract limit is honoured.
        let error = extract_package(&archive_path, &manifest, &root.join("staging5/files"), 1).unwrap_err();
        assert!(error.contains("above the 1 byte limit"), "{error}");
    }

    #[test]
    fn extract_package_streams_entries_without_trusting_the_archive() {
        let root = std::env::temp_dir().join("sp-assets-extract-bomb");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // The manifest declares five bytes; the entry delivers one mebibyte. Extraction stops at
        // the declared size, so the surplus is never buffered and never written.
        let manifest = build_manifest_value(KIND_DELTA, "2.6.2", "2.6.3", &[("assets/a.png", b"hello")]);
        let manifest_text = manifest.to_string();
        let oversized = vec![b'x'; 1024 * 1024];
        let archive_path = root.join("oversized.zip");
        write_zip(
            &archive_path,
            &[(PACKAGE_MANIFEST, manifest_text.as_bytes()), ("assets/a.png", oversized.as_slice())],
        );
        let destination = root.join("staging/files");
        let error = extract_package(&archive_path, &manifest, &destination, DEFAULT_MAX_EXTRACT_BYTES).unwrap_err();
        assert_eq!(error, "assets/a.png is larger than the 5 bytes the manifest declares");
        let written = std::fs::read(destination.join("assets/a.png")).unwrap_or_default();
        assert!(written.len() <= 5, "only the declared prefix may reach the disk, got {}", written.len());

        // A header that declares more entries than the extraction budget can pay for is refused
        // before any of them is opened: every written entry costs at least one byte.
        let small = build_manifest_value(KIND_DELTA, "2.6.2", "2.6.3", &[("assets/a.png", b"hi")]);
        let small_text = small.to_string();
        let many = root.join("many.zip");
        write_zip(
            &many,
            &[
                (PACKAGE_MANIFEST, small_text.as_bytes()),
                ("assets/a.png", b"hi"),
                ("assets/b.png", b"x"),
                ("assets/c.png", b"y"),
            ],
        );
        let error = extract_package(&many, &small, &root.join("staging2/files"), 2).unwrap_err();
        assert_eq!(error, "package holds 4 entries, above the 2 entry limit");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_store_publication_keeps_the_previous_generation() {
        let root = std::env::temp_dir().join("sp-assets-apply-order");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let first = base_package(&root, "first.zip", "2.6.3", &[("assets/a.png", b"first")]);
        apply_package(&root, &first, None, DEFAULT_MAX_EXTRACT_BYTES).expect("the first base installs");
        let installed = layer_dirs(&root);
        assert_eq!(installed.len(), 1);
        assert_eq!(std::fs::read(lookup_asset(&root, "assets/a.png").unwrap()).unwrap(), b"first");

        // Block the store pointer's temporary path: the new layer extracts, but the generation
        // cannot be published. The install that was working must survive untouched.
        let blocked = root.join(format!("{STORE_FILE}.tmp"));
        std::fs::create_dir_all(&blocked).unwrap();
        let second = base_package(&root, "second.zip", "2.6.4", &[("assets/a.png", b"second")]);
        let error = apply_package(&root, &second, None, DEFAULT_MAX_EXTRACT_BYTES).unwrap_err();
        assert!(error.contains("cannot write store"), "{error}");
        assert_eq!(layer_dirs(&root), installed, "the unpublished generation is not left installed");
        assert_eq!(
            std::fs::read(lookup_asset(&root, "assets/a.png").unwrap()).unwrap(),
            b"first",
            "the previous base is still the install being served"
        );
        assert!(root.join(STORE_FILE).is_file(), "the previous store pointer is still published");

        // Retrying once the block is gone installs the new generation and replaces the old one.
        std::fs::remove_dir_all(&blocked).unwrap();
        apply_package(&root, &second, None, DEFAULT_MAX_EXTRACT_BYTES).expect("the retry installs");
        assert_eq!(std::fs::read(lookup_asset(&root, "assets/a.png").unwrap()).unwrap(), b"second");
        assert_eq!(layer_dirs(&root).len(), 1, "a base install replaces its predecessors");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_updater_never_falls_back_to_a_client_that_follows_redirects() {
        // The client is built in one place, with the redirect policy and the deadlines. A default
        // client would follow redirects itself and replay the Authorization header to the new host,
        // which is exactly the leak the manual redirect loop exists to prevent.
        let source = include_str!("assets.rs");
        let default_client = ["reqwest::Client", "::new()"].concat();
        assert!(!source.contains(&default_client), "the updater must not fall back to a default client");
        // The factory body, read as characters so the slice can never split a code point. The test's
        // own literals live far below it, so this cannot pass on the text of the assertion itself.
        let factory = source.find("fn build_http_client").expect("the client factory exists");
        let body: String = source[factory..].chars().take(900).collect();
        assert!(
            body.contains("redirect(reqwest::redirect::Policy::none())"),
            "the updater's client must refuse automatic redirects"
        );
        assert!(
            body.contains(".timeout(Duration::from_secs(600))"),
            "the download deadline is part of the client, not an optional extra"
        );
        let client = build_http_client().0.expect("the pinned client builds in a test environment");
        drop(client);
    }

    #[tokio::test]
    async fn a_missing_http_client_fails_the_request_with_the_reason() {
        let root = std::env::temp_dir().join("sp-assets-no-client");
        let assets = RuntimeAssets {
            client_root: root.clone(),
            store_root: root.join("store"),
            config: ConfigOutcome::Disabled { reason: "test".to_string() },
            lock: Mutex::new(()),
            client: None,
            client_error: Some("asset HTTP client could not be built: test".to_string()),
        };
        let error = assets.request("https://example.test/assets-index.json", Some("jwt")).await.unwrap_err();
        assert_eq!(error, "asset HTTP client could not be built: test");
        assert_eq!(
            assets.http_client().err().as_deref(),
            Some("asset HTTP client could not be built: test")
        );
    }

    /// Layer directory names currently installed, sorted, so a test can compare installs exactly.
    fn layer_dirs(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root.join(LAYER_DIR))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// A package that a base install accepts: its manifest inventory matches what it lands on.
    fn base_package(root: &Path, name: &str, version: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let mut manifest = build_manifest_value(KIND_BASE, "", version, files);
        let entries = manifest_files(&manifest).unwrap();
        manifest["inventory"] = serde_json::Value::String(inventory_digest(&entries));
        let text = manifest.to_string();
        let mut archive: Vec<(&str, &[u8])> = vec![(PACKAGE_MANIFEST, text.as_bytes())];
        for &(path, bytes) in files {
            archive.push((path, bytes));
        }
        let package = root.join(name);
        write_zip(&package, &archive);
        package
    }

    fn build_manifest_value(kind: &str, from: &str, to: &str, files: &[(&str, &[u8])]) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        for (path, bytes) in files {
            map.insert(
                (*path).to_string(),
                serde_json::json!({ "size": bytes.len(), "sha256": sha256_hex(bytes) }),
            );
        }
        serde_json::json!({
            "format": PACKAGE_FORMAT,
            "kind": kind,
            "from": from,
            "version": to,
            "inventory": "0".repeat(64),
            "files": serde_json::Value::Object(map),
        })
    }

    fn build_manifest(kind: &str, from: &str, to: &str, files: &[(&str, &[u8])]) -> String {
        build_manifest_value(kind, from, to, files).to_string()
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }
}
