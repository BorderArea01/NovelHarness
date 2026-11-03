param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$activePath = Join-Path $root 'data/local-host/active.json'
if (-not (Test-Path -LiteralPath $activePath)) { throw 'No verified local migration has been activated.' }
$active = Get-Content -LiteralPath $activePath -Raw -Encoding UTF8 | ConvertFrom-Json
$listener = Get-NetTCPConnection -LocalPort 3211 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  $env:NOVEL_HOST_CANDIDATE = $active.candidate
  if ($active.runtime -eq 'official-dsh') {
    & node.exe --max-old-space-size=96 cloud/scripts/launch-official-host.mjs --owner-requested
  } else {
    & node.exe --max-old-space-size=96 cloud/scripts/launch-host.mjs --owner-requested
  }
  if ($LASTEXITCODE -ne 0) { throw 'Verified local host did not start.' }
}
$tunnelRoot = Join-Path $root 'data/local-host/tunnel'
$tunnel = Get-Content -LiteralPath (Join-Path $tunnelRoot 'tunnel.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ready = $false
try { $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3219/ready' -TimeoutSec 2; $ready = $response.StatusCode -eq 200 } catch {}
if (-not $ready) {
  $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($tunnel.connectorPid)" -ErrorAction SilentlyContinue
  if ($existing -and $existing.ExecutablePath -eq $tunnel.binary) { throw 'Owned connector is running but not ready; no duplicate was started.' }
  if ((Get-FileHash -LiteralPath $tunnel.binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $tunnel.binarySha256) { throw 'Connector checksum changed.' }
  $token = Join-Path $tunnelRoot 'tunnel-token.txt'
  $process = Start-Process -FilePath $tunnel.binary -ArgumentList @('tunnel','--no-autoupdate','--protocol','quic','--metrics','127.0.0.1:3219','run','--token-file',('"'+$token+'"')) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $tunnelRoot 'connector.out.log') -RedirectStandardError (Join-Path $tunnelRoot 'connector.error.log')
  $tunnel.connectorPid = $process.Id
  [IO.File]::WriteAllText((Join-Path $tunnelRoot 'tunnel.json'), ($tunnel | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}
Write-Host 'Local host: http://127.0.0.1:3211 ; public entry uses the same database.'
if ($OpenBrowser) { Start-Process 'http://127.0.0.1:3211' }
