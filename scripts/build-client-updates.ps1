param(
  [Parameter(Mandatory = $true)]
  [string]$PreviousWindowsClient,
  [string]$PreviousVersion = '',
  [string]$CurrentWindowsClient = '',
  [string]$CurrentAndroidApk = '',
  [string]$OutputRoot = '',
  [string]$UpstreamMainlineVersion = '',
  [switch]$MainlineUpdate,
  [switch]$KeepExpanded
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$PackageInfo = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = [string]$PackageInfo.version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\08-客户端增量包' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$PreviousWindowsClient = [IO.Path]::GetFullPath($PreviousWindowsClient)
if (-not (Test-Path -LiteralPath $PreviousWindowsClient -PathType Container)) { throw "Previous Windows client directory was not found: $PreviousWindowsClient" }

function Get-VersionFromPath([string]$Path) {
  $Match = [regex]::Match($Path, '-v(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)')
  if ($Match.Success) { return $Match.Groups['version'].Value }
  return ''
}
if (-not $PreviousVersion) { $PreviousVersion = Get-VersionFromPath $PreviousWindowsClient }
if (-not $PreviousVersion) { throw 'Unable to infer the previous version. Pass -PreviousVersion explicitly.' }

function Get-ReleaseVersion([string]$Value) {
  $Match = [regex]::Match($Value, '^(?<core>\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$')
  if (-not $Match.Success) { throw "Version is not comparable: $Value" }
  return [version]$Match.Groups['core'].Value
}

function Assert-LocalVersionMatchesUpstream([string]$LocalVersion, [string]$UpstreamVersion, [switch]$RequireMainlineBaseline) {
  $UpstreamMatch = [regex]::Match($UpstreamVersion, '^\d+\.\d+\.(?<tail>\d+)$')
  if (-not $UpstreamMatch.Success) { throw "Upstream mainline version must use X.Y.Z form: $UpstreamVersion" }
  $LocalMatch = [regex]::Match($LocalVersion, '^0\.(?<mainline>\d+)\.(?<revision>\d+)(?:[-+][0-9A-Za-z.-]+)?$')
  if (-not $LocalMatch.Success) { throw "Local release version must use 0.<upstream tail>.<small revision>: $LocalVersion" }
  if ($LocalMatch.Groups['mainline'].Value -ne $UpstreamMatch.Groups['tail'].Value) {
    throw "Local version $LocalVersion does not match upstream $UpstreamVersion. Expected local form: 0.$($UpstreamMatch.Groups['tail'].Value).*"
  }
  if ($RequireMainlineBaseline -and $LocalMatch.Groups['revision'].Value -ne '0') {
    throw "A mainline release based on upstream $UpstreamVersion must start at 0.$($UpstreamMatch.Groups['tail'].Value).0; small releases increment only the final number."
  }
}

$PreviousRelease = Get-ReleaseVersion $PreviousVersion
$CurrentRelease = Get-ReleaseVersion $Version
if ($CurrentRelease -le $PreviousRelease) { throw "Current version $Version must be newer than base version $PreviousVersion." }
if (-not $UpstreamMainlineVersion) { throw 'Every incremental release requires -UpstreamMainlineVersion.' }
Assert-LocalVersionMatchesUpstream $Version $UpstreamMainlineVersion -RequireMainlineBaseline:$MainlineUpdate
$UpdateKind = if ($MainlineUpdate) { 'mainline' } else { 'minor' }
$Channel = if ($MainlineUpdate) { '02-主线版本更新' } else { '01-小版本更新' }
$OutputRoot = Join-Path $OutputRoot $Channel

if (-not $CurrentWindowsClient) { $CurrentWindowsClient = Join-Path $WorkspaceRoot "enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-v$Version-win-x64" }
if (-not $CurrentAndroidApk) { $CurrentAndroidApk = Join-Path $WorkspaceRoot "enhanced-client-servers\03-Android客户端\Stronghold-Protocol-Client-v$Version-android-debug.apk" }
$CurrentWindowsClient = [IO.Path]::GetFullPath($CurrentWindowsClient)
$CurrentAndroidApk = [IO.Path]::GetFullPath($CurrentAndroidApk)
if (-not (Test-Path -LiteralPath $CurrentWindowsClient -PathType Container)) { throw "Build the current Windows client first: $CurrentWindowsClient" }
if (-not (Test-Path -LiteralPath $CurrentAndroidApk -PathType Leaf)) { throw "Build the current Android client first: $CurrentAndroidApk" }

$WindowsName = "Stronghold-Protocol-Client-v$PreviousVersion-to-v$Version-windows-update"
$WindowsDir = Join-Path $OutputRoot $WindowsName
$WindowsZip = Join-Path $OutputRoot "$WindowsName.zip"
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
foreach ($Path in @($WindowsDir, $WindowsZip)) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

Write-Host "Building Windows incremental package: $PreviousVersion -> $Version"
& node (Join-Path $ProjectRoot 'tools\clientDelta.mjs') windows --from $PreviousWindowsClient --to $CurrentWindowsClient --out $WindowsDir --from-version $PreviousVersion --to-version $Version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Windows delta generator failed with exit code $LASTEXITCODE" }
$UpdateClient = Join-Path $WindowsDir 'Stronghold Protocol Update Client.exe'
& (Join-Path $ProjectRoot 'scripts\build-windows-update-client.ps1') -OutputPath $UpdateClient
if ($LASTEXITCODE -ne 0) { throw "Windows update client build failed with exit code $LASTEXITCODE" }
@"
# Windows client incremental update

This package updates Stronghold Protocol Client from $PreviousVersion to $Version.

1. Exit **Stronghold Protocol Client** completely.
2. Extract this ZIP to a temporary directory.
3. Double-click **Stronghold Protocol Update Client.exe**.
4. Choose the existing `Stronghold-Protocol-Client-v$PreviousVersion-win-x64` folder and confirm the update.

The update client checks every base and target file by SHA-256. It refuses a mismatched or incomplete client.
Keep the full client ZIP as a recovery option; this update package cannot downgrade or repair an unknown installation.
"@ | Set-Content -LiteralPath (Join-Path $WindowsDir 'README.md') -Encoding utf8

Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $WindowsDir -Force | Select-Object -ExpandProperty FullName) -DestinationPath $WindowsZip -CompressionLevel Optimal

$Release = [ordered]@{
  format = 'stronghold-client-release-v3'
  updateKind = $UpdateKind
  upstreamMainlineVersion = $UpstreamMainlineVersion
  fromVersion = $PreviousVersion
  toVersion = $Version
  windows = [ordered]@{ full = $CurrentWindowsClient; update = $WindowsZip; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $WindowsZip).Hash }
  android = [ordered]@{ full = $CurrentAndroidApk; apkSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $CurrentAndroidApk).Hash }
}
$ReleasePath = Join-Path $OutputRoot "Stronghold-Protocol-Client-v$PreviousVersion-to-v$Version-update-manifest.json"
$Release | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReleasePath -Encoding utf8

if (-not $KeepExpanded) {
  Remove-Item -LiteralPath $WindowsDir -Recurse -Force
}
Write-Host "Windows incremental package ready:" -ForegroundColor Green
Write-Host "  Windows update: $WindowsZip"
Write-Host "  Android full APK: $CurrentAndroidApk"
Write-Host "  Manifest: $ReleasePath"

if ($MainlineUpdate) {
  # A mainline update is deliberately based on the previous mainline full package, not the
  # immediately preceding small release. Only now that both update ZIPs and their manifest exist
  # do we remove full packages in the covered interval. The two mainline endpoints stay intact.
  $WindowsRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\02-Windows客户端'
  $AndroidRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\03-Android客户端'
  $Removed = [System.Collections.Generic.List[object]]::new()
  function Remove-IntermediateFullPackages([string]$Root, [string]$Pattern, [string]$Platform) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    foreach ($Item in Get-ChildItem -LiteralPath $Root -Force) {
      $Match = [regex]::Match($Item.Name, $Pattern)
      if (-not $Match.Success) { continue }
      $Candidate = Get-ReleaseVersion $Match.Groups['version'].Value
      if ($Candidate -le $PreviousRelease -or $Candidate -ge $CurrentRelease) { continue }
      Remove-Item -LiteralPath $Item.FullName -Recurse -Force
      $Removed.Add([ordered]@{ platform = $Platform; version = $Match.Groups['version'].Value; path = $Item.FullName })
    }
  }
  Remove-IntermediateFullPackages $WindowsRoot '^Stronghold-Protocol-Client-v(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-win-x64(?:\.zip)?$' 'windows'
  Remove-IntermediateFullPackages $AndroidRoot '^Stronghold-Protocol-Client-v(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-android-debug\.apk$' 'android'
  $CleanupPath = Join-Path $OutputRoot "Stronghold-Protocol-Client-v$PreviousVersion-to-v$Version-full-package-cleanup.json"
  [ordered]@{
    format = 'stronghold-client-mainline-cleanup-v1'
    fromVersion = $PreviousVersion
    toVersion = $Version
    removed = @($Removed)
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $CleanupPath -Encoding utf8
  if ($Removed.Count) {
    Write-Host "Removed $($Removed.Count) intermediate full client package(s)." -ForegroundColor Yellow
  } else {
    Write-Host 'No intermediate full client packages required cleanup.'
  }
  Write-Host "  Cleanup record: $CleanupPath"
}
