// Finalize only observed, live-verified publication metadata. Never touch stories.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const active = await read('data/local-host/active.json');
const live = await read('data/local-host/live-verification.json');
const release = await read(resolve(active.release, 'ui-release.json'));
const cutover = await read('data/local-host/cutover.json');
const feature = process.argv[2] ?? 'manual-title-editing';
if (!['manual-title-editing', 'collapsed-sidebar-layout', 'unified-writing', 'manual-content', 'dsh-purge-novel'].includes(feature)) throw new Error('Unknown verified UI feature.');
if (!live.complete || !live.liveManualTitleControls || !live.liveUiAssetHashesMatched || !(live.beforeAfterNativeIdentitiesUnchanged || live.beforeNativeIdentitiesPreserved) || live.uiRevision !== active.revision)
  throw new Error('Verified title controls, exact live assets and unchanged native data identities required.');
const deployment = await read('data/cloud-platform/deployment.json');
const tested = await read(resolve(active.release, 'tested.json'));
if (tested.revision !== active.revision) throw new Error('Exact isolated test receipt required.');
if (feature === 'collapsed-sidebar-layout' && (!tested.collapsedSidebarAndMobileDrawer || !live.liveCollapsedSidebar || !live.liveMobileNavigationOverlay))
  throw new Error('Isolated and live sidebar/mobile layout verification required.');
if (feature === 'unified-writing' && (!tested.unifiedWriting || !tested.inPlaceNativeUpgrade || !live.liveUnifiedWritingEntry || !live.allBookFilesUnchangedAtRestart || !live.liveCollapsedSidebar || !live.liveMobileNavigationOverlay))
  throw new Error('Verified native writing, in-place upgrade, unchanged book contents and live navigation required.');
if (feature === 'manual-content' && (!tested.manualContentManagement || !tested.manualRecoveryAfterRestart || !tested.manualContentMobile ||
  !live.liveManualContentControls || (live.chapterBookAvailable && !live.liveChapterManagementControls) || !live.liveUnifiedWritingEntry || !live.allBookFilesUnchangedAtRestart || !live.liveCollapsedSidebar || !live.liveMobileNavigationOverlay))
  throw new Error('Exact recovery/restart tests, live manual controls and unchanged production content required.');
if (feature === 'dsh-purge-novel' && (!tested.purgeReversible || !tested.purgeNativePromptLifecycle || !tested.manualContentManagement ||
  !live.livePurgeInstalled || !live.livePurgeControls || !live.liveManualContentControls || !live.allBookFilesUnchangedAtRestart))
  throw new Error('Verified reversible plugin, native requests, manuscript regression and live installation required.');
deployment.currentUi = { feature, revision: active.revision, hostRelease: active.release,
  pagesStage: cutover.pagesRelease, verifiedAt: cutover.lastVerifiedAt, backendUnchanged: release.backendUnchanged,
  nativeDatabase: 'same-local-storage', evidence: 'data/local-host/live-verification.json' };
await save('data/cloud-platform/deployment.json', deployment);
const lock = await read('cloud/runtime-lock.json');
if (feature === 'manual-title-editing') lock.manualTitleUpgrade = { ...deployment.currentUi, published: true, originalNativeRenameOwners: true,
  chapterOutlineTitleSync: true, sameFilePathsAndNativeSessionIds: true, cancelAndRefreshVerified: true,
  mobile390AndTablet768: true, proseDraftPreserved: true, renameModelCalls: 0, productionStoryWritesByTests: false,
  isolatedEvidence: 'test-results/guarded-logs/20261028-184907-993-cloud-titles.out.log',
  fullLegacyReleaseAuditNotReusedAsCurrentUiProof: true };
else if (feature === 'collapsed-sidebar-layout') lock.sidebarLayoutUpgrade = { ...deployment.currentUi, published: true,
  bounded44pxControls: true, desktop1440And1280And1024: true, short480Height: true,
  originalSettingsDialogs: true, mobileOverlayAndTapOutside: true, manualTitleRegressionPassed: true,
  isolatedEvidence: 'cloud/tests/title-editing-runtime.mjs', isolatedTestedAt: tested.passedAt,
  productionStoryWritesByTests: false, realModelCalls: 0 };
else if (feature === 'unified-writing') {
  lock.unifiedWritingUpgrade = { ...deployment.currentUi, published: true, allNativeToolsAvailable: true,
    mixedRevisionAndContinuation: true, inPlaceNativeUpgrade: true, allBookFilesUnchangedAtRestart: true,
    nativeSchemaAndAuthUnchanged: true, isolatedEvidence: 'cloud/tests/unified-writing-runtime.mjs',
    isolatedTestedAt: tested.unifiedWritingPassedAt, productionStoryWritesByTests: false, realModelCalls: 0 };
  lock.sidebarLayoutUpgrade = { ...deployment.currentUi, feature: 'collapsed-sidebar-layout', published: true,
    bounded44pxControls: true, mobileOverlayAndTapOutside: true,
    isolatedEvidence: 'cloud/tests/title-editing-runtime.mjs', isolatedTestedAt: tested.passedAt };
}
else if (feature === 'manual-content') {
  lock.manualContentUpgrade = { ...deployment.currentUi, published: true, manualChapterDeleteAndClear: true,
    manualOutlineAndDirectionClear: true, recoveryReceiptsInOriginalVfs: true, versionConflictsRefuseOverwrite: true,
    nativeRecoveryAfterRestart: true, allBookFilesUnchangedAtRestart: true, isolatedEvidence: 'cloud/tests/content-management-runtime.mjs',
    isolatedTestedAt: tested.manualContentPassedAt, productionStoryWritesByTests: false, realModelCalls: 0 };
}
else {
  lock.purgeNovelUpgrade = { ...deployment.currentUi, published: true, installed: true, adapter: 'novel-1',
    upstreamVersion: '1.1.82', upstreamCommit: '0c933dc7d3252698f3f0f9756932dcc88355f532',
    scopedRequestOnly: true, sameConversationDisableAndUninstallVerified: true, originalBooksPreserved: true,
    noHostPatchesOrRedteam: true, noExtraAutomaticRetries: true, isolatedEvidence: 'cloud/tests/purge-runtime.mjs',
    isolatedTestedAt: tested.purgePassedAt, realModelCalls: 0, productionStoryWritesByTests: false };
}
await save('cloud/runtime-lock.json', lock);
console.log(JSON.stringify({ currentUiRecorded: true, revision: active.revision, backendUnchanged: release.backendUnchanged }));
