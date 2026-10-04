param(
  [string]$ToolchainDir = '',
  [string]$OutputDir = '',
  [string]$CacheRoot = '',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..'))
$PackageInfo = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$Version = [string]$PackageInfo.version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }
if (-not $CacheRoot) { $CacheRoot = Join-Path $WorkspaceRoot '成果文件\06-构建环境与缓存' }
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
if (-not $ToolchainDir) { $ToolchainDir = Join-Path $CacheRoot 'android-toolchain' }
if (-not $OutputDir) { $OutputDir = Join-Path $WorkspaceRoot '成果文件\03-Android客户端' }
$ToolchainDir = [IO.Path]::GetFullPath($ToolchainDir)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$AndroidRoot = Join-Path $ProjectRoot 'android'
$AssetsDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-embedded-assets'))
$BuildOutputDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-app-build'))
$ProjectCacheDir = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-project-cache'))
$GradleUserHome = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'gradle-user-home'))
$AndroidUserHome = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'android-user-home'))
$JdkRoot = Join-Path $ToolchainDir 'jdk-17'
$SdkRoot = Join-Path $ToolchainDir 'android-sdk'
$Gradle = Join-Path $ToolchainDir 'gradle-8.10.2\bin\gradle.bat'

foreach ($Required in @((Join-Path $JdkRoot 'bin\java.exe'), $Gradle, (Join-Path $SdkRoot 'platforms\android-35\android.jar'))) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
    throw "Missing Android build dependency: $Required. Run scripts\install-android-toolchain.ps1 first."
  }
}
if (-not $AssetsDir.StartsWith($CacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe Android assets path: $AssetsDir"
}
if (Test-Path -LiteralPath $AssetsDir) { Remove-Item -LiteralPath $AssetsDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AssetsDir, $BuildOutputDir, $ProjectCacheDir, $GradleUserHome, $AndroidUserHome, $OutputDir | Out-Null

Write-Host 'Embedding client code and all local resources...'
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'public') -Force |
  Where-Object { $_.Name -ne 'dev' } |
  Copy-Item -Destination $AssetsDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data') -Destination (Join-Path $AssetsDir 'data') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'shared') -Destination (Join-Path $AssetsDir 'shared') -Recurse -Force

$SimTarget = Join-Path $AssetsDir 'sim'
New-Item -ItemType Directory -Force -Path $SimTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'server\sim') -Force |
  Where-Object { $_.Name -ne 'nodeData.js' } |
  Copy-Item -Destination $SimTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'desktop\runtime\data.js') -Destination (Join-Path $AssetsDir 'data.js')

$env:JAVA_HOME = $JdkRoot
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:GRADLE_USER_HOME = $GradleUserHome
$env:ANDROID_USER_HOME = $AndroidUserHome
$env:SP_ANDROID_ASSETS_DIR = $AssetsDir
$env:SP_ANDROID_BUILD_DIR = $BuildOutputDir
$env:Path = (Join-Path $JdkRoot 'bin') + [IO.Path]::PathSeparator + $env:Path

Push-Location $AndroidRoot
try {
  if ($Clean) { & $Gradle --no-daemon --project-cache-dir $ProjectCacheDir clean }
  & $Gradle --no-daemon --project-cache-dir $ProjectCacheDir --stacktrace assembleDebug
  if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$BuiltApk = Join-Path $BuildOutputDir 'outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $BuiltApk -PathType Leaf)) { throw 'Gradle completed but the APK was not found' }
$OutputApk = Join-Path $OutputDir "Stronghold-Protocol-Client-v$Version-android-debug.apk"
Copy-Item -LiteralPath $BuiltApk -Destination $OutputApk -Force
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputApk).Hash
$Size = (Get-Item -LiteralPath $OutputApk).Length
Write-Host ("Android APK ready: {0} ({1:N1} MiB)" -f $OutputApk, ($Size / 1MB))
Write-Host "SHA256: $Hash"
