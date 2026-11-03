param([Parameter(Mandatory=$true)][string]$Release, [switch]$OwnerApprovedIdleRestart, [switch]$OwnerApprovedWritingRuntimeUpdate, [switch]$OwnerApprovedContentRuntimeUpdate, [switch]$OwnerApprovedPurgeRuntimeUpdate)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (-not $OwnerApprovedIdleRestart) { throw 'Specific authorization for this idle restart is required.' }
$game = @(Get-Process -ErrorAction Stop | Where-Object ProcessName -eq 'NRC-Win64-Shipping')
$memory = Get-CimInstance Win32_OperatingSystem
if ($game.Count -or $memory.FreePhysicalMemory -lt 4GB/1KB) { throw 'Resource guard: no update started.' }
$releasePath = (Resolve-Path -LiteralPath $Release).Path
$owned = [IO.Path]::GetFullPath((Join-Path $root 'data/local-host/releases')) + [IO.Path]::DirectorySeparatorChar
if (-not $releasePath.StartsWith($owned, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release is outside the owned release root.' }
$receipt = Get-Content -LiteralPath (Join-Path $releasePath 'ui-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tested = Get-Content -LiteralPath (Join-Path $releasePath 'tested.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($tested.revision -ne $receipt.revision) { throw 'Tested exact release required.' }
if (-not $receipt.backendUnchanged -and -not ($receipt.format -eq 'novel-local-runtime-release-v1' -and (($OwnerApprovedWritingRuntimeUpdate -and $receipt.feature -eq 'unified-writing') -or ($OwnerApprovedContentRuntimeUpdate -and $receipt.feature -eq 'manual-content') -or ($OwnerApprovedPurgeRuntimeUpdate -and $receipt.feature -eq 'dsh-purge-novel')))) { throw 'Specific runtime feature update authorization required.' }
& node.exe --input-type=module --max-old-space-size=96 -e "import {verifyUiRelease} from './cloud/scripts/verify-ui-release.mjs'; await verifyUiRelease(process.argv[1]);" $releasePath
if ($LASTEXITCODE -ne 0) { throw 'UI manifest changed; live host was not stopped.' }
& node.exe --max-old-space-size=96 cloud/scripts/backup-host-before-ui.mjs --owner-approved-idle-restart
if ($LASTEXITCODE -ne 0) { throw 'Backup or activity check failed; live host was not stopped.' }
$activePath = Join-Path $root 'data/local-host/active.json'
$active = Get-Content -LiteralPath $activePath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($active.pid)"
$entry = [IO.Path]::GetFullPath((Join-Path $root 'cloud/host/serve.mjs'))
if (-not $process -or $process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains($entry)) { throw 'Exact owned host process not confirmed; nothing stopped.' }
& node.exe --max-old-space-size=96 cloud/scripts/backup-host-before-ui.mjs --owner-approved-idle-restart --check-only
if ($LASTEXITCODE -ne 0) { throw 'Final activity check did not complete; live host was not stopped.' }
$game = @(Get-Process -ErrorAction Stop | Where-Object ProcessName -eq 'NRC-Win64-Shipping')
if ($game.Count) { throw 'Game started; live host was not stopped.' }
$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($active.pid)")
foreach ($child in $children) { if ($child.CreationDate -lt $process.CreationDate) { throw 'Ambiguous reused parent PID; no process was stopped.' } }
Write-Host 'Native writing is idle and the online backup is verified; updating only this application process.'
& taskkill.exe /PID $active.pid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Owned host stop was not confirmed; no replacement started.' }
$env:NOVEL_HOST_CANDIDATE = $active.candidate
$env:NOVEL_HOST_UI_RELEASE = $releasePath
& node.exe --max-old-space-size=96 cloud/scripts/launch-host.mjs --owner-requested
if ($LASTEXITCODE -ne 0) { throw 'New UI host not confirmed. The same local database and verified backup are retained; inspect host logs before proceeding.' }
Write-Host 'Local UI updated; database path, PIN and outbound tunnel were not changed.'
