package org.strongholdprotocol.nativeclient.assets;

import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Serves the WebView from the layered asset store.
 *
 * <p>The client asks for {@code https://appassets.androidplatform.net/…}; this handler answers: a
 * runtime asset path comes from the newest layer that holds it (and a path the published inventory no
 * longer lists is a 404, so a deleted asset really disappears), anything else comes from the APK. The
 * APK remains the floor, so a device with no store, no network or a failed update keeps working with
 * exactly what it shipped with.
 *
 * <p>Requests never reach the file system without passing the shared path rules, and our own bookkeeping
 * files (the stamped state, the public config, the store pointer and its directories) are never served.
 */
public final class RuntimeAssetHandler implements WebViewAssetLoader.PathHandler {
    private final AssetStore store;
    private final AssetSource apk;

    public RuntimeAssetHandler(AssetStore store, AssetSource apk) {
        this.store = store;
        this.apk = apk;
    }

    @Override
    public WebResourceResponse handle(String path) {
        String rel = AssetPaths.webPath(path);
        if (rel == null || AssetPaths.isInternal(rel)) return notFound();
        // Only a store with a known state may answer with a 404 for an asset path: without a stamped
        // inventory (an older APK, a broken stamp) the packaged assets are all we have.
        if (store != null && store.hasState() && AssetPaths.isAssetPath(rel)) {
            // A commit that published between the snapshot this resolution took and the file system
            // lookup can hide a file that was just replaced (an older layer directory is removed after
            // the new state is published). Retrying once re-resolves against the published state: the
            // file is found in the new layer, while a file the new state really removed stays a 404.
            WebResourceResponse served = serve(store, rel);
            if (served == null) served = serve(store, rel);
            if (served != null) return served;
            return notFound();
        }
        if (apk == null) return notFound();
        try {
            return response(rel, apk.open(rel));
        } catch (IOException error) {
            return notFound();
        }
    }

    /** Resolve and open one path, or null when the published state cannot answer it. */
    private static WebResourceResponse serve(AssetStore store, String rel) {
        AssetStore.Hit hit = store.resolve(rel);
        if (hit == null) return null;
        try {
            return response(rel, hit.open());
        } catch (IOException error) {
            return null;
        }
    }

    private static WebResourceResponse response(String rel, InputStream stream) {
        String mime = AssetPaths.mimeType(rel);
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        String encoding = null;
        if (mime.startsWith("text/") || mime.startsWith("application/javascript") || mime.startsWith("application/json")) {
            encoding = "UTF-8";
        }
        return new WebResourceResponse(mime, encoding, stream);
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse response = new WebResourceResponse("text/plain", "UTF-8",
            new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
        response.setStatusCodeAndReasonPhrase(404, "Not Found");
        return response;
    }
}
