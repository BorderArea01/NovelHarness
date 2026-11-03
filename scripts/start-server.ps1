param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
try {
  $raw = & node.exe --max-old-space-size=96 cloud/selfhost/print-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read deployment configuration.' }
  $config = $raw | ConvertFrom-Json
  if (-not $config.prepared) { throw 'Run npm run build first. Background startup does not build automatically.' }
  if ($config.mode -eq 'shared' -and -not $config.pinConfigured -and -not $config.canInitialize) {
    throw 'Run npm start once to set your private PIN.'
  }
  $address = 'http://127.0.0.1:' + $config.port
  if ($config.host -notin @('0.0.0.0', '::', 'localhost', '127.0.0.1')) {
    $address = 'http://' + $config.host + ':' + $config.port
  }
  $listener = Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    if (-not (Test-Path -LiteralPath $config.leaseFile)) { throw 'Configured port is occupied by another service; nothing was stopped.' }
    $lease = Get-Content -LiteralPath $config.leaseFile -Raw | ConvertFrom-Json
    if ($lease.pid -notin @($listener.OwningProcess) -or $lease.mode -ne $config.mode -or $lease.dataDirectory -ne $config.dataDirectory) {
      throw 'Running service does not match this configuration; nothing was stopped.'
    }
    $health = Invoke-RestMethod -Uri ($address + '/api/health') -TimeoutSec 5
    if ($health.runtime -ne 'deepseek-harness' -or $health.mode -ne $config.mode) { throw 'Unexpected service identity.' }
    Write-Host ('NovelHarness is already running: ' + $address)
    if ($OpenBrowser) { Start-Process $address }
    return
  }
  # Keep launch logs outside an unregistered data directory: first startup
  # must see an empty store and claim it before anything else writes there.
  $logDir = Join-Path $config.runtimeDirectory ('logs/' + [IO.Path]::GetFileNameWithoutExtension($config.leaseFile))
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $stdout = Join-Path $logDir 'service.log'
  $stderr = Join-Path $logDir 'service-error.log'
  $process = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('--max-old-space-size=192', 'cloud/selfhost/server.mjs') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Milliseconds 1000
    if ($process.HasExited) { throw ('Startup failed. See ' + $stderr) }
    try {
      $health = Invoke-RestMethod -Uri ($address + '/api/health') -TimeoutSec 2
      $lease = Get-Content -LiteralPath $config.leaseFile -Raw | ConvertFrom-Json
      if ($health.runtime -eq 'deepseek-harness' -and $health.mode -eq $config.mode -and $lease.pid -eq $process.Id) {
        Write-Host ('NovelHarness started: ' + $address)
        if ($OpenBrowser) { Start-Process $address }
        return
      }
    } catch { }
  }
  throw ('Startup is taking longer than expected; no process was forcibly stopped. See ' + $stderr)
} finally { Pop-Location }
