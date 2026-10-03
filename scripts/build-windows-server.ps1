param(
  [string]$NodeExe = '',
  [string]$OutputRoot = '',
  [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkspaceRoot '成果文件\04-Windows服务端' }
$DistRoot = [IO.Path]::GetFullPath($OutputRoot)
$OutputDir = [IO.Path]::GetFullPath((Join-Path $DistRoot 'Stronghold-Protocol-Server-win-x64'))

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
New-Item -ItemType Directory -Force -Path $OutputDir, $DataTarget, $ModulesTarget | Out-Null

Write-Host 'Copying network server and private rule data...'
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'server') -Destination (Join-Path $OutputDir 'server') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'shared') -Destination (Join-Path $OutputDir 'shared') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'node_modules\ws') -Destination (Join-Path $ModulesTarget 'ws') -Recurse -Force

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
  $Archive = Join-Path $DistRoot 'Stronghold-Protocol-Server-win-x64.zip'
  if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
  Write-Host 'Creating portable server ZIP...'
  Compress-Archive -LiteralPath $OutputDir -DestinationPath $Archive -CompressionLevel Optimal
  Write-Host "Portable archive: $Archive"
}

$Bytes = (Get-ChildItem -LiteralPath $OutputDir -File -Recurse | Measure-Object Length -Sum).Sum
Write-Host ("Windows portable server ready: {0} ({1:N1} MiB)" -f $OutputDir, ($Bytes / 1MB))
