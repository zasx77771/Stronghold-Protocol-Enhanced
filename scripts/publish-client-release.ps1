param(
  [string]$PreviousWindowsClient = '',
  [string]$PreviousVersion = '',
  [string]$UpstreamMainlineVersion = '',
  [switch]$MainlineUpdate,
  [string]$WindowsCacheDir = '',
  [string]$WindowsAssetSourceDir = '',
  [string]$AndroidToolchainDir = '',
  [string]$AndroidCacheRoot = '',
  [string]$AndroidResourceSourceDir = '',
  [switch]$AndroidClean,
  # Android signing is forwarded only at process execution time; credentials are never persisted.
  [string]$AndroidSigningKeystore = '',
  [string]$AndroidSigningStorePassword = '',
  [string]$AndroidSigningKeyAlias = '',
  [string]$AndroidSigningKeyPassword = '',
  [string]$IncrementalOutputRoot = '',
  # Public runtime asset configuration for the Android client (baked into the APK and its asset-config.json).
  [string]$AssetIndexUrl = '',
  [string]$AssetTokenUrl = '',
  [string]$AssetIndexBaseUrl = '',
  [int]$AssetMaxChain = 3,
  [switch]$AssetAllowHttp,
  # Runtime asset packages (R2): where the asset trees come from and where the packages are written.
  [string]$CurrentAssetDir = '',
  [string]$PreviousAssetDir = '',
  [string]$AssetCacheRoot = '',
  [switch]$SkipAssetPackages
)

$ErrorActionPreference = 'Stop'

$HasPreviousWindows = -not [string]::IsNullOrWhiteSpace($PreviousWindowsClient)
if ($MainlineUpdate -and -not $HasPreviousWindows) {
  throw 'A mainline release requires the previous mainline Windows client directory.'
}
if (-not $UpstreamMainlineVersion) {
  throw 'Every release requires -UpstreamMainlineVersion, for example 0.1.3 or 0.1.4.'
}

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PackageInfo = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$LocalVersion = [string]$PackageInfo.version
if ($AssetIndexUrl -and -not $AssetTokenUrl) {
  throw 'A private R2 release requires -AssetTokenUrl with -AssetIndexUrl.'
}
if ($AssetIndexUrl -and -not $CurrentAssetDir) { $CurrentAssetDir = $ProjectRoot }

$PolicyArguments = @((Join-Path $ProjectRoot 'tools\release-policy.mjs'), '--upstream', $UpstreamMainlineVersion)
if ($MainlineUpdate) { $PolicyArguments += '--mainline' }
& node @PolicyArguments
if ($LASTEXITCODE -ne 0) { throw 'Release policy validation failed.' }

$WindowsArguments = @{}
if ($AssetIndexUrl) { $WindowsArguments.AssetIndexUrl = $AssetIndexUrl }
if ($AssetTokenUrl) { $WindowsArguments.AssetTokenUrl = $AssetTokenUrl }
if ($AssetMaxChain -gt 0) { $WindowsArguments.AssetMaxChain = $AssetMaxChain }
if ($AssetAllowHttp) { $WindowsArguments.AssetAllowHttp = $true }
if ($WindowsCacheDir) { $WindowsArguments.CacheDir = $WindowsCacheDir }
if ($WindowsAssetSourceDir) { $WindowsArguments.AssetSourceDir = $WindowsAssetSourceDir }

Write-Host 'Building complete Windows client package...'
& (Join-Path $PSScriptRoot 'build-windows-client.ps1') @WindowsArguments
if (-not $?) { throw 'Windows client build failed.' }

$AndroidArguments = @{}
if ($AndroidToolchainDir) { $AndroidArguments.ToolchainDir = $AndroidToolchainDir }
if ($AndroidCacheRoot) { $AndroidArguments.CacheRoot = $AndroidCacheRoot }
if ($AndroidResourceSourceDir) { $AndroidArguments.ResourceSourceDir = $AndroidResourceSourceDir }
if ($AssetTokenUrl) { $AndroidArguments.AssetTokenUrl = $AssetTokenUrl }
if ($AndroidClean) { $AndroidArguments.Clean = $true }
$AndroidSigningInputs = @($AndroidSigningKeystore, $AndroidSigningStorePassword, $AndroidSigningKeyAlias, $AndroidSigningKeyPassword)
$MissingAndroidSigningInputCount = $AndroidSigningInputs.Where({ [string]::IsNullOrWhiteSpace([string]$_) }).Count
if ($MissingAndroidSigningInputCount -ne $AndroidSigningInputs.Count) {
  if ($MissingAndroidSigningInputCount -ne 0) { throw 'Android signing requires the keystore, store password, key alias and key password together.' }
  $AndroidArguments.SigningKeystore = $AndroidSigningKeystore
  $AndroidArguments.SigningStorePassword = $AndroidSigningStorePassword
  $AndroidArguments.SigningKeyAlias = $AndroidSigningKeyAlias
  $AndroidArguments.SigningKeyPassword = $AndroidSigningKeyPassword
}
if ($AssetIndexUrl) { $AndroidArguments.AssetIndexUrl = $AssetIndexUrl }
if ($AssetIndexBaseUrl) { $AndroidArguments.AssetIndexBaseUrl = $AssetIndexBaseUrl }
if ($AssetMaxChain -gt 0) { $AndroidArguments.AssetMaxChain = $AssetMaxChain }
if ($AssetAllowHttp) { $AndroidArguments.AssetAllowHttp = $true }

Write-Host 'Building complete Android client package...'
& (Join-Path $PSScriptRoot 'build-android-client.ps1') @AndroidArguments
if (-not $?) { throw 'Android client build failed.' }

if (-not $HasPreviousWindows) {
  # A first release still needs a baseline on R2: it is the package a fresh install downloads before it
  # has any asset version of its own.
  if (-not $SkipAssetPackages) {
    $BaselineArguments = @{ Version = $PackageInfo.version; AssetMaxChain = $AssetMaxChain }
    if ($CurrentAssetDir) { $BaselineArguments.CurrentAssetDir = $CurrentAssetDir }
    if ($AssetCacheRoot) { $BaselineArguments.AssetCacheRoot = $AssetCacheRoot }
    if ($AssetIndexBaseUrl) { $BaselineArguments.IndexBaseUrl = $AssetIndexBaseUrl }
    Write-Host 'Building the runtime asset baseline package...'
    & (Join-Path $PSScriptRoot 'build-asset-packages.ps1') @BaselineArguments
    if (-not $?) { throw 'Asset baseline package build failed.' }
  }
  Write-Host 'First release complete: full Windows and Android packages are ready; no Windows incremental package was requested.' -ForegroundColor Green
  return
}

$UpdateArguments = @{
  PreviousWindowsClient = $PreviousWindowsClient
}
if ($PreviousVersion) { $UpdateArguments.PreviousVersion = $PreviousVersion }
$UpdateArguments.UpstreamMainlineVersion = $UpstreamMainlineVersion
if ($MainlineUpdate) { $UpdateArguments.MainlineUpdate = $true }
if ($IncrementalOutputRoot) { $UpdateArguments.OutputRoot = $IncrementalOutputRoot }
if ($CurrentAssetDir) { $UpdateArguments.CurrentAssetDir = $CurrentAssetDir }
if ($PreviousAssetDir) { $UpdateArguments.PreviousAssetDir = $PreviousAssetDir }
if ($AssetCacheRoot) { $UpdateArguments.AssetCacheRoot = $AssetCacheRoot }
if ($AssetMaxChain -gt 0) { $UpdateArguments.AssetMaxChain = $AssetMaxChain }
if ($AssetIndexBaseUrl) { $UpdateArguments.AssetIndexBaseUrl = $AssetIndexBaseUrl }
if ($SkipAssetPackages) { $UpdateArguments.SkipAssetPackages = $true }

Write-Host 'Building Windows incremental package and runtime asset packages...'
& (Join-Path $PSScriptRoot 'build-client-updates.ps1') @UpdateArguments
if (-not $?) { throw 'Client incremental package build failed.' }

Write-Host 'Client release complete.' -ForegroundColor Green
