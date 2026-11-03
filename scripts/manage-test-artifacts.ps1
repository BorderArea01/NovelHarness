param([switch]$Apply, [switch]$FunctionsOnly)

$ErrorActionPreference = 'Stop'
$artifactPattern = '^cloud-(native|engine|tool-scope)-[0-9]{13}$'

function Get-ArtifactSelection {
  param([string[]]$Names, [string[]]$ProtectedNames = @())
  $keep = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $ProtectedNames) {
    if ($name -notmatch $artifactPattern) { throw "Invalid protected artifact name: $name" }
    [void]$keep.Add($name)
  }
  # Dated test workers are disposable, not additional rollback releases.
  # Only an explicitly identified live consumer can pin a directory. Never
  # retain a few per family/platform/failure merely as evidence.
  [pscustomobject]@{
    Keep = @($Names | Where-Object { $_ -match $artifactPattern -and $keep.Contains($_) })
    Delete = @($Names | Where-Object { $_ -match $artifactPattern -and -not $keep.Contains($_) })
  }
}

function Assert-ArtifactPath {
  param([string]$TestRoot, [string]$Path)
  $base = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
  $target = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not [IO.Path]::GetDirectoryName($target).Equals($base, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($target) -notmatch $artifactPattern) {
    throw "Refusing a deletion outside a dated test directory: $target"
  }
  # Reject junctions in both the target and every ancestor, before recursion.
  $current = $target
  while ($current) {
    if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing a reparse point: $current"
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
  return $target
}

function Measure-ArtifactTree {
  param([string]$Path, [switch]$RejectReparse)
  [long]$bytes = 0
  [long]$files = 0
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($Path)
  while ($stack.Count) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($stack.Pop())) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($RejectReparse) { throw "Refusing an artifact containing a reparse point: $entry" }
        continue
      }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $stack.Push($entry) }
      else { $bytes += ([IO.FileInfo]$entry).Length; $files++ }
    }
  }
  [pscustomobject]@{ Bytes = $bytes; Files = $files }
}

function Assert-ArtifactDiskBudget {
  param([long]$FreeBytes, [long]$ArtifactBytes = 0, [switch]$Admission)
  $floor = if ($Admission) { 10GB } else { 5GB }
  if ($FreeBytes -lt $floor) { throw "Disk guard: less than $($floor/1GB) GiB free; task must not run." }
  if ($ArtifactBytes -gt 4GB) { throw 'Disk guard: test artifacts exceed 4 GiB; task must not run.' }
}

if ($FunctionsOnly) { return }
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$testRoot = Join-Path $root 'test-results'
$mutex = New-Object System.Threading.Mutex($false, 'Local\NovelWriterResourceGuard')
$locked = $false
try {
  $locked = $mutex.WaitOne(0)
  if (-not $locked) { throw 'A guarded task is running; artifact cleanup refused.' }
  $active = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match 'cloud[/\\]tests[/\\](native|engine|tool-scope)-runtime\.mjs'
  })
  if ($active.Count) { throw 'A native test driver is still active; artifact cleanup refused.' }
  if (-not (Test-Path -LiteralPath $testRoot -PathType Container)) { return }
  $directories = @(Get-ChildItem -LiteralPath $testRoot -Directory -Force | Where-Object { $_.Name -match $artifactPattern })
  $protected = New-Object 'System.Collections.Generic.List[string]'
  $auditPath = Join-Path $testRoot 'cloud-studio-release-audit.json'
  if (Test-Path -LiteralPath $auditPath) {
    $audit = Get-Content -LiteralPath $auditPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $lock = Get-Content -LiteralPath (Join-Path $root 'cloud/runtime-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($audit.revision -ne $lock.deployment.revision -or @($audit.testDirectories).Count -ne 2) {
      throw 'Published audit has no matching two-directory retention receipt; refusing cleanup.'
    }
    foreach ($relative in $audit.testDirectories) {
      if ($relative -notmatch '^test-results/(cloud-(native|engine)-[0-9]{13})/worker$') {
        throw 'Invalid published audit directory.'
      }
      $name = $Matches[1]
      if (Test-Path -LiteralPath (Join-Path $testRoot $name)) {
        [void](Assert-ArtifactPath $testRoot (Join-Path $testRoot $name))
      }
      # The signed/hash audit itself remains; a historical test copy is not
      # running code and must not become an extra rollback release.
    }
  }
  # Explicit ownership receipts replace inference from timestamps/error text.
  # The first cleanup migrated the historical failures into this receipt.
  $failures = @{}
  $lastReceipt = Join-Path $testRoot 'artifact-cleanup-last.json'
  if (Test-Path -LiteralPath $lastReceipt) {
    $previous = Get-Content -LiteralPath $lastReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.FailureRuns) {
      foreach ($property in $previous.FailureRuns.PSObject.Properties) {
        if ($property.Name -notin @('native','engine','tool-scope') -or $property.Value -notmatch "^cloud-$($property.Name)-[0-9]{13}$") {
          throw 'Invalid historical failure receipt.'
        }
        if (Test-Path -LiteralPath (Join-Path $testRoot $property.Value) -PathType Container) {
          $failures[$property.Name] = [string]$property.Value
        }
      }
    }
  }
  $logs = Join-Path $testRoot 'guarded-logs'
  $recorded = @{}
  if (Test-Path -LiteralPath $logs) {
    foreach ($log in @(Get-ChildItem -LiteralPath $logs -File -Filter '*.result.json' | Sort-Object Name -Descending)) {
      $result = Get-Content -LiteralPath $log.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($result.Format -ne 'novel-guarded-task-result-v1') { throw 'Unknown task ownership receipt.' }
      $task = [string]$result.Task
      if ($task -notin @('cloud-native','cloud-history','cloud-engine','cloud-authoring','cloud-performance','cloud-controls','cloud-questions','cloud-pipeline','cloud-navigation','cloud-studio','cloud-tool-scope') -or $result.Result -eq 'passed') { continue }
      $task = $task.Substring(6)
      $family = if ($task -eq 'history') { 'native' } elseif ($task -in @('native','tool-scope')) { $task } else { 'engine' }
      if ($recorded.ContainsKey($family)) { continue }
      $owned = @($result.TestDirectories)
      if (-not $owned.Count) { continue }
      foreach ($name in $owned) {
        if ($name -notmatch "^cloud-$family-[0-9]{13}$") { throw 'Invalid owned test directory.' }
        if (Test-Path -LiteralPath (Join-Path $testRoot $name)) {
          [void](Assert-ArtifactPath $testRoot (Join-Path $testRoot $name))
        }
        # Keep the failure ownership metadata, not a duplicate runtime tree.
      }
      $failures[$family] = [string]$owned[0]
      $recorded[$family] = $true
    }
  }
  $selection = Get-ArtifactSelection @($directories.Name) @($protected)
  $before = Measure-ArtifactTree $testRoot
  [long]$reclaimable = 0
  $verified = @()
  foreach ($name in $selection.Delete) {
    $path = Assert-ArtifactPath $testRoot (Join-Path $testRoot $name)
    $size = Measure-ArtifactTree $path -RejectReparse
    $reclaimable += $size.Bytes
    $verified += [pscustomobject]@{ Name = $name; Path = $path; Bytes = $size.Bytes }
  }
  if ($before.Bytes - $reclaimable -gt 4GB) {
    throw 'Protected/other test artifacts exceed the 4 GiB budget; no files were deleted.'
  }
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($root))
  [long]$freeBefore = $drive.AvailableFreeSpace
  if ($Apply) {
    foreach ($item in $verified) {
      $path = Assert-ArtifactPath $testRoot $item.Path
      [void](Measure-ArtifactTree $path -RejectReparse)
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    }
  }
  $after = Measure-ArtifactTree $testRoot
  $report = [ordered]@{
    Format = 'novel-test-artifact-cleanup-v1'; Applied = [bool]$Apply
    CheckedAtUtc = [DateTime]::UtcNow.ToString('o'); Root = $testRoot
    BeforeBytes = $before.Bytes; AfterBytes = $after.Bytes; PlannedReclaimBytes = $reclaimable
    FreeDiskBeforeBytes = $freeBefore; FreeDiskAfterBytes = $drive.AvailableFreeSpace
    DeletedCount = $(if ($Apply) { $verified.Count } else { 0 })
    CandidateCount = $verified.Count; Candidates = @($verified | Select-Object Name,Bytes)
    Retained = $selection.Keep; PublishedAndFailed = @($protected)
    FailureRuns = $failures
    KeepLatestPerFamily = 0; MaximumRetainedBytes = 4GB
    ProductionDataTouched = $false
  }
  if ($Apply -and ($verified.Count -gt 0 -or -not (Test-Path -LiteralPath (Join-Path $testRoot 'artifact-cleanup-last.json')))) {
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $testRoot 'artifact-cleanup-last.json') -Encoding UTF8
  }
  [pscustomobject]$report
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
