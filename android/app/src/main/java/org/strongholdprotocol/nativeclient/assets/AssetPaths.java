package org.strongholdprotocol.nativeclient.assets;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Path rules and file-name constants shared by the runtime asset store.
 *
 * <p>The rules are the mirror image of {@code tools/assetPackages.mjs}: the runtime set is exactly
 * {@code assets/**}, {@code fonts/**}, {@code data/assets.json} and {@code data/local-assets.json} —
 * everything else is program code and stays in the APK. The canonical inventory digest is built from
 * the raw paths, so both sides must agree byte for byte; that is why non-ASCII and control characters
 * are rejected here instead of being normalised later.
 */
public final class AssetPaths {
    private AssetPaths() {
    }

    /** The client entry point. {@code MainActivity} loads exactly this file, so an APK without it can
     *  answer nothing but a 404. */
    public static final String ENTRY_FILE = "index.html";
    /** Asset root state stamped into the APK by the release build. */
    public static final String STATE_FILE = "asset-state.json";
    /** Optional public configuration shipped in the APK (index URL, limits). */
    public static final String CONFIG_FILE = "asset-config.json";
    /** Active pointer inside the writable store. */
    public static final String STORE_FILE = "asset-store.json";
    public static final String LAYER_DIR = "asset-layers";
    public static final String STAGING_DIR = "asset-staging";
    public static final String RETIRED_DIR = "asset-retired";
    public static final String PACKAGE_MANIFEST = "ASSETS.json";
    public static final String PACKAGE_STATE = "STATE.json";

    public static final String[] ASSET_DIRS = {"assets/", "fonts/"};
    public static final String[] ASSET_FILES = {"data/assets.json", "data/local-assets.json"};

    private static final Pattern[] JUNK = {
        Pattern.compile("(?:^|/)\\.DS_Store$"),
        Pattern.compile("(?:^|/)Thumbs\\.db$", Pattern.CASE_INSENSITIVE),
        Pattern.compile("(?:^|/)desktop\\.ini$", Pattern.CASE_INSENSITIVE),
        Pattern.compile("(?:^|/)\\._[^/]*$"),
        Pattern.compile("(?:^|/)\\.git(?:/|$)"),
        Pattern.compile("~$"),
        Pattern.compile("\\.(?:tmp|temp|bak|swp|swo|crdownload|part)$", Pattern.CASE_INSENSITIVE)
    };

    /** True for a path that belongs to the runtime asset set (no {@code public/} prefix). */
    public static boolean isAssetPath(String rel) {
        if (rel == null || rel.isEmpty()) return false;
        if (rel.startsWith("/") || rel.endsWith("/")) return false;
        for (String file : ASSET_FILES) {
            if (file.equals(rel)) return true;
        }
        for (String dir : ASSET_DIRS) {
            if (rel.startsWith(dir) && rel.length() > dir.length()) return true;
        }
        return false;
    }

    /**
     * The shared path rules. Returns null when the path is safe, otherwise a short reason. Anything
     * rejected here never reaches a package manifest, a zip entry or the file system.
     */
    public static String problem(String rel) {
        if (rel == null || rel.isEmpty()) return "empty path";
        if (rel.indexOf('\\') >= 0) return "backslash in path";
        if (rel.startsWith("/")) return "absolute path";
        if (rel.endsWith("/")) return "trailing slash";
        if (rel.length() > 1 && isAsciiLetter(rel.charAt(0)) && rel.charAt(1) == ':') return "drive-letter path";
        if (rel.contains("//")) return "empty path segment";
        int start = 0;
        while (start <= rel.length()) {
            int slash = rel.indexOf('/', start);
            String segment = slash < 0 ? rel.substring(start) : rel.substring(start, slash);
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) return "unsafe path segment";
            if (slash < 0) break;
            start = slash + 1;
        }
        for (int i = 0; i < rel.length(); i++) {
            char c = rel.charAt(i);
            if (c < 0x20 || c == 0x7f) return "control character in path";
            if (c > 0x7e) return "non-ASCII path";
        }
        char last = rel.charAt(rel.length() - 1);
        if (last == ' ' || last == '\t') return "trailing whitespace in path";
        return null;
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    public static String assertSafe(String rel) {
        String problem = problem(rel);
        if (problem != null) throw new IllegalArgumentException("unsafe asset path \"" + rel + "\": " + problem);
        return rel;
    }

    /** True for names that are never published. */
    public static boolean isJunk(String rel) {
        if (rel == null) return true;
        for (Pattern pattern : JUNK) {
            if (pattern.matcher(rel).find()) return true;
        }
        return false;
    }

    /**
     * Resolve {@code rel} under {@code root}, refusing anything that leaves the tree. Returns null
     * when the target file does not exist.
     */
    public static File resolve(File root, String rel) throws IOException {
        File target = target(root, rel);
        return target.exists() ? target : null;
    }

    /** Resolve {@code rel} under {@code root} as a target path, whether or not it exists yet. */
    public static File target(File root, String rel) throws IOException {
        assertSafe(rel);
        File base = root.getCanonicalFile();
        File target = new File(base, rel.replace('/', File.separatorChar)).getCanonicalFile();
        String basePath = base.getPath();
        String targetPath = target.getPath();
        if (targetPath.equals(basePath)) throw new IOException("asset path names the store root: " + rel);
        if (!targetPath.startsWith(basePath + File.separator)) {
            throw new IOException("asset path escapes the store: " + rel);
        }
        return target;
    }

    /**
     * Turn a WebView request path into a repository-relative path, or null when it is not one. The
     * framework hands over paths like {@code /assets/char/avatar/x.png}; anything with traversal,
     * control characters, an empty segment, a backslash or a drive letter is refused before it
     * touches the disk.
     */
    public static String webPath(String path) {
        if (path == null) return null;
        if (path.indexOf('\\') >= 0) return null;
        String rel = path;
        if (rel.startsWith("/")) rel = rel.substring(1);
        if (rel.isEmpty() || rel.endsWith("/")) return null;
        return problem(rel) == null ? rel : null;
    }

    /** Bookkeeping files and directories of the updater: never served to the client. */
    public static boolean isInternal(String rel) {
        if (rel == null) return true;
        if (rel.equals(STATE_FILE) || rel.equals(CONFIG_FILE) || rel.equals(STORE_FILE)) return true;
        for (String dir : new String[] {LAYER_DIR, STAGING_DIR, RETIRED_DIR}) {
            if (rel.equals(dir) || rel.startsWith(dir + "/")) return true;
        }
        return false;
    }

    /** Content type for a served asset. The WebView rejects some resource types with a wrong type. */
    public static String mimeType(String rel) {
        String ext = "";
        int dot = rel.lastIndexOf('.');
        if (dot >= 0) ext = rel.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        switch (ext) {
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "svg": return "image/svg+xml";
            case "bmp": return "image/bmp";
            case "ico": return "image/x-icon";
            case "mp3": return "audio/mpeg";
            case "ogg":
            case "oga":
            case "opus": return "audio/ogg";
            case "wav": return "audio/wav";
            case "m4a": return "audio/mp4";
            case "aac": return "audio/aac";
            case "mp4": return "video/mp4";
            case "webm": return "video/webm";
            case "json": return "application/json";
            case "js":
            case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "html":
            case "htm": return "text/html";
            case "txt": return "text/plain";
            case "woff2": return "font/woff2";
            case "woff": return "font/woff";
            case "otf": return "font/otf";
            case "ttf": return "font/ttf";
            case "atlas":
            case "skel":
            case "bin":
            case "wasm":
            default: return "application/octet-stream";
        }
    }

    static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }
}
