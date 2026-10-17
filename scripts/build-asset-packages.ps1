param(
  [string]$Version = '',
  [string]$CurrentAssetDir = '',
  [string]$PreviousAssetDir = '',
  [string]$PreviousVersion = '',
  [string]$OutputRoot = '',
  [string]$AssetCacheRoot = '',
  [int]$MaxChain = 3,
  [switch]$MainlineUpdate,
  [string]$IndexBaseUrl = '',
  [switch]$SkipUploadPlan,
  [switch]$UploadAssets,
  [string]$R2Endpoint = '',
  [string]$R2Bucket = 'stronghold-protocol',
  [string]$R2Prefix = 'runtime-assets',
  [switch]$PassThru
)

# Builds the runtime asset packages of one release and refreshes the release index.
#
# The Android client updates its art from R2 through `assets-index.json`: a baseline ZIP
# (`assets-base-<version>.zip`) for a fresh install, a repair or a version jump, and a delta ZIP
# (`assets-delta-<from>-<to>.zip`) for the usual release. `tools\assets-r2.mjs release` decides which
# packages this release needs, refuses to replace an already published package and rewrites the index.
#
# The asset tree of the current version is the Android embedded asset root when it exists, because that
# is exactly what the APK ships and what its stamped `asset-state.json` describes. The previous version is
# read from its full client directory, whose `public/assets`, `public/fonts` and `data/assets.json` are the
# same bytes the previous APK embedded. Nothing inside a released directory is ever written to.
#
# This script prints the `aws s3 cp` commands an operator runs with their own R2 credentials. It never
# stores or prints credentials, and it never uploads anything itself.

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$AssetsCli = Join-Path $ProjectRoot 'tools\assets-r2.mjs'

if (-not $Version) {
  $PackageInfo = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
  $Version = [string]$PackageInfo.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
if ($MainlineUpdate -and -not $PreviousVersion) { throw 'A mainline release needs -PreviousVersion to describe the delta it replaces.' }
if ($MaxChain -lt 1) { throw "-MaxChain must be a positive integer (got $MaxChain)." }

if (-not $AssetCacheRoot) { $AssetCacheRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\06-构建环境与缓存' }
$AssetCacheRoot = [IO.Path]::GetFullPath($AssetCacheRoot)
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkspaceRoot 'enhanced-client-servers\08-客户端增量包' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if ($MainlineUpdate) { $OutputRoot = Join-Path $OutputRoot '02-主线版本更新' } else { $OutputRoot = Join-Path $OutputRoot '01-小版本更新' }

if (-not $CurrentAssetDir) {
  $EmbeddedAssets = Join-Path $AssetCacheRoot 'android-embedded-assets'
  if (Test-Path -LiteralPath (Join-Path $EmbeddedAssets 'data\assets.json') -PathType Leaf) {
    $CurrentAssetDir = $EmbeddedAssets
  } else {
    $CurrentAssetDir = Join-Path $WorkspaceRoot "enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-v$Version-win-x64"
  }
} else {
  $CurrentAssetDir = [IO.Path]::GetFullPath($CurrentAssetDir)
}
if (-not (Test-Path -LiteralPath $CurrentAssetDir -PathType Container)) {
  throw "The current asset tree was not found: $CurrentAssetDir (build the client first or pass -CurrentAssetDir)."
}

if (-not $PreviousAssetDir -and $PreviousVersion) {
  $PreviousAssetDir = Join-Path $WorkspaceRoot "enhanced-client-servers\02-Windows客户端\Stronghold-Protocol-Client-v$PreviousVersion-win-x64"
}
if ($PreviousAssetDir) {
  $PreviousAssetDir = [IO.Path]::GetFullPath($PreviousAssetDir)
  $PreviousAssetTree = Join-Path $PreviousAssetDir 'public\assets'
  if (-not (Test-Path -LiteralPath $PreviousAssetTree -PathType Container)) { $PreviousAssetTree = Join-Path $PreviousAssetDir 'assets' }
  if (-not (Test-Path -LiteralPath $PreviousAssetTree -PathType Container)) {
    Write-Host "No previous asset tree under $PreviousAssetDir; publishing a baseline only." -ForegroundColor Yellow
    $PreviousAssetDir = ''
  }
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
Write-Host "Building runtime asset packages for $Version"
Write-Host "  current tree:  $CurrentAssetDir"
if ($PreviousAssetDir) { Write-Host "  previous tree: $PreviousAssetDir" } else { Write-Host '  previous tree: (none, this release publishes a baseline)' }

$Scratch = Join-Path ([IO.Path]::GetTempPath()) ("sp-asset-$Version-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
try {
  $StateText = & node $AssetsCli state --root $CurrentAssetDir --version $Version --out $Scratch | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Unable to read the asset inventory of $CurrentAssetDir" }
  $State = $StateText | ConvertFrom-Json
  Write-Host ("  asset set: {0} files, {1:N1} MiB, inventory {2}" -f $State.count, ($State.bytes / 1MB), $State.inventory)

  $ReleaseArguments = @($AssetsCli, 'release', '--dir', $OutputRoot, '--version', $Version, '--after', $CurrentAssetDir, '--max-chain', [string]$MaxChain)
  if ($PreviousAssetDir) { $ReleaseArguments += @('--from', $PreviousVersion, '--before', $PreviousAssetDir) }
  if ($MainlineUpdate) { $ReleaseArguments += '--mainline' }
  $ReleaseText = & node @ReleaseArguments | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'The asset package release failed.' }
  $Release = $ReleaseText | ConvertFrom-Json
} finally {
  if (Test-Path -LiteralPath $Scratch) { Remove-Item -LiteralPath $Scratch -Force }
}

foreach ($Note in $Release.notes) { Write-Host "  note: $Note" -ForegroundColor DarkGray }
if ($Release.base) { Write-Host ("  baseline: {0} ({1:N0} KiB)" -f $Release.base.name, ($Release.base.size / 1KB)) }
if ($Release.delta) { Write-Host ("  delta: {0} ({1:N0} KiB)" -f $Release.delta.name, ($Release.delta.size / 1KB)) }
if ($Release.stranded.Count) { throw "These versions can no longer reach $Version : $($Release.stranded -join ', ')" }

$IndexPath = Join-Path $OutputRoot 'assets-index.json'
if (-not (Test-Path -LiteralPath $IndexPath -PathType Leaf)) { throw "The asset index was not written: $IndexPath" }
$Index = Get-Content -Raw -Encoding utf8 -LiteralPath $IndexPath | ConvertFrom-Json
if ([string]$Index.latest -ne $Version) { throw "The asset index points at $($Index.latest), not $Version." }

$Summary = [ordered]@{
  format = 'stronghold-client-assets-v1'
  version = $Version
  dir = $OutputRoot
  index = $IndexPath
  indexSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $IndexPath).Hash.ToLowerInvariant()
  latest = [string]$Index.latest
  maxChain = [int]$Index.maxChain
  inventory = [string]$State.inventory
  files = [int]$State.count
  bytes = [long]$State.bytes
  versions = @($Index.versions.PSObject.Properties).Count
  bases = @($Index.bases).Count
  deltas = @($Index.deltas).Count
  base = if ($Release.base) { [string]$Release.base.name } else { $null }
  baseSha256 = if ($Release.base) { [string]$Release.base.sha256 } else { $null }
  delta = if ($Release.delta) { [string]$Release.delta.name } else { $null }
  deltaSha256 = if ($Release.delta) { [string]$Release.delta.sha256 } else { $null }
}

Write-Host "  index: $IndexPath" -ForegroundColor Green
if (-not $SkipUploadPlan) {
  Write-Host 'Upload these files to R2 with your own credentials:' -ForegroundColor Green
  $UploadArguments = @($AssetsCli, 'upload-plan', '--dir', $OutputRoot, '--json')
  if ($IndexBaseUrl) { $UploadArguments += @('--public-base', $IndexBaseUrl) }
  $PlanText = & node @UploadArguments | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the R2 upload plan.' }
  $Plan = $PlanText | ConvertFrom-Json
  foreach ($Command in $Plan.commands) { Write-Host "  $Command" }
  if ($Plan.urls) {
    Write-Host 'Verify these public URLs after the upload:'
    foreach ($Url in $Plan.urls) { Write-Host "  $Url" }
  }
  $Summary.uploads = @($Plan.files)
}

if ($UploadAssets) {
  if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI is required for -UploadAssets.' }
  if (-not $R2Endpoint) { $R2Endpoint = [string]$env:AWS_ENDPOINT_URL }
  if (-not $R2Endpoint) { throw '-UploadAssets requires -R2Endpoint or AWS_ENDPOINT_URL.' }
  if (-not $env:AWS_ACCESS_KEY_ID -or -not $env:AWS_SECRET_ACCESS_KEY) { throw '-UploadAssets requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the operator or CI secret store.' }
  $R2Prefix = $R2Prefix.Trim('/')
  $PackageNames = @($Summary.base, $Summary.delta | Where-Object { $_ })
  foreach ($Name in $PackageNames) {
    $Local = Join-Path $OutputRoot $Name
    $Key = "$R2Prefix/$Name"
    $Head = & aws s3api head-object --bucket $R2Bucket --key $Key --endpoint-url $R2Endpoint 2>&1
    if ($LASTEXITCODE -eq 0) { throw "Refusing to replace published R2 package: $Key" }
    if (($Head | Out-String) -notmatch '(404|Not Found|NoSuchKey)') { throw "Unable to inspect R2 package ${Key}: $Head" }
    & aws s3 cp $Local "s3://$R2Bucket/$Key" --endpoint-url $R2Endpoint --content-type application/zip --cache-control 'private, max-age=31536000, immutable'
    if ($LASTEXITCODE -ne 0) { throw "R2 upload failed: $Key" }
  }
  $IndexKey = "$R2Prefix/assets-index.json"
  & aws s3 cp $IndexPath "s3://$R2Bucket/$IndexKey" --endpoint-url $R2Endpoint --content-type 'application/json' --cache-control 'private, max-age=60, must-revalidate'
  if ($LASTEXITCODE -ne 0) { throw "R2 index upload failed: $IndexKey" }
  $Summary.r2 = [ordered]@{ bucket = $R2Bucket; prefix = $R2Prefix; endpoint = $R2Endpoint; uploaded = $PackageNames + 'assets-index.json' }
  Write-Host "R2 upload complete: $R2Bucket/$R2Prefix (index published last)" -ForegroundColor Green
}
if ($PassThru) { return $Summary }
