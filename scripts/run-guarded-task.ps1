param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('cloud-prose-compare','build','typecheck','lint','test','e2e','inspiration-e2e','format-check','format-changed','install-patch','official-install','official-validate','official-novel','official-web','official-history','official-lifecycle','official-config','official-lan-prepare','official-lan-test','official-lan-update-prepare','official-lan-update-stop','official-lan-update-apply','official-lan-update-refresh','official-session-repair-preview','official-session-repair-apply','official-pre-step','official-format','cloud-test','cloud-prompt-repair','cloud-prompt-format','cloud-storage','cloud-host-prepare','cloud-host-pages','cloud-host-verify','cloud-vision','cloud-titles','cloud-unified','cloud-content','cloud-content-format','cloud-purge','cloud-purge-format','cloud-writing-format','cloud-ui-prepare','cloud-ui-format','cloud-format','cloud-browser','cloud-runtime-install','cloud-merge-vendor','cloud-editor-vendor','cloud-native','cloud-history','cloud-engine','cloud-pipeline','cloud-authoring','cloud-performance','cloud-controls','cloud-questions','cloud-studio','cloud-navigation','cloud-read-cost','cloud-tool-scope','cloud-auth-status','cloud-deploy','cloud-public-browser','cloud-quality','cloud-quality-native','cloud-quality-native-refine','artifact-policy-test')]
  [string]$Task
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mutex = New-Object System.Threading.Mutex($false, 'Local\NovelWriterResourceGuard')
$locked = $false
$process = $null
$outcome = 'not-started'

function Get-Game {
  @(Get-Process -ErrorAction Stop | Where-Object {
    $_.ProcessName -eq 'NRC-Win64-Shipping'
  })
}

try {
  $locked = $mutex.WaitOne(0)
  if (-not $locked) { throw 'Another guarded task is running; concurrent builds/tests are prohibited.' }
  # The LAN acceptance process uses the same private patched host installation.
  # Never rewrite its dependencies or regenerate its baseline while it is live.
  # Client-only LAN checks are safe and intentionally remain available.
  $sharedHostTasks = @('official-install','official-validate','official-novel','official-web','official-history','official-lifecycle','official-config','official-lan-prepare','official-format','official-pre-step')
  $lanRunning = Join-Path $root 'data\official-validation\integration\lan-staging\running.json'
  if ($Task -in $sharedHostTasks -and (Test-Path -LiteralPath $lanRunning)) {
    $lan = Get-Content -LiteralPath $lanRunning -Raw | ConvertFrom-Json
    $lanProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$lan.pid)" -ErrorAction Stop
    if ($lanProcess -and $lanProcess.CommandLine -match 'cloud[/\\]scripts[/\\]serve-official-lan\.mjs') {
      throw 'LAN acceptance service is running. Its shared host files were not changed; first perform an idle, graceful test-service shutdown. Production was not touched.'
    }
  }
  $game = @(Get-Game)
  $memory = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  if ($game.Count) { throw 'Rock Kingdom is running. No build, lint or test was started.' }
  # Small pure-Node tasks have a 128 MiB heap and no runtime/browser children.
  # Release upload is serial with a 192 MiB Wrangler heap, no local workerd or
  # browser; keep a separate 3 GB admission floor. Browser/build gates stay 4 GB.
  # All profiles retain the same live game check and 2 GB emergency stop.
  $minimumFree = if ($Task -in @('cloud-test','cloud-format','cloud-quality','artifact-policy-test')) { 2.5GB } elseif ($Task -in @('cloud-deploy','cloud-host-pages')) { 3GB } else { 4GB }
  if ($memory.FreePhysicalMemory -lt $minimumFree/1KB) { throw "Less than $($minimumFree/1GB) GB memory is available. No task was started." }

  # Same named mutex, same PowerShell thread: nested acquisition is reentrant.
  # Prune disposable dated test workers before allocating another runtime.
  # Keep audit/ownership metadata, not extra releases per family or failure.
  . (Join-Path $PSScriptRoot 'manage-test-artifacts.ps1') -FunctionsOnly
  $cleanup = & (Join-Path $PSScriptRoot 'manage-test-artifacts.ps1') -Apply
  $disk = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($root))
  $artifactBytes = if ($cleanup) { $cleanup.AfterBytes } else { 0 }
  Assert-ArtifactDiskBudget -FreeBytes $disk.AvailableFreeSpace -ArtifactBytes $artifactBytes -Admission
  $nextArtifactCheck = [DateTime]::UtcNow.AddSeconds(5)

  $commands = @{
    'official-install' = 'npm.cmd --prefix cloud/official install --ignore-scripts --install-links --no-audit --no-fund --maxsockets=2'
    'official-validate' = 'node.exe --max-old-space-size=192 cloud/scripts/validate-official-host.mjs'
    'official-novel' = 'node.exe --max-old-space-size=384 cloud/tests/official-novel-runtime.mjs'
    'official-web' = 'node.exe --max-old-space-size=384 cloud/tests/official-novel-web.mjs'
    'official-history' = 'node.exe --max-old-space-size=384 cloud/tests/official-novel-history.mjs'
    'official-lifecycle' = 'node.exe --max-old-space-size=384 cloud/tests/official-novel-lifecycle.mjs'
    'official-config' = 'node.exe --max-old-space-size=384 cloud/tests/official-novel-configuration.mjs'
    'official-lan-prepare' = 'node.exe --max-old-space-size=384 cloud/scripts/prepare-official-lan.mjs'
    'official-lan-test' = 'node.exe --max-old-space-size=384 cloud/tests/official-novel-lan.mjs'
    'official-lan-update-prepare' = 'node.exe --max-old-space-size=384 cloud/scripts/official-lan-update.mjs prepare'
    'official-lan-update-stop' = 'node.exe --max-old-space-size=128 cloud/scripts/official-lan-update.mjs stop'
    'official-lan-update-apply' = 'node.exe --max-old-space-size=192 cloud/scripts/official-lan-update.mjs apply'
    'official-lan-update-refresh' = 'node.exe --max-old-space-size=192 cloud/scripts/official-lan-update.mjs refresh'
    'official-session-repair-preview' = 'node.exe --max-old-space-size=128 cloud/scripts/repair-pre-step-history.mjs preview'
    'official-session-repair-apply' = 'node.exe --max-old-space-size=128 cloud/scripts/repair-pre-step-history.mjs apply'
    'official-pre-step' = 'node.exe --max-old-space-size=384 cloud/tests/pre-step-native-runtime.mjs'
    'official-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/official/novel/runtime.mjs cloud/official/novel/storage.mjs cloud/official/novel/filesystem.mjs cloud/official/novel/tools.mjs cloud/official/novel/host-compat.mjs cloud/official/novel/subprocess.mjs cloud/official/novel/client-base.mjs cloud/official/novel/web.mjs cloud/official/novel/history.mjs cloud/official/novel/directory-picker.mjs cloud/official/novel/profile.mjs cloud/official/novel/configuration.mjs cloud/scripts/official-session-lab.mjs cloud/scripts/prepare-official-novel.mjs cloud/tests/official-novel-runtime.mjs cloud/tests/official-novel-loop.mjs cloud/tests/official-novel-filesystem.mjs cloud/tests/official-novel-reopen.mjs cloud/tests/official-novel-web.mjs cloud/tests/official-novel-history.mjs cloud/tests/official-novel-lifecycle.mjs cloud/tests/official-novel-configuration.mjs cloud/tests/fixtures/model-server.mjs docs/OFFICIAL-HOST-VALIDATION.md THIRD_PARTY_NOTICES.md'
    'artifact-policy-test' = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-artifact-retention.ps1'
    'cloud-runtime-install' = 'npm.cmd --prefix cloud/tools install --ignore-scripts --no-audit --no-fund'
    'cloud-merge-vendor' = 'node.exe --max-old-space-size=128 cloud/scripts/build-merge-vendor.mjs'
    'cloud-editor-vendor' = 'node.exe --max-old-space-size=128 cloud/scripts/build-editor-vendor.mjs'
    'cloud-native' = 'node.exe --max-old-space-size=128 cloud/tests/native-runtime.mjs'
    'cloud-storage' = 'node.exe --max-old-space-size=128 cloud/tests/storage-runtime.mjs'
    'cloud-host-prepare' = 'node.exe --max-old-space-size=128 cloud/scripts/prepare-host.mjs --owner-requested'
    'cloud-host-pages' = 'node.exe --max-old-space-size=128 cloud/scripts/deploy-host-pages.mjs --owner-requested'
    'cloud-host-verify' = 'node.exe --max-old-space-size=128 cloud/scripts/verify-host-live.mjs'
    'cloud-vision' = 'node.exe --max-old-space-size=128 cloud/scripts/vision-once.mjs --owner-requested'
    'cloud-titles' = 'node.exe --max-old-space-size=128 cloud/tests/title-editing-runtime.mjs'
    'cloud-unified' = 'node.exe --max-old-space-size=128 cloud/tests/unified-writing-runtime.mjs'
    'cloud-content' = 'node.exe --max-old-space-size=128 cloud/tests/content-management-runtime.mjs'
    'cloud-purge' = 'node.exe --max-old-space-size=128 cloud/tests/purge-runtime.mjs'
    'cloud-purge-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/worker/purge-plugin.mjs cloud/worker/entry.mjs cloud/worker/novel-gateway.mjs cloud/pages/public/novel-assets/harness-bridge.mjs cloud/pages/public/novel-assets/application.css cloud/tests/purge-plugin.test.mjs cloud/tests/purge-runtime.mjs cloud/scripts/runtime-release-policy.mjs cloud/scripts/prepare-ui-release.mjs cloud/scripts/verify-ui-release.mjs'
    'cloud-content-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/worker/document-storage.mjs cloud/worker/novel-gateway.mjs cloud/worker/novel-documents.mjs cloud/pages/public/novel-assets/manuscript.mjs cloud/pages/public/novel-assets/manuscript.css cloud/pages/public/novel-assets/content-management.mjs cloud/pages/public/novel-assets/chapter-navigation.mjs cloud/pages/public/novel-assets/outline-editor.mjs cloud/tests/manuscript.test.mjs cloud/tests/content-management-runtime.mjs cloud/scripts/runtime-release-policy.mjs cloud/scripts/prepare-ui-release.mjs cloud/scripts/verify-ui-release.mjs'
    'cloud-writing-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/worker/proposal-tools.mjs cloud/worker/novel-documents.mjs cloud/worker/novel-role.mjs cloud/worker/prompt-templates.mjs cloud/worker/shared/writing-context.mjs cloud/worker/shared/writing-prompts.mjs cloud/pages/public/novel-assets/manuscript-core.mjs cloud/pages/public/novel-assets/manuscript.mjs cloud/tests/manuscript.test.mjs cloud/tests/writing-review.test.mjs cloud/tests/unified-writing-runtime.mjs'
    'cloud-ui-prepare' = 'node.exe --max-old-space-size=128 cloud/scripts/prepare-ui-release.mjs'
    'cloud-ui-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/pages/public/novel-assets/title-editor.mjs cloud/pages/public/novel-assets/application.mjs cloud/pages/public/novel-assets/application.css cloud/pages/public/novel-assets/manuscript.mjs cloud/pages/public/novel-assets/chapter-navigation.mjs cloud/pages/public/novel-assets/outline-editor.mjs cloud/tests/title-editor.test.mjs cloud/tests/title-editing-runtime.mjs cloud/scripts/prepare-ui-release.mjs cloud/scripts/backup-host-before-ui.mjs cloud/scripts/deploy-host-pages.mjs cloud/scripts/launch-host.mjs cloud/host/serve.mjs'
    'cloud-history' = 'node.exe --max-old-space-size=128 cloud/tests/native-runtime.mjs --history'
    'cloud-engine' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs'
    'cloud-read-cost' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --read-cost'
    'cloud-pipeline' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --pipeline'
    'cloud-authoring' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --authoring'
    'cloud-performance' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --performance'
    'cloud-controls' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --controls'
    'cloud-questions' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --questions'
    'cloud-navigation' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --navigation'
    'cloud-studio' = 'node.exe --max-old-space-size=128 cloud/tests/engine-runtime.mjs --studio'
    'cloud-tool-scope' = 'node.exe --max-old-space-size=128 cloud/tests/tool-scope-runtime.mjs'
    'cloud-auth-status' = 'node.exe --max-old-space-size=128 cloud/scripts/auth-status.mjs'
    'cloud-deploy' = 'node.exe --max-old-space-size=128 cloud/scripts/provision.mjs'
    'cloud-public-browser' = 'node.exe --max-old-space-size=128 cloud/tests/public-runtime.mjs'
    'cloud-test' = 'node.exe --max-old-space-size=128 cloud/tests/run.mjs'
    'cloud-prompt-repair' = 'node.exe --max-old-space-size=192 cloud/tests/prompt-repair-runtime.mjs'
    'cloud-prompt-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud/worker/prompt-templates.mjs cloud/scripts/runtime-release-policy.mjs cloud/scripts/prepare-ui-release.mjs cloud/scripts/verify-ui-release.mjs cloud/tests/runtime-release.test.mjs cloud/worker/novel-role.mjs cloud/worker/legacy-default-prompts.mjs cloud/worker/purge-plugin.mjs cloud/worker/shared/writing-context.mjs cloud/worker/shared/writing-prompts.mjs cloud/pages/public/novel-assets/bundle.mjs cloud/shared/managed-prompt-repair.mjs cloud/official/novel/runtime.mjs cloud/official/novel/tools.mjs cloud/tests/prompt-policy.test.mjs cloud/tests/prompt-repair-runtime.mjs cloud/tests/prompt-templates.test.mjs cloud/tests/novel-role.test.mjs cloud/tests/run.mjs'
    'cloud-quality' = 'node.exe --max-old-space-size=128 cloud/scripts/quality-once.mjs'
    'cloud-prose-compare' = 'node.exe --max-old-space-size=128 cloud/scripts/quality-dialogue-5cny.mjs --owner-approved-5cny-20261030'
    'cloud-quality-native' = 'node.exe --max-old-space-size=128 cloud/scripts/quality-native-once.mjs'
    'cloud-quality-native-refine' = 'node.exe --max-old-space-size=128 cloud/scripts/quality-native-once.mjs --refine-remaining'
    'cloud-browser' = 'node.exe --max-old-space-size=128 cloud/tests/browser.mjs'
    'cloud-format' = 'node.exe --max-old-space-size=128 node_modules/prettier/bin/prettier.cjs --write cloud THIRD_PARTY_NOTICES.md'
    'install-patch' = 'npm.cmd install -w @novel-writer/shared fast-json-patch@3.1.1 --ignore-scripts'
    'build' = 'npm.cmd run build'
    'typecheck' = 'npm.cmd run typecheck'
    'lint' = 'npm.cmd run lint'
    'test' = 'npm.cmd run test -w @novel-writer/server -- --maxWorkers=1 --no-file-parallelism'
    'e2e' = 'npm.cmd run test:e2e -- --workers=1'
    'inspiration-e2e' = 'npm.cmd run test:e2e -- --workers=1 --grep inspiration-v2'
    'format-check' = 'npm.cmd run format:check'
    'format-changed' = 'npx.cmd prettier --write apps/web/public/inspiration-writer.js apps/web/public/inspiration-writer.css apps/web/public/creative-workflow.js apps/web/public/workbench-adapter.js apps/web/src/state-patch.ts apps/web/vite.config.ts packages/shared/src/state-patch.ts packages/shared/src/index.ts packages/shared/package.json apps/server/src/app.ts apps/server/src/store.ts apps/server/src/db.ts apps/server/src/app.test.ts playwright.config.ts tests/app.spec.ts tests/inspiration-v2.spec.ts README.md CHANGELOG.md docs/ARCHITECTURE.md docs/BACKUP-RESTORE.md THIRD_PARTY_NOTICES.md'
  }
  $commands['cloud-prompt-format'] += ' cloud/worker/entry.mjs cloud/worker/novel-gateway.mjs cloud/pages/public/novel-assets/rules-core.mjs cloud/pages/public/novel-assets/rules-editor.mjs cloud/pages/public/novel-assets/harness-bridge.mjs cloud/pages/public/novel-assets/manuscript.mjs cloud/official/novel/web.mjs cloud/tests/prompt-sources.test.mjs cloud/tests/authoring-system-scenario.mjs'
  $commands['cloud-prompt-format'] += ' cloud/worker/shared/retired-writing-options.mjs cloud/tests/rules.test.mjs cloud/tests/purge-source-order.test.mjs cloud/tests/public-runtime.mjs cloud/tests/rules-scenario.mjs cloud/tests/engine-runtime.mjs cloud/tests/creative-questions-scenario.mjs'
  $commands['cloud-prompt-format'] += ' cloud/worker/proposal-tools.mjs cloud/worker/novel-documents.mjs cloud/worker/chapter-order.mjs cloud/worker/book-catalog.mjs cloud/pages/public/novel-assets/chapter-focus.mjs cloud/pages/public/novel-assets/writing-run-core.mjs cloud/scripts/quality-fixture.mjs cloud/tests/quality.test.mjs cloud/tests/writing-review.test.mjs cloud/tests/bundle.test.mjs cloud/tests/book-performance.test.mjs cloud/tests/manuscript.test.mjs cloud/tests/reference.test.mjs cloud/tests/canon-proposals.test.mjs cloud/tests/outline.test.mjs cloud/tests/native-activity.test.mjs cloud/tests/proposal-tool-fixture.mjs cloud/tests/purge-plugin.test.mjs cloud/tests/reading-edition.test.mjs cloud/tests/writing-run.test.mjs cloud/tests/chapter-order.test.mjs cloud/tests/novel-pipeline-scenario.mjs'
  $commands['cloud-prompt-format'] += ' cloud/scripts/official-lan-update.mjs cloud/scripts/prepare-official-novel.mjs cloud/scripts/serve-official-lan.mjs cloud/tests/official-novel-web.mjs cloud/tests/official-novel-lan.mjs'
  $commands['cloud-prompt-format'] += ' cloud/official/novel/pre-step-compat.mjs cloud/scripts/prepare-pre-step-compat.mjs cloud/scripts/repair-pre-step-history.mjs cloud/tests/pre-step-compat.test.mjs cloud/tests/pre-step-native-runtime.mjs'
  $commands['cloud-prompt-format'] += ' cloud/official/novel/purge-authoring.mjs cloud/tests/purge-authoring.test.mjs'
  $commands['cloud-prompt-format'] += ' cloud/official/novel/filesystem.mjs cloud/tests/filesystem-contract.test.mjs cloud/tests/native-edit-scenario.mjs'
  $commands['cloud-prompt-format'] += ' cloud/scripts/quality-cny-budget.mjs cloud/scripts/dialogue-eval-fixtures.mjs cloud/scripts/quality-dialogue-5cny.mjs cloud/tests/quality-cny-budget.test.mjs'
  $commands['cloud-prompt-format'] += ' cloud/scripts/quality-native-5cny.mjs'
  if ($Task -eq 'official-web' -and $env:NOVEL_QUALITY_NATIVE -eq 'owner-approved-5cny-20261030') {
    $commands['official-web'] = 'node.exe --max-old-space-size=384 cloud/scripts/quality-native-5cny.mjs --owner-approved-5cny-20261030'
  }
  if ($Task -eq 'official-web' -and $env:NOVEL_QUALITY_NATIVE -eq 'owner-approved-extra2cny-20261030') {
    $commands['official-web'] = 'node.exe --max-old-space-size=384 cloud/scripts/quality-native-5cny.mjs --owner-approved-extra2cny-20261030'
  }
  if ($Task -eq 'official-web' -and $env:NOVEL_QUALITY_NATIVE -eq 'owner-approved-extra3cny-20261030') {
    $commands['official-web'] = 'node.exe --max-old-space-size=384 cloud/scripts/quality-native-5cny.mjs --owner-approved-extra3cny-20261030'
  }
  $commands['cloud-prompt-format'] += ' cloud/official/novel/host-compat.mjs'
  $commands['cloud-prompt-format'] += ' cloud/worker/book-lifecycle.mjs cloud/pages/public/novel-assets/book-management.mjs cloud/pages/public/novel-assets/studio.mjs cloud/pages/public/novel-assets/workspace.mjs cloud/pages/public/novel-assets/application.mjs cloud/pages/public/novel-assets/application.css cloud/pages/public/novel-assets/content-management.mjs cloud/tests/book-lifecycle.test.mjs cloud/tests/book-lifecycle-scenario.mjs'
  $logs = Join-Path $root 'test-results\guarded-logs'
  if ($Task -in @('cloud-runtime-install','official-install')) {
    $env:NODE_OPTIONS = '--max-old-space-size=384'
  }
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdout = Join-Path $logs "$stamp-$Task.out.log"
  $stderr = Join-Path $logs "$stamp-$Task.error.log"
  $artifactNamesBefore = @(Get-ChildItem -LiteralPath (Join-Path $root 'test-results') -Directory | Where-Object Name -Match '^cloud-(native|engine|tool-scope)-[0-9]{13}$' | Select-Object -ExpandProperty Name)
  # cmd owns exactly this npm task and its children; no process-name-based termination.
  $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c', $commands[$Task]) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $outcome = 'failed'
  # Retain the owned process handle so Windows PowerShell cannot lose its exit code.
  [void]$process.Handle
  Write-Output "Started $Task (owned PID $($process.Id)); available memory $([math]::Round($memory.FreePhysicalMemory/1MB,1)) GB."
  while (-not $process.HasExited) {
    Start-Sleep -Milliseconds 500
    try {
      $game = @(Get-Game)
      $memory = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
      if ($game.Count -or $memory.FreePhysicalMemory -lt 2GB/1KB) {
        throw 'Game started or available memory became critically low.'
      }
      if ([DateTime]::UtcNow -ge $nextArtifactCheck) {
        $artifactBytes = (Measure-ArtifactTree (Join-Path $root 'test-results')).Bytes
        $nextArtifactCheck = [DateTime]::UtcNow.AddSeconds(5)
      }
      Assert-ArtifactDiskBudget -FreeBytes $disk.AvailableFreeSpace -ArtifactBytes $artifactBytes
    } catch {
      $outcome = 'guard-stopped'
      if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
      throw "Resource guard stopped only this task and its descendants. It will not restart automatically. $($_.Exception.Message)"
    }
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  if ($null -eq $exitCode) { throw 'Task ended without a readable exit code; verification is inconclusive.' }
  $outcome = if ($exitCode -eq 0) { 'passed' } else { 'failed' }
  Get-Content -LiteralPath $stdout -Encoding UTF8
  Get-Content -LiteralPath $stderr -Encoding UTF8
  exit $exitCode
} finally {
  if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
  if ($locked -and $process) {
    try {
      $created = @(Get-ChildItem -LiteralPath (Join-Path $root 'test-results') -Directory | Where-Object {
        $_.Name -match '^cloud-(native|engine|tool-scope)-[0-9]{13}$' -and $_.Name -notin $artifactNamesBefore
      } | Select-Object -ExpandProperty Name)
      [ordered]@{
        Format = 'novel-guarded-task-result-v1'; Task = $Task; Result = $outcome
        ExitCode = $process.ExitCode; TestDirectories = $created
      } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logs "$stamp-$Task.result.json") -Encoding UTF8
      $cleanup = & (Join-Path $PSScriptRoot 'manage-test-artifacts.ps1') -Apply
      Write-Output "Artifact retention: $($cleanup.DeletedCount) old runs removed; $([Math]::Round($cleanup.AfterBytes/1GB,2)) GiB retained."
      $settledPath = Join-Path $root 'data\official-validation\integration\lan-staging\pending-update.json'
      if ((Test-Path -LiteralPath $settledPath) -and
          ((Get-Content -LiteralPath $settledPath -Raw | ConvertFrom-Json).status -eq 'verified')) {
        $codeCleanup = & (Join-Path $PSScriptRoot 'compact-code-artifacts.ps1') -Apply
        Write-Output "Code retention: $($codeCleanup.CodeTrees.Count) obsolete trees removed; one verified project rollback retained."
      }
    } catch {
      Write-Warning "Artifact retention refused unsafe/oversized cleanup: $($_.Exception.Message)"
    }
  }
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
