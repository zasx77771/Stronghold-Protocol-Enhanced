# Client Release Packaging

Use `publish-client-release.ps1` for the normal release workflow. It builds the complete Windows ZIP and Android APK for **every** release, then generates a Windows incremental package. Android is always distributed as the complete signed APK; `build-client-updates.ps1` only regenerates the Windows update package and its release manifest.

## Version policy

The upstream mainline tail selects the local release line: upstream `0.1.3` maps to local `0.3.*`. A mainline merge must be released as `0.3.0`; later small feature releases on that same upstream mainline may only increment the final number (`0.3.1`, `0.3.2`, and so on). The mainline command therefore requires `-UpstreamMainlineVersion 0.1.3` and rejects a mismatched local version or a nonzero final number.

## Small release

For a small release, use the immediately previous Windows client as the base. For example, `v0.2.5 -> v0.2.6` produces a `v0.2.5-to-v0.2.6` Windows update ZIP while Android receives the complete `v0.2.6` APK:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/publish-client-release.ps1 `
  -UpstreamMainlineVersion 0.1.2 `
  -PreviousWindowsClient "..\enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-vPREVIOUS-win-x64" `
  -PreviousVersion PREVIOUS
```

The output is written to `../enhanced-client-servers/08-客户端增量包/01-小版本更新/`.

## Mainline release

For a mainline program release, pass the last mainline version explicitly, rather than the immediately preceding small version. For example, when `v0.3.0` follows the `v0.2.5` mainline and includes `v0.2.6` and `v0.2.7` changes:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/publish-client-release.ps1 `
  -MainlineUpdate `
  -UpstreamMainlineVersion 0.1.3 `
  -PreviousWindowsClient "..\enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-v0.2.5-win-x64" `
  -PreviousVersion 0.2.5
```

This writes a direct `v0.2.5-to-v0.3.0` Windows update ZIP to `../enhanced-client-servers/08-客户端增量包/02-主线版本更新/`; it contains all changes accumulated between those two mainline versions. The matching Android release remains a complete APK. Only after the Windows update ZIP and release manifest are generated successfully, the script removes full Windows directories/ZIPs and Android APKs for strictly intermediate releases, such as `v0.2.6` and `v0.2.7`. It preserves the `v0.2.5` and `v0.3.0` full packages and writes a cleanup record alongside the mainline update manifest.

## Package contents

- The Windows ZIP contains only changed files, a deletion list, and a native Windows update client. The update client verifies every base and resulting file with SHA-256 and does not depend on PowerShell.
- Android releases always use the complete, consistently signed APK. It can be installed directly over the previous release when the signing key is unchanged.

Each Windows update package is valid for exactly one source and destination version. Small-release packages use the immediately prior release; mainline packages use the prior mainline baseline and therefore already include all intermediate changes.
