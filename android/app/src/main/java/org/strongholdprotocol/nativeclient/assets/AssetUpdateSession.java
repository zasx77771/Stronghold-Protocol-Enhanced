package org.strongholdprotocol.nativeclient.assets;

import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Explicit, user-driven runtime asset update session for the thin Android client.
 *
 * <p>The old startup updater checked the release index by itself on every launch and downloaded in the
 * background as soon as a game-session token arrived. Nothing may transfer bytes without a player's
 * request any more, so the work is split into two deliberate steps:
 *
 * <ol>
 *   <li>{@link #prepare()} exchanges the private session token for an asset token, reads the release
 *       index and computes the {@link AssetIndex.Plan}. It downloads no package. The plan (versions,
 *       package names, sizes, hashes) is what the UI shows in its confirmation dialog.</li>
 *   <li>{@link #start()} runs exactly the prepared plan, reporting per-package bytes, and only the UI
 *       calls it after the player confirms. {@link #retry()} is the same explicit request again.</li>
 * </ol>
 *
 * <p>Secrets stay here: the game-session token and the exchanged asset token are private fields, are
 * never part of {@link #status()}, and the only way a token enters the session is
 * {@link #setSessionToken(String)} (called by the native TCP bridge), or the {@link Fetcher} seam for
 * tests. Everything the UI sees is public release metadata.
 *
 * <p>Failure never damages the installed assets: a package is only committed by
 * {@link AssetStore#apply(File, String, long)} after its SHA-256 matches, a failed or cancelled
 * transfer deletes its temporary file, and the previous version stays installed and serving.
 *
 * <p>The class is plain Java (no Android types) so {@code tools/android-asset-tests.mjs} can exercise
 * it on a JVM with an injected {@link Fetcher}.
 */
public final class AssetUpdateSession {
    /** The network surface the session needs. The default implementation is {@link AssetUpdater}. */
    public interface Fetcher {
        String exchangeToken(AssetConfig config, String sessionToken) throws IOException;

        byte[] bytes(String url, long limit, AssetConfig config, String authorization) throws IOException;

        void file(String url, File target, long limit, AssetConfig config, String authorization, AssetUpdater.Progress progress) throws IOException;
    }

    /** Notified after every state change with a fresh snapshot that is safe to hand to the WebView. */
    public interface Listener {
        void onState(Map<String, Object> status);
    }

    public static final String UNAVAILABLE = "unavailable";
    public static final String UNCONFIGURED = "unconfigured";
    public static final String WAITING = "waiting-session";
    public static final String IDLE = "idle";
    public static final String PREPARING = "preparing";
    public static final String READY = "ready";
    public static final String DOWNLOADING = "downloading";
    public static final String APPLYING = "applying";
    public static final String COMPLETE = "complete";
    public static final String BLOCKED = "blocked";
    public static final String FAILED = "failed";
    public static final String CANCELLED = "cancelled";
    public static final String STATUS_FORMAT = "sp-asset-update-status-v1";

    private static final String SESSION_TOKEN_PATTERN = "[0-9a-f]{32}";
    private static final String TEMP_PACKAGE = "asset-package.zip";

    /** Signalled from inside a byte-progress callback to stop the transfer at the next chunk. */
    private static final class Aborted extends RuntimeException {
        private static final long serialVersionUID = 1L;
    }

    private final AssetStore store;
    private final AssetConfig config;
    private final File cacheDir;
    private final Fetcher fetcher;

    private Listener listener;
    private String sessionToken;
    private String assetToken;
    private String state;
    private String message = "";
    private String error = "";
    private boolean retryable;
    private AssetIndex index;
    private AssetIndex.Plan plan;
    private volatile boolean abort;
    private int packageIndex;
    private int packageCount;
    private String packageName = "";
    private long packageDone;
    private long packageSize;
    private long doneBytes;
    private long totalBytes;

    public AssetUpdateSession(AssetStore store, AssetConfig config, File cacheDir, Fetcher fetcher) {
        this.store = store;
        this.config = config;
        this.cacheDir = cacheDir;
        this.fetcher = fetcher == null ? new DefaultFetcher() : fetcher;
        this.state = initialState();
    }

    /**
     * @return the state the session starts in: no store is a hard stop, no usable configuration is
     *     unconfigured, and a protected deployment waits for the game session before anything else.
     */
    private String initialState() {
        if (store == null) return UNAVAILABLE;
        if (config == null || !config.enabled) return UNCONFIGURED;
        return protectedAssets() ? WAITING : IDLE;
    }

    private boolean protectedAssets() {
        return config != null && config.tokenUrl != null && !config.tokenUrl.isEmpty();
    }

    public synchronized void setListener(Listener value) {
        listener = value;
    }

    /** The native TCP bridge hands the game-session token over here; an invalid token is ignored. */
    public synchronized void setSessionToken(String token) {
        if (token == null || !token.matches(SESSION_TOKEN_PATTERN)) return;
        sessionToken = token;
        if (WAITING.equals(state)) {
            state = IDLE;
            message = "";
            notifyState();
        }
    }

    public synchronized boolean hasSession() {
        return sessionToken != null;
    }

    /**
     * Exchange the session token, read the release index and describe what a download would install.
     * No package is transferred and the installed assets are untouched.
     *
     * @return the new status snapshot
     */
    public Map<String, Object> prepare() {
        synchronized (this) {
            if (store == null) {
                state = UNAVAILABLE;
                message = "the runtime asset store is unavailable";
                notifyState();
                return status();
            }
            if (config == null || !config.enabled) {
                state = UNCONFIGURED;
                message = config == null ? "no configuration" : AssetPackage.join(config.problems);
                notifyState();
                return status();
            }
            if (protectedAssets() && sessionToken == null) {
                state = WAITING;
                message = "waiting for the game session";
                notifyState();
                return status();
            }
            abort = false;
            index = null;
            plan = null;
            assetToken = null;
            error = "";
            retryable = false;
            packageIndex = 0;
            packageCount = 0;
            packageName = "";
            packageDone = 0;
            packageSize = 0;
            doneBytes = 0;
            totalBytes = 0;
            state = PREPARING;
            message = "checking the release index";
            notifyState();
        }
        try {
            String token = protectedAssets() ? fetcher.exchangeToken(config, sessionToken) : null;
            AssetIndex parsed = AssetIndex.parse(new String(
                    fetcher.bytes(config.indexUrl, config.maxIndexBytes, config, token), StandardCharsets.UTF_8));
            String localVersion = store.hasState() ? store.version() : null;
            String localInventory = store.hasState() ? store.inventoryDigest() : null;
            AssetIndex.Plan computed = parsed.plan(localVersion, localInventory, config.maxChain);
            synchronized (this) {
                assetToken = token;
                index = parsed;
                plan = computed;
                packageCount = computed.steps.size();
                totalBytes = computed.bytes;
                doneBytes = 0;
                retryable = false;
                error = "";
                if (!computed.needsUpdate()) {
                    state = BLOCKED.equals(computed.status) ? BLOCKED : COMPLETE;
                    message = computed.reason;
                } else {
                    state = READY;
                    message = "ready to download " + packageCount + " package(s)";
                }
                notifyState();
                return status();
            }
        } catch (Exception failure) {
            synchronized (this) {
                fail(failure);
                return status();
            }
        }
    }

    /**
     * Download, verify and apply the prepared plan. This is the only path that transfers a package and
     * it is entered only from the player's explicit confirmation, so a call with no prepared plan
     * returns the current status without touching the network.
     *
     * @return the final status snapshot
     */
    public Map<String, Object> start() {
        final AssetIndex.Plan active;
        final List<AssetIndex.Step> steps;
        final String token;
        synchronized (this) {
            if (!READY.equals(state) || plan == null) return status();
            active = plan;
            steps = new ArrayList<>(plan.steps);
            token = assetToken;
            abort = false;
        }
        final File packageFile = new File(cacheDir, TEMP_PACKAGE);
        final long[] completed = { 0 };
        try {
            if (!cacheDir.isDirectory() && !cacheDir.mkdirs()) throw new IOException("cannot create " + cacheDir);
            for (int i = 0; i < steps.size(); i += 1) {
                final AssetIndex.Step step = steps.get(i);
                if (abort) {
                    delete(packageFile);
                    synchronized (this) {
                        state = CANCELLED;
                        message = "cancelled before " + step.name;
                        retryable = false;
                        notifyState();
                        return status();
                    }
                }
                synchronized (this) {
                    packageIndex = i + 1;
                    packageName = step.name;
                    packageSize = step.size;
                    packageDone = 0;
                    state = DOWNLOADING;
                    message = "downloading " + step.name;
                    notifyState();
                }
                delete(packageFile);
                try {
                    String url = new URL(new URL(config.indexUrl), step.name).toString();
                    fetcher.file(url, packageFile, config.maxDownloadBytes, config, token, (done, announced) -> {
                        synchronized (AssetUpdateSession.this) {
                            if (abort) throw new Aborted();
                            packageDone = done;
                            if (announced > 0) packageSize = announced;
                            doneBytes = completed[0] + done;
                            if (totalBytes > 0 && doneBytes > totalBytes) doneBytes = totalBytes;
                            notifyState();
                        }
                    });
                    synchronized (this) {
                        state = APPLYING;
                        message = "verifying and applying " + step.name;
                        notifyState();
                    }
                    store.apply(packageFile, step.sha256, config.maxExtractBytes);
                    completed[0] += step.size;
                    synchronized (this) {
                        packageDone = step.size;
                        doneBytes = Math.max(doneBytes, completed[0]);
                        if (totalBytes > 0 && doneBytes > totalBytes) doneBytes = totalBytes;
                    }
                } finally {
                    delete(packageFile);
                }
            }
            synchronized (this) {
                state = COMPLETE;
                message = active.reason;
                retryable = false;
                packageIndex = steps.size();
                doneBytes = totalBytes;
                notifyState();
                return status();
            }
        } catch (Aborted aborted) {
            delete(packageFile);
            synchronized (this) {
                state = CANCELLED;
                message = "cancelled by the user";
                retryable = false;
                notifyState();
                return status();
            }
        } catch (Exception failure) {
            delete(packageFile);
            synchronized (this) {
                fail(failure);
                return status();
            }
        }
    }

    /**
     * Explicit retry after a failure: plan again from the release index and, when the new plan still
     * has work, run it. The UI only offers this from a failed state after a positive tap.
     */
    public Map<String, Object> retry() {
        Map<String, Object> after = prepare();
        if (READY.equals(String.valueOf(after.get("state")))) return start();
        return after;
    }

    /**
     * Ask the running transfer to stop. A download stops at the next chunk and leaves the installed
     * assets and every previously applied package exactly as they were.
     */
    public void cancel() {
        synchronized (this) {
            abort = true;
            if (READY.equals(state) || IDLE.equals(state) || WAITING.equals(state)) {
                state = CANCELLED;
                message = "cancelled by the user";
                retryable = false;
                notifyState();
            }
        }
    }

    /**
     * @return a snapshot for the UI bridge. It carries public release metadata and progress only:
     *     neither the game-session token nor the asset token is ever included.
     */
    public synchronized Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("format", STATUS_FORMAT);
        out.put("state", state);
        out.put("message", message == null ? "" : message);
        out.put("error", error == null ? "" : error);
        out.put("retryable", retryable);
        out.put("enabled", config != null && config.enabled);
        out.put("hasSession", sessionToken != null);
        out.put("done", doneBytes);
        out.put("total", totalBytes);
        out.put("packageIndex", packageIndex);
        out.put("packageCount", packageCount);
        out.put("packageName", packageName == null ? "" : packageName);
        out.put("packageDone", packageDone);
        out.put("packageSize", packageSize);
        out.put("current", store != null && store.hasState() ? store.version() : "");
        out.put("latest", index == null ? "" : index.latest);
        out.put("mirrors", config == null ? new ArrayList<Map<String, String>>() : config.mirrors);
        out.put("mirrorProblems", config == null ? new ArrayList<String>() : config.mirrorProblems);
        out.put("importAvailable", store != null);
        out.put("plan", planMap());
        return out;
    }

    private void fail(Throwable failure) {
        state = FAILED;
        error = failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
        message = error;
        retryable = store != null;
        notifyState();
    }

    private Map<String, Object> planMap() {
        AssetIndex.Plan active = plan;
        if (active == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", active.status);
        out.put("reason", active.reason == null ? "" : active.reason);
        out.put("verification", active.verification == null ? "" : active.verification);
        out.put("routeKind", active.routeKind == null ? "" : String.valueOf(active.routeKind));
        out.put("localVersion", active.localVersion == null ? "" : active.localVersion);
        out.put("latest", active.latest == null ? "" : active.latest);
        out.put("bytes", active.bytes);
        out.put("count", active.steps.size());
        List<Map<String, Object>> packages = new ArrayList<>();
        for (AssetIndex.Step step : active.steps) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("kind", step.kind == null ? "" : step.kind);
            item.put("name", step.name == null ? "" : step.name);
            item.put("size", step.size);
            item.put("sha256", step.sha256 == null ? "" : step.sha256);
            item.put("from", step.from == null ? "" : step.from);
            item.put("to", step.to == null ? "" : step.to);
            packages.add(item);
        }
        out.put("packages", packages);
        return out;
    }

    private void notifyState() {
        Listener current = listener;
        if (current == null) return;
        try {
            current.onState(status());
        } catch (RuntimeException ignored) {
            // A broken observer must never break the transfer.
        }
    }

    private static void delete(File file) {
        if (file != null && file.exists()) file.delete();
    }

    /** The production network surface: the same verifying primitives the old startup updater used. */
    private static final class DefaultFetcher implements Fetcher {
        @Override
        public String exchangeToken(AssetConfig config, String sessionToken) throws IOException {
            return AssetUpdater.exchangeToken(config, sessionToken);
        }

        @Override
        public byte[] bytes(String url, long limit, AssetConfig config, String authorization) throws IOException {
            return AssetUpdater.fetchBytes(url, limit, config, authorization);
        }

        @Override
        public void file(String url, File target, long limit, AssetConfig config, String authorization, AssetUpdater.Progress progress) throws IOException {
            AssetUpdater.fetchFile(url, target, limit, config, authorization, progress);
        }
    }
}
