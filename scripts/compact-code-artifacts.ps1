param([switch]$Apply)
$applyCode = [bool]$Apply

# Project-wide code retention. Data/home/credentials are deliberately never
# targets. The active programs and ONE verified rollback remain, irrespective
# of how many platforms, update attempts or test families produced the code.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'manage-test-artifacts.ps1') -FunctionsOnly
$mutex = New-Object System.Threading.Mutex($false, 'Local\NovelWriterResourceGuard')
$locked = $false
try {
  $locked = $mutex.WaitOne(0)
  if (-not $locked) { throw 'Another guarded task is running; code cleanup refused.' }
  $activePath = Join-Path $root 'data/local-host/active.json'
  $activeHash = (Get-FileHash -LiteralPath $activePath -Algorithm SHA256).Hash
  $active = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
  $stage = Join-Path $root 'data/official-validation/integration/lan-staging'
  $pendingPath = Join-Path $stage 'pending-update.json'
  $pending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
  if ($pending.status -ne 'verified') { throw 'Only a verified, settled LAN version may be compacted.' }
  $rollbackAlias=$null
  if($active.runtime -eq 'official-dsh'){
    if(-not $active.verifiedReady){throw 'Unverified formal package; cleanup refused.'}
    $previous=Get-Content -LiteralPath (Join-Path $active.previousRuntimeBackup 'active-before.json') -Raw | ConvertFrom-Json
    $rollback=[IO.Path]::GetFullPath($previous.release)
    $rollbackAlias=[IO.Path]::GetFullPath((Join-Path $previous.candidate 'release'))
    if(-not $rollback.StartsWith((Join-Path $root 'data/local-host/releases')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Rollback release escaped its owned root.'}
    if(-not $rollbackAlias.StartsWith((Join-Path $root 'data/local-host/candidates')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Rollback boot anchor escaped its owned root.'}
    $protected=@([IO.Path]::GetFullPath($active.runtimeRoot),(Join-Path $root 'data/official-validation/integration/baseline'),$rollback)
  }else{
    $rollback = [IO.Path]::GetFullPath((Join-Path $pending.backup 'baseline'))
    $protected = @([IO.Path]::GetFullPath($active.release),[IO.Path]::GetFullPath((Join-Path $active.candidate 'release')),
      (Join-Path $root 'data/official-validation/integration/baseline'),$rollback)
  }
  foreach ($p in $protected) {
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw "Required current/rollback code is missing: $p" }
  }
  $plans = New-Object 'System.Collections.Generic.List[object]'
  function Add-CodeTree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    if($rollbackAlias -and [IO.Path]::GetFullPath($Path) -eq $rollbackAlias -and
       ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
      $target=[IO.Path]::GetFullPath((Get-Item -LiteralPath $Path -Force).Target)
      if($target -ne $rollback){throw 'Rollback anchor points at an unknown tree.'}
      return
    }
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $p.StartsWith((Join-Path $root 'data') + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Code target escaped project data root.'
    }
    foreach ($keep in $protected) {
      if ($p.Equals($keep, [StringComparison]::OrdinalIgnoreCase) -or
          $keep.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase) -or
          $p.StartsWith($keep + '\', [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    $ancestor = $p
    while ($ancestor) {
      if (([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Code target contains a junction ancestor: $ancestor"
      }
      $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $size = Measure-ArtifactTree $p -RejectReparse
    # These named code trees must NEVER contain a data owner or secret. An
    # unexpected file aborts the entire plan, not just this entry's deletion.
    foreach ($f in Get-ChildItem -LiteralPath $p -Recurse -Force -File) {
      if ($f.Name -match '(?i)(\.sqlite($|-)|\.db($|-)|^owner-key|^\.credentials|\.(pem|pfx|keystore|jks)$)' -or
          $f.DirectoryName -match '(?i)[\\/](storage|sessions|home)([\\/]|$)') {
        throw "Unexpected user data in code tree; no cleanup: $p"
      }
    }
    $plans.Add([pscustomobject]@{ Path = $p; Bytes = $size.Bytes })
  }
  $releaseRoot = Join-Path $root 'data/local-host/releases'
  foreach ($dir in Get-ChildItem -LiteralPath $releaseRoot -Directory) {
    if ($dir.Name -notmatch '^\d{4}-\d{2}-\d{2}T[0-9TZ.-]+-[a-f0-9]{8}$') { throw 'Unrecognized release directory.' }
    Add-CodeTree $dir.FullName
  }
  foreach ($dir in Get-ChildItem -LiteralPath (Join-Path $root 'data/local-host/candidates') -Directory) {
    if ($dir.Name -notmatch '^\d{4}-\d{2}-\d{2}T[0-9TZ.-]+-[a-f0-9]{8}$') { throw 'Unrecognized candidate directory.' }
    Add-CodeTree (Join-Path $dir.FullName 'release')
  }
  $updates = Join-Path $root 'data/official-validation/integration/lan-updates'
  foreach ($dir in Get-ChildItem -LiteralPath $updates -Directory) {
    if ($dir.Name -notmatch '^\d{4}-\d{2}-\d{2}T[0-9TZ.-]+$') { throw 'Unrecognized update directory.' }
    foreach ($relative in @('source','candidate/baseline','backup/baseline')) {
      Add-CodeTree (Join-Path $dir.FullName $relative)
    }
    $revisions = Join-Path $dir.FullName 'revisions'
    if (Test-Path -LiteralPath $revisions) {
      foreach ($rev in Get-ChildItem -LiteralPath $revisions -Directory) {
        if ($rev.Name -notmatch '^\d{4}-\d{2}-\d{2}T[0-9TZ.-]+$') { throw 'Unrecognized revision directory.' }
        foreach ($relative in @('source','candidate/baseline','previous/baseline')) {
          Add-CodeTree (Join-Path $rev.FullName $relative)
        }
      }
    }
  }
  if ($applyCode) {
    foreach ($plan in $plans) {
      if ((Get-FileHash -LiteralPath $activePath -Algorithm SHA256).Hash -ne $activeHash) { throw 'Active release changed during cleanup.' }
      [void](Measure-ArtifactTree $plan.Path -RejectReparse)
      Remove-Item -LiteralPath $plan.Path -Recurse -Force
    }
    if($rollbackAlias -and -not (Test-Path -LiteralPath $rollbackAlias)){
      # The old host validates this anchor's realpath. Point it at the ONE
      # retained old release rather than retaining an extra historical build.
      New-Item -ItemType Junction -Path $rollbackAlias -Target $rollback | Out-Null
    }
  }
  $report = [ordered]@{
    Format = 'novel-project-code-retention-v1'; At = [DateTime]::UtcNow.ToString('o')
    Applied = $applyCode; ProtectedCurrent = @($protected | Where-Object { $_ -ne $rollback })
    VerifiedRollback = $rollback; MaximumRollbackVersions = 1
    CodeTrees = $plans.ToArray(); ReclaimableBytes = ($plans | Measure-Object Bytes -Sum).Sum
    DataHomesConfigsAndKeysUntouched = $true
  }
  if ($applyCode) {
    $receipt = Join-Path $root 'data/code-retention-last.json'
    $text = $report | ConvertTo-Json -Depth 5
    if ($plans.Count -gt 0 -or -not (Test-Path -LiteralPath $receipt)) {
      [IO.File]::WriteAllText($receipt, $text, (New-Object Text.UTF8Encoding($false)))
    }
  }
  [pscustomobject]$report
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
