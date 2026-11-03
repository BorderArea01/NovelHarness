$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Consumed only by the parent process, never printed to task logs or persisted.
$settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
@{ enabled = [bool]$settings.ProxyEnable; server = [string]$settings.ProxyServer } | ConvertTo-Json -Compress
