# Client Release Packaging

Use `publish-client-release.ps1` for the normal release workflow. It builds the complete Windows ZIP and Android APK for **every** release, then generates a Windows incremental package and the runtime asset packages. Android is always distributed as the complete signed APK; `build-client-updates.ps1` only regenerates the Windows update package, its release manifest and the runtime asset packages.

A release now produces three kinds of artifact, and they serve different halves of the client:

| Artifact | Reaches the client as | Updates |
| --- | --- | --- |
| Windows client ZIP / update ZIP | the Windows updater | program files only |
| Android APK | the Play/sideload install | the program and the art it is built with |
| Runtime asset packages + `assets-index.json` | Cloudflare R2, fetched by the Android client itself | `assets/`, `fonts/`, `data/assets.json`, `data/local-assets.json` only |

The Windows updater must never update the art: `server/update.js` treats `public/assets/`, `public/fonts/` and the two art manifests as setup art, so a Windows update package leaves them alone and the players re-run `npm run assets` instead. Art changes reach Android in the background, through R2, without a new APK. Details of the package format, the index, the client's store and the safety rules are in [docs/ASSETS.md](../docs/ASSETS.md) ("Runtime asset packages").

## Version policy

Upstream `0.M.N` maps to enhanced `M.N.*`; a new upstream baseline starts at `M.N.0`, and enhanced releases on that baseline increment only the final component. Published `0.2.*` and `0.3.*` releases remain unchanged. The general mapping has been active since upstream `0.1.4`; the current version is read from `release-policy.json` and the version files rather than hard-coded in this guide.

Both release scripts delegate validation to `tools/release-policy.mjs`. Do not duplicate the mapping in PowerShell.

## Small release

For a small release, use the immediately previous Windows client as the base. Windows receives an update ZIP, Android receives the complete APK, and R2 receives the asset delta:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/publish-client-release.ps1 `
  -UpstreamMainlineVersion UPSTREAM_VERSION `
  -PreviousWindowsClient "..\enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-vPREVIOUS-win-x64" `
  -PreviousVersion PREVIOUS `
  -AssetIndexUrl "https://ASSET_HOST/stronghold/assets-index.json"
```

The output is written to `../enhanced-client-servers/08-客户端增量包/01-小版本更新/`.

## Mainline release

For a mainline program release, pass the last mainline version explicitly, rather than the immediately preceding small version. The package may span multiple enhanced revisions, but must still name one exact source and destination.

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/publish-client-release.ps1 `
  -MainlineUpdate `
  -UpstreamMainlineVersion UPSTREAM_VERSION `
  -PreviousWindowsClient "..\enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-vPREVIOUS-win-x64" `
  -PreviousVersion PREVIOUS `
  -AssetIndexUrl "https://ASSET_HOST/stronghold/assets-index.json"
```

This writes a direct Windows update ZIP to `../enhanced-client-servers/08-客户端增量包/02-主线版本更新/`; it contains all changes accumulated between the two named versions. The matching Android release remains a complete APK. Only after the Windows update ZIP and release manifest are generated and verified successfully may the script remove full Windows directories/ZIPs and Android APKs for strictly intermediate releases. It preserves both endpoints and writes a cleanup record alongside the mainline update manifest.

Android `versionName`, the APK filename and release notes use the public enhanced version `M.N.R`. Android still requires a strictly increasing integer `versionCode` internally; it is not part of the release tag, artifact name or GitHub Release title.

## Runtime asset packages (R2)

`publish-client-release.ps1` runs `scripts/build-asset-packages.ps1` once the current client exists, and `build-client-updates.ps1` runs it as part of the same step. It writes into the channel directory (`01-小版本更新/` or `02-主线版本更新/`), next to the Windows package of the same release:

- `assets-base-<version>.zip` when this release has to publish a baseline: a new upstream baseline, the first release, a previous tree that no longer matches what was published for it, or a chain that would grow past `-AssetMaxChain`.
- `assets-delta-<from>-<to>.zip` when the previous asset tree is known: only the files that were added or changed, plus the paths this release removed. This is the everyday case.
- `assets-index.json` — the small index the client fetches first: `latest`, `maxChain`, the inventory digest of every published version, and every baseline and delta with its size and SHA-256.

The script verifies both packages and the index before it finishes, refuses to replace a package that is already in the directory (published packages are immutable; fix a mistake with a new version), and fails when a version that used to be reachable can no longer reach the new one. It then prints the `aws s3 cp` commands for the maintainer's own R2 credentials and never uploads or stores anything itself.

To regenerate only the asset packages of an already built release:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/build-asset-packages.ps1 `
  -Version VERSION `
  -PreviousVersion PREVIOUS `
  -IndexBaseUrl "https://ASSET_HOST/stronghold"
```

The current asset tree defaults to `06-构建环境与缓存\android-embedded-assets` (what the APK embeds, with its stamped `asset-state.json`); the previous tree defaults to the previous Windows client directory, whose `public/assets` and `public/fonts` are the bytes the previous clients shipped. `-CurrentAssetDir`, `-PreviousAssetDir` and `-AssetCacheRoot` override that. Pass `-SkipAssetPackages` to the release scripts when a release must not touch the channel directory.

Rules that are easy to get wrong:

- A delta is only published when the previous tree's inventory digest matches what the index published for that version. Otherwise a client whose files are gone could never verify it, so the release publishes a baseline instead (the script says so in its notes).
- The index is uploaded **last**. Clients always read it first, so it must never point at a package that is not there yet.
- The Android APK's asset updater is only enabled when the build was given an index URL (`-AssetIndexUrl`, `-AssetIndexBaseUrl`, or `SP_ASSET_INDEX_URL` / `SP_ASSET_BASE_URL`). Without it the APK serves the art it embedded and never contacts the network. See `scripts/build-android-client.ps1`.
- The URL is public configuration. No key, token, signed URL or account id may appear in it, in the APK, in the index, or in any file of this repository; the upload is done by the maintainer with their own credentials.
- Downloaded art and the packages themselves are never committed.
- Old baselines and their deltas stay on R2 until no supported version needs them. `node tools/assets-r2.mjs route --index assets-index.json --root <asset tree>` is the check that every version a release still supports can reach the new one; the release scripts fail the release when one cannot.

## Package contents

- The Windows ZIP contains only changed files, a deletion list, and a native Windows update client. The update client verifies every base and resulting file with SHA-256 and does not depend on PowerShell. It is program-only and never writes the art.
- Android releases always use the complete, consistently signed APK. It can be installed directly over the previous release when the signing key is unchanged. The APK embeds its art plus an `asset-state.json` stamp (the immutable floor) and, when configured, an `asset-config.json` with the public index URL and limits.
- Runtime asset packages are ZIPs of art files only, verified end to end with SHA-256: the whole archive against the index, then every entry and the resulting inventory against the package manifest.

Each Windows update package is valid for exactly one source and destination version. Small-release packages use the immediately prior release; mainline packages use the prior mainline baseline and therefore already include all intermediate changes.

Older Android delta scripts and packages are retained only as historical artifacts. They are not part of the supported release workflow and must not be used to produce new releases. The runtime asset packages described above are a separate, art-only mechanism and do not replace the complete APK.
