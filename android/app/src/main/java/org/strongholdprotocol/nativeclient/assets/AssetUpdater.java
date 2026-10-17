package org.strongholdprotocol.nativeclient.assets;

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
import java.util.Map;

/** Verifying startup updater for public or session-protected runtime asset packages. */
public final class AssetUpdater {
    private AssetUpdater() { }
    public interface Listener { void onResult(String message); }
    public interface CompletionListener { void onComplete(Outcome outcome); }
    /** Byte-level progress of one package download; a throw aborts the transfer. */
    public interface Progress { void onBytes(long done, long announced); }
    public static final class Outcome {
        public final String status, version, message;
        Outcome(String status, String version, String message) { this.status = status; this.version = version; this.message = message; }
        @Override public String toString() { return status + " " + version + (message == null || message.isEmpty() ? "" : ": " + message); }
    }
    private static final int CONNECT_TIMEOUT_MS = 15000, READ_TIMEOUT_MS = 30000;
    /** Redirect hops one transfer may take; package-private so the asset self-test pins the cap. */
    static final int MAX_REDIRECTS = 3;
    private static final String USER_AGENT = "StrongholdProtocolAssets/1";

    public static Thread start(AssetStore store, AssetConfig config, File cacheDir, Listener listener) { return start(store, config, cacheDir, null, listener, null); }
    public static Thread start(AssetStore store, AssetConfig config, File cacheDir, Listener listener, CompletionListener completion) { return start(store, config, cacheDir, null, listener, completion); }
    public static Thread start(final AssetStore store, final AssetConfig config, final File cacheDir, final String sessionToken, final Listener listener, final CompletionListener completion) {
        Thread thread = new Thread(() -> {
            Outcome outcome = update(store, config, cacheDir, sessionToken, listener);
            if (completion != null) try { completion.onComplete(outcome); } catch (RuntimeException ignored) { }
        }, "sp-asset-update");
        thread.setDaemon(true); thread.start(); return thread;
    }

    public static Outcome update(AssetStore store, AssetConfig config, File cacheDir, Listener listener) { return update(store, config, cacheDir, null, listener); }
    public static Outcome update(AssetStore store, AssetConfig config, File cacheDir, String sessionToken, Listener listener) {
        if (config == null || !config.enabled) {
            note(listener, "assets: " + (config == null ? "no configuration" : config.describe()));
            return new Outcome("disabled", store.version(), config == null ? "no configuration" : AssetPackage.join(config.problems));
        }
        File packageFile = new File(cacheDir, "asset-package.zip");
        try {
            if (!cacheDir.isDirectory() && !cacheDir.mkdirs()) throw new IOException("cannot create " + cacheDir);
            String assetToken = config.tokenUrl == null || config.tokenUrl.isEmpty() ? null : exchangeToken(config, sessionToken);
            String localVersion = store.hasState() ? store.version() : null;
            String localInventory = store.hasState() ? store.inventoryDigest() : null;
            AssetIndex index = AssetIndex.parse(new String(fetchBytes(config.indexUrl, config.maxIndexBytes, config, assetToken), StandardCharsets.UTF_8));
            AssetIndex.Plan plan = index.plan(localVersion, localInventory, config.maxChain);
            note(listener, "assets: " + plan.status + " local=" + localVersion + " latest=" + index.latest + " (" + plan.reason + ")");
            if (!plan.needsUpdate()) return new Outcome(plan.status, store.version(), plan.reason);
            for (AssetIndex.Step step : plan.steps) {
                delete(packageFile);
                try {
                    fetchFile(new URL(new URL(config.indexUrl), step.name).toString(), packageFile, config.maxDownloadBytes, config, assetToken);
                    note(listener, "assets: " + store.apply(packageFile, step.sha256, config.maxExtractBytes));
                } finally { delete(packageFile); }
            }
            return new Outcome(plan.status, store.version(), plan.reason);
        } catch (Exception error) {
            delete(packageFile);
            String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
            note(listener, "assets: update failed (" + message + "); keeping " + store.version());
            return new Outcome("failed", store.version(), message);
        }
    }

    static String exchangeToken(AssetConfig config, String sessionToken) throws IOException {
        if (sessionToken == null || !sessionToken.matches("[0-9a-f]{32}")) throw new IOException("game session token is required for protected assets");
        try {
            Map<String, Object> response = AssetJson.object(AssetJson.parse(new String(fetchBytes(config.tokenUrl, config.maxIndexBytes, config, sessionToken), StandardCharsets.UTF_8)));
            String token = AssetJson.string(AssetJson.get(response, "token"), "");
            if (!token.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")) throw new IOException("asset token response is invalid");
            return token;
        } catch (IllegalArgumentException error) { throw new IOException("asset token response is invalid", error); }
    }

    static byte[] fetchBytes(String url, long limit, AssetConfig config) throws IOException { return fetchBytes(url, limit, config, null); }
    static byte[] fetchBytes(String url, long limit, AssetConfig config, String authorization) throws IOException {
        HttpURLConnection connection = open(url, config, authorization);
        try {
            long declared = connection.getContentLengthLong();
            if (declared > limit) throw new IOException("index is " + declared + " bytes, above the " + limit + " byte limit");
            return readAll(connection.getInputStream(), limit);
        } finally { connection.disconnect(); }
    }
    static void fetchFile(String url, File target, long limit, AssetConfig config) throws IOException { fetchFile(url, target, limit, config, null, null); }
    static void fetchFile(String url, File target, long limit, AssetConfig config, String authorization) throws IOException { fetchFile(url, target, limit, config, authorization, null); }
    /**
     * Download one package. {@code progress} (optional) is told the running and announced byte counts
     * after every chunk; it may throw to abort the transfer, which leaves {@code target} partial and is
     * the caller's to delete.
     */
    static void fetchFile(String url, File target, long limit, AssetConfig config, String authorization, Progress progress) throws IOException {
        HttpURLConnection connection = open(url, config, authorization);
        try {
            long declared = connection.getContentLengthLong();
            if (declared > limit) throw new IOException("package is " + declared + " bytes, above the " + limit + " byte limit");
            long total = 0;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[1 << 16]; int read;
                while ((read = in.read(buffer)) > 0) {
                    total += read; if (total > limit) throw new IOException("package is larger than the " + limit + " byte limit"); out.write(buffer, 0, read);
                    if (progress != null) progress.onBytes(total, declared);
                }
            }
            if (declared >= 0 && total != declared) throw new IOException("package is " + total + " bytes, the server announced " + declared);
        } finally { connection.disconnect(); }
    }

    private static HttpURLConnection open(String url, AssetConfig config, String authorization) throws IOException {
        URL first = AssetConfig.parseUrl(url);
        if (first == null) throw new IOException("invalid asset URL: " + url);
        String origin = originOf(first);
        boolean credential = authorization != null && !authorization.isEmpty();
        URL current = first;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            requireAllowed(current, config);
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(CONNECT_TIMEOUT_MS); connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept-Encoding", "identity"); connection.setRequestProperty("User-Agent", USER_AGENT);
            if (credential && originOf(current).equals(origin)) connection.setRequestProperty("Authorization", "Bearer " + authorization);
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) { String location = connection.getHeaderField("Location"); connection.disconnect(); current = redirectTarget(current, location, origin); continue; }
            if (code != HttpURLConnection.HTTP_OK) { connection.disconnect(); throw new IOException("HTTP " + code + " from " + current); }
            return connection;
        }
        throw new IOException("too many redirects from " + url);
    }

    /**
     * The origin of an asset URL: scheme plus host plus effective port. Only URLs that share an origin
     * with the first hop may receive the Worker token.
     */
    static String originOf(URL url) {
        String protocol = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.ROOT);
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        int port = url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
        return protocol + "://" + host + ":" + port;
    }

    /**
     * The URL a redirect points at, or an {@link IOException} when following it would move the transfer
     * off {@code origin}. The refusal happens before the request is repeated, so the token is never sent
     * rather than sent and then undone.
     */
    static URL redirectTarget(URL current, String location, String origin) throws IOException {
        if (location == null || location.isEmpty()) throw new IOException("redirect without a location from " + current);
        URL next;
        try { next = new URL(current, location); } catch (IOException error) { throw new IOException("invalid redirect target from " + current, error); }
        if (!originOf(next).equals(origin)) throw new IOException("refusing cross-origin asset redirect from " + current + " to " + next.getHost());
        return next;
    }
    private static void requireAllowed(URL url, AssetConfig config) throws IOException {
        String protocol = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.ROOT);
        if (!"https".equals(protocol) && !(config.allowHttp && "http".equals(protocol))) throw new IOException("refusing " + protocol + " URL: " + url);
        if (url.getHost() == null || url.getHost().isEmpty()) throw new IOException("asset URL has no host: " + url);
        if (url.getUserInfo() != null && !url.getUserInfo().isEmpty()) throw new IOException("asset URL carries credentials");
    }
    private static byte[] readAll(InputStream input, long limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024); long total = 0;
        try (InputStream stream = input) { byte[] buffer = new byte[1 << 16]; int read; while ((read = stream.read(buffer)) > 0) { total += read; if (total > limit) throw new IOException("document is larger than the " + limit + " byte limit"); out.write(buffer, 0, read); } }
        return out.toByteArray();
    }
    private static void delete(File file) { if (file != null && file.exists()) file.delete(); }
    private static void note(Listener listener, String message) { if (listener != null) try { listener.onResult(message); } catch (RuntimeException ignored) { } }
}
