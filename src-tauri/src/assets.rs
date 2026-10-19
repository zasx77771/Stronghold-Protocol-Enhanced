//! Embedded runtime art: the local override store used by the packaged client.
//!
//! The shipped Windows installer and Android APK carry the official `public` art themselves, so
//! nothing here touches the network: there is no index, no token exchange, no package download and
//! no mirror. The store only exists so a player can import a package by hand (the native picker
//! hands over a path; page JavaScript never does) and so an imported layer wins over the packaged
//! files without rewriting the installation.
//!
//! The safety surface is still native: every manifest is re-validated, every entry must be listed
//! with a matching SHA-256, paths are joined through [`safe_join`], and a new generation is
//! published by an atomic rename that keeps the previous one on failure.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------------------------
// Formats and limits (mirrors the package format the import picker accepts)
// ---------------------------------------------------------------------------------------------


pub const STORE_FORMAT: &str = "sp-assets-store-v1";
pub const PACKAGE_FORMAT: &str = "sp-assets-package-v1";
pub const STATE_FORMAT: &str = "sp-assets-state-v1";
pub const STORE_FILE: &str = "asset-store.json";
pub const LAYER_DIR: &str = "asset-layers";
pub const STAGING_DIR: &str = "asset-staging";
pub const RETIRED_DIR: &str = "asset-retired";
pub const PACKAGE_MANIFEST: &str = "ASSETS.json";
pub const PACKAGE_FILE: &str = "asset-package.zip";
pub const KIND_BASE: &str = "base";
pub const KIND_DELTA: &str = "delta";

pub const DEFAULT_MAX_EXTRACT_BYTES: u64 = 4096 * 1024 * 1024;
/// Defensive per-file ceiling for one package entry.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

pub const ASSET_DIRS: [&str; 2] = ["assets/", "fonts/"];
pub const ASSET_FILES: [&str; 2] = ["data/assets.json", "data/local-assets.json"];

/// header is attacker-controlled and can name millions of entries without shipping any bytes.
const MAX_EXTRACT_ENTRIES: usize = 100_000;

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

/// Streaming SHA-256 for a file the user explicitly chose.  Used by local package import so a
/// large archive is not read into memory just to be hashed before `apply_package` validates it.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|error| format!("package unreadable: {error}"))?;
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut chunk).map_err(|error| format!("package unreadable: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// ---------------------------------------------------------------------------------------------
// The store on disk
// ---------------------------------------------------------------------------------------------

/// One published generation of the store: the directory plus the files it shadows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
        if expected.size > MAX_FILE_BYTES {
            return Err(format!("{name} is larger than the {MAX_FILE_BYTES} byte file limit"));
        }
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
                if manifest_entries.contains_key(&path) {
                    return Err(format!("a package cannot both ship and remove {path}"));
                }
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
// ---------------------------------------------------------------------------------------------
// The override store
// ---------------------------------------------------------------------------------------------

/// Managed application state for the local override store.
///
/// With the official art embedded in the installation this only ever publishes a user-imported
/// package; there is no remote update path and nothing in here holds a token.
pub struct AssetStore {
    root: PathBuf,
}

impl AssetStore {
    pub fn open(root: PathBuf, _client_root: &Path) -> Self {
        Self { root }
    }

    pub fn is_enabled(&self) -> bool {
        true
    }

    pub fn lookup(&self, relative: &str) -> Option<PathBuf> {
        if !is_asset_path(relative) {
            return None;
        }
        lookup_asset(&self.root, relative)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Applies an explicitly chosen local package as the next store generation.  The caller has
    /// already shown a native picker; this API never accepts a path from page JavaScript.  The
    /// package digest is supplied by the caller so it can be computed with the same bytes that are
    /// applied, and `apply_package` still validates manifest, inventory, entry hash and paths.
    pub fn import_package(&self, package: &Path, expected_sha256: &str) -> Result<String, String> {
        apply_package(&self.root, package, Some(expected_sha256), DEFAULT_MAX_EXTRACT_BYTES)
    }

    /// Public diagnostics for the native panel. It deliberately carries no filesystem path: the
    /// status object crosses into page JavaScript, which must not learn the private store location.
    pub fn status(&self) -> serde_json::Value {
        let store = load_store(&self.root).ok();
        let (version, files) = match store {
            Some(state) => (state.version.unwrap_or_default(), state.files.len()),
            None => (String::new(), 0),
        };
        serde_json::json!({
            "format": "sp-asset-status-v1",
            "platform": "windows",
            "mode": "embedded",
            "enabled": true,
            "current": version,
            "files": files,
            "importAvailable": true,
        })
    }
}


#[cfg(test)]
mod tests {
    use super::*;

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