param(
  [Parameter(Mandatory = $true)]
  [string]$TargetDir,
  [string]$PackageDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

function Get-SafePath([string]$Root, [string]$Relative) {
  $Normalized = $Relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($Normalized) -or [IO.Path]::IsPathRooted($Normalized) -or $Normalized.Split([IO.Path]::DirectorySeparatorChar) -contains '..') {
    throw "Unsafe update path: $Relative"
  }
  $Base = [IO.Path]::GetFullPath($Root)
  $Path = [IO.Path]::GetFullPath((Join-Path $Base $Normalized))
  if (-not $Path.StartsWith($Base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Update path escapes the client directory: $Relative"
  }
  return $Path
}

function Test-FileSet($Root, $Files, [string]$Label) {
  foreach ($File in $Files) {
    $Path = Get-SafePath $Root $File.path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing $($File.path)" }
    $Item = Get-Item -LiteralPath $Path
    if ([int64]$Item.Length -ne [int64]$File.size) { throw "$Label has an unexpected size: $($File.path)" }
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($Hash -ne $File.sha256.ToLowerInvariant()) { throw "$Label has an unexpected hash: $($File.path)" }
  }
}
function Test-NoUnexpectedFiles($Root, $Files, [string]$Label) {
  $Expected = @{}
  foreach ($File in $Files) { $Expected[$File.path.Replace('/', '\\')] = $true }
  $Base = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  foreach ($Item in Get-ChildItem -LiteralPath $Root -File -Recurse) {
    $Relative = $Item.FullName.Substring($Base.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (-not $Expected.ContainsKey($Relative)) { throw "$Label contains an unexpected file: $Relative" }
  }
}

$TargetDir = [IO.Path]::GetFullPath($TargetDir)
$PackageDir = [IO.Path]::GetFullPath($PackageDir)
$ManifestPath = Join-Path $PackageDir 'update.json'
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "update.json was not found in $PackageDir" }
$Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
if ($Manifest.format -ne 'stronghold-windows-update-v1') { throw 'Unsupported Windows update package.' }
if (-not (Test-Path -LiteralPath $TargetDir -PathType Container)) { throw "Client directory was not found: $TargetDir" }

Write-Host "Verifying Windows client $($Manifest.from.version)..."
Test-FileSet $TargetDir $Manifest.baseFiles 'Base client'
Test-NoUnexpectedFiles $TargetDir $Manifest.baseFiles 'Base client'

foreach ($Relative in $Manifest.removed) {
  $Path = Get-SafePath $TargetDir $Relative
  if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path -Force }
}
foreach ($File in $Manifest.changed) {
  $Source = Get-SafePath (Join-Path $PackageDir 'files') $File.path
  $Destination = Get-SafePath $TargetDir $File.path
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Update payload is missing $($File.path)" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

Write-Host "Verifying Windows client $($Manifest.to.version)..."
Test-FileSet $TargetDir $Manifest.targetFiles 'Updated client'
Test-NoUnexpectedFiles $TargetDir $Manifest.targetFiles 'Updated client'
Write-Host "Windows client update complete: $($Manifest.from.version) -> $($Manifest.to.version)" -ForegroundColor Green
