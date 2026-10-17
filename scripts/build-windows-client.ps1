# Build the packaged Windows desktop client.
#
# The client is a Tauri 2 application (src-tauri/). This script compiles it with `cargo tauri build`
# and assembles the portable payload in the same layout the release tooling has always consumed
# (`Stronghold-Protocol-Client-v<version>-win-x64`), so build-client-updates.ps1,
# build-asset-packages.ps1 and publish-client-release.ps1 keep working unchanged.
#
# There is no separate browser-engine download step and no Node runtime inside the payload any more.
# The executable is produced by Cargo; the page it serves is the same public/ tree the browser build uses.
#
# Prerequisites (documented in docs/WINDOWS.md):
#   * Rust toolchain (rustup, stable, >= 1.77) with the x86_64-pc-windows-msvc target
#   * WebView2 runtime (ships with Windows 11 and current Windows 10)
#   * cargo-tauri 2:  cargo install tauri-cli --version "^2" --locked
#   * Node.js 22+ only to generate the icons and to write a thin-client asset-config.json
#
# Output: <OutputRoot>/Stronghold-Protocol-Client-v<version>-win-x64/
#           Stronghold Protocol Client.exe   <- src-tauri/target/release/stronghold-protocol-client.exe
#           client/  data/  shared/  README-Windows.txt  NOTICE.md  THIRD-PARTY-NOTICES.md
#           <ArtifactName>.zip               <- unless -NoArchive

param(
  [string]$OutputRoot = '',
  [string]$CacheDir = '',
  [string]$AssetSourceDir = '',
  [string]$AssetIndexUrl = '',
  [string]$AssetTokenUrl = '',
  [int]$AssetMaxChain = 3,
  [switch]$AssetAllowHttp,
  [string]$ArtifactSuffix = '',
  [switch]$NoArchive,

  # Tauri build controls.
  [string]$TargetDir = '',
  [string]$CargoPath = '',
  [string]$NodePath = '',
  [switch]$SkipBundle,
  [switch]$RegenerateIcons
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$TauriRoot = Join-Path $ProjectRoot 'src-tauri'
$CargoBinaryName = 'stronghold-protocol-client.exe'

# ------------------------------------------------------------------ repository and version checks

$TauriConfigPath = Join-Path $TauriRoot 'tauri.conf.json'
if (-not (Test-Path -LiteralPath $TauriConfigPath -PathType Leaf)) {
  throw "The Tauri project is missing: $TauriConfigPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $TauriRoot 'Cargo.toml') -PathType Leaf)) {
  throw "The Tauri crate is missing: $(Join-Path $TauriRoot 'Cargo.toml')"
}
$TauriConfig = Get-Content -Raw -Encoding utf8 -LiteralPath $TauriConfigPath | ConvertFrom-Json
$ProductName = [string]$TauriConfig.productName
if (-not $ProductName) { throw 'src-tauri/tauri.conf.json must declare productName.' }
$ClientExeName = "$ProductName.exe"

$PackageInfo = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = [string]$PackageInfo.version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
if ([string]$TauriConfig.version -ne $Version) {
  throw "src-tauri/tauri.conf.json version $([string]$TauriConfig.version) must equal package.json version $Version."
}

if (-not $AssetSourceDir) { $AssetSourceDir = Join-Path $ProjectRoot 'public' }
$AssetSourceDir = [IO.Path]::GetFullPath($AssetSourceDir)
if (-not (Test-Path -LiteralPath $AssetSourceDir -PathType Container)) {
  throw "Windows asset source directory was not found: $AssetSourceDir"
}

$ArtifactName = "Stronghold-Protocol-Client-v$Version-win-x64"
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\02-Windows客户端' }
if ($ArtifactSuffix -and $ArtifactSuffix -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$') {
  throw 'ArtifactSuffix must contain only letters, digits, dot, underscore or hyphen.'
}
if ($ArtifactSuffix) { $ArtifactName = "$ArtifactName-$ArtifactSuffix" }
$DistRoot = [IO.Path]::GetFullPath($OutputRoot)
$OutputDir = [IO.Path]::GetFullPath((Join-Path $DistRoot $ArtifactName))
if (-not $OutputDir.StartsWith($DistRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe output path: $OutputDir"
}
if (-not $CacheDir) { $CacheDir = Join-Path $WorkspaceRoot 'enhanced-client-servers\06-构建环境与缓存\tauri-build-cache' }
$CacheDir = [IO.Path]::GetFullPath($CacheDir)

if (-not $TargetDir) { $TargetDir = Join-Path $TauriRoot 'target' }
$TargetDir = [IO.Path]::GetFullPath($TargetDir)
$ReleaseDir = Join-Path $TargetDir 'release'
$BuiltBinary = Join-Path $ReleaseDir $CargoBinaryName

# -------------------------------------------------------------------------------- tool discovery

function Resolve-ToolPath {
  param([string]$Explicit, [string]$Name, [string[]]$Candidates, [string]$Hint)
  if ($Explicit) {
    $Resolved = [IO.Path]::GetFullPath($Explicit)
    if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) { throw "$Name was not found at $Resolved" }
    return $Resolved
  }
  foreach ($Candidate in $Candidates) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $Candidate }
  }
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($Command) { return $Command.Source }
  throw "$Name was not found on PATH. $Hint"
}

$NodeCandidates = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
$Node = $null
if ($NodePath -or $AssetIndexUrl -or $RegenerateIcons) {
  $Node = Resolve-ToolPath -Explicit $NodePath -Name 'node' -Candidates $NodeCandidates `
    -Hint 'Node.js 22 or newer is required to generate the icons and to write the thin-client asset configuration.'
}

# ---------------------------------------------------------------------------------------- icons

if ($Node) {
  $IconsScript = Join-Path $ProjectRoot 'tools\tauri-icons.mjs'
  $NeedIcons = $true
  if (-not $RegenerateIcons) {
    & $Node $IconsScript --check | Out-Null
    $NeedIcons = $LASTEXITCODE -ne 0
  }
  if ($NeedIcons) {
    Write-Host 'Generating client icons...'
    & $Node $IconsScript --write
    if ($LASTEXITCODE -ne 0) { throw 'Unable to generate the client icons (tools/tauri-icons.mjs --write).' }
  }
}

# ---------------------------------------------------------------------------------- cargo tauri

$Cargo = Resolve-ToolPath -Explicit $CargoPath -Name 'cargo' -Candidates @(
  (Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe')
) -Hint 'Install the Rust toolchain with rustup (https://rustup.rs) and reopen the shell.'

# Fail with an actionable message instead of Cargo's "no such subcommand: tauri".
$TauriVersion = & $Cargo tauri --version 2>&1
if ($LASTEXITCODE -ne 0) {
  throw @"
cargo-tauri (Tauri CLI 2) is required to build the Windows client.
Install it once with:
  cargo install tauri-cli --version "^2" --locked
"@
}
Write-Host "Tauri CLI: $($TauriVersion -join ' ')"

$CargoArguments = @('tauri', 'build')
if ($SkipBundle) { $CargoArguments += '--no-bundle' }
if ($TargetDir) { $CargoArguments += @('--target-dir', $TargetDir) }

New-Item -ItemType Directory -Force -Path $DistRoot, $CacheDir | Out-Null
Write-Host "Building the Tauri client: $Cargo $($CargoArguments -join ' ')"
Push-Location $TauriRoot
try {
  & $Cargo @CargoArguments
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath $BuiltBinary -PathType Leaf)) {
  throw "cargo tauri build did not produce $BuiltBinary"
}

# ---------------------------------------------------------------------------- payload assembly

if (Test-Path -LiteralPath $OutputDir) {
  $ResolvedOutput = [IO.Path]::GetFullPath($OutputDir)
  if (-not $ResolvedOutput.StartsWith($DistRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unsafe output path: $ResolvedOutput"
  }
  if ($ResolvedOutput -eq $DistRoot) { throw "Refusing to remove the distribution root: $DistRoot" }
  Remove-Item -LiteralPath $ResolvedOutput -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Copy-Item -LiteralPath $BuiltBinary -Destination (Join-Path $OutputDir $ClientExeName) -Force

$ClientDir = Join-Path $OutputDir 'client'
New-Item -ItemType Directory -Force -Path $ClientDir | Out-Null

Write-Host 'Copying the local client tree...'
$ThinClient = [bool]$AssetIndexUrl
if ($ThinClient -and -not $AssetTokenUrl) { throw 'A thin Windows client requires -AssetTokenUrl.' }

Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'public') -Force |
  Where-Object { $_.Name -notin @('dev', 'assets', 'fonts') } |
  Copy-Item -Destination $ClientDir -Recurse -Force
if (-not $ThinClient) {
  foreach ($AssetDirectory in @('assets', 'fonts')) {
    $Source = Join-Path $AssetSourceDir $AssetDirectory
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
      throw "Windows full client requires $AssetDirectory under asset source: $AssetSourceDir"
    }
    Copy-Item -LiteralPath $Source -Destination (Join-Path $ClientDir $AssetDirectory) -Recurse -Force
  }
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data') -Destination (Join-Path $ClientDir 'data') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'shared') -Destination (Join-Path $ClientDir 'shared') -Recurse -Force

$SimTarget = Join-Path $ClientDir 'sim'
New-Item -ItemType Directory -Force -Path $SimTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'server\sim') -Force |
  Where-Object { $_.Name -ne 'nodeData.js' } |
  Copy-Item -Destination $SimTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\data.js') -Destination (Join-Path $ClientDir 'data.js') -Force

if ($ThinClient) {
  foreach ($RelativePath in @('data\assets.json', 'data\local-assets.json')) {
    $Target = Join-Path $ClientDir $RelativePath
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }
  }
  $ConfigArguments = @(
    (Join-Path $ProjectRoot 'tools\assets-r2.mjs'), 'config',
    '--index-url', $AssetIndexUrl,
    '--token-url', $AssetTokenUrl,
    '--out', (Join-Path $ClientDir 'asset-config.json')
  )
  if ($AssetAllowHttp) { $ConfigArguments += '--allow-http' }
  if ($AssetMaxChain -gt 0) { $ConfigArguments += @('--max-chain', [string]$AssetMaxChain) }
  & $Node @ConfigArguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to write the Windows runtime asset configuration (asset-config.json).' }
  Write-Host 'Windows thin client: runtime art is downloaded from R2 after the first successful game session.'
}

Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\README-Windows.txt') -Destination $OutputDir -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'NOTICE.md') -Destination $OutputDir -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'THIRD-PARTY-NOTICES.md') -Destination $OutputDir -Force

# The NSIS installer `cargo tauri build` produced, when it was not skipped.
if (-not $SkipBundle) {
  $NsisDir = Join-Path $ReleaseDir 'bundle\nsis'
  if (Test-Path -LiteralPath $NsisDir -PathType Container) {
    Get-ChildItem -LiteralPath $NsisDir -Filter '*.exe' -File |
      Copy-Item -Destination $OutputDir -Force
    Write-Host "Installer copied from $NsisDir"
  } else {
    Write-Warning "No NSIS installer found under $NsisDir (was -SkipBundle used, or the NSIS target unavailable?)."
  }
}

if (-not $NoArchive) {
  $Archive = Join-Path $DistRoot "$ArtifactName.zip"
  if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
  Write-Host 'Creating portable ZIP (this may take several minutes)...'
  Compress-Archive -LiteralPath $OutputDir -DestinationPath $Archive -CompressionLevel Optimal
  Write-Host "Portable archive: $Archive"
}

$Bytes = (Get-ChildItem -LiteralPath $OutputDir -File -Recurse | Measure-Object Length -Sum).Sum
Write-Host ("Windows portable client ready: {0} ({1:N1} MiB)" -f $OutputDir, ($Bytes / 1MB))
