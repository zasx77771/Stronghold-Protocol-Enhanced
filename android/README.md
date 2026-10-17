# Android native shell

`syncNativeWeb` copies the current upstream `public/` directory and the single shared
`native/bridge/stronghold-native-bridge.js` into generated Android assets immediately before build.
No checked-in copy of webpage sources exists under `android/`; this is the boundary that keeps an
upstream update from becoming a manual Android merge.
