param([ValidateSet('build','integration','browser','protocol','format')][string]$Task)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$mutex=New-Object System.Threading.Mutex($false,'Local\NovelWriterResourceGuard')
$locked=$false
$child=$null
try {
  $locked=$mutex.WaitOne(0)
  if(-not $locked){throw 'Another guarded task is running.'}
  if(Get-Process -Name NRC-Win64-Shipping -ErrorAction SilentlyContinue){throw 'Game running; task not started.'}
  if((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4GB/1KB){throw 'Less than 4 GiB free; task not started.'}
  $commands=@{
    build='--max-old-space-size=384 cloud/selfhost/build.mjs'
    integration='--max-old-space-size=192 cloud/selfhost/isolation.test.mjs'
    browser='--max-old-space-size=192 cloud/selfhost/browser.test.mjs'
    protocol='--max-old-space-size=128 cloud/tests/run.mjs'
    format='--max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/selfhost/*.mjs cloud/official/novel/runtime.mjs cloud/official/novel/web.mjs cloud/official/novel/storage.mjs README.md SECURITY.md .github/workflows/*.yml'
  }
  $child=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $commands[$Task] -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$root/test-results/public-$Task.out.log" -RedirectStandardError "$root/test-results/public-$Task.error.log"
  $null=$child.Handle
  while(-not $child.WaitForExit(1000)){
    if((Get-Process -Name NRC-Win64-Shipping -ErrorAction SilentlyContinue) -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 2GB/1KB){
      & taskkill.exe /PID $child.Id /T /F | Out-Null
      throw 'Owned task stopped for game or memory protection.'
    }
  }
  $child.WaitForExit()
  Get-Content -LiteralPath "$root/test-results/public-$Task.out.log" -Tail 12
  if($child.ExitCode -ne 0){Get-Content -LiteralPath "$root/test-results/public-$Task.error.log" -Tail 25; throw "Task failed: $($child.ExitCode)"}
} finally {
  if($locked){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
