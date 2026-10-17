param(
  [string]$ToolchainDir = '',
  [string]$OutputDir = '',
  [string]$CacheRoot = '',
  [string]$ResourceSourceDir = '',
  [string]$AssetIndexUrl = '',
  [string]$AssetTokenUrl = '',
  [string]$AssetIndexBaseUrl = '',
  [int]$AssetMaxChain = 3,
  [switch]$AssetAllowHttp,
  [string]$SigningKeystore = '',
  [string]$SigningStorePassword = '',
  [string]$SigningKeyAlias = '',
  [string]$SigningKeyPassword = '',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$PackageInfo = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = [string]$PackageInfo.version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
if (-not $CacheRoot) {
  $CacheRoot = Join-Path $env:LOCALAPPDATA 'StrongholdProtocol\android-cache'
}
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)

if (-not $ToolchainDir) {
  $ToolchainDir = Join-Path $CacheRoot 'android-toolchain'
}

if (-not $OutputDir) {
  $OutputDir = Join-Path $WorkspaceRoot 'android-output'
}

$ToolchainDir = [IO.Path]::GetFullPath($ToolchainDir)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$AndroidRoot = Join-Path $ProjectRoot 'android'
$AssetsDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-embedded-assets'))
$BuildOutputDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-app-build'))
$ProjectCacheDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-project-cache'))
$GradleUserHome = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'gradle-user-home'))
$AndroidUserHome = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-user-home'))
$JdkRoot = Join-Path $ToolchainDir 'jdk-17'
$SdkRoot = Join-Path $ToolchainDir 'android-sdk'
$Gradle = Join-Path $ToolchainDir 'gradle-8.10.2\bin\gradle.bat'
if (-not $ResourceSourceDir) { $ResourceSourceDir = Join-Path $ProjectRoot 'public' }
$ResourceSourceDir = [IO.Path]::GetFullPath($ResourceSourceDir)
$SigningInputs = @($SigningKeystore, $SigningStorePassword, $SigningKeyAlias, $SigningKeyPassword)
$MissingSigningInputCount = $SigningInputs.Where({ [string]::IsNullOrWhiteSpace([string]$_) }).Count
if ($MissingSigningInputCount -ne $SigningInputs.Count) {
  if ($MissingSigningInputCount -ne 0) {
    throw 'Android signing requires SigningKeystore, SigningStorePassword, SigningKeyAlias and SigningKeyPassword together.'
  }
  $SigningKeystore = [IO.Path]::GetFullPath($SigningKeystore)
  if (-not (Test-Path -LiteralPath $SigningKeystore -PathType Leaf)) { throw "Android signing keystore was not found: $SigningKeystore" }
}

foreach ($Required in @((Join-Path $JdkRoot 'bin\java.exe'), $Gradle, (Join-Path $SdkRoot 'platforms\android-35\android.jar'))) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
    throw "Missing Android build dependency: $Required. Run scripts\install-android-toolchain.ps1 first."
  }
}
if (-not $AssetsDir.StartsWith($CacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe Android assets path: $AssetsDir"
}
if (Test-Path -LiteralPath $AssetsDir) { Remove-Item -LiteralPath $AssetsDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AssetsDir, $BuildOutputDir, $ProjectCacheDir, $GradleUserHome, $AndroidUserHome, $OutputDir | Out-Null

Write-Host 'Preparing generated browser dependencies...'
& node (Join-Path $ProjectRoot 'tools\vendor.mjs')
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to prepare browser dependencies. Run npm ci in this worktree before building Android.'
}

Write-Host 'Embedding client code and all local resources...'
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'public') -Force |
  Where-Object { $_.Name -notin @('dev', 'assets', 'fonts') } |
  Copy-Item -Destination $AssetsDir -Recurse -Force
foreach ($ResourceName in @('assets', 'fonts')) {
  $ResourcePath = Join-Path $ResourceSourceDir $ResourceName
  if (-not (Test-Path -LiteralPath $ResourcePath -PathType Container)) {
    throw "Missing Android client resource directory: $ResourcePath"
  }
  Copy-Item -LiteralPath $ResourcePath -Destination (Join-Path $AssetsDir $ResourceName) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data') -Destination (Join-Path $AssetsDir 'data') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'shared') -Destination (Join-Path $AssetsDir 'shared') -Recurse -Force

$SimTarget = Join-Path $AssetsDir 'sim'
New-Item -ItemType Directory -Force -Path $SimTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'server\sim') -Force |
  Where-Object { $_.Name -ne 'nodeData.js' } |
  Copy-Item -Destination $SimTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\data.js') -Destination (Join-Path $AssetsDir 'data.js')

& node (Join-Path $ProjectRoot 'tools\validate-client-runtime.mjs') $AssetsDir
if ($LASTEXITCODE -ne 0) { throw 'Android embedded client runtime validation failed.' }

# The embedded art is the runtime asset floor. Stamp its inventory so the client can prove what the APK
# already ships and only ever download the difference. The state describes the assets, it is not an asset.
Write-Host 'Stamping the embedded runtime asset state...'
& node (Join-Path $ProjectRoot 'tools\assets-r2.mjs') state --root $AssetsDir --version $Version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to stamp the embedded runtime asset state (asset-state.json).' }
$StatePath = Join-Path $AssetsDir 'asset-state.json'
$StateJson = (Get-Content -Raw -Encoding utf8 -LiteralPath $StatePath) | ConvertFrom-Json
Write-Host ("Embedded asset floor: {0} files, {1:N1} MiB, inventory {2}" -f $StateJson.count, ($StateJson.bytes / 1MB), $StateJson.inventory)

# Public runtime configuration. The index URL is not a secret, but it must never carry credentials or
# signed query parameters, so it goes through the same validator the client uses. Without a URL the
# updater stays off and the APK keeps serving its embedded assets.
if (-not $AssetIndexUrl) { $AssetIndexUrl = [string]$env:SP_ASSET_INDEX_URL }
if (-not $AssetTokenUrl) { $AssetTokenUrl = [string]$env:SP_ASSET_TOKEN_URL }
if (-not $AssetIndexUrl -and -not $AssetIndexBaseUrl) { $AssetIndexBaseUrl = [string]$env:SP_ASSET_BASE_URL }
if (-not $AssetIndexUrl -and $AssetIndexBaseUrl) { $AssetIndexUrl = $AssetIndexBaseUrl.TrimEnd('/') + '/assets-index.json' }
$ConfigPath = Join-Path $AssetsDir 'asset-config.json'
if (Test-Path -LiteralPath $ConfigPath) { Remove-Item -LiteralPath $ConfigPath -Force }
if ($AssetIndexUrl) {
  $ConfigArguments = @((Join-Path $ProjectRoot 'tools\assets-r2.mjs'), 'config', '--index-url', $AssetIndexUrl, '--out', $ConfigPath)
  if ($AssetTokenUrl) { $ConfigArguments += @('--token-url', $AssetTokenUrl) }
  if ($AssetAllowHttp) { $ConfigArguments += '--allow-http' }
  if ($AssetMaxChain -gt 0) { $ConfigArguments += @('--max-chain', [string]$AssetMaxChain) }
  & node @ConfigArguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to write the embedded runtime asset configuration (asset-config.json).' }
  $env:SP_ASSET_INDEX_URL = $AssetIndexUrl
  $env:SP_ASSET_TOKEN_URL = $AssetTokenUrl
  $env:SP_ASSET_MAX_CHAIN = [string]$AssetMaxChain
  if ($AssetAllowHttp) { $env:SP_ASSET_ALLOW_HTTP = 'true' }
  Write-Host "Runtime asset index: $AssetIndexUrl"

  # A configured release is a thin APK: program files and public R2 configuration remain, while the
  # runtime art and its APK-floor stamp are removed after their inventory was used to build packages.
  foreach ($RelativePath in @('assets', 'fonts', 'data\assets.json', 'data\local-assets.json', 'asset-state.json')) {
    $Target = Join-Path $AssetsDir $RelativePath
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
  }
  Write-Host 'Android thin APK: runtime art will be downloaded from R2 on first launch.'
} else {
  Write-Host 'Runtime asset updates are disabled for this build (pass -AssetIndexUrl to enable them).' -ForegroundColor Yellow
}


# Full and thin APKs are not interchangeable Gradle outputs. A dedicated profile, paired with
# disabled task caching below, prevents a prior full APK from restoring bundled art into a thin one.
if ($AssetIndexUrl) {
  $BuildOutputDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-app-build-thin-r2'))
  $ProjectCacheDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-project-cache-thin-r2'))
  New-Item -ItemType Directory -Force -Path $BuildOutputDir, $ProjectCacheDir | Out-Null
}
$env:JAVA_HOME = $JdkRoot
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:GRADLE_USER_HOME = $GradleUserHome
$env:ANDROID_USER_HOME = $AndroidUserHome
$env:SP_ANDROID_ASSETS_DIR = $AssetsDir
$env:SP_ANDROID_BUILD_DIR = $BuildOutputDir
if ($SigningKeystore) {
  $env:SP_ANDROID_SIGNING_STORE_FILE = $SigningKeystore
  $env:SP_ANDROID_SIGNING_STORE_PASSWORD = $SigningStorePassword
  $env:SP_ANDROID_SIGNING_KEY_ALIAS = $SigningKeyAlias
  $env:SP_ANDROID_SIGNING_KEY_PASSWORD = $SigningKeyPassword
} else {
  Remove-Item Env:SP_ANDROID_SIGNING_STORE_FILE, Env:SP_ANDROID_SIGNING_STORE_PASSWORD, Env:SP_ANDROID_SIGNING_KEY_ALIAS, Env:SP_ANDROID_SIGNING_KEY_PASSWORD -ErrorAction SilentlyContinue
}
$env:Path = (Join-Path $JdkRoot 'bin') + [IO.Path]::PathSeparator + $env:Path

Push-Location $AndroidRoot
try {
  if ($Clean) { & $Gradle --no-daemon --project-cache-dir $ProjectCacheDir clean }
  $GradleArguments = @('--no-daemon', '--project-cache-dir', $ProjectCacheDir, '--stacktrace')
  if ($AssetIndexUrl) {
    # `--rerun-tasks` also invalidates stale package-resource task outputs from older Gradle versions.
    $GradleArguments += @('--no-build-cache', '--rerun-tasks')
  }
  $GradleArguments += 'assembleDebug'
  & $Gradle @GradleArguments
  if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$BuiltApk = Join-Path $BuildOutputDir 'outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $BuiltApk -PathType Leaf)) { throw 'Gradle completed but the APK was not found' }
$OutputApk = Join-Path $OutputDir "Stronghold-Protocol-Client-v$Version-android-debug.apk"
Copy-Item -LiteralPath $BuiltApk -Destination $OutputApk -Force
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputApk).Hash
$Size = (Get-Item -LiteralPath $OutputApk).Length
Write-Host ("Android APK ready: {0} ({1:N1} MiB)" -f $OutputApk, ($Size / 1MB))
Write-Host "SHA256: $Hash"
