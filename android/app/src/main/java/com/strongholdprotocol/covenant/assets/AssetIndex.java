package com.strongholdprotocol.covenant.assets;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The published release index: the small document that says which asset packages exist and how a
 * client reaches the latest version.
 *
 * <p>Route selection mirrors {@code planRoute} in {@code tools/assetPackages.mjs}: the shortest safe
 * path wins. A client only trusts a delta chain when its own inventory digest matches the published
 * digest of the version it runs, so a corrupted or hand-modified cache turns into the "download a
 * fresh base" repair path instead of a silently wrong update. The chain limit comes from the client
 * configuration, not from the index, so a hostile or broken index cannot make the client apply an
 * unbounded number of packages.
 */
public final class AssetIndex {
    public static final String FORMAT = "sp-assets-index-v1";

    /** One package to download, in order. */
    public static final class Step {
        public final String kind;
        public final String from;
        public final String to;
        public final String name;
        public final long size;
        public final String sha256;

        Step(String kind, String from, String to, String name, long size, String sha256) {
            this.kind = kind;
            this.from = from;
            this.to = to;
            this.name = name;
            this.size = size;
            this.sha256 = String.valueOf(sha256).toLowerCase(Locale.ROOT);
        }

        public boolean isBase() {
            return AssetPackage.KIND_BASE.equals(kind);
        }

        @Override
        public String toString() {
            return kind + " " + name;
        }
    }

    /** Published totals for one version. */
    public static final class VersionInfo {
        public final String inventory;
        public final long count;
        public final long bytes;
        /** Version whose package carries the identical bytes for this metadata-only release. */
        public final String reused;

        VersionInfo(String inventory, long count, long bytes, String reused) {
            this.inventory = inventory == null ? null : inventory.toLowerCase(Locale.ROOT);
            this.count = count;
            this.bytes = bytes;
            this.reused = reused == null || reused.isEmpty() ? null : reused;
        }
    }

    /** The decision for one client. */
    public static final class Plan {
        public final String status;
        public final String reason;
        public final String verification;
        public final String localVersion;
        public final String latest;
        public final String routeKind;
        public final List<Step> steps;
        public final long bytes;

        Plan(String status, String reason, String verification, String localVersion, String latest,
             String routeKind, List<Step> steps, long bytes) {
            this.status = status;
            this.reason = reason;
            this.verification = verification;
            this.localVersion = localVersion;
            this.latest = latest;
            this.routeKind = routeKind;
            this.steps = steps;
            this.bytes = bytes;
        }

        public boolean needsUpdate() {
            return !steps.isEmpty();
        }
    }

    public final String latest;
    public final int maxChain;
    public final Map<String, VersionInfo> versions;
    public final List<Step> bases;
    public final List<Step> deltas;

    private AssetIndex(String latest, int maxChain, Map<String, VersionInfo> versions, List<Step> bases, List<Step> deltas) {
        this.latest = latest;
        this.maxChain = maxChain;
        this.versions = versions;
        this.bases = bases;
        this.deltas = deltas;
    }

    /** Parse and validate an index document. */
    public static AssetIndex parse(String json) {
        return of(AssetJson.object(AssetJson.parse(json)));
    }

    /** Parse and validate an index object. */
    public static AssetIndex of(Map<String, Object> json) {
        List<String> problems = new ArrayList<>();
        String format = AssetJson.string(AssetJson.get(json, "format"), "");
        if (!FORMAT.equals(format)) problems.add("format " + format);
        String latest = AssetJson.string(AssetJson.get(json, "latest"), "");
        if (latest.isEmpty()) problems.add("no latest version");
        int maxChain = (int) AssetJson.number(AssetJson.get(json, "maxChain"), 3);
        Map<String, VersionInfo> versions = new LinkedHashMap<>();
        Map<String, Object> rawVersions = AssetJson.objectOrNull(AssetJson.get(json, "versions"));
        if (rawVersions == null) {
            problems.add("no versions map");
        } else {
            for (Map.Entry<String, Object> item : rawVersions.entrySet()) {
                Map<String, Object> entry = AssetJson.object(item.getValue());
                if (AssetPaths.problem(item.getKey()) != null) problems.add("bad version key " + item.getKey());
                versions.put(item.getKey(), new VersionInfo(
                    AssetJson.string(entry.get("inventory"), null),
                    AssetJson.number(entry.get("count"), 0),
                    AssetJson.number(entry.get("bytes"), 0),
                    AssetJson.string(entry.get("reused"), null)));
            }
        }
        List<Step> bases = new ArrayList<>();
        for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(json, "bases"))) {
            Map<String, Object> entry = AssetJson.object(item);
            String version = AssetJson.string(entry.get("version"), "");
            String name = AssetJson.string(entry.get("name"), "");
            bases.add(new Step(AssetPackage.KIND_BASE, version, version, name,
                AssetJson.number(entry.get("size"), 0), AssetJson.string(entry.get("sha256"), "")));
        }
        List<Step> deltas = new ArrayList<>();
        for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(json, "deltas"))) {
            Map<String, Object> entry = AssetJson.object(item);
            deltas.add(new Step(AssetPackage.KIND_DELTA,
                AssetJson.string(entry.get("from"), ""),
                AssetJson.string(entry.get("to"), ""),
                AssetJson.string(entry.get("name"), ""),
                AssetJson.number(entry.get("size"), 0),
                AssetJson.string(entry.get("sha256"), "")));
        }
        List<String> packageProblems = new ArrayList<>();
        for (Step step : bases) {
            if (!step.name.equals("assets-base-" + step.to + ".zip")) packageProblems.add("base name " + step.name);
            if (!step.sha256.matches("^[0-9a-f]{64}$")) packageProblems.add("base " + step.name + " has no sha256");
        }
        for (Step step : deltas) {
            if (!step.name.equals("assets-delta-" + step.from + "-" + step.to + ".zip")) packageProblems.add("delta name " + step.name);
            if (!step.sha256.matches("^[0-9a-f]{64}$")) packageProblems.add("delta " + step.name + " has no sha256");
        }
        problems.addAll(packageProblems);
        if (!problems.isEmpty()) throw new IllegalArgumentException("bad asset index: " + AssetPackage.join(problems));
        return new AssetIndex(latest, maxChain, versions, bases, deltas);
    }

    /** Numeric comparison for {@code 0.M.N} and {@code M.N.R} style versions. */
    public static int compareVersions(String a, String b) {
        String[] left = String.valueOf(a == null ? "" : a).split("\\.", -1);
        String[] right = String.valueOf(b == null ? "" : b).split("\\.", -1);
        int length = Math.max(left.length, right.length);
        for (int i = 0; i < length; i++) {
            int x = i < left.length ? parseInt(left[i]) : 0;
            int y = i < right.length ? parseInt(right[i]) : 0;
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    private static int parseInt(String text) {
        try {
            return Integer.parseInt(text.trim());
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    /** The shortest delta chain from {@code from} to {@code to}, at most {@code limit} steps, or null. */
    public List<Step> shortestDeltaChain(String from, String to, int limit) {
        if (from == null || to == null) return null;
        if (from.equals(to)) return new ArrayList<>();
        Map<String, List<Step>> edges = new HashMap<>();
        for (Step delta : deltas) {
            List<Step> list = edges.get(delta.from);
            if (list == null) {
                list = new ArrayList<>();
                edges.put(delta.from, list);
            }
            list.add(delta);
        }
        // Same order as the Node planner: ascending target version, then package name.
        for (List<Step> list : edges.values()) {
            list.sort((left, right) -> {
                int order = compareVersions(left.to, right.to);
                return order != 0 ? order : left.name.compareTo(right.name);
            });
        }
        Deque<String> versions = new ArrayDeque<>();
        Deque<List<Step>> chains = new ArrayDeque<>();
        Set<String> seen = new HashSet<>();
        versions.add(from);
        chains.add(new ArrayList<Step>());
        seen.add(from);
        while (!versions.isEmpty()) {
            String version = versions.poll();
            List<Step> chain = chains.poll();
            if (chain.size() >= limit) continue;
            List<Step> outgoing = edges.get(version);
            if (outgoing == null) continue;
            for (Step delta : outgoing) {
                if (seen.contains(delta.to)) continue;
                List<Step> next = new ArrayList<>(chain);
                next.add(delta);
                if (delta.to.equals(to)) return next;
                seen.add(delta.to);
                versions.add(delta.to);
                chains.add(next);
            }
        }
        return null;
    }

    /** The base package that reaches {@code target} with the fewest steps. */
    public List<Step> bestBaseRoute(String target, int limit) {
        List<Step> best = null;
        for (Step base : bases) {
            List<Step> chain = shortestDeltaChain(base.to, target, limit);
            if (chain == null) continue;
            List<Step> steps = new ArrayList<>();
            steps.add(base);
            steps.addAll(chain);
            if (best == null || steps.size() < best.size()) best = steps;
        }
        return best;
    }

    /** A version can serve bytes either directly or through a delta ending at that version. */
    private boolean versionProvides(String version) {
        for (Step base : bases) if (base.to.equals(version)) return true;
        for (Step delta : deltas) if (delta.to.equals(version)) return true;
        return false;
    }

    /** Resolve a metadata-only release to the version whose package carries its exact payload. */
    private String providerVersion(String version) {
        if (version == null || version.isEmpty()) return version;
        String original = version;
        String current = version;
        Set<String> seen = new HashSet<>();
        seen.add(current);
        for (int step = 0; step < 8; step += 1) {
            VersionInfo info = versions.get(current);
            String next = info == null ? null : info.reused;
            if (next == null) break;
            if (seen.contains(next) || !versionProvides(next)) return original;
            seen.add(next);
            current = next;
        }
        return current;
    }

    /**
     * Decide how a client with the given local state reaches the published latest version.
     *
     * @param localVersion the version the client currently serves, or null when it has none
     * @param localInventory the digest of the inventory the client currently serves, or null
     * @param limit the client's own maximum chain length
     */
    public Plan plan(String localVersion, String localInventory, int limit) {
        String version = localVersion == null || localVersion.isEmpty() ? null : localVersion;
        String inventory = localInventory == null ? null : localInventory.toLowerCase(Locale.ROOT);
        VersionInfo published = version == null ? null : versions.get(version);
        String verification = "unknown";
        if (version != null && published != null && inventory != null) {
            verification = published.inventory != null && published.inventory.equals(inventory) ? "ok" : "mismatch";
        } else if (version != null && published == null) {
            verification = "unpublished";
        }
        String provider = providerVersion(version);
        VersionInfo providerInfo = provider == null ? null : versions.get(provider);
        if (provider != null && !provider.equals(version) && providerInfo != null && inventory != null) {
            verification = providerInfo.inventory != null && providerInfo.inventory.equals(inventory) ? "ok" : "mismatch";
        }
        String target = providerVersion(latest);
        List<Step> baseRoute = bestBaseRoute(target, limit);
        if (compareVersions(provider, target) == 0 && !"mismatch".equals(verification)) {
            String reason = provider != null && provider.equals(version)
                ? (target.equals(latest) ? "already on " + latest : "already on the asset set published for " + latest)
                : version + " reuses the payload published for " + provider;
            return new Plan("current", reason, verification, version, latest, null, new ArrayList<Step>(), 0);
        }
        List<Step> deltaChain = provider != null && "ok".equals(verification) ? shortestDeltaChain(provider, target, limit) : null;
        if (deltaChain != null && !deltaChain.isEmpty()) {
            return new Plan("update", deltaChain.size() + " delta package(s) from " + provider, verification, version, latest,
                AssetPackage.KIND_DELTA, deltaChain, bytes(deltaChain));
        }
        if (baseRoute != null) {
            boolean repair = "mismatch".equals(verification) || version == null;
            String reason;
            if ("mismatch".equals(verification)) reason = "local state does not match published " + version + "; using a fresh base";
            else if (version == null) reason = "no local state; using a base package";
            else reason = "no usable delta chain; base " + baseRoute.get(0).to;
            return new Plan(repair ? "repair" : "update", reason, verification, version, latest,
                AssetPackage.KIND_BASE, baseRoute, bytes(baseRoute));
        }
        if (compareVersions(provider, target) == 0) {
            return new Plan("current", "already on " + latest, verification, version, latest, null, new ArrayList<Step>(), 0);
        }
        return new Plan("blocked", "the index has no route to the latest version", verification, version, latest, null,
            new ArrayList<Step>(), 0);
    }
    private static long bytes(List<Step> steps) {
        long total = 0;
        for (Step step : steps) total += step.size;
        return total;
    }
}
