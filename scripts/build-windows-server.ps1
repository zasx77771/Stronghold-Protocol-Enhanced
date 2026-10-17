param(
  [string]$NodeExe = '',
  [string]$OutputRoot = '',
  [string]$ArtifactSuffix = '',
  [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$PackageInfo = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = [string]$PackageInfo.version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
$ArtifactName = "Stronghold-Protocol-Server-v$Version-win-x64"
if ($ArtifactSuffix) {
  if ($ArtifactSuffix -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "Invalid ArtifactSuffix: $ArtifactSuffix" }
  $ArtifactName += "-$ArtifactSuffix"
}
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\04-Windows服务端' }
$DistRoot = [IO.Path]::GetFullPath($OutputRoot)
$OutputDir = [IO.Path]::GetFullPath((Join-Path $DistRoot $ArtifactName))

if (-not $OutputDir.StartsWith($DistRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe output path: $OutputDir"
}

if (-not $NodeExe) {
  $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($NodeCommand) { $NodeExe = $NodeCommand.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  throw 'node.exe not found. Pass its full path with -NodeExe.'
}
$NodeExe = [IO.Path]::GetFullPath($NodeExe)

New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null
if (Test-Path -LiteralPath $OutputDir) {
  $ResolvedOutput = [IO.Path]::GetFullPath($OutputDir)
  if (-not $ResolvedOutput.StartsWith($DistRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unsafe output path: $ResolvedOutput"
  }
  Remove-Item -LiteralPath $ResolvedOutput -Recurse -Force
}

$DataTarget = Join-Path $OutputDir 'data'
$ModulesTarget = Join-Path $OutputDir 'node_modules'
$ToolsAssetsTarget = Join-Path $OutputDir 'tools/assets'
New-Item -ItemType Directory -Force -Path $OutputDir, $DataTarget, $ModulesTarget, $ToolsAssetsTarget | Out-Null

Write-Host 'Copying network server and private rule data...'
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'server') -Destination (Join-Path $OutputDir 'server') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'shared') -Destination (Join-Path $OutputDir 'shared') -Recurse -Force
foreach ($Tool in @('skel.mjs', 'anim-roles.mjs', 'atlas.mjs')) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "tools/assets/$Tool") -Destination $ToolsAssetsTarget -Force
}

function Copy-NodePackageClosure([string[]]$Roots) {
  $Pending = [Collections.Generic.Queue[string]]::new()
  $Copied = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($Root in $Roots) { $Pending.Enqueue($Root) }

  while ($Pending.Count) {
    $Name = $Pending.Dequeue()
    if (-not $Copied.Add($Name)) { continue }
    $Source = Join-Path $ProjectRoot "node_modules/$Name"
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
      throw "Portable server dependency was not found: $Source"
    }
    $Destination = Join-Path $ModulesTarget $Name
    $DestinationParent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $DestinationParent | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force

    $ManifestPath = Join-Path $Source 'package.json'
    $Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
    foreach ($Field in @('dependencies', 'optionalDependencies', 'peerDependencies')) {
      $Entries = $Manifest.$Field
      if (-not $Entries) { continue }
      foreach ($Property in $Entries.PSObject.Properties) {
        $Optional = $Manifest.peerDependenciesMeta.$($Property.Name).optional
        if ($Field -eq 'peerDependencies' -and $Optional -eq $true) { continue }
        $Pending.Enqueue($Property.Name)
      }
    }
  }
}

Copy-NodePackageClosure @('ws', '@pixi-spine/runtime-3.8')
$ServerDataFiles = @(
  'bands.json', 'bonds.json', 'bosses.json', 'chess.json', 'choices.json', 'config.json',
  'effects.json', 'enemies.json', 'factions.json', 'garrisons.json', 'items.json',
  'stages.json', 'tokens.json', 'tuning.json', 'waves.json'
)
foreach ($File in $ServerDataFiles) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "data\$File") -Destination $DataTarget
}

Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $OutputDir 'node.exe')
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'server-portable') -File |
  Copy-Item -Destination $OutputDir -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'LICENSE') -Destination $OutputDir
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'NOTICE.md') -Destination $OutputDir
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'THIRD-PARTY-NOTICES.md') -Destination $OutputDir

foreach ($Forbidden in @('public', 'assets', 'fonts')) {
  if (Test-Path -LiteralPath (Join-Path $OutputDir $Forbidden)) {
    throw "Client resource directory leaked into server package: $Forbidden"
  }
}
foreach ($ForbiddenFile in @('assets.json', 'local-assets.json', 'emotes.json')) {
  if (Test-Path -LiteralPath (Join-Path $DataTarget $ForbiddenFile)) {
    throw "Client-only data leaked into server package: $ForbiddenFile"
  }
}

if (-not $NoArchive) {
  $Archive = Join-Path $DistRoot "$ArtifactName.zip"
  if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
  Write-Host 'Creating portable server ZIP...'
  Compress-Archive -LiteralPath $OutputDir -DestinationPath $Archive -CompressionLevel Optimal
  Write-Host "Portable archive: $Archive"
}

$Bytes = (Get-ChildItem -LiteralPath $OutputDir -File -Recurse | Measure-Object Length -Sum).Sum
Write-Host ("Windows portable server ready: {0} ({1:N1} MiB)" -f $OutputDir, ($Bytes / 1MB))
