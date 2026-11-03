param([Parameter(Mandatory=$true)][ValidateSet('package','verify','publish-pages')][string]$Task)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$mutex=New-Object System.Threading.Mutex($false,'Local\NovelWriterResourceGuard')
$locked=$false
$p=$null
try {
  $locked=$mutex.WaitOne(0)
  if(-not $locked){throw 'Another guarded task is running.'}
  if(Get-Process NRC-Win64-Shipping -ErrorAction SilentlyContinue){throw 'Game is running; preparation refused.'}
  if((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4GB/1KB){throw 'Less than 4 GiB memory available.'}
  $args=if($Task -eq 'package'){@('--max-old-space-size=192','cloud/scripts/package-official-production.mjs','--owner-requested')}elseif($Task -eq 'verify'){@('--max-old-space-size=384','cloud/tests/official-production-preview.mjs')}else{@('--max-old-space-size=192','cloud/scripts/publish-official-pages.mjs','--owner-requested')}
  $p=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$root/data/local-host/production-$Task.out.log" -RedirectStandardError "$root/data/local-host/production-$Task.error.log"
  while(-not $p.WaitForExit(1000)){
    if((Get-Process NRC-Win64-Shipping -ErrorAction SilentlyContinue) -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 2GB/1KB){
      & taskkill.exe /PID $p.Id /T /F | Out-Null
      throw 'Only this preparation task was stopped by resource protection; no automatic retry.'
    }
  }
  $p.WaitForExit()
  Get-Content -LiteralPath "$root/data/local-host/production-$Task.out.log"
  Get-Content -LiteralPath "$root/data/local-host/production-$Task.error.log"
  if($Task -eq 'verify'){
    $report=Get-Content -LiteralPath "$root/data/local-host/official-runtime/production-preview.json" -Raw | ConvertFrom-Json
    if(-not $report.passed){throw 'Production preview failed; formal runtime was not switched.'}
  }
  if($Task -eq 'publish-pages'){
    $report=Get-Content -LiteralPath "$root/data/local-host/official-pages-publish.json" -Raw | ConvertFrom-Json
    if(-not $report.published){throw 'Pages publication did not pass.'}
  }
  if($null -eq $p.ExitCode -and $Task -eq 'package'){throw 'No readable task exit code; package verification is inconclusive.'}
  exit $(if($null -eq $p.ExitCode){0}else{$p.ExitCode})
}finally{
  if($p -and -not $p.HasExited){& taskkill.exe /PID $p.Id /T /F | Out-Null}
  if($locked){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
