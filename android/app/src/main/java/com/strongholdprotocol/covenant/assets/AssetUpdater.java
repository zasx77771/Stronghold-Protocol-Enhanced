package com.strongholdprotocol.covenant.assets;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * The startup update check: fetch the release index, pick the shortest safe route, download and
 * verify each package, apply it to the store.
 *
 * <p>The updater is a pure-Java component on purpose (no Android APIs), so the same code runs in the
 * JVM tests against a local HTTP server. Everything that can fail is contained: a missing network, an
 * HTTP error, a truncated download, a digest mismatch or a malformed package all end as a logged
 * result with the previous state still in place — the app never blocks and never loses its cache.
 */
public final class AssetUpdater {
    private AssetUpdater() {
    }

    /** Where progress goes. The app logs it; tests collect it. */
    public interface Listener {
        void onResult(String message);
    }

    /** The outcome of one check. */
    public static final class Outcome {
        public final String status;
        public final String version;
        public final String message;

        Outcome(String status, String version, String message) {
            this.status = status;
            this.version = version;
            this.message = message;
        }

        @Override
        public String toString() {
            return status + " " + version + (message == null || message.isEmpty() ? "" : ": " + message);
        }
    }

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int MAX_REDIRECTS = 3;
    private static final String USER_AGENT = "StrongholdProtocolAssets/1";

    /** Run one update check on a background thread and return it. */
    public static Thread start(final AssetStore store, final AssetConfig config, final File cacheDir, final Listener listener) {
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                update(store, config, cacheDir, listener);
            }
        }, "sp-asset-update");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    /** Blocking update check, used by the tests and by {@link #start}. Never throws. */
    public static Outcome update(AssetStore store, AssetConfig config, File cacheDir, Listener listener) {
        if (config == null || !config.enabled) {
            note(listener, "assets: " + (config == null ? "no configuration" : config.describe()));
            return new Outcome("disabled", store.version(), config == null ? "no configuration" : AssetPackage.join(config.problems));
        }
        File packageFile = new File(cacheDir, "asset-package.zip");
        try {
            if (!cacheDir.isDirectory() && !cacheDir.mkdirs()) throw new IOException("cannot create " + cacheDir);
            String localVersion = store.hasState() ? store.version() : null;
            String localInventory = store.hasState() ? store.inventoryDigest() : null;
            byte[] raw = fetchBytes(config.indexUrl, config.maxIndexBytes, config);
            AssetIndex index = AssetIndex.parse(new String(raw, StandardCharsets.UTF_8));
            AssetIndex.Plan plan = index.plan(localVersion, localInventory, config.maxChain);
            note(listener, "assets: " + plan.status + " local=" + localVersion + " latest=" + index.latest + " (" + plan.reason + ")");
            if (!plan.needsUpdate()) return new Outcome(plan.status, store.version(), plan.reason);
            for (AssetIndex.Step step : plan.steps) {
                delete(packageFile);
                try {
                    String url = new URL(new URL(config.indexUrl), step.name).toString();
                    fetchFile(url, packageFile, config.maxDownloadBytes, config);
                    AssetStore.Applied applied = store.apply(packageFile, step.sha256, config.maxExtractBytes);
                    note(listener, "assets: " + applied);
                } finally {
                    delete(packageFile);
                }
            }
            return new Outcome(plan.status, store.version(), plan.reason);
        } catch (Exception error) {
            delete(packageFile);
            String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
            note(listener, "assets: update failed (" + message + "); keeping " + store.version());
            return new Outcome("failed", store.version(), message);
        }
    }

    private static void note(Listener listener, String message) {
        if (listener == null) return;
        try {
            listener.onResult(message);
        } catch (RuntimeException ignored) {
            // A logging failure must never abort an update.
        }
    }

    private static void delete(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    /** Read a small document (the index) into memory with a hard cap. */
    static byte[] fetchBytes(String url, long limit, AssetConfig config) throws IOException {
        HttpURLConnection connection = open(url, config);
        try {
            long declared = connection.getContentLengthLong();
            if (declared > limit) throw new IOException("index is " + declared + " bytes, above the " + limit + " byte limit");
            return readAll(connection.getInputStream(), limit);
        } finally {
            connection.disconnect();
        }
    }

    /** Download a package to a file with a hard cap. The digest is verified when it is applied. */
    static void fetchFile(String url, File target, long limit, AssetConfig config) throws IOException {
        HttpURLConnection connection = open(url, config);
        try {
            long declared = connection.getContentLengthLong();
            if (declared > limit) throw new IOException("package is " + declared + " bytes, above the " + limit + " byte limit");
            long total = 0;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    total += read;
                    if (total > limit) throw new IOException("package is larger than the " + limit + " byte limit");
                    out.write(buffer, 0, read);
                }
            }
            if (declared >= 0 && total != declared) throw new IOException("package is " + total + " bytes, the server announced " + declared);
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Open a connection, following redirects by hand so every hop is checked against the same rules:
     * https unless the configuration allows plain http, no credentials, at most a few hops.
     */
    private static HttpURLConnection open(String url, AssetConfig config) throws IOException {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            URL parsed = AssetConfig.parseUrl(current);
            if (parsed == null) throw new IOException("invalid asset URL: " + current);
            requireAllowed(parsed, config);
            HttpURLConnection connection = (HttpURLConnection) parsed.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", USER_AGENT);
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || location.isEmpty()) throw new IOException("redirect without a location from " + current);
                current = new URL(parsed, location).toString();
                continue;
            }
            if (code != HttpURLConnection.HTTP_OK) {
                connection.disconnect();
                throw new IOException("HTTP " + code + " from " + current);
            }
            return connection;
        }
        throw new IOException("too many redirects from " + url);
    }

    private static void requireAllowed(URL url, AssetConfig config) throws IOException {
        String protocol = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.ROOT);
        if (!"https".equals(protocol) && !(config.allowHttp && "http".equals(protocol))) {
            throw new IOException("refusing " + protocol + " URL: " + url);
        }
        if (url.getHost() == null || url.getHost().isEmpty()) throw new IOException("asset URL has no host: " + url);
        String userInfo = url.getUserInfo();
        if (userInfo != null && !userInfo.isEmpty()) throw new IOException("asset URL carries credentials");
    }

    private static byte[] readAll(InputStream input, long limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        long total = 0;
        try (InputStream stream = input) {
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = stream.read(buffer)) > 0) {
                total += read;
                if (total > limit) throw new IOException("document is larger than the " + limit + " byte limit");
                out.write(buffer, 0, read);
            }
        }
        return out.toByteArray();
    }
}
