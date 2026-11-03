$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-server.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'NovelWriterLAN.cmd'

Push-Location -LiteralPath $root
try {
  $raw = & node.exe --max-old-space-size=96 cloud/selfhost/print-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read deployment configuration.' }
  $config = $raw | ConvertFrom-Json
  if (-not $config.prepared) { throw 'Run npm run build before installing startup. No automatic build was started.' }
  if ($config.mode -eq 'shared' -and -not $config.pinConfigured -and -not $config.canInitialize) {
    throw 'Run npm start once to set the private PIN before enabling startup.'
  }
} finally { Pop-Location }

$command = "& '" + $launcher.Replace("'", "''") + "'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$content = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $encoded`r`n"
Set-Content -LiteralPath $target -Value $content -Encoding ascii
Write-Host "Autostart enabled: $target"
