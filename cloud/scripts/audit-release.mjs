// Read-only comparison of release/test code; writes only a generated audit
// report under test-results. Never reads stories, cookies or provider settings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const state = JSON.parse(await readFile(resolve(root, 'data/cloud-platform/deployment.json'), 'utf8'));
if (state.currentUi) throw new Error('The cloud release tree is historical after local hosting. Use currentUi, the verified UI manifest and live-verification.json; refusing to label an old cloud audit as current.');
assert.equal(state.format, 'novel-harness-deployment-v1');
assert.equal(state.status, 'verified');
const stage = resolve(state.stage);
assert.ok(stage.startsWith(resolve(root, 'data/cloud-platform/release-')));
const tests = process.argv.slice(2).map((path) => {
  assert.match(path.replaceAll('\\', '/'), /^test-results\/cloud-(?:native|engine)-\d+\/worker$/);
  return resolve(root, path);
});
assert.equal(tests.length, 2);
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...(await files(directory, name)));
    else {
      assert.ok(entry.isFile(), 'Unexpected source link.');
      result.push(name);
    }
  }
  return result.sort();
}
const mismatches = [];
let releaseSourceFiles = 0,
  testWorkerComparisons = 0;
for (const part of ['functions', 'src', 'public']) {
  const source = resolve(root, 'cloud/pages', part),
    target = resolve(stage, part);
  const paths = await files(source);
  assert.deepEqual(await files(target), paths);
  for (const path of paths) {
    releaseSourceFiles++;
    if ((await hash(resolve(source, path))) !== (await hash(resolve(target, path))))
      mismatches.push(part + '/' + path);
  }
}
const worker = resolve(root, 'cloud/worker');
let sharedModuleComparisons = 0;
for (const name of ['writing-context.mjs', 'writing-prompts.mjs']) {
  const expected = await hash(resolve(root, 'cloud/worker/shared', name));
  for (const folder of [
    resolve(root, 'cloud/pages/public/worker/shared'),
    resolve(stage, 'worker/shared'),
    resolve(stage, 'public/worker/shared'),
    ...tests.map((test) => resolve(test, 'shared')),
  ]) {
    sharedModuleComparisons++;
    if ((await hash(resolve(folder, name))) !== expected)
      mismatches.push('shared/' + relative(root, folder) + '/' + name);
  }
}
for (const name of (await readdir(worker)).filter((name) => name.endsWith('.mjs'))) {
  const expected = await hash(resolve(worker, name));
  if ((await hash(resolve(stage, 'worker', name))) !== expected) mismatches.push('release-worker/' + name);
  for (const tested of tests) {
    testWorkerComparisons++;
    if ((await hash(resolve(tested, name))) !== expected)
      mismatches.push(relative(root, tested).split(sep).join('/') + '/' + name);
  }
}
const nativeHash = await hash(resolve(root, 'cloud/tools/node_modules/dsh-edge/worker/direct/index.js'));
for (const target of [resolve(stage, 'worker'), ...tests])
  if ((await hash(resolve(target, 'native/index.js'))) !== nativeHash)
    mismatches.push('native-runtime/' + relative(root, target));
const report = {
  revision: state.uploadedRevision,
  testDirectories: tests.map((path) => relative(root, path).split(sep).join('/')),
  releaseSourceFiles,
  testWorkerComparisons,
  sharedModuleComparisons,
  pinnedNativeRuntimeCopiesVerified: 3,
  mismatches,
};
await writeFile(
  resolve(root, 'test-results/cloud-studio-release-audit.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
assert.deepEqual(mismatches, []);
