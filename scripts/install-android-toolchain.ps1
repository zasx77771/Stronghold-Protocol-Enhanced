param(
  [string]$ToolchainDir = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
if (-not $ToolchainDir) { $ToolchainDir = Join-Path $WorkspaceRoot 'enhanced-client-servers\06-构建环境与缓存\android-toolchain' }
$ToolchainDir = [IO.Path]::GetFullPath($ToolchainDir)
$Downloads = Join-Path $ToolchainDir 'downloads'
$JdkRoot = Join-Path $ToolchainDir 'jdk-17'
$SdkRoot = Join-Path $ToolchainDir 'android-sdk'
$GradleVersion = '8.10.2'
$GradleRoot = Join-Path $ToolchainDir "gradle-$GradleVersion"

New-Item -ItemType Directory -Force -Path $ToolchainDir, $Downloads | Out-Null

function Get-VerifiedDownload {
  param([string]$Uri, [string]$Destination, [string]$Sha256)
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $Current = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
    if ($Current -eq $Sha256.ToLowerInvariant()) {
      Write-Host "Using cached $([IO.Path]::GetFileName($Destination))"
      return
    }
    Remove-Item -LiteralPath $Destination -Force
  }
  Write-Host "Downloading $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
  if ($Actual -ne $Sha256.ToLowerInvariant()) {
    Remove-Item -LiteralPath $Destination -Force
    throw "Checksum mismatch for $Destination"
  }
}

function Reset-ToolDirectory {
  param([string]$Path)
  $Resolved = [IO.Path]::GetFullPath($Path)
  if (-not $Resolved.StartsWith($ToolchainDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe toolchain directory: $Resolved"
  }
  if (Test-Path -LiteralPath $Resolved) { Remove-Item -LiteralPath $Resolved -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Resolved | Out-Null
}

# Eclipse Temurin JDK 17: obtain both the binary URL and checksum from Adoptium's official API.
if (-not (Test-Path -LiteralPath (Join-Path $JdkRoot 'bin\java.exe') -PathType Leaf)) {
  Write-Host 'Resolving the latest Temurin JDK 17...'
  $JdkAssets = Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse'
  $JdkPackage = $JdkAssets | Select-Object -First 1 -ExpandProperty binary | Select-Object -ExpandProperty package
  if (-not $JdkPackage.link -or -not $JdkPackage.checksum) { throw 'Adoptium API did not return a JDK package' }
  $JdkZip = Join-Path $Downloads 'temurin-jdk17-win-x64.zip'
  Get-VerifiedDownload -Uri $JdkPackage.link -Destination $JdkZip -Sha256 $JdkPackage.checksum
  $JdkStage = Join-Path $ToolchainDir '_jdk-stage'
  Reset-ToolDirectory $JdkStage
  Expand-Archive -LiteralPath $JdkZip -DestinationPath $JdkStage -Force
  $JdkExtracted = Get-ChildItem -LiteralPath $JdkStage -Directory | Select-Object -First 1
  if (-not $JdkExtracted) { throw 'JDK archive was empty' }
  Reset-ToolDirectory $JdkRoot
  Get-ChildItem -LiteralPath $JdkExtracted.FullName -Force | Move-Item -Destination $JdkRoot -Force
  Remove-Item -LiteralPath $JdkStage -Recurse -Force
}

$env:JAVA_HOME = $JdkRoot
$env:Path = (Join-Path $JdkRoot 'bin') + [IO.Path]::PathSeparator + $env:Path

# Android command-line tools. The checksum is published beside the current Windows download.
$CmdVersion = '15859902'
$CmdZip = Join-Path $Downloads "commandlinetools-win-$CmdVersion.zip"
$CmdUri = "https://dl.google.com/android/repository/commandlinetools-win-${CmdVersion}_latest.zip"
$CmdSha = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
$SdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path -LiteralPath $SdkManager -PathType Leaf)) {
  Get-VerifiedDownload -Uri $CmdUri -Destination $CmdZip -Sha256 $CmdSha
  $CmdStage = Join-Path $ToolchainDir '_cmdline-stage'
  Reset-ToolDirectory $CmdStage
  Expand-Archive -LiteralPath $CmdZip -DestinationPath $CmdStage -Force
  $Latest = Join-Path $SdkRoot 'cmdline-tools\latest'
  Reset-ToolDirectory $Latest
  Get-ChildItem -LiteralPath (Join-Path $CmdStage 'cmdline-tools') -Force | Move-Item -Destination $Latest -Force
  Remove-Item -LiteralPath $CmdStage -Recurse -Force
}

# Gradle distribution pinned to the Android Gradle Plugin compatibility table.
$GradleZip = Join-Path $Downloads "gradle-$GradleVersion-bin.zip"
$GradleUri = "https://downloads.gradle.org/distributions/gradle-$GradleVersion-bin.zip"
$GradleShaUri = "$GradleUri.sha256"
if (-not (Test-Path -LiteralPath (Join-Path $GradleRoot 'bin\gradle.bat') -PathType Leaf)) {
  $GradleShaResponse = Invoke-WebRequest -UseBasicParsing -Uri $GradleShaUri
  $GradleShaContent = $GradleShaResponse.Content
  if ($GradleShaContent -is [byte[]]) {
    $GradleShaContent = [Text.Encoding]::UTF8.GetString($GradleShaContent)
  }
  $GradleSha = ([string]$GradleShaContent).Trim()
  if ($GradleSha -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid Gradle checksum response' }
  Get-VerifiedDownload -Uri $GradleUri -Destination $GradleZip -Sha256 $GradleSha
  $GradleStage = Join-Path $ToolchainDir '_gradle-stage'
  Reset-ToolDirectory $GradleStage
  Expand-Archive -LiteralPath $GradleZip -DestinationPath $GradleStage -Force
  $GradleExtracted = Join-Path $GradleStage "gradle-$GradleVersion"
  Reset-ToolDirectory $GradleRoot
  Get-ChildItem -LiteralPath $GradleExtracted -Force | Move-Item -Destination $GradleRoot -Force
  Remove-Item -LiteralPath $GradleStage -Recurse -Force
}

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
Write-Host 'Accepting Android SDK licenses required for this build...'
1..25 | ForEach-Object { 'y' } | & $SdkManager "--sdk_root=$SdkRoot" --licenses | Out-Host

Write-Host 'Installing Android platform and build tools...'
& $SdkManager "--sdk_root=$SdkRoot" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
if ($LASTEXITCODE -ne 0) { throw "sdkmanager failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Android toolchain ready:'
Write-Host "  JDK:     $JdkRoot"
Write-Host "  SDK:     $SdkRoot"
Write-Host "  Gradle:  $GradleRoot"
& (Join-Path $JdkRoot 'bin\java.exe') -version
& (Join-Path $GradleRoot 'bin\gradle.bat') --version
