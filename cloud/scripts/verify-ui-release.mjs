import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  isWritingRuntimeRelease,
  isPromptRuntimeRelease,
  isContentRuntimeRelease,
  isPurgeRuntimeRelease,
  PURGE_RUNTIME_ADDITIONS,
} from './runtime-release-policy.mjs';
export async function verifyUiRelease(path, { requireTests = true } = {}) {
  const release = await realpath(path),
    owned = await realpath(resolve('data/local-host/releases'));
  if (!release.startsWith(owned + sep)) throw new Error('Owned immutable UI release required.');
  const receipt = JSON.parse(await readFile(resolve(release, 'ui-release.json'), 'utf8'));
  const runtimeUpgrade =
    isWritingRuntimeRelease(receipt) ||
    isContentRuntimeRelease(receipt) ||
    isPurgeRuntimeRelease(receipt) ||
    isPromptRuntimeRelease(receipt);
  if (
    !((receipt.format === 'novel-local-ui-release-v1' && receipt.backendUnchanged) || runtimeUpgrade) ||
    !Array.isArray(receipt.manifest)
  )
    throw new Error('Verified unchanged backend and UI manifest required.');
  const digest = createHash('sha256'),
    seen = new Set();
  for (const entry of receipt.manifest) {
    const file = resolve(release, entry.path);
    if (!file.startsWith(release + sep) || seen.has(entry.path)) throw new Error('Invalid UI manifest path.');
    seen.add(entry.path);
    const bytes = await readFile(file),
      sha = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== entry.bytes || sha !== entry.sha256)
      throw new Error('UI files changed after preparation.');
    digest.update(entry.path + '\0' + sha + '\n');
  }
  if (digest.digest('hex') !== receipt.revision) throw new Error('UI revision identity mismatch.');
  if (runtimeUpgrade) {
    const previous = await realpath(receipt.previousRelease);
    const allowedPrevious =
      previous.startsWith(owned + sep) ||
      previous.startsWith((await realpath(resolve('data/local-host/candidates'))) + sep);
    if (!allowedPrevious) throw new Error('Original owned runtime required.');
    // Compare the ENTIRE backend again; a receipt cannot hide an extra change.
    const { readdir } = await import('node:fs/promises');
    async function inventory(root, prefix = 'worker') {
      const out = [];
      for (const item of await readdir(resolve(root, prefix), { withFileTypes: true })) {
        const path = prefix + '/' + item.name;
        if (item.isDirectory()) out.push(...(await inventory(root, path)));
        else if (item.isFile()) out.push(path);
        else throw new Error('Unsupported runtime file type.');
      }
      return out.sort();
    }
    const oldFiles = await inventory(previous),
      newFiles = await inventory(release);
    if (
      oldFiles.some((p) => !newFiles.includes(p)) ||
      newFiles.some(
        (p) => !oldFiles.includes(p) && !(isPurgeRuntimeRelease(receipt) && PURGE_RUNTIME_ADDITIONS.has(p)),
      )
    )
      throw new Error('Native module inventory changed.');
    const changes = [];
    for (const path of [...newFiles, 'host/gateway-entry.mjs', 'host/host-wire.mjs']) {
      const before =
        path.startsWith('worker/') && !oldFiles.includes(path)
          ? null
          : createHash('sha256')
              .update(await readFile(resolve(previous, path)))
              .digest('hex');
      const after = createHash('sha256')
        .update(await readFile(resolve(release, path)))
        .digest('hex');
      if (before !== after) changes.push({ path, previousSha256: before, sha256: after });
    }
    if (JSON.stringify(changes) !== JSON.stringify(receipt.backendChanges))
      throw new Error('Runtime changes do not match the reviewed release.');
  }
  if (requireTests) {
    const tested = JSON.parse(await readFile(resolve(release, 'tested.json'), 'utf8'));
    if (tested.revision !== receipt.revision || !tested.originalNativeHarness || !tested.titleSynchronization)
      throw new Error('The exact UI release has not passed native title tests.');
    if (
      runtimeUpgrade &&
      (!tested.unifiedWriting || !tested.inPlaceNativeUpgrade || !tested.collapsedSidebarAndMobileDrawer)
    )
      throw new Error('Exact writing runtime/in-place upgrade and navigation tests required.');
    if (
      isContentRuntimeRelease(receipt) &&
      (!tested.manualContentManagement || !tested.manualRecoveryAfterRestart || !tested.manualContentMobile)
    )
      throw new Error('Exact manual operation, recovery/restart and mobile tests required.');
    if (
      isPurgeRuntimeRelease(receipt) &&
      (!tested.purgeReversible || !tested.purgeNativePromptLifecycle || !tested.manualContentManagement)
    )
      throw new Error('Exact purge prompt lifecycle/reversibility and manuscript regression tests required.');
  }
  return receipt;
}
