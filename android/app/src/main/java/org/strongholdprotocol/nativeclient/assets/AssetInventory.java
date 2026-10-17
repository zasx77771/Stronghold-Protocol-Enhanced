package org.strongholdprotocol.nativeclient.assets;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * The set of asset files a client serves, with the canonical digest that ties it to the release
 * index.
 *
 * <p>The digest is the SHA-256 of {@code <path>\t<size>\t<sha256>\n} for every path in ascending
 * order, byte for byte the same computation {@code tools/assetPackages.mjs} performs. Paths are
 * restricted to printable ASCII, so a {@link TreeMap} (which orders by {@code String.compareTo},
 * that is, by UTF-16 code unit) reproduces the JavaScript {@code Array.sort()} order exactly.
 */
public final class AssetInventory {
    private final TreeMap<String, Entry> files = new TreeMap<>();

    /** One inventory row. */
    public static final class Entry {
        public final long size;
        public final String sha256;

        public Entry(long size, String sha256) {
            this.size = size;
            this.sha256 = String.valueOf(sha256).toLowerCase(java.util.Locale.ROOT);
        }

        public Map<String, Object> toJson() {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("size", size);
            json.put("sha256", sha256);
            return json;
        }
    }

    public AssetInventory() {
    }

    /** Read the {@code files} map of a state file: {@code {path: {size, sha256}}}. */
    public static AssetInventory fromFilesJson(Object filesJson) {
        AssetInventory inventory = new AssetInventory();
        if (filesJson == null) return inventory;
        Map<String, Object> map = AssetJson.object(filesJson);
        for (Map.Entry<String, Object> item : map.entrySet()) {
            Map<String, Object> entry = AssetJson.object(item.getValue());
            inventory.put(item.getKey(), AssetJson.number(entry.get("size"), -1), AssetJson.string(entry.get("sha256"), ""));
        }
        return inventory;
    }

    /** Read a published state file ({@code {format, version, files, …}}). */
    public static AssetInventory fromState(Map<String, Object> state) {
        return fromFilesJson(AssetJson.get(state, "files"));
    }

    public static AssetInventory copyOf(AssetInventory source) {
        AssetInventory inventory = new AssetInventory();
        inventory.files.putAll(source.files);
        return inventory;
    }

    public AssetInventory copy() {
        return copyOf(this);
    }

    public void put(String rel, long size, String sha256) {
        files.put(AssetPaths.assertSafe(rel), new Entry(size, sha256));
    }

    public Entry get(String rel) {
        return files.get(rel);
    }

    public void remove(String rel) {
        files.remove(rel);
    }

    public int count() {
        return files.size();
    }

    public long bytes() {
        long total = 0;
        for (Entry entry : files.values()) total += entry.size;
        return total;
    }

    public Iterable<String> paths() {
        return files.keySet();
    }

    /** Canonical digest, identical to the one the release tooling publishes. */
    public String digest() {
        MessageDigest digest = newDigest();
        StringBuilder line = new StringBuilder(128);
        for (Map.Entry<String, Entry> item : files.entrySet()) {
            line.setLength(0);
            line.append(item.getKey()).append('\t').append(item.getValue().size).append('\t')
                .append(item.getValue().sha256).append('\n');
            digest.update(AssetPaths.utf8(line.toString()));
        }
        return hex(digest.digest());
    }

    /** The {@code files} map, in ascending path order. */
    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        for (Map.Entry<String, Entry> item : files.entrySet()) json.put(item.getKey(), item.getValue().toJson());
        return json;
    }

    public static MessageDigest newDigest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static String sha256(byte[] data) {
        MessageDigest digest = newDigest();
        digest.update(data);
        return hex(digest.digest());
    }

    public static String sha256(InputStream input) throws IOException {
        MessageDigest digest = newDigest();
        byte[] buffer = new byte[1 << 16];
        int read;
        while ((read = input.read(buffer)) > 0) digest.update(buffer, 0, read);
        return hex(digest.digest());
    }

    public static String sha256(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return sha256(input);
        }
    }

    public static String hex(byte[] raw) {
        StringBuilder text = new StringBuilder(raw.length * 2);
        for (byte value : raw) {
            text.append(Character.forDigit((value >> 4) & 0xf, 16));
            text.append(Character.forDigit(value & 0xf, 16));
        }
        return text.toString();
    }
}
