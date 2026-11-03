$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-server.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'NovelWriterLAN.cmd'

if (-not (Test-Path -LiteralPath (Join-Path $root 'apps\server\dist\index.js'))) {
  Push-Location $root
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
  } finally { Pop-Location }
}

$content = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"`r`n"
Set-Content -LiteralPath $target -Value $content -Encoding ascii
Write-Host "Autostart enabled: $target"
