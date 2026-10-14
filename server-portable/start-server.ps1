param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [int]$TcpPort = 0,
  [string]$ListenAddress = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'
$env:SP_SERVER_ONLY = '1'
$env:PORT = [string]$Port
$ResolvedTcpPort = if ($TcpPort -gt 0) { $TcpPort } elseif ($Port -lt 65535) { $Port + 1 } else { 3001 }
if ($ResolvedTcpPort -lt 1 -or $ResolvedTcpPort -gt 65535) { throw "Invalid TCP port: $ResolvedTcpPort" }
$env:TCP_PORT = [string]$ResolvedTcpPort
$env:HOST = $ListenAddress
& (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'server\index.js')
exit $LASTEXITCODE
