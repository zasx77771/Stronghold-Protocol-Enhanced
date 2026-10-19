# Android native shell

`syncNativeWeb` copies the current upstream `public/` directory and the single shared
`native/bridge/stronghold-native-bridge.js` into generated Android assets immediately before build.
No checked-in copy of webpage sources exists under `android/`; this is the boundary that keeps an
upstream update from becoming a manual Android merge.

## Release signing

`assembleRelease` requires `SP_ANDROID_KEYSTORE`, `SP_ANDROID_KEYSTORE_PASSWORD`,
`SP_ANDROID_KEY_ALIAS`, and `SP_ANDROID_KEY_PASSWORD`. The keystore and passwords stay outside
the repository; a debug APK is never a formal release artifact.
