param(
  [string]$PreviousWindowsClient = '',
  [string]$PreviousVersion = '',
  [string]$UpstreamMainlineVersion = '',
  [switch]$MainlineUpdate,
  [string]$ElectronVersion = '44.5.1',
  [string]$ElectronZip = '',
  [string]$WindowsCacheDir = '',
  [string]$AndroidToolchainDir = '',
  [string]$AndroidCacheRoot = '',
  [switch]$AndroidClean,
  [string]$IncrementalOutputRoot = ''
)

$ErrorActionPreference = 'Stop'

$HasPreviousWindows = -not [string]::IsNullOrWhiteSpace($PreviousWindowsClient)
if ($MainlineUpdate -and -not $HasPreviousWindows) {
  throw 'A mainline release requires the previous mainline Windows client directory.'
}
if (-not $UpstreamMainlineVersion) {
  throw 'Every release requires -UpstreamMainlineVersion, for example 0.1.2 or 0.1.3.'
}

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PackageInfo = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$LocalVersion = [string]$PackageInfo.version
$UpstreamMatch = [regex]::Match($UpstreamMainlineVersion, '^\d+\.\d+\.(?<tail>\d+)$')
$LocalMatch = [regex]::Match($LocalVersion, '^0\.(?<mainline>\d+)\.(?<revision>\d+)(?:[-+][0-9A-Za-z.-]+)?$')
if (-not $UpstreamMatch.Success) { throw "Upstream mainline version must use X.Y.Z form: $UpstreamMainlineVersion" }
if (-not $LocalMatch.Success -or $LocalMatch.Groups['mainline'].Value -ne $UpstreamMatch.Groups['tail'].Value) {
  throw "Local version $LocalVersion does not match upstream $UpstreamMainlineVersion. Expected local form: 0.$($UpstreamMatch.Groups['tail'].Value).*"
}
if ($MainlineUpdate -and $LocalMatch.Groups['revision'].Value -ne '0') {
  throw "A mainline release based on upstream $UpstreamMainlineVersion must start at 0.$($UpstreamMatch.Groups['tail'].Value).0; small releases increment only the final number."
}

$WindowsArguments = @{
  ElectronVersion = $ElectronVersion
}
if ($ElectronZip) { $WindowsArguments.ElectronZip = $ElectronZip }
if ($WindowsCacheDir) { $WindowsArguments.CacheDir = $WindowsCacheDir }

Write-Host 'Building complete Windows client package...'
& (Join-Path $PSScriptRoot 'build-windows-client.ps1') @WindowsArguments
if (-not $?) { throw 'Windows client build failed.' }

$AndroidArguments = @{}
if ($AndroidToolchainDir) { $AndroidArguments.ToolchainDir = $AndroidToolchainDir }
if ($AndroidCacheRoot) { $AndroidArguments.CacheRoot = $AndroidCacheRoot }
if ($AndroidClean) { $AndroidArguments.Clean = $true }

Write-Host 'Building complete Android client package...'
& (Join-Path $PSScriptRoot 'build-android-client.ps1') @AndroidArguments
if (-not $?) { throw 'Android client build failed.' }

if (-not $HasPreviousWindows) {
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

Write-Host 'Building Windows incremental package...'
& (Join-Path $PSScriptRoot 'build-client-updates.ps1') @UpdateArguments
if (-not $?) { throw 'Client incremental package build failed.' }

Write-Host 'Client release complete.' -ForegroundColor Green
