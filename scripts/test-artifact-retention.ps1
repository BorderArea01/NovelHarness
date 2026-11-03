$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'manage-test-artifacts.ps1') -FunctionsOnly
$passed = 0
function Check { param([bool]$Condition, [string]$Name)
  if (-not $Condition) { throw "Retention self-test failed: $Name" }; $script:passed++
}
function Refuses { param([scriptblock]$Operation, [string]$Name)
  $failed = $false
  try { & $Operation | Out-Null } catch { $failed = $true }
  Check $failed $Name
}

$names = @('cloud-native-0000000000001','cloud-native-0000000000002','cloud-native-0000000000003','cloud-native-0000000000004',
  'cloud-engine-0000000000001','cloud-engine-0000000000002','cloud-engine-0000000000003','cloud-engine-0000000000004',
  'cloud-tool-scope-0000000000001','cloud-tool-scope-0000000000002','cloud-tool-scope-0000000000003','cloud-tool-scope-0000000000004',
  'data','guarded-logs','cloud-quality-native-0000000000001','cloud-engine-not-a-timestamp','../data')
$plan = Get-ArtifactSelection $names @('cloud-native-0000000000001')
Check ($plan.Keep.Count -eq 1) 'only the explicit live-consumer pin, not per-family history'
Check ($plan.Delete.Count -eq 11) 'all disposable dated runtimes are eligible'
Check ($plan.Delete -notcontains 'cloud-native-0000000000001') 'explicit live-consumer pin overrides age'
foreach ($name in @('data','guarded-logs','cloud-quality-native-0000000000001','cloud-engine-not-a-timestamp','../data')) {
  Check ($plan.Delete -notcontains $name) "non-allowlisted name: $name"
}
Refuses { Get-ArtifactSelection $names @('../data') } 'invalid protected names fail closed'
Check ((Get-ArtifactSelection @() @()).Delete.Count -eq 0) 'empty workspace'
Assert-ArtifactDiskBudget -FreeBytes 10GB -ArtifactBytes 4GB -Admission
Check $true 'admission boundary allows 10 GiB and 4 GiB artifacts'
Assert-ArtifactDiskBudget -FreeBytes 5GB -ArtifactBytes 4GB
Check $true 'live boundary allows 5 GiB'
Refuses { Assert-ArtifactDiskBudget -FreeBytes (10GB-1) -Admission } 'admission below 10 GiB'
Refuses { Assert-ArtifactDiskBudget -FreeBytes (5GB-1) } 'live free space below 5 GiB'
Refuses { Assert-ArtifactDiskBudget -FreeBytes 20GB -ArtifactBytes (4GB+1) } 'artifact budget over 4 GiB'

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$testRoot = Join-Path $root 'test-results'
$fixture = Join-Path $testRoot ('artifact-retention-smoke-' + [Guid]::NewGuid().ToString('N'))
$candidate = Join-Path $fixture 'cloud-native-0000000000001'
$target = Join-Path $fixture 'author-data-must-survive'
$junction = Join-Path $fixture 'cloud-engine-0000000000001'
try {
  [void][IO.Directory]::CreateDirectory($candidate)
  [void][IO.Directory]::CreateDirectory($target)
  [IO.File]::WriteAllText((Join-Path $target 'sentinel.txt'), 'not test garbage')
  Check ((Assert-ArtifactPath $fixture $candidate) -eq $candidate) 'validated exact dated child'
  Refuses { Assert-ArtifactPath $fixture $fixture } 'cannot delete its own root'
  Refuses { Assert-ArtifactPath $fixture (Join-Path $fixture '../data') } 'parent escape rejected'
  Refuses { Assert-ArtifactPath $fixture $target } 'non-dated author data rejected'
  Refuses { Assert-ArtifactPath $fixture (Join-Path $candidate 'cloud-native-0000000000002') } 'nested dated directory rejected'
  New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
  Refuses { Assert-ArtifactPath $fixture $junction } 'root junction rejected'
  Refuses { Measure-ArtifactTree $fixture -RejectReparse } 'recursive junction rejected without traversal'
  Check ([IO.File]::ReadAllText((Join-Path $target 'sentinel.txt')) -eq 'not test garbage') 'junction target untouched'
} finally {
  if (Test-Path -LiteralPath $junction) {
    if (([IO.File]::GetAttributes($junction) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Unexpected non-junction fixture.' }
    # Nonrecursive unlink of our own verified fixture junction, never its target.
    [IO.Directory]::Delete($junction)
  }
  if (Test-Path -LiteralPath $fixture) {
    $absolute = [IO.Path]::GetFullPath($fixture)
    if ([IO.Path]::GetDirectoryName($absolute) -ne $testRoot -or [IO.Path]::GetFileName($absolute) -notmatch '^artifact-retention-smoke-[a-f0-9]{32}$') { throw 'Unsafe smoke fixture path.' }
    [void](Measure-ArtifactTree $absolute -RejectReparse)
    Remove-Item -LiteralPath $absolute -Recurse -Force
  }
}
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-guarded-task.ps1'), [ref]$tokens, [ref]$parseErrors)
Check ($parseErrors.Count -eq 0) 'guarded runner parses on Windows PowerShell'
$receipt = Get-FileHash -LiteralPath (Join-Path $testRoot 'artifact-cleanup-last.json') -Algorithm SHA256
$blockedByGuard = $false
try { $dry = & (Join-Path $PSScriptRoot 'manage-test-artifacts.ps1') }
catch {
  if ($_.Exception.Message -ne 'A guarded task is running; artifact cleanup refused.') { throw }
  $blockedByGuard = $true
}
if ($blockedByGuard) { Check $true 'child process cannot clean while parent resource guard owns the mutex' }
else { Check ($dry.CandidateCount -eq 0) 'real cleanup is idempotent' }
Check (Test-Path -LiteralPath (Join-Path $testRoot 'cloud-studio-release-audit.json') -PathType Leaf) 'audit metadata survives without keeping duplicate worker code'
Check ((Get-FileHash -LiteralPath $receipt.Path -Algorithm SHA256).Hash -eq $receipt.Hash) 'dry run preserves deletion receipt'
Write-Output "Artifact retention self-test: $passed checks passed; no build, browser or model request."
