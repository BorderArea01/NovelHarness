// New immutable UI release; leave the live process and its database untouched.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stageHostRelease } from '../host/stage.mjs';
import { privateDirectory } from './private-directory.mjs';
import {
  WRITING_RUNTIME_FILES,
  CONTENT_RUNTIME_FILES,
  PURGE_RUNTIME_FILES,
  PURGE_RUNTIME_ADDITIONS,
  PROMPT_RUNTIME_FILES,
} from './runtime-release-policy.mjs';
const writingUpgrade =
  process.argv.includes('--unified-writing') || process.env.NOVEL_HOST_RUNTIME_UPGRADE === 'unified-writing';
const contentUpgrade =
  process.argv.includes('--manual-content') || process.env.NOVEL_HOST_RUNTIME_UPGRADE === 'manual-content';
const purgeUpgrade = process.env.NOVEL_HOST_RUNTIME_UPGRADE === 'dsh-purge-novel';
const promptUpgrade =
  process.argv.includes('--prompt-policy') || process.env.NOVEL_HOST_RUNTIME_UPGRADE === 'prompt-policy';
if ([writingUpgrade, contentUpgrade, purgeUpgrade, promptUpgrade].filter(Boolean).length > 1)
  throw new Error('One reviewed runtime feature per release.');
const upgrade = writingUpgrade || contentUpgrade || purgeUpgrade || promptUpgrade;
const allowed = promptUpgrade
  ? PROMPT_RUNTIME_FILES
  : purgeUpgrade
    ? PURGE_RUNTIME_FILES
    : contentUpgrade
      ? CONTENT_RUNTIME_FILES
      : WRITING_RUNTIME_FILES;
const active = JSON.parse(await readFile('data/local-host/active.json', 'utf8'));
const previous = active.release ?? resolve(active.candidate, 'release');
const target = resolve(
  'data/local-host/releases',
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8),
);
await privateDirectory(target);
await stageHostRelease(target);
async function files(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(root, path).replaceAll('\\', '/'));
      else throw new Error('Unexpected release file type.');
    }
  }
  await visit(root);
  return result.sort();
}
const oldWorker = await files(resolve(previous, 'worker')),
  newWorker = await files(resolve(target, 'worker'));
if (
  oldWorker.some((p) => !newWorker.includes(p)) ||
  newWorker.some(
    (p) => !oldWorker.includes(p) && !(purgeUpgrade && PURGE_RUNTIME_ADDITIONS.has('worker/' + p)),
  )
)
  throw new Error('Backend module inventory changed; UI-only release refused.');
const backendChanges = [];
for (const file of [
  ...newWorker.map((path) => 'worker/' + path),
  'host/gateway-entry.mjs',
  'host/host-wire.mjs',
]) {
  const before =
      file.startsWith('worker/') && !oldWorker.includes(file.slice(7))
        ? null
        : await readFile(resolve(previous, file)),
    after = await readFile(resolve(target, file));
  if (!before || !before.equals(after)) {
    if (!upgrade || !allowed.has(file))
      throw new Error('Unreviewed backend change; release refused: ' + file);
    backendChanges.push({
      path: file,
      previousSha256: before ? createHash('sha256').update(before).digest('hex') : null,
      sha256: createHash('sha256').update(after).digest('hex'),
    });
  }
}
const hash = createHash('sha256'),
  manifest = [];
for (const path of await files(target)) {
  const data = await readFile(resolve(target, path)),
    sha256 = createHash('sha256').update(data).digest('hex');
  hash.update(path + '\0' + sha256 + '\n');
  manifest.push({ path, sha256, bytes: data.length });
}
const receipt = {
  format: upgrade ? 'novel-local-runtime-release-v1' : 'novel-local-ui-release-v1',
  release: target,
  revision: hash.digest('hex'),
  previousRelease: previous,
  preparedAt: new Date().toISOString(),
  backendUnchanged: backendChanges.length === 0,
  ...(upgrade
    ? {
        feature: promptUpgrade
          ? 'prompt-policy'
          : purgeUpgrade
            ? 'dsh-purge-novel'
            : contentUpgrade
              ? 'manual-content'
              : 'unified-writing',
        backendChanges,
      }
    : {}),
  databaseChanged: false,
  tested: false,
  manifest,
};
await writeFile(resolve(target, 'ui-release.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    release: target,
    revision: receipt.revision,
    backendUnchanged: receipt.backendUnchanged,
    changedBackendFiles: backendChanges.map((change) => change.path),
    databaseChanged: false,
    published: false,
  }),
);
