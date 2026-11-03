// Real SQLite transaction and original full-plugin factory prompt, offline.
// No running-service changes, real model requests, or dependency patching.
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from '../scripts/private-directory.mjs';
import { openNovelStorage, vfsFileFingerprint } from '../official/novel/storage.mjs';
import { repairManagedBookPrompts } from '../shared/managed-prompt-repair.mjs';

const work = resolve('data/official-validation/integration/prompt-repair');
await privateDirectory(work);
const source = resolve('data/official-validation/integration/lan-staging/source-main.sqlite');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const report = {
  passed: false,
  productionWrites: 0,
  productionSwitched: false,
  realModelCalls: 0,
  phase: 'prepare',
};
const resultPath = join(work, 'report.json');
await writeFile(resultPath, JSON.stringify(report), { mode: 0o600 });
const sourceHash = sha(await readFile(source));
const activeHash = sha(await readFile('data/local-host/active.json'));
let storage;
try {
  await copyFile(source, join(work, 'validation.sqlite'));
  storage = await openNovelStorage(join(work, 'validation.sqlite'));
  const before = vfsFileFingerprint(storage);
  const preview = repairManagedBookPrompts(storage.fs, storage.db);
  assert(preview.files.filter((f) => f.path.endsWith('/AGENTS.md')).length === 5);
  assert.equal(sha(JSON.stringify(vfsFileFingerprint(storage))), sha(JSON.stringify(before)));
  report.plannedBookFiles = preview.files.length;
  report.plannedPluginUpdate = preview.pluginChanged;
  report.phase = 'transaction rollback';
  const originalWrite = storage.fs.writeFileSync;
  const originalUnlink = storage.fs.unlinkSync;
  const failPath = preview.files.at(-1).path;
  storage.fs.writeFileSync = function (path, ...args) {
    if (path === failPath) throw new Error('fixture disk full');
    return originalWrite.call(this, path, ...args);
  };
  storage.fs.unlinkSync = function (path, ...args) {
    if (path === failPath) throw new Error('fixture disk full');
    return originalUnlink.call(this, path, ...args);
  };
  try {
    assert.throws(
      () =>
        repairManagedBookPrompts(storage.fs, storage.db, {
          apply: true,
          ensureIdle() {
            assert.equal(storage.path, join(work, 'validation.sqlite'));
          },
        }),
      /fixture disk full/,
    );
  } finally {
    storage.fs.writeFileSync = originalWrite;
    storage.fs.unlinkSync = originalUnlink;
  }
  assert.equal(sha(JSON.stringify(vfsFileFingerprint(storage))), sha(JSON.stringify(before)));
  assert.equal(storage.fs.existsSync('/workspace/.novel-prompt-repair'), false);
  report.failedWriteRolledBackFilesAndBackups = true;
  report.phase = 'apply';
  const repaired = repairManagedBookPrompts(storage.fs, storage.db, {
    apply: true,
    ensureIdle() {
      assert.equal(storage.path, join(work, 'validation.sqlite'));
    },
  });
  const after = new Map(vfsFileFingerprint(storage).map((item) => [item.path, item]));
  const allowed = new Map(repaired.files.map((item) => [item.path, item]));
  let untouched = 0;
  for (const item of before) {
    if (allowed.has(item.path)) assert.equal(after.get(item.path)?.hash ?? null, allowed.get(item.path).hash);
    else {
      assert.deepEqual(after.get(item.path), item);
      untouched++;
    }
  }
  assert.equal(repairManagedBookPrompts(storage.fs, storage.db, { apply: true }).changed, 0);
  report.unchangedOtherBookFiles = untouched;
  report.repairIsIdempotent = true;
  storage.close();
  storage = undefined;
  storage = await openNovelStorage(join(work, 'validation.sqlite'));
  assert.equal(repairManagedBookPrompts(storage.fs, storage.db).changed, 0);
  report.sqliteReopenVerified = true;
  storage.close();
  storage = undefined;
  report.phase = 'full-plugin injection owner';
  const moduleRoot = resolve('cloud/official/node_modules/dsh-purge/lib');
  const corePath = join(moduleRoot, 'core.js');
  const packageHash = sha(await readFile(corePath));
  const core = await import(pathToFileURL(corePath));
  const factory = core.defaultOverrideText();
  assert(factory.length > 10000);
  const home = join(work, 'operator-home');
  await mkdir(home, { recursive: true });
  const path = join(home, 'prompt-inject.md');
  await writeFile(path, factory, { mode: 0o600 });
  assert.equal(
    await readFile(path, 'utf8'),
    factory,
    'No migration substitutes a novel prompt into the original plugin.',
  );
  const custom = '作者自定插件提示词，不可覆盖。';
  await writeFile(path, custom, { mode: 0o600 });
  assert.equal(await readFile(path, 'utf8'), custom);

  assert.equal(sha(await readFile(corePath)), packageHash);
  report.originalFullPluginUnmodified = true;
  report.factoryAndCustomPluginPromptsUnchanged = true;
  assert.equal(sha(await readFile(source)), sourceHash);
  assert.equal(sha(await readFile('data/local-host/active.json')), activeHash);
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: String(error.message).split('\n')[0].slice(0, 180) };
  process.exitCode = 1;
} finally {
  if (storage) storage.close();
  await writeFile(resultPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
