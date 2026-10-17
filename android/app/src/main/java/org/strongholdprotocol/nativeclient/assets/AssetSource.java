package org.strongholdprotocol.nativeclient.assets;

import java.io.IOException;
import java.io.InputStream;

/**
 * Where the immutably installed asset files live.
 *
 * <p>On the device this is the APK's own asset directory (the "floor"): the release build stamps
 * {@code asset-state.json} next to the files, and every update is a layer on top. In tests and local
 * runs it is a plain directory, which is why the store never touches Android classes itself.
 */
public interface AssetSource {
    /** True when the source holds the given asset path. */
    boolean has(String rel);

    /** Open one asset, or throw {@link IOException} when it is missing. */
    InputStream open(String rel) throws IOException;

    /** Short description for logs. */
    String describe();
}
