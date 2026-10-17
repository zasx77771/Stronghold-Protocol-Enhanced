param(
  [Parameter(Mandatory = $true)]
  [string]$BaseApk,
  [string]$OutputApk = '',
  [string]$PackageDir = $PSScriptRoot,
  [string]$Adb = ''
)

$ErrorActionPreference = 'Stop'

function Read-Exactly([IO.BinaryReader]$Reader, [int]$Count) {
  $Bytes = $Reader.ReadBytes($Count)
  if ($Bytes.Length -ne $Count) { throw 'Unexpected end of Android update payload.' }
  return ,$Bytes
}
function Read-U32BE([IO.BinaryReader]$Reader) {
  $Bytes = Read-Exactly $Reader 4
  [Array]::Reverse($Bytes)
  return [BitConverter]::ToUInt32($Bytes, 0)
}
function Read-U64BE([IO.BinaryReader]$Reader) {
  $Bytes = Read-Exactly $Reader 8
  [Array]::Reverse($Bytes)
  return [BitConverter]::ToUInt64($Bytes, 0)
}
function Copy-ReaderBytes([IO.BinaryReader]$Reader, [IO.FileStream]$Writer, [UInt64]$Count) {
  $Buffer = New-Object byte[] 1048576
  while ($Count -gt 0) {
    $Take = [Math]::Min([UInt64]$Buffer.Length, $Count)
    $Bytes = Read-Exactly $Reader ([int]$Take)
    $Writer.Write($Bytes, 0, $Bytes.Length)
    $Count -= [UInt64]$Bytes.Length
  }
}
function Copy-BaseBytes([IO.FileStream]$Base, [IO.FileStream]$Writer, [UInt64]$Offset, [UInt64]$Count) {
  if ($Offset + $Count -gt [UInt64]$Base.Length) { throw 'Android update copy range exceeds the base APK.' }
  $Buffer = New-Object byte[] 1048576
  $Base.Position = [Int64]$Offset
  while ($Count -gt 0) {
    $Take = [Math]::Min([UInt64]$Buffer.Length, $Count)
    $Read = $Base.Read($Buffer, 0, [int]$Take)
    if ($Read -ne $Take) { throw 'Unable to read the base APK.' }
    $Writer.Write($Buffer, 0, $Read)
    $Count -= [UInt64]$Read
  }
}

$BaseApk = [IO.Path]::GetFullPath($BaseApk)
$PackageDir = [IO.Path]::GetFullPath($PackageDir)
$Manifest = Get-Content -Raw -LiteralPath (Join-Path $PackageDir 'update.json') | ConvertFrom-Json
if ($Manifest.format -ne 'stronghold-android-update-v1') { throw 'Unsupported Android update package.' }
if (-not $OutputApk) { $OutputApk = Join-Path (Split-Path -Parent $BaseApk) ("Stronghold-Protocol-Client-v{0}-android-debug.apk" -f $Manifest.to.version) }
$OutputApk = [IO.Path]::GetFullPath($OutputApk)
$PatchPath = Join-Path $PackageDir $Manifest.patch.file
if (-not (Test-Path -LiteralPath $BaseApk -PathType Leaf)) { throw "Base APK was not found: $BaseApk" }
if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { throw "Android delta was not found: $PatchPath" }

$BaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BaseApk).Hash.ToLowerInvariant()
if ($BaseHash -ne $Manifest.from.apkSha256.ToLowerInvariant()) { throw "The selected APK is not version $($Manifest.from.version)." }

$Temporary = "$OutputApk.partial"
Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
$PatchStream = [IO.File]::OpenRead($PatchPath)
$Reader = [IO.BinaryReader]::new($PatchStream)
$BaseStream = [IO.File]::OpenRead($BaseApk)
$Writer = [IO.File]::Open($Temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
  $Magic = [Text.Encoding]::ASCII.GetString((Read-Exactly $Reader 8))
  if ($Magic -ne 'SPDELTA1') { throw 'Invalid Android update payload.' }
  if ((Read-U32BE $Reader) -ne 1) { throw 'Unsupported Android update payload version.' }
  $BlockBytes = Read-U32BE $Reader
  if ($BlockBytes -lt 1) { throw 'Invalid Android update block size.' }
  $ExpectedBase = [Convert]::ToHexString((Read-Exactly $Reader 32)).ToLowerInvariant()
  $ExpectedTarget = [Convert]::ToHexString((Read-Exactly $Reader 32)).ToLowerInvariant()
  $ExpectedBaseBytes = Read-U64BE $Reader
  $ExpectedTargetBytes = Read-U64BE $Reader
  if ($ExpectedBase -ne $BaseHash -or [UInt64]$BaseStream.Length -ne $ExpectedBaseBytes) { throw 'The Android update does not match this base APK.' }
  [UInt64]$Written = 0
  while ($true) {
    $Op = $Reader.ReadByte()
    if ($Op -eq 255) { break }
    if ($Op -eq 0) {
      $Count = [UInt64](Read-U32BE $Reader)
      Copy-ReaderBytes $Reader $Writer $Count
      $Written += $Count
    } elseif ($Op -eq 1) {
      $Offset = Read-U64BE $Reader
      $Count = [UInt64](Read-U32BE $Reader)
      Copy-BaseBytes $BaseStream $Writer $Offset $Count
      $Written += $Count
    } else { throw "Unknown Android update operation: $Op" }
  }
  if ($Written -ne $ExpectedTargetBytes) { throw 'Android update produced an unexpected APK length.' }
} finally {
  $Writer.Dispose()
  $BaseStream.Dispose()
  $Reader.Dispose()
}

$OutputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Temporary).Hash.ToLowerInvariant()
if ($OutputHash -ne $Manifest.to.apkSha256.ToLowerInvariant()) {
  Remove-Item -LiteralPath $Temporary -Force
  throw 'Android update hash verification failed.'
}
Move-Item -LiteralPath $Temporary -Destination $OutputApk -Force
Write-Host "Android APK reconstructed: $OutputApk" -ForegroundColor Green
if ($Adb) {
  & $Adb install -r $OutputApk
  if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE" }
}
