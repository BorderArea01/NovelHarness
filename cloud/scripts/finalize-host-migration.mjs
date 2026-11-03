// Record observed state only after live acceptance. No runtime/data mutations.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const active = await load('data/local-host/active.json');
const cutover = await load('data/local-host/cutover.json');
const verified = await load('data/local-host/live-verification.json');
if (!verified.complete || !cutover.publicVerified || !cutover.localIsSoleOwner || !active.verifiedReady || active.targetId !== cutover.targetId)
  throw new Error('Completed live migration verification required.');
const candidatePath = resolve(active.candidate, 'candidate.json');
const candidate = await load(candidatePath);
if (!candidate.restoreVerified || candidate.sourceFrozenForTarget !== active.targetId) throw new Error('Candidate integrity evidence missing.');
candidate.activated = true; candidate.nativeRuntimeStarted = true; candidate.cloudStillAuthoritative = false;
candidate.activatedAt = active.activatedAt; candidate.publicVerifiedAt = cutover.verifiedAt;
await save(candidatePath, candidate);
const deployment = await load('data/cloud-platform/deployment.json');
deployment.storageOwnership = { mode: 'local-host', port: 3211, relayWorker: cutover.relayWorker,
  targetId: active.targetId, verifiedAt: cutover.verifiedAt, sourceCloudFrozen: true,
  evidence: 'data/local-host/live-verification.json' };
await save('data/cloud-platform/deployment.json', deployment);
const lock = await load('cloud/runtime-lock.json');
lock.localHostMigration = { completedAt: cutover.verifiedAt, sourceRevision: deployment.revision,
  publicUrl: deployment.url, mode: 'local-host-single-owner', localPort: 3211,
  relayWorker: cutover.relayWorker, booksVerified: active.books, nativeSessionsVerified: active.sessions,
  sqlRows: candidate.stores.main.rows, mainKvKeys: candidate.stores.main.keys, pinKvKeys: candidate.stores.pin.keys,
  fullSqlAndKvMatchedBeforeActivation: true, originalPinRetained: true, originalCloudRetainedFrozen: true,
  livePublicLanIdentityMatch: true, livePublicNativeWebSocket: true, livePublicMobileAndRefresh: true,
  modelCalls: 0, productionStoryWritesByValidation: false,
  targetedEvidence: 'test-results/guarded-logs/20261028-161212-239-cloud-storage.out.log',
  privateLiveEvidence: 'data/local-host/live-verification.json',
  previousFullReleaseAuditRetainedAsHistorical: true,
  fullBroadNativeRegressionPassedThisMigration: false,
  broadNativeRegressionLimitation: 'Earlier complete native suite timed out at the chapter-directory UI selector; targeted native storage, restore, LAN, freeze/restart and scheduler tests passed.' };
await save('cloud/runtime-lock.json', lock);
console.log(JSON.stringify({ migrationRecorded: true, mode: 'local-host-single-owner', books: active.books, sessions: active.sessions, originalCloudRetainedFrozen: true }));
