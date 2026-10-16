package com.strongholdprotocol.covenant.assets;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/** An {@link AssetSource} backed by a directory, used by tests and local verification runs. */
public final class DirectoryAssetSource implements AssetSource {
    private final File root;

    public DirectoryAssetSource(File root) {
        this.root = root;
    }

    @Override
    public boolean has(String rel) {
        try {
            return AssetPaths.resolve(root, rel) != null;
        } catch (IOException error) {
            return false;
        }
    }

    @Override
    public InputStream open(String rel) throws IOException {
        File file = AssetPaths.resolve(root, rel);
        if (file == null) throw new IOException("no such asset: " + rel);
        return new FileInputStream(file);
    }

    @Override
    public String describe() {
        return "directory:" + root;
    }
}
