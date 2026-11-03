$ErrorActionPreference = 'Stop'
$target = Join-Path ([Environment]::GetFolderPath('Startup')) 'NovelWriterLAN.cmd'
if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Force
  Write-Host 'Novel Writer autostart disabled.'
} else {
  Write-Host 'Novel Writer autostart is not enabled.'
}
