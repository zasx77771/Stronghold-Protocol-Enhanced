package org.strongholdprotocol.nativeclient.assets;

import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Public, credential-free runtime asset updater configuration. */
public final class AssetConfig {
    public static final String FORMAT = "sp-assets-config-v1";
    public static final int DEFAULT_MAX_CHAIN = 3;
    public static final int MAX_MIRRORS = 4;
    public static final long DEFAULT_MAX_INDEX_BYTES = 1L << 20;
    public static final long DEFAULT_MAX_DOWNLOAD_BYTES = 1536L * 1024 * 1024;
    public static final long DEFAULT_MAX_EXTRACT_BYTES = 4096L * 1024 * 1024;

    public final boolean enabled;
    public final String indexUrl;
    /** Optional HTTPS endpoint that exchanges the game-session token for a short-lived asset token. */
    public final String tokenUrl;
    public final int maxChain;
    public final long maxIndexBytes;
    public final long maxDownloadBytes;
    public final long maxExtractBytes;
    public final boolean allowHttp;
    public final List<String> problems;
    /**
     * Reserved mirror entries ({@code name}, {@code url}) from {@code asset-config.json}. Stage C
     * only models and validates them: the updater keeps using {@link #indexUrl} and the short-lived
     * token, and an empty list is the default. No mirror is preconfigured or auto-selected.
     */
    public final List<Map<String, String>> mirrors;
    /** Invalid reserved mirror entries, reported without disabling the authoritative R2 path. */
    public final List<String> mirrorProblems;

    private AssetConfig(boolean enabled, String indexUrl, String tokenUrl, int maxChain, long maxIndexBytes,
            long maxDownloadBytes, long maxExtractBytes, boolean allowHttp, List<String> problems,
            List<Map<String, String>> mirrors, List<String> mirrorProblems) {
        this.enabled = enabled;
        this.indexUrl = indexUrl;
        this.tokenUrl = tokenUrl;
        this.maxChain = maxChain;
        this.maxIndexBytes = maxIndexBytes;
        this.maxDownloadBytes = maxDownloadBytes;
        this.maxExtractBytes = maxExtractBytes;
        this.allowHttp = allowHttp;
        this.problems = problems;
        this.mirrors = mirrors;
        this.mirrorProblems = mirrorProblems;
    }

    public static AssetConfig disabled(String reason) {
        List<String> problems = new ArrayList<>();
        if (reason != null) problems.add(reason);
        return new AssetConfig(false, null, null, DEFAULT_MAX_CHAIN, DEFAULT_MAX_INDEX_BYTES,
                DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_EXTRACT_BYTES, false, problems,
                new ArrayList<Map<String, String>>(), new ArrayList<String>());
    }

    public static AssetConfig from(Map<String, Object> json) {
        List<String> problems = new ArrayList<>();
        if (json == null) return disabled("no asset configuration");
        String format = AssetJson.string(AssetJson.get(json, "format"), "");
        if (!FORMAT.equals(format)) problems.add("format " + format);
        boolean allowHttp = AssetJson.bool(AssetJson.get(json, "allowHttp"), false);
        String indexUrl = AssetJson.string(AssetJson.get(json, "indexUrl"), "");
        String tokenUrl = AssetJson.string(AssetJson.get(json, "tokenUrl"), "");
        int maxChain = (int) AssetJson.number(AssetJson.get(json, "maxChain"), DEFAULT_MAX_CHAIN);
        long maxDownloadBytes = AssetJson.number(AssetJson.get(json, "maxDownloadBytes"), DEFAULT_MAX_DOWNLOAD_BYTES);
        long maxExtractBytes = AssetJson.number(AssetJson.get(json, "maxExtractBytes"), DEFAULT_MAX_EXTRACT_BYTES);
        checkIndexUrl(indexUrl, allowHttp, problems);
        if (!tokenUrl.isEmpty()) checkTokenUrl(tokenUrl, problems);
        if (maxChain <= 0) problems.add("maxChain must be a positive number");
        if (maxDownloadBytes <= 0) problems.add("maxDownloadBytes must be a positive number");
        if (maxExtractBytes <= 0) problems.add("maxExtractBytes must be a positive number");
        // Reserved mirrors are parsed defensively: bad entries are reported, never fatal, and never
        // used by AssetUpdater in this stage.
        List<Map<String, String>> mirrors = new ArrayList<>();
        List<String> mirrorProblems = new ArrayList<>();
        checkMirrors(AssetJson.get(json, "mirrors"), allowHttp, mirrors, mirrorProblems);
        if (!problems.isEmpty()) {
            List<String> reported = new ArrayList<>();
            for (String problem : problems) reported.add("config: " + problem);
            return new AssetConfig(false, indexUrl, tokenUrl, maxChain, DEFAULT_MAX_INDEX_BYTES,
                    maxDownloadBytes, maxExtractBytes, allowHttp, reported, mirrors, mirrorProblems);
        }
        return new AssetConfig(true, indexUrl, tokenUrl, maxChain, DEFAULT_MAX_INDEX_BYTES,
                maxDownloadBytes, maxExtractBytes, allowHttp, new ArrayList<String>(), mirrors,
                mirrorProblems);
    }

    private static void checkIndexUrl(String indexUrl, boolean allowHttp, List<String> problems) {
        if (indexUrl.isEmpty()) { problems.add("indexUrl is required"); return; }
        URL parsed = parseUrl(indexUrl);
        if (parsed == null) { problems.add("indexUrl is not a valid URL"); return; }
        String protocol = parsed.getProtocol().toLowerCase(Locale.ROOT);
        if (!"http".equals(protocol) && !"https".equals(protocol)) problems.add("indexUrl must be an http(s) URL");
        if (parsed.getUserInfo() != null && !parsed.getUserInfo().isEmpty()) problems.add("indexUrl must not carry credentials");
        if (!allowHttp && !"https".equals(protocol)) problems.add("indexUrl must use https");
        String query = parsed.getQuery() == null ? "" : parsed.getQuery().toLowerCase(Locale.ROOT);
        if (query.matches(".*(^|&)(sig|signature|token|key|secret|x-amz-[a-z-]+)=.*")) problems.add("indexUrl must not carry signature or token parameters");
    }

    private static void checkTokenUrl(String tokenUrl, List<String> problems) {
        URL parsed = parseUrl(tokenUrl);
        if (parsed == null || !"https".equalsIgnoreCase(parsed.getProtocol()) || parsed.getUserInfo() != null || parsed.getQuery() != null) {
            problems.add("tokenUrl must be https without credentials or query");
        }
    }

    /**
     * Validates the reserved mirror list. Only HTTPS URLs without credentials, query or fragment are
     * accepted; names are 1-32 printable characters and duplicate URLs are rejected. Valid entries
     * survive invalid siblings and nothing here changes {@link #indexUrl} or {@link #tokenUrl}.
     */
    private static void checkMirrors(Object raw, boolean allowHttp, List<Map<String, String>> out,
            List<String> problems) {
        if (raw == null) return;
        if (!(raw instanceof List)) {
            problems.add("mirrors: must be an array");
            return;
        }
        List<Object> items = AssetJson.array(raw);
        if (items.size() > MAX_MIRRORS) {
            problems.add("mirrors: at most " + MAX_MIRRORS + " entries are allowed");
            return;
        }
        Set<String> seen = new LinkedHashSet<>();
        for (int index = 0; index < items.size(); index++) {
            Map<String, Object> item = AssetJson.objectOrNull(items.get(index));
            if (item == null) {
                problems.add("mirrors[" + index + "]: entry must be an object");
                continue;
            }
            String rawUrl = AssetJson.string(AssetJson.get(item, "url"), "");
            if (rawUrl.isEmpty()) {
                problems.add("mirrors[" + index + "]: url is required");
                continue;
            }
            URL parsed = parseUrl(rawUrl);
            if (parsed == null) {
                problems.add("mirrors[" + index + "]: url is not valid");
                continue;
            }
            String scheme = parsed.getProtocol().toLowerCase(Locale.ROOT);
            boolean schemeOk = "https".equals(scheme) || (allowHttp && "http".equals(scheme));
            if (!schemeOk) {
                problems.add("mirrors[" + index + "]: url must use https");
                continue;
            }
            if (parsed.getUserInfo() != null && !parsed.getUserInfo().isEmpty()) {
                problems.add("mirrors[" + index + "]: url must not carry credentials");
                continue;
            }
            if (parsed.getQuery() != null || parsed.getRef() != null) {
                problems.add("mirrors[" + index + "]: url must not carry a query or fragment");
                continue;
            }
            if (parsed.getHost() == null || parsed.getHost().isEmpty()) {
                problems.add("mirrors[" + index + "]: url needs a host");
                continue;
            }
            String name = AssetJson.string(AssetJson.get(item, "name"), "").trim();
            if (name.isEmpty()) name = "mirror-" + (index + 1);
            if (name.length() > 32 || name.chars().anyMatch(value -> Character.isISOControl(value))) {
                problems.add("mirrors[" + index + "]: name must be 1-32 printable characters");
                continue;
            }
            String key = rawUrl.replaceAll("/+$", "");
            if (!seen.add(key)) {
                problems.add("mirrors[" + index + "]: duplicate url");
                continue;
            }
            Map<String, String> mirror = new LinkedHashMap<>();
            mirror.put("name", name);
            mirror.put("url", rawUrl);
            out.add(mirror);
        }
    }

    public static AssetConfig fromBuild(String indexUrl, int maxChain, long maxDownloadBytes, long maxExtractBytes, boolean allowHttp) {
        return fromBuild(indexUrl, null, maxChain, maxDownloadBytes, maxExtractBytes, allowHttp);
    }

    public static AssetConfig fromBuild(String indexUrl, String tokenUrl, int maxChain, long maxDownloadBytes,
            long maxExtractBytes, boolean allowHttp) {
        if (indexUrl == null || indexUrl.trim().isEmpty()) return disabled("no index URL configured");
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("format", FORMAT);
        json.put("indexUrl", indexUrl.trim());
        if (tokenUrl != null && !tokenUrl.trim().isEmpty()) json.put("tokenUrl", tokenUrl.trim());
        json.put("maxChain", maxChain);
        json.put("maxDownloadBytes", maxDownloadBytes);
        json.put("maxExtractBytes", maxExtractBytes);
        json.put("allowHttp", allowHttp);
        return from(json);
    }

    public static URL parseUrl(String text) {
        try { return URI.create(text).toURL(); }
        catch (RuntimeException | java.net.MalformedURLException error) { return null; }
    }

    public String describe() {
        if (!enabled) return "asset updates disabled (" + (problems.isEmpty() ? "unconfigured" : AssetPackage.join(problems)) + ")";
        return "asset updates via " + indexUrl + (tokenUrl == null || tokenUrl.isEmpty() ? "" : " (token exchange enabled)")
                + " (maxChain=" + maxChain + ", maxDownloadBytes=" + maxDownloadBytes + ")";
    }
}
