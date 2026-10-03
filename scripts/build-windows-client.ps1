param(
  [string]$ElectronVersion = '44.5.1',
  [string]$ElectronZip = '',
  [string]$OutputRoot = '',
  [string]$CacheDir = '',
  [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$PackageInfo = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = [string]$PackageInfo.version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
$ArtifactName = "Stronghold-Protocol-Client-v$Version-win-x64"
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkspaceRoot '成果文件\02-Windows客户端' }
$DistRoot = [IO.Path]::GetFullPath($OutputRoot)
$OutputDir = [IO.Path]::GetFullPath((Join-Path $DistRoot $ArtifactName))
if (-not $CacheDir) { $CacheDir = Join-Path $WorkspaceRoot '成果文件\06-构建环境与缓存\electron-download-cache' }
$CacheDir = [IO.Path]::GetFullPath($CacheDir)

if (-not $OutputDir.StartsWith($DistRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe output path: $OutputDir"
}

New-Item -ItemType Directory -Force -Path $DistRoot, $CacheDir | Out-Null
if (-not $ElectronZip) {
  $ElectronZip = Join-Path $CacheDir "electron-v$ElectronVersion-win32-x64.zip"
}
$ElectronZip = [IO.Path]::GetFullPath($ElectronZip)

if (-not (Test-Path -LiteralPath $ElectronZip -PathType Leaf)) {
  $BaseUrl = "https://github.com/electron/electron/releases/download/v$ElectronVersion"
  Write-Host "Downloading Electron $ElectronVersion..."
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/electron-v$ElectronVersion-win32-x64.zip" -OutFile $ElectronZip
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHASUMS256.txt" -OutFile (Join-Path $CacheDir "SHASUMS256-v$ElectronVersion.txt")
}

$ShaFile = Join-Path $CacheDir "SHASUMS256-v$ElectronVersion.txt"
if (Test-Path -LiteralPath $ShaFile) {
  $ZipName = [IO.Path]::GetFileName($ElectronZip)
  $ExpectedLine = Get-Content -LiteralPath $ShaFile | Where-Object { $_ -match "\s+\*?$([regex]::Escape($ZipName))$" } | Select-Object -First 1
  if (-not $ExpectedLine) { throw "Electron checksum entry not found for $ZipName" }
  $Expected = ($ExpectedLine -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $ElectronZip).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "Electron archive checksum mismatch" }
}

if (Test-Path -LiteralPath $OutputDir) {
  $ResolvedOutput = [IO.Path]::GetFullPath($OutputDir)
  if (-not $ResolvedOutput.StartsWith($DistRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unsafe output path: $ResolvedOutput"
  }
  Remove-Item -LiteralPath $ResolvedOutput -Recurse -Force
}

Write-Host 'Extracting desktop runtime...'
Expand-Archive -LiteralPath $ElectronZip -DestinationPath $OutputDir -Force
$OriginalExe = Join-Path $OutputDir 'electron.exe'
$ClientExe = Join-Path $OutputDir 'Stronghold Protocol Client.exe'
Move-Item -LiteralPath $OriginalExe -Destination $ClientExe

$AppDir = Join-Path $OutputDir 'resources\app'
$ClientDir = Join-Path $AppDir 'client'
New-Item -ItemType Directory -Force -Path $AppDir, $ClientDir | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\main.cjs') -Destination $AppDir
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\preload.cjs') -Destination $AppDir
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\package.json') -Destination $AppDir

Write-Host 'Copying local client code and resources...'
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'public') -Force |
  Where-Object { $_.Name -ne 'dev' } |
  Copy-Item -Destination $ClientDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data') -Destination (Join-Path $ClientDir 'data') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'shared') -Destination (Join-Path $ClientDir 'shared') -Recurse -Force

$SimTarget = Join-Path $ClientDir 'sim'
New-Item -ItemType Directory -Force -Path $SimTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'server\sim') -Force |
  Where-Object { $_.Name -ne 'nodeData.js' } |
  Copy-Item -Destination $SimTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\data.js') -Destination (Join-Path $ClientDir 'data.js')

Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\README-Windows.txt') -Destination $OutputDir
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'NOTICE.md') -Destination $OutputDir
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'THIRD-PARTY-NOTICES.md') -Destination $OutputDir

if (-not $NoArchive) {
  $Archive = Join-Path $DistRoot "$ArtifactName.zip"
  if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
  Write-Host 'Creating portable ZIP (this may take several minutes)...'
  Compress-Archive -LiteralPath $OutputDir -DestinationPath $Archive -CompressionLevel Optimal
  Write-Host "Portable archive: $Archive"
}

$Bytes = (Get-ChildItem -LiteralPath $OutputDir -File -Recurse | Measure-Object Length -Sum).Sum
Write-Host ("Windows portable client ready: {0} ({1:N1} MiB)" -f $OutputDir, ($Bytes / 1MB))
