package com.strongholdprotocol.covenant.assets;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * An asset package: a ZIP carrying {@code ASSETS.json} (the manifest), optionally {@code STATE.json}
 * (the complete target inventory, shipped by base packages) and the shipped files.
 *
 * <p>Everything here is defensive. A package is untrusted input: it arrives over the network from a
 * public bucket, so every path, size and digest is checked against the manifest before a single byte
 * is written, and the manifest itself is checked against the local state by {@link AssetStore}.
 */
public final class AssetPackage {
    private AssetPackage() {
    }

    public static final String FORMAT = "sp-assets-package-v1";
    public static final String KIND_BASE = "base";
    public static final String KIND_DELTA = "delta";
    private static final String HEX64 = "^[0-9a-f]{64}$";

    /** A deleted file, kept as a tombstone so a client can prove it removed the right content. */
    public static final class Tombstone {
        public final String path;
        public final long size;
        public final String sha256;

        Tombstone(String path, long size, String sha256) {
            this.path = path;
            this.size = size;
            this.sha256 = String.valueOf(sha256).toLowerCase(Locale.ROOT);
        }
    }

    /** The package manifest. */
    public static final class Manifest {
        public final String format;
        public final String kind;
        public final String version;
        public final String from;
        public final String fromInventory;
        public final String inventory;
        public final long count;
        public final long bytes;
        public final long shippedCount;
        public final long shippedBytes;
        public final AssetInventory files;
        public final List<Tombstone> removed;

        private Manifest(Map<String, Object> json) {
            this.format = AssetJson.string(AssetJson.get(json, "format"), "");
            this.kind = AssetJson.string(AssetJson.get(json, "kind"), "");
            this.version = AssetJson.string(AssetJson.get(json, "version"), "");
            this.from = AssetJson.string(AssetJson.get(json, "from"), null);
            this.fromInventory = AssetJson.string(AssetJson.get(json, "fromInventory"), null);
            this.inventory = AssetJson.string(AssetJson.get(json, "inventory"), "");
            this.count = AssetJson.number(AssetJson.get(json, "count"), -1);
            this.bytes = AssetJson.number(AssetJson.get(json, "bytes"), -1);
            Map<String, Object> shipped = AssetJson.objectOrNull(AssetJson.get(json, "shipped"));
            this.shippedCount = shipped == null ? -1 : AssetJson.number(shipped.get("count"), -1);
            this.shippedBytes = shipped == null ? -1 : AssetJson.number(shipped.get("bytes"), -1);
            this.files = AssetInventory.fromFilesJson(AssetJson.get(json, "files"));
            List<Tombstone> tombstones = new ArrayList<>();
            for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(json, "removed"))) {
                Map<String, Object> entry = AssetJson.object(item);
                tombstones.add(new Tombstone(
                    AssetJson.string(entry.get("path"), ""),
                    AssetJson.number(entry.get("size"), -1),
                    AssetJson.string(entry.get("sha256"), "")));
            }
            this.removed = tombstones;
        }

        public boolean isBase() {
            return KIND_BASE.equals(kind);
        }
    }

    /** Parse a manifest object. */
    public static Manifest parse(Map<String, Object> json) {
        return new Manifest(json);
    }

    /** Read and validate the manifest of a package file. */
    public static Manifest readManifest(File zip) throws IOException {
        Map<String, Object> json = readJson(zip, AssetPaths.PACKAGE_MANIFEST);
        if (json == null) throw new IOException(zip.getName() + " has no " + AssetPaths.PACKAGE_MANIFEST);
        Manifest manifest = new Manifest(json);
        check(manifest);
        return manifest;
    }

    /** The complete target inventory shipped by a base package, or null for a delta. */
    public static AssetInventory readState(File zip) throws IOException {
        Map<String, Object> json = readJson(zip, AssetPaths.PACKAGE_STATE);
        return json == null ? null : AssetInventory.fromState(json);
    }

    /** Raw bytes of one entry, or null when the package has no such entry. */
    public static byte[] readEntry(File zip, String name) throws IOException {
        try (ZipFile archive = new ZipFile(zip)) {
            ZipEntry entry = archive.getEntry(name);
            if (entry == null || entry.isDirectory()) return null;
            return readAll(archive.getInputStream(entry), Math.max(entry.getSize(), 0) + 1024);
        }
    }

    /**
     * Validate a manifest on its own. Throws {@link IllegalArgumentException} listing every problem,
     * so a malformed package is refused before it can touch the file system.
     */
    public static void check(Manifest manifest) {
        List<String> problems = new ArrayList<>();
        if (!FORMAT.equals(manifest.format)) problems.add("format " + manifest.format);
        if (!KIND_BASE.equals(manifest.kind) && !KIND_DELTA.equals(manifest.kind)) problems.add("kind " + manifest.kind);
        if (manifest.version == null || manifest.version.isEmpty()) problems.add("no version");
        if (manifest.isBase()) {
            if (manifest.from != null) problems.add("a base package has a source version");
        } else if (manifest.from == null || manifest.from.isEmpty()) {
            problems.add("a delta package has no source version");
        }
        if (!String.valueOf(manifest.inventory).matches(HEX64)) problems.add("bad inventory digest");
        // count/bytes describe the complete target state, while files only lists what the package
        // ships: a delta ships a subset, a base ships everything.
        if (manifest.count >= 0 && manifest.count < manifest.files.count()) {
            problems.add("the manifest ships more files than the target state holds");
        }
        if (manifest.isBase() && manifest.count >= 0 && manifest.count != manifest.files.count()) {
            problems.add("a base package must ship every file of its state");
        }
        for (String rel : manifest.files.paths()) {
            String pathProblem = AssetPaths.problem(rel);
            if (pathProblem != null) problems.add("unsafe file path \"" + rel + "\": " + pathProblem);
            else if (!AssetPaths.isAssetPath(rel)) problems.add("path outside the asset set: " + rel);
            if (AssetPaths.isJunk(rel)) problems.add("junk file " + rel);
            AssetInventory.Entry entry = manifest.files.get(rel);
            if (entry == null || !entry.sha256.matches(HEX64)) problems.add("bad sha256 for " + rel);
            if (entry != null && entry.size < 0) problems.add("bad size for " + rel);
        }
        for (Tombstone tombstone : manifest.removed) {
            String pathProblem = AssetPaths.problem(tombstone.path);
            if (pathProblem != null) problems.add("unsafe removed path \"" + tombstone.path + "\": " + pathProblem);
            else if (!AssetPaths.isAssetPath(tombstone.path)) problems.add("removed path outside the asset set: " + tombstone.path);
            if (!tombstone.sha256.matches(HEX64)) problems.add("bad removed sha256 for " + tombstone.path);
        }
        if (!problems.isEmpty()) throw new IllegalArgumentException("bad asset package: " + join(problems));
    }

    /** Result of staging a package. */
    public static final class ExtractResult {
        public final int files;
        public final long bytes;
        public final byte[] manifestBytes;
        public final byte[] stateBytes;

        ExtractResult(int files, long bytes, byte[] manifestBytes, byte[] stateBytes) {
            this.files = files;
            this.bytes = bytes;
            this.manifestBytes = manifestBytes;
            this.stateBytes = stateBytes;
        }
    }

    /**
     * Write the shipped files of a verified package into {@code dest} (a staging directory).
     *
     * <p>Rejected: absolute paths, traversal, backslashes, non-ASCII names, junk names, duplicate
     * entries, entries the manifest does not list, wrong declared sizes, wrong content digests and
     * declared totals above {@code maxExtractBytes}. A throw leaves a partial {@code dest} behind on
     * purpose: the caller deletes the whole staging directory.
     */
    public static ExtractResult extract(File zip, Manifest manifest, File dest, long maxExtractBytes) throws IOException {
        long declared = manifest.shippedBytes >= 0 ? manifest.shippedBytes : manifest.files.bytes();
        if (declared > maxExtractBytes) {
            throw new IOException("package extracts " + declared + " bytes, above the " + maxExtractBytes + " byte limit");
        }
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("cannot create " + dest);

        Set<String> seen = new HashSet<>();
        Set<String> written = new HashSet<>();
        long total = 0;
        byte[] manifestBytes = null;
        byte[] stateBytes = null;
        try (ZipFile archive = new ZipFile(zip)) {
            java.util.Enumeration<? extends ZipEntry> entries = archive.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (entry.isDirectory()) {
                    if (!seen.add(name)) throw new IOException("package repeats " + name);
                    continue;
                }
                if (!seen.add(name)) throw new IOException("package repeats " + name);
                if (AssetPaths.PACKAGE_MANIFEST.equals(name)) {
                    if (manifestBytes != null) throw new IOException("package repeats " + name);
                    manifestBytes = readAll(archive.getInputStream(entry), 8L << 20);
                    continue;
                }
                if (AssetPaths.PACKAGE_STATE.equals(name)) {
                    if (stateBytes != null) throw new IOException("package repeats " + name);
                    stateBytes = readAll(archive.getInputStream(entry), 64L << 20);
                    continue;
                }
                // Never trust the archive: the same rules that guard the manifest guard the entry.
                AssetPaths.assertSafe(name);
                if (AssetPaths.isJunk(name)) throw new IOException("package ships junk file " + name);
                AssetInventory.Entry expected = manifest.files.get(name);
                if (expected == null) throw new IOException("package ships " + name + ", which the manifest does not list");
                long declaredSize = entry.getSize();
                if (declaredSize >= 0 && declaredSize != expected.size) {
                    throw new IOException(name + " declares " + declaredSize + " bytes, the manifest says " + expected.size);
                }
                byte[] data = readAll(archive.getInputStream(entry), expected.size);
                if (data.length != expected.size) {
                    throw new IOException(name + " is " + data.length + " bytes, expected " + expected.size);
                }
                String digest = AssetInventory.sha256(data);
                if (!digest.equals(expected.sha256)) {
                    throw new IOException(name + " hashes to " + digest + ", expected " + expected.sha256);
                }
                File out = AssetPaths.target(dest, name);
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
                try (FileOutputStream stream = new FileOutputStream(out)) {
                    stream.write(data);
                }
                total += data.length;
                if (total > maxExtractBytes) throw new IOException("package writes more than " + maxExtractBytes + " bytes");
                written.add(name);
            }
        }
        for (String rel : manifest.files.paths()) {
            if (!written.contains(rel)) throw new IOException("package is missing " + rel);
        }
        if (manifestBytes == null) throw new IOException("package is missing " + AssetPaths.PACKAGE_MANIFEST);
        return new ExtractResult(written.size(), total, manifestBytes, stateBytes);
    }

    /**
     * The inventory a client has after applying a package. A base carries the complete state and
     * replaces the previous inventory (that is the compaction step); a delta layers on top.
     */
    public static AssetInventory merge(AssetInventory before, Manifest manifest) {
        AssetInventory next = manifest.isBase() ? new AssetInventory() : AssetInventory.copyOf(before);
        for (String rel : manifest.files.paths()) {
            AssetInventory.Entry entry = manifest.files.get(rel);
            next.put(rel, entry.size, entry.sha256);
        }
        for (Tombstone tombstone : manifest.removed) next.remove(tombstone.path);
        return next;
    }

    private static Map<String, Object> readJson(File zip, String name) throws IOException {
        byte[] data = readEntry(zip, name);
        if (data == null) return null;
        try {
            return AssetJson.object(AssetJson.parse(new String(data, java.nio.charset.StandardCharsets.UTF_8)));
        } catch (IllegalArgumentException error) {
            throw new IOException(zip.getName() + ": " + name + " is not a JSON object: " + error.getMessage(), error);
        }
    }

    /** Read a stream into memory, refusing to exceed {@code limit} bytes. */
    static byte[] readAll(InputStream input, long limit) throws IOException {
        long cap = limit <= 0 ? 1 : limit;
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] buffer = new byte[1 << 16];
        long total = 0;
        try (InputStream stream = input) {
            int read;
            while ((read = stream.read(buffer)) > 0) {
                total += read;
                if (total > cap) throw new IOException("entry is larger than its declared " + cap + " bytes");
                out.write(buffer, 0, read);
            }
        }
        return out.toByteArray();
    }

    static String join(List<String> problems) {
        StringBuilder text = new StringBuilder();
        for (String problem : problems) {
            if (text.length() > 0) text.append("; ");
            text.append(problem);
        }
        return text.toString();
    }
}
