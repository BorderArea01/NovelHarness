param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'apps\server\dist\index.js'
$dataDir = Join-Path $root 'data'
$logDir = Join-Path $dataDir 'logs'
$pidFile = Join-Path $dataDir 'server.pid'

$listener = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Write-Host 'Novel Writer service is already running: http://127.0.0.1:3210'
  if ($OpenBrowser) { Start-Process 'http://127.0.0.1:3210' }
  exit 0
}

if (-not (Test-Path -LiteralPath $entry)) {
  Write-Host 'First launch: building the service...'
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stdout = Join-Path $logDir 'server.log'
$stderr = Join-Path $logDir 'server-error.log'
$process = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/health' -TimeoutSec 2
    if ($health.ok) { $healthy = $true; break }
  } catch {}
}

if (-not $healthy) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  throw "Service failed to start. See $stderr"
}

Write-Host "Novel Writer service started (PID $($process.Id)): http://127.0.0.1:3210"
if ($OpenBrowser) { Start-Process 'http://127.0.0.1:3210' }
