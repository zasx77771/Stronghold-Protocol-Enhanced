package org.strongholdprotocol.nativeclient.assets;

import android.content.res.AssetManager;

import java.io.IOException;
import java.io.InputStream;

/**
 * The APK itself as an {@link AssetSource}: the immutable "floor" of the layered asset store. It also
 * backs every request that is not a runtime asset path (the program code, fonts CSS, i18n packs…),
 * which is what the WebView served before the updater existed.
 */
public final class AssetApkSource implements AssetSource {
    private final AssetManager manager;

    public AssetApkSource(AssetManager manager) {
        this.manager = manager;
    }


    @Override
    public boolean has(String rel) {
        try {
            manager.open(rel, AssetManager.ACCESS_STREAMING).close();
            return true;
        } catch (IOException error) {
            return false;
        }
    }
    @Override
    public InputStream open(String rel) throws IOException {
        // ACCESS_STREAMING keeps large assets readable even when the packaging tool compressed them
        // (plain open() refuses assets above the legacy 1 MiB compressed limit).
        return manager.open(rel, AssetManager.ACCESS_STREAMING);
    }

    @Override
    public String describe() {
        return "apk assets";
    }
}
