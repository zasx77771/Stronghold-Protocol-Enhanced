package com.strongholdprotocol.covenant.assets;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The runtime asset store: an immutable floor (the APK's own assets) plus zero or more applied
 * package layers, addressed by a single pointer file.
 *
 * <p>Every update is staged and verified before it can be observed: files are written under
 * {@code asset-staging}, checked against the package manifest, moved into {@code asset-layers}, and
 * only then does the atomic replacement of {@code asset-store.json} publish the new state. A failure,
 * a crash or a lost network connection at any point leaves either the previous pointer (the old
 * version, untouched) or, at worst, an unreferenced layer directory that the next successful update
 * removes. That is what makes "a failed update never damages the old cache" true rather than hoped
 * for.
 *
 * <p><b>Concurrency.</b> The updater applies packages on its own thread while the WebView asks for
 * assets on the main thread and its network threads. Everything a reader may see lives in one
 * immutable {@link Snapshot} behind a single volatile reference: the layer list, the merged inventory
 * and its digest are built off to the side and published together, so a request either sees the whole
 * old state or the whole new one — never a half-committed layer list. Reads take one snapshot and use
 * it for the whole request; {@link #apply} is the only writer and is serialized, and it publishes the
 * new snapshot only after the pointer file already names it.
 */
public final class AssetStore {
    private final File root;
    private final AssetSource floor;
    private final AssetInventory floorInventory;
    private final String floorVersion;
    private final String floorKind;
    private final List<String> notes = Collections.synchronizedList(new ArrayList<String>());

    /**
     * Everything a reader may observe, published as one unit. {@code inventory} is never mutated
     * after publication ({@link AssetPackage#merge} copies), so it can be shared between threads.
     */
    public static final class Snapshot {
        public final String version;
        public final String floor;
        public final List<Layer> layers;
        public final AssetInventory inventory;
        public final String digest;

        Snapshot(String version, String floor, List<Layer> layers, AssetInventory inventory) {
            this.version = version;
            this.floor = floor;
            this.layers = Collections.unmodifiableList(new ArrayList<>(layers));
            this.inventory = inventory;
            this.digest = inventory.digest();
        }
    }

    private volatile Snapshot state;

    /** One applied package. */
    public static final class Layer {
        public final String dir;
        public final String kind;
        public final String version;
        public final String from;

        Layer(String dir, String kind, String version, String from) {
            this.dir = dir;
            this.kind = kind;
            this.version = version;
            this.from = from;
        }
    }

    /** A served asset and where it came from. */
    public static final class Hit {
        public final String source;
        public final String path;
        private final File file;
        private final AssetSource floorSource;

        private Hit(String source, String path, File file, AssetSource floorSource) {
            this.source = source;
            this.path = path;
            this.file = file;
            this.floorSource = floorSource;
        }

        public InputStream open() throws IOException {
            if (file != null) return new FileInputStream(file);
            if (floorSource != null) return floorSource.open(path);
            throw new IOException("asset is not readable: " + path);
        }

        public long length() {
            return file != null ? file.length() : -1;
        }
    }

    /** The result of one successful package commit. */
    public static final class Applied {
        public final String version;
        public final String inventory;
        public final String kind;
        public final int files;
        public final int removed;
        public final int layers;

        Applied(String version, String inventory, String kind, int files, int removed, int layers) {
            this.version = version;
            this.inventory = inventory;
            this.kind = kind;
            this.files = files;
            this.removed = removed;
            this.layers = layers;
        }

        @Override
        public String toString() {
            return "applied " + kind + " " + version + " (" + files + " file(s), " + removed + " removal(s), " + layers + " layer(s))";
        }
    }

    /**
     * The move and copy primitives the pointer replacement uses. Production code uses real file
     * operations; the self-test substitutes a failing implementation to prove that a rejected
     * pointer replacement keeps the old pointer and the old cache intact.
     */
    public interface PointerIo {
        boolean rename(File from, File to);

        void copy(File from, File to) throws IOException;
    }

    private static final PointerIo REAL_IO = new PointerIo() {
        @Override
        public boolean rename(File from, File to) {
            return from.renameTo(to);
        }

        @Override
        public void copy(File from, File to) throws IOException {
            AssetStore.copy(from, to);
        }
    };

    private volatile PointerIo pointerIo = REAL_IO;

    private AssetStore(File root, AssetSource floor, AssetInventory floorInventory, String floorVersion, String floorKind, List<Layer> layers, List<String> notes) {
        this.root = root;
        this.floor = floor;
        this.floorInventory = floorInventory;
        this.floorVersion = floorVersion;
        this.floorKind = floorKind;
        this.notes.addAll(notes);
        this.state = snapshotFor(layers);
    }

    /**
     * Open the store.
     *
     * @param root the writable directory that holds the pointer and the layers
     * @param floor the immutable asset source (the APK), or null when the build stamps no state
     * @param floorInventory the inventory of {@code floor}
     * @param floorVersion the version the floor belongs to
     */
    public static AssetStore open(File root, AssetSource floor, AssetInventory floorInventory, String floorVersion) throws IOException {
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("cannot create the asset store at " + root);
        List<String> notes = new ArrayList<>();
        List<Layer> layers = readLayers(root, notes);
        AssetStore store = new AssetStore(root, floor, floorInventory, floorVersion, floor == null ? "none" : "apk", layers, notes);
        // A staging directory only ever belongs to an interrupted commit; layers are referenced by the
        // pointer, so unreferenced directories are ignored here and cleaned up by the next commit.
        deleteTree(new File(root, AssetPaths.STAGING_DIR));
        return store;
    }

    /** Open the store with a directory as its floor (tests and local verification). */
    public static AssetStore openDir(File root, File floorRoot) throws IOException {
        AssetSource floor = null;
        AssetInventory inventory = null;
        String version = null;
        if (floorRoot != null && floorRoot.isDirectory()) {
            File state = new File(floorRoot, AssetPaths.STATE_FILE);
            if (state.isFile()) {
                Map<String, Object> json = AssetJson.object(AssetJson.parse(readText(state)));
                String format = AssetJson.string(AssetJson.get(json, "format"), "");
                if (!"sp-assets-state-v1".equals(format)) throw new IOException(state + ": unsupported state format " + format);
                inventory = AssetInventory.fromState(json);
                version = AssetJson.string(AssetJson.get(json, "version"), null);
                floor = new DirectoryAssetSource(floorRoot);
            }
        }
        return open(root, floor, inventory, version);
    }

    /**
     * Read the layer list from the pointer, falling back to {@code asset-store.json.bak} when a
     * replacement was interrupted after the old pointer had been moved aside: the backup is what the
     * next launch recovers the previous state from.
     */
    private static List<Layer> readLayers(File root, List<String> notes) {
        File pointer = new File(root, AssetPaths.STORE_FILE);
        File backup = new File(root, AssetPaths.STORE_FILE + ".bak");
        List<Layer> layers = pointerLayers(root, pointer);
        // The backup is also consulted when the pointer is simply absent: a replacement that stopped
        // right after the old pointer had been moved aside leaves a usable backup and no pointer.
        boolean lost = layers == null || (layers.isEmpty() && !pointer.isFile());
        if (lost && backup.isFile()) {
            List<Layer> recovered = pointerLayers(root, backup);
            if (recovered != null) {
                layers = recovered;
                notes.add("recovered the asset pointer from " + backup.getName());
                try {
                    copy(backup, pointer);
                } catch (IOException error) {
                    notes.add("could not restore " + pointer.getName() + ": " + error.getMessage());
                }
            }
        }
        if (layers == null) {
            // A corrupt pointer must never break the app: fall back to the floor only. The layer
            // directories stay on disk so nothing is lost, they are simply not trusted.
            notes.add("ignoring an unreadable " + AssetPaths.STORE_FILE + "; serving the floor only");
            return new ArrayList<>();
        }
        return layers;
    }

    /** The layers of one pointer file: an empty list when absent, null when it cannot be trusted. */
    private static List<Layer> pointerLayers(File root, File pointer) {
        if (!pointer.isFile()) return new ArrayList<>();
        try {
            Map<String, Object> store = AssetJson.object(AssetJson.parse(readText(pointer)));
            if (!"sp-assets-store-v1".equals(AssetJson.string(AssetJson.get(store, "format"), ""))) return null;
            List<Layer> layers = new ArrayList<>();
            for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(store, "layers"))) {
                Map<String, Object> layer = AssetJson.object(item);
                String dir = AssetJson.string(layer.get("dir"), "");
                if (AssetPaths.problem(dir) != null) return null;
                File manifest = new File(new File(new File(root, AssetPaths.LAYER_DIR), dir), AssetPaths.PACKAGE_MANIFEST);
                if (!manifest.isFile()) return null;
                layers.add(new Layer(dir,
                    AssetJson.string(layer.get("kind"), ""),
                    AssetJson.string(layer.get("version"), ""),
                    AssetJson.string(layer.get("from"), null)));
            }
            return layers;
        } catch (IOException | IllegalArgumentException error) {
            return null;
        }
    }

    /** Merge the floor and the given layers into the snapshot that is about to be published. */
    private Snapshot snapshotFor(List<Layer> layers) {
        List<Layer> frozen = new ArrayList<>(layers);
        AssetInventory inventory = floorInventory == null ? new AssetInventory() : AssetInventory.copyOf(floorInventory);
        for (Layer layer : frozen) {
            File dir = new File(new File(root, AssetPaths.LAYER_DIR), layer.dir);
            try {
                Map<String, Object> json = AssetJson.object(AssetJson.parse(readText(new File(dir, AssetPaths.PACKAGE_MANIFEST))));
                inventory = AssetPackage.merge(inventory, AssetPackage.parse(json));
            } catch (IOException | IllegalArgumentException error) {
                // A layer that cannot be read is ignored rather than trusted; the pointer check at
                // open time already rejects this case, so this is belt and braces.
                notes.add("ignoring unreadable layer " + layer.dir + ": " + error.getMessage());
            }
        }
        String version = frozen.isEmpty() ? floorVersion : frozen.get(frozen.size() - 1).version;
        return new Snapshot(version, floorKind, frozen, inventory);
    }

    public List<String> notes() {
        synchronized (notes) {
            return Collections.unmodifiableList(new ArrayList<>(notes));
        }
    }

    /** The published state; every reader shares the same immutable instance. */
    public Snapshot snapshot() {
        return state;
    }

    public List<Layer> layers() {
        return state.layers;
    }

    /**
     * The version the client currently serves. Layers are ordered oldest to newest, so the last one
     * wins; the floor version is used when nothing has been applied.
     */
    public String version() {
        return state.version;
    }

    public String floorKind() {
        return floorKind;
    }

    /** True when a local state exists, which is what a delta chain needs to be trusted. */
    public boolean hasState() {
        return floorInventory != null || !state.layers.isEmpty();
    }

    /** The inventory the client currently serves, as of the published snapshot. */
    public AssetInventory inventory() {
        return state.inventory;
    }

    public String inventoryDigest() {
        return state.digest;
    }

    /**
     * Resolve one served path: newest layer first, then the retired grace set, then the immutable
     * floor — but only while the current inventory still lists the path, so a file an update removed
     * is never resurrected from the APK.
     */
    public Hit resolve(String rel) {
        if (!AssetPaths.isAssetPath(rel) || AssetPaths.problem(rel) != null) return null;
        // One snapshot for the whole request: it is the set the client is entitled to see, so the
        // check comes first, and a file a later update removed is never resurrected from an older
        // layer or from the APK.
        Snapshot current = state;
        if (current.inventory.get(rel) == null) return null;
        String local = rel.replace('/', File.separatorChar);
        List<Layer> layers = current.layers;
        for (int i = layers.size() - 1; i >= 0; i -= 1) {
            File candidate = new File(new File(new File(root, AssetPaths.LAYER_DIR), layers.get(i).dir), local);
            if (candidate.isFile()) return new Hit("layer", rel, candidate, null);
        }
        // Files a commit removed are only *moved* here (never deleted straight away) so a response
        // stream that is still being read keeps its inode; the inventory guard above means the set is
        // not served again.
        File retired = new File(new File(root, AssetPaths.RETIRED_DIR), local);
        if (retired.isFile()) return new Hit("retired", rel, retired, null);
        if (floor != null && floor.has(rel)) return new Hit("floor", rel, null, floor);
        return null;
    }

    /**
     * Verify and apply one package file. Throws before any visible change when anything does not add
     * up; the caller only has to delete the downloaded file. Commits are serialized, and the new
     * state becomes visible in one step.
     */
    public synchronized Applied apply(File packageFile, String expectedSha256, long maxExtractBytes) throws IOException {
        if (!packageFile.isFile()) throw new IOException("no such package: " + packageFile);
        if (expectedSha256 != null) {
            String digest = AssetInventory.sha256(packageFile);
            if (!digest.equalsIgnoreCase(expectedSha256)) {
                throw new IOException("package sha256 " + digest + " does not match the index digest " + expectedSha256);
            }
        }
        AssetPackage.Manifest manifest = AssetPackage.readManifest(packageFile);
        Snapshot current = state;
        AssetInventory before = current.inventory;
        String beforeVersion = current.version;
        if (!manifest.isBase()) {
            if (manifest.from == null) throw new IOException("delta package without a source version");
            if (!manifest.from.equals(beforeVersion)) {
                throw new IOException("package " + manifest.from + " -> " + manifest.version + " does not continue from " + beforeVersion);
            }
            if (manifest.fromInventory == null || !manifest.fromInventory.equalsIgnoreCase(before.digest())) {
                throw new IOException("package expects source inventory " + manifest.fromInventory + ", the local state is " + before.digest());
            }
        } else if (beforeVersion != null && AssetIndex.compareVersions(manifest.version, beforeVersion) < 0) {
            throw new IOException("package " + manifest.version + " is older than the local " + beforeVersion);
        }
        AssetInventory next = AssetPackage.merge(before, manifest);
        String nextDigest = next.digest();
        if (!nextDigest.equalsIgnoreCase(manifest.inventory)) {
            throw new IOException("package lands on inventory " + nextDigest + ", the manifest declares " + manifest.inventory);
        }
        if (manifest.isBase()) {
            AssetInventory state = AssetPackage.readState(packageFile);
            if (state == null) throw new IOException("a base package must ship " + AssetPaths.PACKAGE_STATE);
            if (!state.digest().equalsIgnoreCase(manifest.inventory)) {
                throw new IOException(AssetPaths.PACKAGE_STATE + " does not match the manifest inventory");
            }
        }

        File staging = new File(root, AssetPaths.STAGING_DIR);
        deleteTree(staging);
        try {
            AssetPackage.ExtractResult result = AssetPackage.extract(packageFile, manifest, new File(staging, "files"), maxExtractBytes);
            File layersDir = new File(root, AssetPaths.LAYER_DIR);
            if (!layersDir.isDirectory() && !layersDir.mkdirs()) throw new IOException("cannot create " + layersDir);
            int generation = 1;
            for (Layer layer : current.layers) generation = Math.max(generation, generation(layer.dir) + 1);
            File target = new File(layersDir, layerName(generation, manifest));
            // A directory an older layer still references is never reused: a reader that took the
            // previous snapshot keeps the files it already resolved until its request is done.
            while (target.exists()) {
                generation += 1;
                target = new File(layersDir, layerName(generation, manifest));
            }
            deleteTree(new File(root, AssetPaths.RETIRED_DIR));
            retireRemoved(current.layers, before, next);
            move(new File(staging, "files"), target);
            write(new File(target, AssetPaths.PACKAGE_MANIFEST), result.manifestBytes);
            if (result.stateBytes != null) write(new File(target, AssetPaths.PACKAGE_STATE), result.stateBytes);

            List<Layer> nextLayers = new ArrayList<>();
            if (!manifest.isBase()) nextLayers.addAll(current.layers);
            nextLayers.add(new Layer(target.getName(), manifest.kind, manifest.version, manifest.from));
            // The pointer is what makes a commit visible, so it is written (atomically, keeping the old
            // pointer recoverable) before any older layer is removed, and the immutable snapshot is
            // published right after it: a request sees the old state or the new one, never a mixture.
            writePointer(nextLayers);
            Snapshot published = snapshotFor(nextLayers);
            if (!published.digest.equalsIgnoreCase(nextDigest)) {
                notes.add("published inventory " + published.digest + " differs from the verified " + nextDigest);
            }
            state = published;
            sweepLayers(layersDir, nextLayers);
            return new Applied(manifest.version, nextDigest, manifest.kind, result.files, manifest.removed.size(), nextLayers.size());
        } finally {
            deleteTree(staging);
        }
    }

    private static String layerName(int generation, AssetPackage.Manifest manifest) {
        return pad4(generation) + "-" + manifest.kind + "-"
            + (manifest.from != null ? manifest.from : manifest.version) + "-" + manifest.version;
    }

    /** Remove every layer directory the published state does not reference. */
    private static void sweepLayers(File layersDir, List<Layer> keep) {
        File[] entries = layersDir.listFiles();
        if (entries == null) return;
        List<String> referenced = new ArrayList<>();
        for (Layer layer : keep) referenced.add(layer.dir);
        for (File entry : entries) {
            if (entry.isDirectory() && !referenced.contains(entry.getName())) deleteTree(entry);
        }
    }

    private Map<String, Object> storeJson(List<Layer> nextLayers) {
        Map<String, Object> store = new LinkedHashMap<>();
        store.put("format", "sp-assets-store-v1");
        store.put("version", nextLayers.isEmpty() ? floorVersion : nextLayers.get(nextLayers.size() - 1).version);
        store.put("floor", floorKind);
        List<Object> list = new ArrayList<>();
        for (Layer layer : nextLayers) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("dir", layer.dir);
            item.put("kind", layer.kind);
            item.put("version", layer.version);
            item.put("from", layer.from);
            list.add(item);
        }
        store.put("layers", list);
        return store;
    }

    /**
     * Replace the pointer file.
     *
     * <p>The fast path is a single rename, which replaces the destination atomically. When the
     * platform refuses to rename over an existing file (Windows-style), the current pointer is first
     * moved to {@code asset-store.json.bak} and the new content is then renamed into place, or copied
     * as a last resort. If every attempt fails the previous pointer is restored from the backup, so a
     * failed commit leaves the old state fully usable — on disk and in memory — and never a missing or
     * truncated pointer. Anything the backup cannot repair is recovered by {@link #open} on the next
     * launch.
     */
    private void writePointer(List<Layer> nextLayers) throws IOException {
        byte[] data = AssetJson.stringify(storeJson(nextLayers)).getBytes(StandardCharsets.UTF_8);
        File pointer = new File(root, AssetPaths.STORE_FILE);
        File temp = new File(root, AssetPaths.STORE_FILE + ".tmp");
        File backup = new File(root, AssetPaths.STORE_FILE + ".bak");
        PointerIo io = pointerIo;
        write(temp, data);
        if (io.rename(temp, pointer)) {
            safeDelete(backup);
            return;
        }
        if (pointer.isFile()) {
            safeDelete(backup);
            if (!io.rename(pointer, backup)) copy(pointer, backup);
        }
        boolean published = false;
        try {
            published = io.rename(temp, pointer);
            if (!published) {
                io.copy(temp, pointer);
                published = true;
            }
        } finally {
            if (!published) restorePointer(pointer, backup);
            safeDelete(temp);
            if (published) safeDelete(backup);
        }
    }

    /**
     * Put the previous pointer back after a failed replacement. The real file primitives are used on
     * purpose: recovery must not depend on the seam that just failed.
     */
    private static void restorePointer(File pointer, File backup) {
        if (!backup.isFile()) return;
        try {
            copy(backup, pointer);
            safeDelete(backup);
        } catch (IOException error) {
            // The backup stays on disk; open() recovers from it on the next launch.
        }
    }

    private static void safeDelete(File file) {
        if (file == null || !file.exists()) return;
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** Test seam: substitute the pointer primitives, for example to fail the replacement on purpose. */
    void pointerIoForTest(PointerIo io) {
        this.pointerIo = io == null ? REAL_IO : io;
    }

    /**
     * Keep the files this update deletes available for one update cycle, so a page that was already
     * loaded can still fetch what it references. Only layer files are copied: the APK copy of a
     * floor file is still there, it is just no longer served.
     */
    private void retireRemoved(List<Layer> sourceLayers, AssetInventory before, AssetInventory next) {
        List<String> removed = new ArrayList<>();
        for (String rel : before.paths()) {
            if (next.get(rel) == null) removed.add(rel);
        }
        if (removed.isEmpty()) return;
        File retired = new File(root, AssetPaths.RETIRED_DIR);
        if (!retired.isDirectory() && !retired.mkdirs()) return;
        for (String rel : removed) {
            for (int i = sourceLayers.size() - 1; i >= 0; i -= 1) {
                File candidate = new File(new File(new File(root, AssetPaths.LAYER_DIR), sourceLayers.get(i).dir), rel.replace('/', File.separatorChar));
                if (!candidate.isFile()) continue;
                try {
                    File target = AssetPaths.target(retired, rel);
                    File parent = target.getParentFile();
                    if (parent != null && !parent.isDirectory()) parent.mkdirs();
                    copy(candidate, target);
                } catch (IOException error) {
                    notes.add("could not retire " + rel + ": " + error.getMessage());
                }
                break;
            }
        }
    }

    static int generation(String dir) {
        if (dir == null || dir.length() < 4) return 0;
        try {
            return Integer.parseInt(dir.substring(0, 4));
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    static String pad4(int value) {
        String text = Integer.toString(value);
        StringBuilder padded = new StringBuilder();
        for (int i = text.length(); i < 4; i += 1) padded.append('0');
        return padded.append(text).toString();
    }

    static String readText(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    static void write(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    static void copy(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
    }

    /** Move a directory into place. Falls back to a recursive copy across file-system boundaries. */
    static void move(File from, File to) throws IOException {
        if (!from.isDirectory()) throw new IOException("nothing to move: " + from);
        if (from.renameTo(to)) return;
        copyTree(from, to);
        deleteTree(from);
    }

    static void copyTree(File from, File to) throws IOException {
        if (!to.isDirectory() && !to.mkdirs()) throw new IOException("cannot create " + to);
        File[] entries = from.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            File target = new File(to, entry.getName());
            if (entry.isDirectory()) copyTree(entry, target);
            else copy(entry, target);
        }
    }

    static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] entries = file.listFiles();
            if (entries != null) {
                for (File entry : entries) deleteTree(entry);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** Short human-readable summary for logs. */
    public String describe() {
        Snapshot current = state;
        StringBuilder text = new StringBuilder();
        text.append("store ").append(root).append(" version=").append(current.version)
            .append(" floor=").append(current.floor).append(" layers=").append(current.layers.size());
        List<String> collected = notes();
        if (!collected.isEmpty()) text.append(" notes=").append(collected);
        return text.toString();
    }

    @Override
    public String toString() {
        return describe();
    }
}
