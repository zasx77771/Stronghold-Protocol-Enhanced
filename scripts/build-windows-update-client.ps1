param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Source = Join-Path $ProjectRoot 'tools\WindowsUpdateClient.cs'
$Compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Windows .NET Framework C# compiler was not found: $Compiler" }
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Update client source was not found: $Source" }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
& $Compiler /nologo /target:winexe /optimize+ /out:$OutputPath /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll $Source
if ($LASTEXITCODE -ne 0) { throw "Update client compilation failed with exit code $LASTEXITCODE" }
Write-Host "Windows update client ready: $OutputPath"
