package com.strongholdprotocol.covenant.assets;

import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Public runtime configuration for the asset updater.
 *
 * <p>This is public data: the index URL and a few limits. It deliberately has no room for
 * credentials — a URL carrying a user name, a password, a signature or a token query parameter is
 * rejected — which is why the file may be committed or shipped inside the APK. When nothing is
 * configured the updater is disabled and the app simply serves the assets that are already
 * installed: an unconfigured build must degrade safely, never fail.
 */
public final class AssetConfig {
    public static final String FORMAT = "sp-assets-config-v1";
    public static final int DEFAULT_MAX_CHAIN = 3;
    public static final long DEFAULT_MAX_INDEX_BYTES = 1L << 20;
    public static final long DEFAULT_MAX_DOWNLOAD_BYTES = 1536L * 1024 * 1024;
    public static final long DEFAULT_MAX_EXTRACT_BYTES = 4096L * 1024 * 1024;

    public final boolean enabled;
    public final String indexUrl;
    public final int maxChain;
    public final long maxIndexBytes;
    public final long maxDownloadBytes;
    public final long maxExtractBytes;
    public final boolean allowHttp;
    public final List<String> problems;

    private AssetConfig(boolean enabled, String indexUrl, int maxChain, long maxIndexBytes, long maxDownloadBytes,
                        long maxExtractBytes, boolean allowHttp, List<String> problems) {
        this.enabled = enabled;
        this.indexUrl = indexUrl;
        this.maxChain = maxChain;
        this.maxIndexBytes = maxIndexBytes;
        this.maxDownloadBytes = maxDownloadBytes;
        this.maxExtractBytes = maxExtractBytes;
        this.allowHttp = allowHttp;
        this.problems = problems;
    }

    /** No configuration: asset updates are off and the installed assets are used as they are. */
    public static AssetConfig disabled(String reason) {
        List<String> problems = new ArrayList<>();
        if (reason != null) problems.add(reason);
        return new AssetConfig(false, null, DEFAULT_MAX_CHAIN, DEFAULT_MAX_INDEX_BYTES, DEFAULT_MAX_DOWNLOAD_BYTES,
            DEFAULT_MAX_EXTRACT_BYTES, false, problems);
    }

    /**
     * Build a configuration from a JSON object (the packaged {@code asset-config.json} or the
     * build-time defaults). Invalid input yields a disabled configuration listing the problems, so
     * callers never have to handle an exception on the startup path.
     */
    public static AssetConfig from(Map<String, Object> json) {
        List<String> problems = new ArrayList<>();
        if (json == null) return disabled("no asset configuration");
        String format = AssetJson.string(AssetJson.get(json, "format"), "");
        if (!FORMAT.equals(format)) problems.add("format " + format);
        boolean allowHttp = AssetJson.bool(AssetJson.get(json, "allowHttp"), false);
        String indexUrl = AssetJson.string(AssetJson.get(json, "indexUrl"), "");
        int maxChain = (int) AssetJson.number(AssetJson.get(json, "maxChain"), DEFAULT_MAX_CHAIN);
        long maxDownloadBytes = AssetJson.number(AssetJson.get(json, "maxDownloadBytes"), DEFAULT_MAX_DOWNLOAD_BYTES);
        long maxExtractBytes = AssetJson.number(AssetJson.get(json, "maxExtractBytes"), DEFAULT_MAX_EXTRACT_BYTES);
        if (indexUrl.isEmpty()) {
            problems.add("indexUrl is required");
        } else {
            URL parsed = parseUrl(indexUrl);
            if (parsed == null) {
                problems.add("indexUrl is not a valid URL");
            } else {
                String protocol = parsed.getProtocol().toLowerCase(Locale.ROOT);
                if (!"http".equals(protocol) && !"https".equals(protocol)) problems.add("indexUrl must be an http(s) URL");
                if (parsed.getUserInfo() != null && !parsed.getUserInfo().isEmpty()) problems.add("indexUrl must not carry credentials");
                if (!allowHttp && !"https".equals(protocol)) problems.add("indexUrl must use https");
                String query = parsed.getQuery() == null ? "" : parsed.getQuery().toLowerCase(Locale.ROOT);
                if (query.matches(".*(^|&)(sig|signature|token|key|secret|x-amz-[a-z-]+)=.*")) {
                    problems.add("indexUrl must not carry signature or token parameters");
                }
            }
        }
        if (maxChain <= 0) problems.add("maxChain must be a positive number");
        if (maxDownloadBytes <= 0) problems.add("maxDownloadBytes must be a positive number");
        if (maxExtractBytes <= 0) problems.add("maxExtractBytes must be a positive number");
        if (!problems.isEmpty()) {
            List<String> reported = new ArrayList<>();
            for (String problem : problems) reported.add("config: " + problem);
            return new AssetConfig(false, indexUrl, maxChain, DEFAULT_MAX_INDEX_BYTES, maxDownloadBytes, maxExtractBytes,
                allowHttp, reported);
        }
        return new AssetConfig(true, indexUrl, maxChain, DEFAULT_MAX_INDEX_BYTES, maxDownloadBytes, maxExtractBytes,
            allowHttp, new ArrayList<String>());
    }

    /** Build a configuration from the two build-time values, or disable it when there is no URL. */
    public static AssetConfig fromBuild(String indexUrl, int maxChain, long maxDownloadBytes, long maxExtractBytes, boolean allowHttp) {
        if (indexUrl == null || indexUrl.trim().isEmpty()) return disabled("no index URL configured");
        Map<String, Object> json = new java.util.LinkedHashMap<>();
        json.put("format", FORMAT);
        json.put("indexUrl", indexUrl.trim());
        json.put("maxChain", maxChain);
        json.put("maxDownloadBytes", maxDownloadBytes);
        json.put("maxExtractBytes", maxExtractBytes);
        json.put("allowHttp", allowHttp);
        return from(json);
    }

    /** Parse a URL without failing the startup path. */
    public static URL parseUrl(String text) {
        try {
            return URI.create(text).toURL();
        } catch (RuntimeException | java.net.MalformedURLException error) {
            return null;
        }
    }

    public String describe() {
        if (!enabled) return "asset updates disabled (" + (problems.isEmpty() ? "unconfigured" : AssetPackage.join(problems)) + ")";
        return "asset updates via " + indexUrl + " (maxChain=" + maxChain + ", maxDownloadBytes=" + maxDownloadBytes + ")";
    }
}
