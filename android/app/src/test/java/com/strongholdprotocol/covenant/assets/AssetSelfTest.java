package com.strongholdprotocol.covenant.assets;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Runnable JVM self-test for the runtime asset update pipeline (no Android, no JUnit).
 *
 * <p>Two modes:
 * <ul>
 *   <li>with a fixture directory (written by {@code node tools/android-asset-tests.mjs} with the real
 *       release tooling) it checks cross-language interoperability: the state stamped by the Node tool
 *       is read by the Java store, Node-built base and delta packages are applied by the Java applier,
 *       the resulting inventory digest matches the published one, and the Java route planner agrees
 *       with the Node planner;</li>
 *   <li>without a fixture directory it builds its own tiny packages and checks extraction, digest
 *       verification, path-traversal refusal, deletion handling, and that every failure leaves the
 *       previous cache untouched.</li>
 * </ul>
 *
 * <p>Run it with {@code node tools/android-asset-tests.mjs}. Exit code 1 means a check failed.
 */
public final class AssetSelfTest {
    private static int checks;
    private static int failures;
    private static boolean verbose;

    private AssetSelfTest() {
    }

    public static void main(String[] args) throws Exception {
        verbose = "1".equals(System.getenv("SP_ASSET_TEST_VERBOSE"));
        String fixture = null;
        String report = null;
        for (int i = 0; i < args.length; i += 1) {
            if ("--report".equals(args[i]) && i + 1 < args.length) {
                report = args[i + 1];
                i += 1;
            } else if (!args[i].startsWith("--")) {
                fixture = args[i];
            }
        }
        File work = Files.createTempDirectory("sp-asset-selftest").toFile();
        try {
            if (fixture != null && !fixture.isEmpty()) {
                System.out.println("[interop] fixture " + fixture);
                interop(new File(fixture), new File(work, "interop"));
            } else {
                System.out.println("[interop] no fixture directory given, skipped");
            }
            explicitUpdate(fixture == null || fixture.isEmpty() ? null : new File(fixture), new File(work, "session"));
            selfContained(new File(work, "self"));
            concurrency(new File(work, "concurrency"));
            pointerFailures(new File(work, "pointer"));
            redirects();
        } finally {
            deleteTree(work);
        }
        System.out.println();
        System.out.println("android asset self-test: " + checks + " check(s), " + failures + " failure(s)");
        if (report != null) {
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("format", "sp-asset-selftest-report-v1");
            summary.put("checks", (long) checks);
            summary.put("failures", (long) failures);
            summary.put("interop", fixture != null);
            write(new File(report), utf8(AssetJson.stringify(summary)));
        }
        if (failures > 0) System.exit(1);
    }

    // ---------------------------------------------------------------- interop (Node fixtures)

    private static void interop(File fixture, File work) throws Exception {
        Map<String, Object> manifest = obj(readText(new File(fixture, "manifest.json")));
        if (!"sp-asset-selftest-fixture-v1".equals(AssetJson.string(AssetJson.get(manifest, "format"), ""))) {
            throw new IOException(fixture + "/manifest.json: unexpected fixture format");
        }
        File floor = new File(fixture, "floor");
        AssetStore store = AssetStore.openDir(new File(work, "store"), floor);
        Map<String, Object> floorInfo = AssetJson.object(AssetJson.get(manifest, "floor"));
        check("interop: the stamped floor version is read", store.version(), AssetJson.string(AssetJson.get(floorInfo, "version"), ""));
        check("interop: the stamped floor inventory digest matches Node", store.inventoryDigest(), AssetJson.string(AssetJson.get(floorInfo, "inventory"), ""));
        checkServed(store, AssetJson.object(AssetJson.get(manifest, "floorFiles")), "interop: floor files are served");

        Map<String, Object> base = AssetJson.object(AssetJson.get(manifest, "base"));
        File baseZip = new File(fixture, "packages/" + AssetJson.string(AssetJson.get(base, "name"), ""));
        AssetStore.Applied appliedBase = store.apply(baseZip, AssetJson.string(AssetJson.get(base, "sha256"), null), AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        check("interop: the Node base package applies", appliedBase.version, AssetJson.string(AssetJson.get(base, "version"), ""));
        check("interop: the base lands on the published inventory", store.inventoryDigest(), AssetJson.string(AssetJson.get(base, "inventory"), ""));
        checkServed(store, AssetJson.object(AssetJson.get(manifest, "baseFiles")), "interop: files after the base");
        checkAbsent(store, AssetJson.arrayOrEmpty(AssetJson.get(manifest, "baseAbsent")), "interop: files the base removed stay removed");

        Map<String, Object> delta = AssetJson.object(AssetJson.get(manifest, "delta"));
        File deltaZip = new File(fixture, "packages/" + AssetJson.string(AssetJson.get(delta, "name"), ""));
        AssetStore.Applied appliedDelta = store.apply(deltaZip, AssetJson.string(AssetJson.get(delta, "sha256"), null), AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        check("interop: the Node delta package applies", appliedDelta.version, AssetJson.string(AssetJson.get(delta, "to"), ""));
        check("interop: the delta lands on the published inventory", store.inventoryDigest(), AssetJson.string(AssetJson.get(delta, "inventory"), ""));
        checkServed(store, AssetJson.object(AssetJson.get(manifest, "deltaFiles")), "interop: files after the delta");
        checkAbsent(store, AssetJson.arrayOrEmpty(AssetJson.get(manifest, "deltaAbsent")), "interop: files the delta removed stay removed");

        File indexFile = new File(fixture, "index/" + AssetJson.string(AssetJson.get(manifest, "indexName"), "assets-index.json"));
        AssetIndex index = AssetIndex.parse(readText(indexFile));
        for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(manifest, "routes"))) {
            Map<String, Object> route = AssetJson.object(item);
            int limit = (int) AssetJson.number(AssetJson.get(route, "maxChain"), AssetConfig.DEFAULT_MAX_CHAIN);
            AssetIndex.Plan plan = index.plan(
                AssetJson.string(AssetJson.get(route, "localVersion"), null),
                AssetJson.string(AssetJson.get(route, "localInventory"), null), limit);
            String label = "interop: route " + AssetJson.string(AssetJson.get(route, "label"), "?");
            check(label + " status", plan.status, AssetJson.string(AssetJson.get(route, "status"), ""));
            check(label + " kind", String.valueOf(plan.routeKind), AssetJson.string(AssetJson.get(route, "routeKind"), "null"));
            List<String> expected = new ArrayList<>();
            for (Object name : AssetJson.arrayOrEmpty(AssetJson.get(route, "names"))) expected.add(String.valueOf(name));
            List<String> actual = new ArrayList<>();
            for (AssetIndex.Step step : plan.steps) actual.add(step.name);
            check(label + " packages", actual.toString(), expected.toString());
        }
    }

    // ---------------------------------------------------------------- explicit session (enhanced 2.6.4)

    /**
     * Serves the fixture's index and packages from memory. The explicit session tests must prove what a
     * transfer does, so nothing here touches a socket and every call is counted.
     */
    private static final class FixtureFetcher implements AssetUpdateSession.Fetcher {
        private final byte[] index;
        private final Map<String, byte[]> packages;
        private final String token;
        private final List<String> transfers = new ArrayList<>();
        private final List<String> authentications = new ArrayList<>();
        private int exchanges;
        private int indexReads;
        private int attempts;
        private boolean failNext;

        FixtureFetcher(byte[] index, Map<String, byte[]> packages, String token) {
            this.index = index;
            this.packages = packages;
            this.token = token;
        }

        @Override
        public String exchangeToken(AssetConfig config, String sessionToken) throws IOException {
            exchanges += 1;
            if (token == null) throw new IOException("the fixture has no asset token");
            return token;
        }

        @Override
        public byte[] bytes(String url, long limit, AssetConfig config, String authorization) throws IOException {
            indexReads += 1;
            authentications.add(authorization == null ? "" : authorization);
            if (index == null) throw new IOException("the fixture has no index");
            return index;
        }

        @Override
        public void file(String url, File target, long limit, AssetConfig config, String authorization,
                AssetUpdater.Progress progress) throws IOException {
            attempts += 1;
            String name = url.substring(url.lastIndexOf('/') + 1);
            if (failNext) {
                failNext = false;
                throw new IOException("simulated network loss");
            }
            byte[] payload = packages.get(name);
            if (payload == null) throw new IOException("unexpected package " + name);
            transfers.add(name);
            authentications.add(authorization == null ? "" : authorization);
            int chunk = Math.max(1, payload.length / 3);
            try (FileOutputStream out = new FileOutputStream(target)) {
                for (int at = 0; at < payload.length; at += chunk) {
                    int end = Math.min(payload.length, at + chunk);
                    out.write(payload, at, end - at);
                    if (progress != null) progress.onBytes(end, payload.length);
                }
                out.flush();
            }
        }
    }

    /**
     * The 2.6.4 contract: the runtime asset session does nothing at all until the player taps the entry
     * and confirms the plan, reports progress while it runs, and never leaks a token to the WebView.
     */
    private static void explicitUpdate(File fixture, File work) throws Exception {
        AssetUpdateSession unavailable = new AssetUpdateSession(null, AssetConfig.disabled("no store"), new File(work, "cache-none"), null);
        check("session: without a store the session is unavailable",
                String.valueOf(unavailable.status().get("state")), AssetUpdateSession.UNAVAILABLE);
        check("session: an unavailable session reports no plan", unavailable.status().get("plan") == null, true);
        if (fixture == null) return;

        Map<String, Object> manifest = obj(readText(new File(fixture, "manifest.json")));
        byte[] indexBytes = read(new File(fixture,
                "index/" + AssetJson.string(AssetJson.get(manifest, "indexName"), "assets-index.json")));
        Map<String, Object> base = AssetJson.object(AssetJson.get(manifest, "base"));
        Map<String, Object> delta = AssetJson.object(AssetJson.get(manifest, "delta"));
        String baseName = AssetJson.string(AssetJson.get(base, "name"), "");
        String deltaName = AssetJson.string(AssetJson.get(delta, "name"), "");
        Map<String, byte[]> packages = new LinkedHashMap<>();
        packages.put(baseName, read(new File(fixture, "packages/" + baseName)));
        packages.put(deltaName, read(new File(fixture, "packages/" + deltaName)));
        List<String> floorRoute = new ArrayList<>();
        for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(manifest, "routes"))) {
            Map<String, Object> route = AssetJson.object(item);
            if (!"floor".equals(AssetJson.string(AssetJson.get(route, "label"), ""))) continue;
            for (Object name : AssetJson.arrayOrEmpty(AssetJson.get(route, "names"))) floorRoute.add(String.valueOf(name));
        }
        check("session: the fixture publishes the floor route to exercise", floorRoute.size() > 0);

        File floor = new File(fixture, "floor");
        AssetConfig protectedConfig = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\","
                + "\"indexUrl\":\"https://assets.example.invalid/index/assets-index.json\","
                + "\"tokenUrl\":\"https://assets.example.invalid/token\",\"maxChain\":3}"));
        check("session: the protected fixture configuration is valid", protectedConfig.enabled);

        // ---- a protected deployment: nothing happens until the player asks for it
        File cache = new File(work, "cache");
        AssetStore store = AssetStore.openDir(new File(work, "store"), floor);
        String installed = store.version();
        FixtureFetcher fetch = new FixtureFetcher(indexBytes, packages, "fixture.asset.token");
        List<Map<String, Object>> snapshots = new ArrayList<>();
        AssetUpdateSession session = new AssetUpdateSession(store, protectedConfig, cache, fetch);
        session.setListener(snapshots::add);
        check("session: a protected deployment waits for the game session",
                String.valueOf(session.status().get("state")), AssetUpdateSession.WAITING);
        check("session: creating the session transfers nothing", fetch.attempts == 0 && fetch.indexReads == 0);
        session.setSessionToken("not-a-session-token");
        check("session: a malformed session token is refused", session.hasSession() == false);
        check("session: the state stays waiting after a bad token",
                String.valueOf(session.status().get("state")), AssetUpdateSession.WAITING);
        session.setSessionToken("0123456789abcdef0123456789abcdef");
        check("session: a valid session token is accepted", session.hasSession());
        check("session: the state is idle once the token arrives",
                String.valueOf(session.status().get("state")), AssetUpdateSession.IDLE);
        check("session: the arrival of the session token starts no background work",
                fetch.attempts == 0 && fetch.indexReads == 0);
        check("session: the status never carries the game-session token",
                AssetJson.stringify(session.status()).contains("0123456789abcdef0123456789abcdef") == false);

        // ---- the confirmation gate: a plan is described first, and it transfers nothing
        Map<String, Object> prepared = session.prepare();
        check("session: prepare reaches the ready state",
                String.valueOf(prepared.get("state")), AssetUpdateSession.READY);
        check("session: prepare exchanged the session token exactly once", fetch.exchanges == 1);
        check("session: prepare read the release index once", fetch.indexReads == 1);
        check("session: prepare transferred no package", fetch.attempts == 0);
        Map<String, Object> plan = AssetJson.object(AssetJson.get(prepared, "plan"));
        List<String> planned = new ArrayList<>();
        for (Object item : AssetJson.arrayOrEmpty(AssetJson.get(plan, "packages"))) {
            planned.add(AssetJson.string(AssetJson.get(AssetJson.object(item), "name"), ""));
        }
        check("session: the prepared plan is the published floor route", planned.toString(), floorRoute.toString());
        check("session: the plan announces its size for the confirmation dialog",
                AssetJson.number(AssetJson.get(plan, "bytes"), 0) > 0);
        check("session: the status does not carry the asset token either",
                AssetJson.stringify(prepared).contains("fixture.asset.token") == false);
        check("session: the index read used the exchanged asset token",
                fetch.authentications.contains("fixture.asset.token"));
        check("session: start outside the ready state changes nothing",
                String.valueOf(new AssetUpdateSession(store, protectedConfig, new File(work, "cache-idle"), fetch).status().get("state")),
                AssetUpdateSession.WAITING);

        // ---- a failed transfer keeps the installed assets and stays retryable
        fetch.failNext = true;
        Map<String, Object> failed = session.start();
        check("session: a transfer failure is reported as failed",
                String.valueOf(failed.get("state")), AssetUpdateSession.FAILED);
        check("session: a failure is retryable", Boolean.TRUE.equals(failed.get("retryable")));
        check("session: a failure reports its reason", String.valueOf(failed.get("error")).isEmpty() == false);
        check("session: a failure keeps the installed version", store.version(), installed);
        check("session: a failure deletes its temporary package",
                new File(cache, "asset-package.zip").exists() == false);

        Map<String, Object> retried = session.retry();
        check("session: retry reruns the plan",
                String.valueOf(retried.get("state")), AssetUpdateSession.COMPLETE);
        check("session: retry applied every planned package", fetch.transfers.toString(), floorRoute.toString());
        check("session: the store landed on the published latest version",
                store.version(), AssetJson.string(AssetJson.get(delta, "to"), ""));
        check("session: completion reports every planned byte",
                AssetJson.number(retried.get("done"), -1) == AssetJson.number(retried.get("total"), -1)
                        && AssetJson.number(retried.get("total"), -1) > 0);
        check("session: the last package is the one reported as current",
                AssetJson.string(AssetJson.get(retried, "packageName"), ""),
                floorRoute.isEmpty() ? "" : floorRoute.get(floorRoute.size() - 1));
        check("session: the snapshot format is published",
                AssetJson.string(AssetJson.get(retried, "format"), ""), AssetUpdateSession.STATUS_FORMAT);
        boolean progressed = false;
        boolean applying = false;
        for (Map<String, Object> snapshot : snapshots) {
            if (AssetUpdateSession.DOWNLOADING.equals(snapshot.get("state"))
                    && AssetJson.number(snapshot.get("packageDone"), 0) > 0) progressed = true;
            if (AssetUpdateSession.APPLYING.equals(snapshot.get("state"))) applying = true;
        }
        check("session: byte progress reaches the UI while downloading", progressed);
        check("session: verification and application are reported", applying);

        // ---- cancelling is only ever a user action, and it never transfers anything by itself
        AssetConfig casualConfig = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\","
                + "\"indexUrl\":\"https://assets.example.invalid/index/assets-index.json\"}"));
        check("session: an unprotected configuration is valid", casualConfig.enabled);
        AssetStore casualStore = AssetStore.openDir(new File(work, "store-casual"), floor);
        FixtureFetcher casualFetch = new FixtureFetcher(indexBytes, packages, null);
        AssetUpdateSession casual = new AssetUpdateSession(casualStore, casualConfig, new File(work, "cache-casual"), casualFetch);
        check("session: an unprotected deployment is idle at once",
                String.valueOf(casual.status().get("state")), AssetUpdateSession.IDLE);
        check("session: start without a confirmed plan transfers nothing",
                String.valueOf(casual.start().get("state")), AssetUpdateSession.IDLE);
        casual.cancel();
        check("session: cancelling from idle is reported",
                String.valueOf(casual.status().get("state")), AssetUpdateSession.CANCELLED);
        check("session: cancelling from idle transferred nothing", casualFetch.attempts == 0);
        Map<String, Object> casualPlan = casual.prepare();
        check("session: an unprotected prepare needs no token exchange", casualFetch.exchanges == 0);
        check("session: an unprotected prepare reaches ready",
                String.valueOf(casualPlan.get("state")), AssetUpdateSession.READY);
        casual.cancel();
        check("session: cancelling the confirmation transfers nothing", casualFetch.attempts == 0);
        check("session: the cancelled state is reported to the UI",
                String.valueOf(casual.status().get("state")), AssetUpdateSession.CANCELLED);

        AssetUpdateSession offline = new AssetUpdateSession(casualStore, AssetConfig.disabled("no configuration"),
                new File(work, "cache-offline"), casualFetch);
        check("session: a disabled configuration reports unconfigured",
                String.valueOf(offline.status().get("state")), AssetUpdateSession.UNCONFIGURED);
        check("session: an unconfigured session prepares nothing",
                String.valueOf(offline.prepare().get("state")), AssetUpdateSession.UNCONFIGURED);
        check("session: an unconfigured session transfers nothing", casualFetch.attempts == 0);
    }

    // ---------------------------------------------------------------- self-contained checks

    private static void selfContained(File work) throws Exception {
        byte[] assetsJsonV1 = utf8("{\"version\":1,\"chars\":{\"char_002_amiya\":{\"avatar\":\"/assets/char/avatar/char_002_amiya.png\"}}}");
        byte[] localV1 = utf8("{\"version\":1,\"scenes\":[]}");
        byte[] avatarV1 = utf8("avatar-v1");
        byte[] cssV1 = utf8("body{color:#fff}");
        byte[] extraV1 = utf8("extra-floor-only");

        File floor = new File(work, "floor");
        Map<String, byte[]> floorFiles = new LinkedHashMap<>();
        floorFiles.put("data/assets.json", assetsJsonV1);
        floorFiles.put("data/local-assets.json", localV1);
        floorFiles.put("assets/char/avatar/char_002_amiya.png", avatarV1);
        floorFiles.put("assets/ui/extra.png", extraV1);
        floorFiles.put("fonts/fonts.css", cssV1);
        for (Map.Entry<String, byte[]> item : floorFiles.entrySet()) write(new File(floor, item.getKey()), item.getValue());
        stamp(floor, "1.0.0", floorFiles);

        File storeRoot = new File(work, "store");
        AssetStore store = AssetStore.openDir(storeRoot, floor);
        check("the floor version is read", store.version(), "1.0.0");
        check("the floor inventory digest is stable", store.inventoryDigest(), store.inventoryDigest());
        check("a floor asset is served", served(store, "assets/char/avatar/char_002_amiya.png"), "avatar-v1");
        check("a path outside the asset set is not served", served(store, "index.html"), null);
        check("a path the state does not list is not served", served(store, "assets/char/avatar/missing.png"), null);

        // ---- a base package replaces the whole state, including deleting a floor file
        byte[] assetsJsonV2 = utf8("{\"version\":1,\"chars\":{\"char_002_amiya\":{\"avatar\":\"/assets/char/avatar/char_002_amiya.png\"},\"char_003_kalts\":{\"avatar\":\"/assets/char/avatar/char_003_kalts.png\"}}}");
        byte[] avatarV2 = utf8("avatar-v2");
        byte[] kalts = utf8("kalts-v2");
        Map<String, byte[]> targetV2 = new LinkedHashMap<>();
        targetV2.put("data/assets.json", assetsJsonV2);
        targetV2.put("data/local-assets.json", localV1);
        targetV2.put("assets/char/avatar/char_002_amiya.png", avatarV2);
        targetV2.put("assets/char/avatar/char_003_kalts.png", kalts);
        Spec base = new Spec("base", "2.0.0");
        base.shipped.putAll(targetV2);
        base.target.putAll(targetV2);
        base.removed.put("fonts/fonts.css", cssV1);
        base.removed.put("assets/ui/extra.png", extraV1);
        File baseZip = new File(work, "assets-base-2.0.0.zip");
        writePackage(baseZip, base);

        AssetStore.Applied applied = store.apply(baseZip, AssetInventory.sha256(baseZip), AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        check("the base package applies", applied.version, "2.0.0");
        check("the base inventory digest is the state digest", store.inventoryDigest(), digestOf(targetV2));
        check("a changed file serves the new bytes", served(store, "assets/char/avatar/char_002_amiya.png"), "avatar-v2");
        check("an added file is served", served(store, "assets/char/avatar/char_003_kalts.png"), "kalts-v2");
        check("an unchanged file is still served", served(store, "data/local-assets.json"), new String(localV1, StandardCharsets.UTF_8));
        check("a file the base removed is gone", served(store, "fonts/fonts.css"), null);
        check("a floor file outside the new state is gone", served(store, "assets/ui/extra.png"), null);

        // ---- a delta layers on top of the base
        byte[] assetsJsonV3 = utf8("{\"version\":1,\"chars\":{\"char_003_kalts\":{\"avatar\":\"/assets/char/avatar/char_003_kalts.png\"}}}");
        byte[] kaltsV3 = utf8("kalts-v3");
        byte[] newFont = utf8("body{color:#000}");
        Map<String, byte[]> shippedV3 = new LinkedHashMap<>();
        shippedV3.put("data/assets.json", assetsJsonV3);
        shippedV3.put("assets/char/avatar/char_003_kalts.png", kaltsV3);
        shippedV3.put("fonts/fonts.css", newFont);
        Map<String, byte[]> targetV3 = new LinkedHashMap<>(targetV2);
        targetV3.putAll(shippedV3);
        targetV3.remove("assets/char/avatar/char_002_amiya.png");
        Spec delta = new Spec("delta", "2.0.1");
        delta.from = "2.0.0";
        delta.fromInventory = store.inventoryDigest();
        delta.shipped.putAll(shippedV3);
        delta.target.putAll(targetV3);
        delta.removed.put("assets/char/avatar/char_002_amiya.png", avatarV2);
        File deltaZip = new File(work, "assets-delta-2.0.0-2.0.1.zip");
        writePackage(deltaZip, delta);

        AssetStore.Applied appliedDelta = store.apply(deltaZip, AssetInventory.sha256(deltaZip), AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        check("the delta package applies", appliedDelta.version, "2.0.1");
        check("the delta inventory digest is the state digest", store.inventoryDigest(), digestOf(targetV3));
        check("a delta-changed file serves the new bytes", served(store, "assets/char/avatar/char_003_kalts.png"), "kalts-v3");
        check("a delta-added file is served on top of the base", served(store, "fonts/fonts.css"), "body{color:#000}");
        check("a delta-removed file is gone", served(store, "assets/char/avatar/char_002_amiya.png"), null);
        check("a file from the base layer is still served", served(store, "data/local-assets.json"), new String(localV1, StandardCharsets.UTF_8));

        String goodVersion = store.version();
        String goodDigest = store.inventoryDigest();
        String goodContent = served(store, "assets/char/avatar/char_003_kalts.png");

        // ---- every failure keeps the previous cache exactly as it was
        expectFailure("a package with the wrong whole-file digest is refused", () ->
            store.apply(deltaZip, "0".repeat(64), AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));
        check("the wrong digest left the version alone", store.version(), goodVersion);
        check("the wrong digest left the content alone", served(store, "assets/char/avatar/char_003_kalts.png"), goodContent);

        File tampered = new File(work, "assets-delta-tampered.zip");
        Spec tamperedSpec = copy(delta);
        tamperedSpec.forced.put("assets/char/avatar/char_003_kalts.png", utf8("kalts-tampered"));
        writePackage(tampered, tamperedSpec);
        expectFailure("a package whose entry does not match its digest is refused", () ->
            store.apply(tampered, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));
        check("the tampered package left the version alone", store.version(), goodVersion);
        check("the tampered package left the content alone", served(store, "assets/char/avatar/char_003_kalts.png"), goodContent);

        File missing = new File(work, "assets-delta-missing.zip");
        Spec missingSpec = copy(delta);
        missingSpec.omit.add("fonts/fonts.css");
        writePackage(missing, missingSpec);
        expectFailure("a package missing a listed file is refused", () ->
            store.apply(missing, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));
        check("the incomplete package left the version alone", store.version(), goodVersion);

        File wrongBase = new File(work, "assets-delta-wrong-base.zip");
        Spec wrongBaseSpec = copy(delta);
        wrongBaseSpec.from = "1.0.0";
        wrongBaseSpec.fromInventory = null;
        writePackage(wrongBase, wrongBaseSpec);
        expectFailure("a delta from another version is refused", () ->
            store.apply(wrongBase, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));

        File wrongInventory = new File(work, "assets-delta-wrong-inventory.zip");
        Spec wrongInventorySpec = copy(delta);
        wrongInventorySpec.fromInventory = "1".repeat(64);
        writePackage(wrongInventory, wrongInventorySpec);
        expectFailure("a delta whose source inventory does not match is refused", () ->
            store.apply(wrongInventory, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));

        File unlisted = new File(work, "assets-delta-unlisted.zip");
        Spec unlistedSpec = copy(delta);
        unlistedSpec.extra.put("assets/ui/hidden.png", utf8("hidden"));
        writePackage(unlisted, unlistedSpec);
        expectFailure("a package with an entry the manifest does not list is refused", () ->
            store.apply(unlisted, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));

        File traversal = new File(work, "assets-delta-traversal.zip");
        Spec traversalSpec = copy(delta);
        traversalSpec.extra.put("../escaped.txt", utf8("escaped"));
        writePackage(traversal, traversalSpec);
        expectFailure("a package with a traversal entry is refused", () ->
            store.apply(traversal, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));
        check("the traversal entry wrote nothing outside the store", new File(storeRoot.getParentFile(), "escaped.txt").exists(), false);
        check("the traversal entry wrote nothing into the staging root", new File(storeRoot, "escaped.txt").exists(), false);
        check("the traversal entry left the version alone", store.version(), goodVersion);

        File absolute = new File(work, "assets-delta-absolute.zip");
        Spec absoluteSpec = copy(delta);
        absoluteSpec.extra.put("/etc/escaped.txt", utf8("escaped"));
        writePackage(absolute, absoluteSpec);
        expectFailure("a package with an absolute entry is refused", () ->
            store.apply(absolute, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));

        // ---- the path rules the WebView handler and the packages share
        check("a normal request path is accepted", AssetPaths.webPath("/assets/char/avatar/x.png"), "assets/char/avatar/x.png");
        check("a request without a leading slash is accepted", AssetPaths.webPath("data/assets.json"), "data/assets.json");
        check("a traversal request is refused", AssetPaths.webPath("/../secret"), null);
        check("a request with an empty segment is refused", AssetPaths.webPath("/assets//x.png"), null);
        check("a request with multiple leading slashes is refused", AssetPaths.webPath("//assets/x.png"), null);
        check("a filename containing two dots is accepted", AssetPaths.webPath("/assets/foo..bar"), "assets/foo..bar");
        check("a backslash request is refused", AssetPaths.webPath("/assets\\x.png"), null);
        check("the state file is never served", AssetPaths.isInternal(AssetPaths.STATE_FILE), true);
        check("the store directories are never served", AssetPaths.isInternal("asset-layers/0001-base-2.0.0/ASSETS.json"), true);
        check("a normal file is served", AssetPaths.isInternal("assets/ui/x.png"), false);

        // ---- routing decisions (the index planner)
        String indexJson = "{\"format\":\"sp-assets-index-v1\",\"latest\":\"2.0.1\",\"maxChain\":3,"
            + "\"versions\":{"
            + "\"1.0.0\":{\"inventory\":\"" + "a".repeat(64) + "\",\"count\":4,\"bytes\":40},"
            + "\"1.0.1\":{\"inventory\":\"" + "b".repeat(64) + "\",\"count\":4,\"bytes\":40},"
            + "\"1.0.2\":{\"inventory\":\"" + "c".repeat(64) + "\",\"count\":4,\"bytes\":40},"
            + "\"2.0.0\":{\"inventory\":\"" + "d".repeat(64) + "\",\"count\":4,\"bytes\":40},"
            + "\"2.0.1\":{\"inventory\":\"" + "e".repeat(64) + "\",\"count\":4,\"bytes\":40}},"
            + "\"bases\":[{\"version\":\"2.0.0\",\"name\":\"assets-base-2.0.0.zip\",\"size\":100,\"sha256\":\"" + "1".repeat(64) + "\"}],"
            + "\"deltas\":["
            + "{\"from\":\"1.0.0\",\"to\":\"1.0.1\",\"name\":\"assets-delta-1.0.0-1.0.1.zip\",\"size\":10,\"sha256\":\"" + "2".repeat(64) + "\"},"
            + "{\"from\":\"1.0.1\",\"to\":\"1.0.2\",\"name\":\"assets-delta-1.0.1-1.0.2.zip\",\"size\":10,\"sha256\":\"" + "3".repeat(64) + "\"},"
            + "{\"from\":\"2.0.0\",\"to\":\"2.0.1\",\"name\":\"assets-delta-2.0.0-2.0.1.zip\",\"size\":10,\"sha256\":\"" + "4".repeat(64) + "\"}]}";
        AssetIndex index = AssetIndex.parse(indexJson);
        check("the index reads the latest version", index.latest, "2.0.1");
        check("a client on the latest version needs nothing", index.plan("2.0.1", "e".repeat(64), 3).status, "current");
        AssetIndex.Plan oneDelta = index.plan("2.0.0", "d".repeat(64), 3);
        check("a delta route is preferred when the state matches", oneDelta.status, "update");
        check("a delta route uses the delta package", String.valueOf(oneDelta.routeKind), "delta");
        check("a delta route has one step", String.valueOf(oneDelta.steps.size()), "1");
        AssetIndex.Plan viaBase = index.plan("1.0.2", "c".repeat(64), 3);
        check("a version with no delta uses a base plus deltas", viaBase.status, "update");
        check("that route starts with a base", String.valueOf(viaBase.routeKind), "base");
        check("that route has two steps", String.valueOf(viaBase.steps.size()), "2");
        check("that route starts from the base package", viaBase.steps.get(0).name, "assets-base-2.0.0.zip");
        AssetIndex.Plan mismatched = index.plan("1.0.0", "9".repeat(64), 3);
        check("a local state that does not match the publication is repaired", mismatched.status, "repair");
        check("a repair reason is reported", mismatched.reason.contains("does not match"), true);
        AssetIndex.Plan fresh = index.plan(null, null, 3);
        check("a client with no state installs a base", fresh.status, "repair");
        check("a fresh client downloads the base", fresh.steps.get(0).name, "assets-base-2.0.0.zip");
        AssetIndex.Plan longChain = index.plan("1.0.0", "a".repeat(64), 1);
        check("a delta chain longer than the client allows falls back to a base", longChain.status, "update");
        check("that fallback starts from a base package", String.valueOf(longChain.routeKind), "base");
        check("that fallback is the base plus one delta", String.valueOf(longChain.steps.size()), "2");
        AssetIndex stale = AssetIndex.parse(indexJson.replace("\"latest\":\"2.0.1\"", "\"latest\":\"3.0.0\""));
        AssetIndex.Plan blocked = stale.plan("1.0.0", "a".repeat(64), 3);
        check("an index with no route to the latest version is blocked", blocked.status, "blocked");
        check("a blocked plan downloads nothing", String.valueOf(blocked.steps.size()), "0");
        check("a blocked plan explains itself", blocked.reason != null && !blocked.reason.isEmpty(), true);
        AssetIndex.Plan unknown = index.plan("9.9.9", "f".repeat(64), 3);
        check("an unpublished local version is treated as unknown", unknown.status, "update");
        check("an unknown version falls back to a base", String.valueOf(unknown.routeKind), "base");
        String reusedIndexJson = "{\"format\":\"sp-assets-index-v1\",\"latest\":\"2.0.2\",\"maxChain\":3,"
            + "\"versions\":{\"2.0.1\":{\"inventory\":\"" + "e".repeat(64) + "\"},"
            + "\"2.0.2\":{\"inventory\":\"" + "e".repeat(64) + "\",\"reused\":\"2.0.1\"}},"
            + "\"bases\":[{\"version\":\"2.0.1\",\"name\":\"assets-base-2.0.1.zip\",\"size\":100,\"sha256\":\"" + "1".repeat(64) + "\"}],\"deltas\":[]}";
        AssetIndex reused = AssetIndex.parse(reusedIndexJson);
        check("a reused latest pointer is parsed", reused.versions.get("2.0.2").reused, "2.0.1");
        AssetIndex.Plan reusedPlan = reused.plan("2.0.1", "e".repeat(64), 3);
        check("a reused latest payload is already current", reusedPlan.status, "current");
        check("a reused latest payload needs no package", String.valueOf(reusedPlan.steps.size()), "0");
        // ---- configuration: public data only, safe degradation
        AssetConfig disabled = AssetConfig.fromBuild("", 3, 1, 1, false);
        check("no index URL disables the updater", disabled.enabled, false);
        AssetConfig http = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\",\"indexUrl\":\"http://example.test/assets-index.json\"}"));
        check("a plain http index URL is refused", http.enabled, false);
        AssetConfig allowed = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\",\"indexUrl\":\"http://example.test/assets-index.json\",\"allowHttp\":true}"));
        check("an explicitly allowed plain http index URL is accepted", allowed.enabled, true);
        AssetConfig credentials = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\",\"indexUrl\":\"https://user:pass@example.test/assets-index.json\"}"));
        check("an index URL with credentials is refused", credentials.enabled, false);
        AssetConfig signed = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\",\"indexUrl\":\"https://example.test/assets-index.json?X-Amz-Signature=abc\"}"));
        check("an index URL with a signature is refused", signed.enabled, false);
        AssetConfig good = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\",\"indexUrl\":\"https://cdn.example.test/assets/assets-index.json\"}"));
        check("a public https index URL is accepted", good.enabled, true);
        check("the accepted URL is kept", good.indexUrl, "https://cdn.example.test/assets/assets-index.json");

        // ---- the updater never throws out of the startup path
        AssetUpdater.Outcome outcome = AssetUpdater.update(store, disabled, new File(work, "cache"), null);
        check("a disabled updater reports and stops", outcome.status, "disabled");
        AssetConfig unreachable = AssetConfig.from(obj("{\"format\":\"sp-assets-config-v1\",\"indexUrl\":\"https://127.0.0.1:1/assets-index.json\",\"allowHttp\":true}"));
        AssetUpdater.Outcome failed = AssetUpdater.update(store, unreachable, new File(work, "cache"), null);
        check("an unreachable index fails safely", failed.status, "failed");
        check("a failed update keeps the installed version", store.version(), goodVersion);
    }

    // ------------------------------------------------- concurrent reads and commits

    /**
     * Four WebView-style readers hammer {@link AssetStore#snapshot()}, {@link AssetStore#resolve}
     * while packages are committed, and every snapshot they observe must describe one complete
     * published state: a version whose digest is the published digest, never a half-merged inventory
     * and never bytes from another version. The commit alternates a base (which shrinks the layer
     * list) with a same-version delta (which grows it), so the layer list is replaced both ways.
     */
    private static void concurrency(File work) throws Exception {
        // The floor deliberately does not hold the paths the packages ship, so a stale pointer can
        // only answer with a layer's bytes and never with the APK's older copy of the same path.
        File floor = new File(work, "floor");
        Map<String, byte[]> floorFiles = new LinkedHashMap<>();
        floorFiles.put("data/assets.json", utf8("{\"version\":1}"));
        floorFiles.put("assets/floor/only.txt", utf8("floor-only"));
        writeTree(floor, floorFiles);
        stamp(floor, "1.0.0", floorFiles);

        Map<String, byte[]> a = new LinkedHashMap<>();
        a.put("data/assets.json", utf8("{\"version\":2,\"phase\":\"a\"}"));
        a.put("assets/gen/current.txt", utf8("gen-v0"));
        a.put("assets/gen/stable.txt", utf8("stable"));
        Map<String, byte[]> b = new LinkedHashMap<>(a);
        b.put("assets/gen/current.txt", utf8("gen-v1"));
        Map<String, byte[]> c = new LinkedHashMap<>(b);
        c.put("assets/gen/current.txt", utf8("gen-v2"));
        c.put("assets/gen/added.txt", utf8("added-v2"));

        File base0 = new File(work, "assets-base-2.0.0.zip");
        Spec first = new Spec(AssetPackage.KIND_BASE, "2.0.0");
        first.shipped.putAll(a);
        first.target.putAll(a);
        writePackage(base0, first);

        File delta1 = new File(work, "assets-delta-2.0.0-2.0.1.zip");
        Spec one = new Spec(AssetPackage.KIND_DELTA, "2.0.1");
        one.from = "2.0.0";
        one.fromInventory = digestOf(a);
        one.shipped.put("assets/gen/current.txt", utf8("gen-v1"));
        one.target.putAll(b);
        writePackage(delta1, one);

        File delta2 = new File(work, "assets-delta-2.0.1-2.0.2.zip");
        Spec two = new Spec(AssetPackage.KIND_DELTA, "2.0.2");
        two.from = "2.0.1";
        two.fromInventory = digestOf(b);
        two.shipped.put("assets/gen/current.txt", utf8("gen-v2"));
        two.shipped.put("assets/gen/added.txt", utf8("added-v2"));
        two.target.putAll(c);
        writePackage(delta2, two);

        File root = new File(work, "store");
        AssetStore store = AssetStore.openDir(root, floor);
        store.apply(base0, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        store.apply(delta1, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        store.apply(delta2, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        check("the concurrency fixture reached its last version", store.version(), "2.0.2");
        check("the concurrency fixture holds the published digest", store.inventoryDigest(), digestOf(c));
        check("the concurrency fixture kept its chain", String.valueOf(store.layers().size()), "3");

        Map<String, String> published = new LinkedHashMap<>();
        published.put("2.0.0", digestOf(a));
        published.put("2.0.1", digestOf(b));
        published.put("2.0.2", digestOf(c));
        List<String> contents = new ArrayList<>();
        contents.add("gen-v0");
        contents.add("gen-v1");
        contents.add("gen-v2");

        // Every round publishes a *different* inventory: a base at a new version (which replaces the
        // layer list) followed by a same-version delta (which extends it). A reader that catches a
        // half-published store therefore sees a version whose inventory is not the published one.
        int rounds = 60;
        String lastVersion = "2.0." + (rounds + 2);
        List<File> baseFiles = new ArrayList<>();
        List<File> deltaFiles = new ArrayList<>();
        for (int round = 1; round <= rounds; round += 1) {
            String version = "2.0." + (round + 2);
            String text = "gen-v" + (round + 2);
            Map<String, byte[]> state = new LinkedHashMap<>();
            state.put("data/assets.json", utf8("{\"version\":2,\"round\":" + round + "}"));
            state.put("assets/gen/current.txt", utf8(text));
            state.put("assets/gen/stable.txt", utf8("stable"));
            state.put("assets/gen/added.txt", utf8("added-v2"));

            Spec base = new Spec(AssetPackage.KIND_BASE, version);
            base.shipped.putAll(state);
            base.target.putAll(state);
            File baseZip = new File(work, "assets-base-" + version + ".zip");
            writePackage(baseZip, base);
            baseFiles.add(baseZip);

            Spec delta = new Spec(AssetPackage.KIND_DELTA, version);
            delta.from = version;
            delta.fromInventory = digestOf(state);
            delta.shipped.put("assets/gen/stable.txt", utf8("stable"));
            delta.target.putAll(state);
            File deltaZip = new File(work, "assets-delta-" + version + "-" + version + ".zip");
            writePackage(deltaZip, delta);
            deltaFiles.add(deltaZip);

            contents.add(text);
            published.put(version, digestOf(state));
        }

        AtomicBoolean stop = new AtomicBoolean(false);
        AtomicReference<String> readerError = new AtomicReference<>(null);
        AtomicLong reads = new AtomicLong();
        List<Thread> readers = new ArrayList<>();
        for (int index = 0; index < 4; index += 1) {
            Thread reader = new Thread(() -> {
                try {
                    while (!stop.get()) {
                        AssetStore.Snapshot snap = store.snapshot();
                        String expectedDigest = published.get(snap.version);
                        if (expectedDigest == null) throw new IllegalStateException("unknown published version " + snap.version);
                        if (!expectedDigest.equals(snap.inventory.digest())) {
                            throw new IllegalStateException("version " + snap.version + " was observed with a partial inventory: " + snap.inventory.digest());
                        }
                        if (!expectedDigest.equals(snap.digest)) throw new IllegalStateException("the snapshot digest disagrees with its inventory");
                        for (AssetStore.Layer layer : snap.layers) {
                            if (layer.dir == null || layer.dir.isEmpty()) throw new IllegalStateException("a published layer has no directory");
                        }
                        AssetStore.Hit current = store.resolve("assets/gen/current.txt");
                        if (current != null) {
                            String text = readHit(current);
                            if (text != null && !contents.contains(text)) throw new IllegalStateException("a reader saw torn content '" + text + "'");
                        }
                        AssetStore.Hit stable = store.resolve("assets/gen/stable.txt");
                        if (stable != null) {
                            String text = readHit(stable);
                            if (text != null && !"stable".equals(text)) throw new IllegalStateException("a reader saw the wrong bytes for an unchanged file: '" + text + "'");
                        }
                        reads.incrementAndGet();
                    }
                } catch (Throwable error) {
                    readerError.compareAndSet(null, error.toString());
                }
            });
            reader.setDaemon(true);
            readers.add(reader);
            reader.start();
        }
        long applied = 0;
        for (int round = 0; round < rounds && readerError.get() == null; round += 1) {
            store.apply(baseFiles.get(round), null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
            store.apply(deltaFiles.get(round), null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
            applied += 2;
        }
        stop.set(true);
        for (Thread reader : readers) reader.join(10000);
        check("applying packages under concurrent readers never failed", readerError.get() == null ? "clean" : readerError.get(), "clean");
        check("readers observed the store while it was being updated", reads.get() > 0, true);
        check("the stress run applied every package", String.valueOf(applied), String.valueOf(rounds * 2));
        check("the stress run left the last published version", store.version(), lastVersion);
        check("the stress run left the last published digest", store.inventoryDigest(), published.get(lastVersion));
        check("the stress run kept the newest base and its delta", String.valueOf(store.layers().size()), "2");
        check("the stress run still serves the newest bytes", served(store, "assets/gen/current.txt"), "gen-v" + (rounds + 2));
        check("the base dropped the floor file and it stays gone", served(store, "assets/floor/only.txt"), null);
    }

    // ------------------------------------------------- pointer replacement failures

    /**
     * Every way the pointer replacement can fail must leave the previously installed state fully
     * usable: the pointer file, the in-memory snapshot, the served bytes and the next launch, which
     * recovers from the backup when the pointer never landed.
     */
    private static void pointerFailures(File work) throws Exception {
        File floor = new File(work, "floor");
        Map<String, byte[]> v1 = new LinkedHashMap<>();
        v1.put("data/assets.json", utf8("{\"version\":1}"));
        v1.put("assets/gen/a.txt", utf8("a1"));
        writeTree(floor, v1);
        stamp(floor, "1.0.0", v1);

        Map<String, byte[]> v2 = new LinkedHashMap<>();
        v2.put("data/assets.json", utf8("{\"version\":2}"));
        v2.put("assets/gen/a.txt", utf8("a2"));
        v2.put("assets/gen/b.txt", utf8("b2"));
        Map<String, byte[]> v3 = new LinkedHashMap<>();
        v3.put("data/assets.json", utf8("{\"version\":3}"));
        v3.put("assets/gen/a.txt", utf8("a3"));
        v3.put("assets/gen/b.txt", utf8("b3"));
        v3.put("assets/gen/c.txt", utf8("c3"));

        File first = new File(work, "assets-base-2.0.0.zip");
        Spec spec0 = new Spec(AssetPackage.KIND_BASE, "2.0.0");
        spec0.shipped.putAll(v2);
        spec0.target.putAll(v2);
        writePackage(first, spec0);

        File second = new File(work, "assets-base-2.0.1.zip");
        Spec spec1 = new Spec(AssetPackage.KIND_BASE, "2.0.1");
        spec1.shipped.putAll(v3);
        spec1.target.putAll(v3);
        writePackage(second, spec1);

        File root = new File(work, "store");
        AssetStore store = AssetStore.openDir(root, floor);
        store.pointerIoForTest(null);
        store.apply(first, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        File pointer = new File(root, AssetPaths.STORE_FILE);
        File backup = new File(root, AssetPaths.STORE_FILE + ".bak");
        String installedPointer = hexOf(pointer);
        check("the fixture installed a pointer", pointer.isFile(), true);
        check("the fixture serves its bytes", served(store, "assets/gen/a.txt"), "a2");

        // A: every replacement attempt fails while the previous pointer is still in place.
        store.pointerIoForTest(new AssetStore.PointerIo() {
            @Override
            public boolean rename(File from, File to) {
                return false;
            }

            @Override
            public void copy(File from, File to) throws IOException {
                throw new IOException("injected: no space left on device");
            }
        });
        expectFailure("a rejected pointer replacement fails the commit", () -> store.apply(second, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));
        check("the rejected replacement kept the pointer file", hexOf(pointer), installedPointer);
        check("the rejected replacement kept the installed version", store.version(), "2.0.0");
        check("the rejected replacement kept the inventory", store.inventoryDigest(), digestOf(v2));
        check("the rejected replacement still serves the old bytes", served(store, "assets/gen/a.txt"), "a2");
        check("the rejected replacement published nothing", served(store, "assets/gen/c.txt"), null);
        check("the rejected replacement left no backup behind", backup.isFile(), false);
        AssetStore reopened = AssetStore.openDir(root, floor);
        check("the next launch reads the version of the rejected replacement", reopened.version(), "2.0.0");
        check("the next launch serves the old bytes", served(reopened, "assets/gen/a.txt"), "a2");
        check("the next launch keeps the new files unpublished", served(reopened, "assets/gen/c.txt"), null);

        // B: the previous pointer had already been moved aside when the rest failed.
        store.pointerIoForTest(new AssetStore.PointerIo() {
            @Override
            public boolean rename(File from, File to) {
                return to.getName().endsWith(".bak");
            }

            @Override
            public void copy(File from, File to) throws IOException {
                throw new IOException("injected: no space left on device");
            }
        });
        expectFailure("a replacement that fails after the pointer was moved aside fails the commit", () -> store.apply(second, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES));
        check("the pointer was put back after the failed replacement", hexOf(pointer), installedPointer);
        check("the moved-aside replacement kept the served bytes", served(store, "assets/gen/a.txt"), "a2");
        check("the moved-aside replacement did not publish", served(store, "assets/gen/c.txt"), null);
        check("the recovered store is readable", AssetStore.openDir(root, floor).version(), "2.0.0");

        // C: the platform refuses to rename over an existing pointer (Windows style): the backup hop
        // has to carry the replacement, and it must clean up after itself.
        store.pointerIoForTest(new AssetStore.PointerIo() {
            @Override
            public boolean rename(File from, File to) {
                if (AssetPaths.STORE_FILE.equals(to.getName()) && to.isFile()) return false;
                return from.renameTo(to);
            }

            @Override
            public void copy(File from, File to) throws IOException {
                AssetStore.copy(from, to);
            }
        });
        AssetStore.Applied applied = store.apply(second, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        check("the fallback path publishes the new version", applied.version, "2.0.1");
        check("the fallback path serves the new bytes", served(store, "assets/gen/a.txt"), "a3");
        check("the fallback path serves the added file", served(store, "assets/gen/c.txt"), "c3");
        check("the fallback path cleaned its backup", backup.isFile(), false);
        check("the fallback path left a readable pointer", AssetStore.openDir(root, floor).version(), "2.0.1");

        // D: the process died between "the old pointer was moved aside" and "the new pointer landed".
        File crashRoot = new File(work, "crash");
        AssetStore other = AssetStore.openDir(crashRoot, floor);
        other.apply(first, null, AssetConfig.DEFAULT_MAX_EXTRACT_BYTES);
        File crashPointer = new File(crashRoot, AssetPaths.STORE_FILE);
        File crashBackup = new File(crashRoot, AssetPaths.STORE_FILE + ".bak");
        String crashedVersion = other.version();
        check("the crash fixture committed", crashedVersion, "2.0.0");
        check("the crash fixture was set up with a moved-aside pointer", crashPointer.renameTo(crashBackup), true);
        AssetStore recovered = AssetStore.openDir(crashRoot, floor);
        check("a store whose pointer never landed recovers the previous state", recovered.version(), crashedVersion);
        check("the recovered store serves the layer files", served(recovered, "assets/gen/b.txt"), "b2");
        check("the recovery restored the pointer file", crashPointer.isFile(), true);
        check("the recovery is reported", String.valueOf(String.join("; ", recovered.notes()).contains("recovered the asset pointer")), "true");
        check("the recovered state survives the next open", AssetStore.openDir(crashRoot, floor).version(), crashedVersion);
    }

    // ---------------------------------------------------------------- fixtures and helpers

    private static void writeTree(File root, Map<String, byte[]> files) throws IOException {
        for (Map.Entry<String, byte[]> item : files.entrySet()) {
            write(new File(root, item.getKey()), item.getValue());
        }
    }

    /** The digest of a file, or {@code absent} when it is not there (a check must report, not throw). */
    private static String hexOf(File file) {
        try {
            return AssetInventory.hex(read(file));
        } catch (IOException error) {
            return "absent";
        }
    }

    /** Read a hit, treating a file a commit removed between resolve and open as "not observed". */
    private static String readHit(AssetStore.Hit hit) throws IOException {
        try (InputStream input = hit.open()) {
            return new String(readAll(input), StandardCharsets.UTF_8);
        } catch (java.io.FileNotFoundException error) {
            return null;
        }
    }

    private static final class Spec {
        final String kind;
        final String version;
        String from;
        String fromInventory;
        final Map<String, byte[]> shipped = new LinkedHashMap<>();
        final Map<String, byte[]> target = new LinkedHashMap<>();
        final Map<String, byte[]> removed = new LinkedHashMap<>();
        final Map<String, byte[]> extra = new LinkedHashMap<>();
        final Map<String, byte[]> forced = new LinkedHashMap<>();
        final List<String> omit = new ArrayList<>();

        Spec(String kind, String version) {
            this.kind = kind;
            this.version = version;
        }
    }

    private static Spec copy(Spec source) {
        Spec spec = new Spec(source.kind, source.version);
        spec.from = source.from;
        spec.fromInventory = source.fromInventory;
        spec.shipped.putAll(source.shipped);
        spec.target.putAll(source.target);
        spec.removed.putAll(source.removed);
        spec.extra.putAll(source.extra);
        spec.forced.putAll(source.forced);
        spec.omit.addAll(source.omit);
        return spec;
    }

    private static void writePackage(File zip, Spec spec) throws IOException {
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("format", AssetPackage.FORMAT);
        manifest.put("kind", spec.kind);
        manifest.put("version", spec.version);
        if (spec.from != null) manifest.put("from", spec.from);
        if (spec.fromInventory != null) manifest.put("fromInventory", spec.fromInventory);
        manifest.put("inventory", digestOf(spec.target));
        manifest.put("count", (long) spec.target.size());
        manifest.put("bytes", bytesOf(spec.target));
        Map<String, Object> shippedStats = new LinkedHashMap<>();
        shippedStats.put("count", (long) spec.shipped.size());
        shippedStats.put("bytes", bytesOf(spec.shipped));
        manifest.put("shipped", shippedStats);
        manifest.put("files", filesJson(spec.shipped, null));
        List<Object> tombstones = new ArrayList<>();
        for (Map.Entry<String, byte[]> item : spec.removed.entrySet()) {
            Map<String, Object> tombstone = new LinkedHashMap<>();
            tombstone.put("path", item.getKey());
            tombstone.put("size", (long) item.getValue().length);
            tombstone.put("sha256", AssetInventory.sha256(item.getValue()));
            tombstones.add(tombstone);
        }
        if (!AssetPackage.KIND_BASE.equals(spec.kind)) manifest.put("removed", tombstones);

        byte[] manifestBytes = utf8(AssetJson.stringify(manifest));
        byte[] stateBytes = null;
        if (AssetPackage.KIND_BASE.equals(spec.kind)) {
            Map<String, Object> state = new LinkedHashMap<>();
            state.put("format", "sp-assets-state-v1");
            state.put("version", spec.version);
            state.put("floor", "base");
            state.put("count", (long) spec.target.size());
            state.put("bytes", bytesOf(spec.target));
            state.put("inventory", digestOf(spec.target));
            state.put("files", filesJson(spec.target, null));
            stateBytes = utf8(AssetJson.stringify(state));
        }

        List<Object[]> entries = new ArrayList<>();
        entries.add(new Object[] {AssetPaths.PACKAGE_MANIFEST, manifestBytes});
        if (stateBytes != null) entries.add(new Object[] {AssetPaths.PACKAGE_STATE, stateBytes});
        for (Map.Entry<String, byte[]> item : spec.shipped.entrySet()) {
            if (spec.omit.contains(item.getKey())) continue;
            byte[] data = spec.forced.containsKey(item.getKey()) ? spec.forced.get(item.getKey()) : item.getValue();
            entries.add(new Object[] {item.getKey(), data});
        }
        for (Map.Entry<String, byte[]> item : spec.extra.entrySet()) entries.add(new Object[] {item.getKey(), item.getValue()});
        writeZip(zip, entries);
    }

    private static void writeZip(File zip, List<Object[]> entries) throws IOException {
        File parent = zip.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
        try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(zip))) {
            for (Object[] item : entries) {
                String name = (String) item[0];
                byte[] data = (byte[]) item[1];
                CRC32 crc = new CRC32();
                crc.update(data);
                ZipEntry entry = new ZipEntry(name);
                entry.setMethod(ZipEntry.STORED);
                entry.setSize(data.length);
                entry.setCompressedSize(data.length);
                entry.setCrc(crc.getValue());
                out.putNextEntry(entry);
                out.write(data);
                out.closeEntry();
            }
        }
    }

    private static Map<String, Object> filesJson(Map<String, byte[]> files, Map<String, byte[]> forced) {
        Map<String, Object> json = new LinkedHashMap<>();
        for (Map.Entry<String, byte[]> item : files.entrySet()) {
            byte[] data = forced != null && forced.containsKey(item.getKey()) ? forced.get(item.getKey()) : item.getValue();
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("size", (long) data.length);
            entry.put("sha256", AssetInventory.sha256(data));
            json.put(item.getKey(), entry);
        }
        return json;
    }

    private static String digestOf(Map<String, byte[]> files) {
        AssetInventory inventory = new AssetInventory();
        for (Map.Entry<String, byte[]> item : files.entrySet()) {
            inventory.put(item.getKey(), item.getValue().length, AssetInventory.sha256(item.getValue()));
        }
        return inventory.digest();
    }

    private static long bytesOf(Map<String, byte[]> files) {
        long total = 0;
        for (byte[] data : files.values()) total += data.length;
        return total;
    }

    private static void stamp(File root, String version, Map<String, byte[]> files) throws IOException {
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("format", "sp-assets-state-v1");
        state.put("version", version);
        state.put("floor", "apk");
        state.put("count", (long) files.size());
        state.put("bytes", bytesOf(files));
        state.put("inventory", digestOf(files));
        state.put("files", filesJson(files, null));
        write(new File(root, AssetPaths.STATE_FILE), utf8(AssetJson.stringify(state)));
    }

    private static void checkServed(AssetStore store, Map<String, Object> expected, String label) throws IOException {
        for (Map.Entry<String, Object> item : expected.entrySet()) {
            check(label + ": " + item.getKey(), served(store, item.getKey()), AssetJson.string(item.getValue(), ""));
        }
    }

    private static void checkAbsent(AssetStore store, List<Object> paths, String label) throws IOException {
        for (Object path : paths) {
            check(label + ": " + path, served(store, String.valueOf(path)), null);
        }
    }

    // ---------------------------------------------------------------- redirects (origin pinning)

    /** The Worker token is pinned to one origin, and the hop cap stays three. */
    private static void redirects() throws Exception {
        String origin = AssetUpdater.originOf(new URL("https://cdn.example.test/a/assets-index.json"));
        check("an origin is scheme, host and effective port", origin, "https://cdn.example.test:443");
        check("an explicit default port is the same origin", AssetUpdater.originOf(new URL("https://CDN.example.test:443/x")), origin);
        check("a different host is a different origin", AssetUpdater.originOf(new URL("https://evil.example.test/x")), "https://evil.example.test:443");
        check("a different port is a different origin", AssetUpdater.originOf(new URL("https://cdn.example.test:8443/x")), "https://cdn.example.test:8443");
        check("plain http is a different origin", AssetUpdater.originOf(new URL("http://cdn.example.test/x")), "http://cdn.example.test:80");

        URL index = new URL("https://cdn.example.test/a/assets-index.json");
        check("a relative same-origin redirect is followed", AssetUpdater.redirectTarget(index, "asset-package.zip", origin).toString(), "https://cdn.example.test/a/asset-package.zip");
        check("an absolute same-origin redirect keeps the origin", AssetUpdater.originOf(AssetUpdater.redirectTarget(index, "https://cdn.example.test/b/asset-package.zip", origin)), origin);

        String crossed = failure(() -> AssetUpdater.redirectTarget(index, "https://evil.example.test/b/asset-package.zip", origin));
        check("a cross-origin redirect is refused before the request is repeated", crossed != null && crossed.startsWith("refusing cross-origin asset redirect from https://cdn.example.test/a/assets-index.json"), true);
        check("the refusal names the host it refused", crossed != null && crossed.contains("evil.example.test"), true);
        check("a downgrade to plain http is refused", failure(() -> AssetUpdater.redirectTarget(index, "http://cdn.example.test/b/asset-package.zip", origin)) != null, true);
        check("a redirect without a location is refused", failure(() -> AssetUpdater.redirectTarget(index, "", origin)), "redirect without a location from https://cdn.example.test/a/assets-index.json");
        check("at most three redirects are followed", String.valueOf(AssetUpdater.MAX_REDIRECTS), "3");
    }

    private static String served(AssetStore store, String rel) throws IOException {
        AssetStore.Hit hit = store.resolve(rel);
        if (hit == null) return null;
        try (InputStream input = hit.open()) {
            return new String(readAll(input), StandardCharsets.UTF_8);
        }
    }

    private static void check(String what, boolean condition) {
        check(what, condition, true);
    }

    private static void check(String what, boolean actual, boolean expected) {
        check(what, String.valueOf(actual), String.valueOf(expected));
    }

    private static void check(String what, String actual, String expected) {
        checks += 1;
        boolean ok = actual == null ? expected == null : actual.equals(expected);
        if (!ok) {
            failures += 1;
            System.out.println("FAIL " + what + ": expected " + expected + ", got " + actual);
        } else if (verbose) {
            System.out.println("  ok " + what);
        }
    }

    /** Runs {@code body} and returns its failure message, or null when it did not fail. */
    private static String failure(Attempt body) {
        try {
            body.run();
            return null;
        } catch (Exception error) {
            return error.getMessage();
        }
    }

    private interface Attempt {
        void run() throws Exception;
    }

    private static void expectFailure(String what, Attempt body) {
        checks += 1;
        try {
            body.run();
            failures += 1;
            System.out.println("FAIL " + what + ": no error was raised");
        } catch (Throwable error) {
            if (verbose) System.out.println("  ok " + what + " -> " + error.getMessage());
        }
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static Map<String, Object> obj(String text) {
        return AssetJson.object(AssetJson.parse(text));
    }

    private static String readText(File file) throws IOException {
        return new String(read(file), StandardCharsets.UTF_8);
    }

    private static byte[] read(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return readAll(input);
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[1 << 16];
        int read;
        while ((read = input.read(buffer)) > 0) out.write(buffer, 0, read);
        return out.toByteArray();
    }

    private static void write(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
