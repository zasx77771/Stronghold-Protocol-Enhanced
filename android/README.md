# Android native shell

`syncNativeWeb` copies the current upstream `public/` directory and the single shared
`native/bridge/stronghold-native-bridge.js` into generated Android assets immediately before build.
No checked-in copy of webpage sources exists under `android/`; this is the boundary that keeps an
upstream update from becoming a manual Android merge.

## Release signing

`assembleRelease` requires `SP_ANDROID_KEYSTORE`, `SP_ANDROID_KEYSTORE_PASSWORD`,
`SP_ANDROID_KEY_ALIAS`, and `SP_ANDROID_KEY_PASSWORD`. The keystore and passwords stay outside
the repository; a debug APK is never a formal release artifact.

## Release artifact

Gradle only leaves `app/build/outputs/apk/release/app-release.apk`. The release file is collected
under the name players already download:

```
node scripts/make-android-client.mjs --out <发布目录>/android-client
# → <发布目录>/android-client/Stronghold-Protocol-Client-v<版本>-android.apk
```

`--force` overwrites a previous run of the same script (`--apk` points at another APK). Before
uploading, `apksigner verify --print-certs` must show the release certificate and `zipalign -c -p 4`
must pass; the script only copies and renames, it never signs.
