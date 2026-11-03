// Executes upstream patch functions on ONLY the isolated official installation.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const lab = resolve(process.env.NOVEL_OFFICIAL_LAB ?? '');
assert(lab.endsWith('official-validation'));
const base = resolve(process.env.DSH_BASE);
const install = resolve(base, '../..');
assert(install.endsWith('cloud\\official') || install.endsWith('cloud/official'));
const core = await import(pathToFileURL(join(install, 'node_modules/dsh-purge/lib/core.js')));
assert.equal(resolve(core.findAiBase()), base);
assert.equal(resolve(core.findDshHome()), join(lab, 'home'));
const paths = [...new Set(Object.values(core.targetFiles(base)).flat().filter(Boolean))];
const inside = (root, file) => {
  const rel = relative(root, resolve(file));
  return !rel.startsWith('..') && !isAbsolute(rel);
};
for (const file of paths) assert(inside(install, file) || inside(lab, file), 'Patch target escapes the lab.');
// A repeated validation may start from the previous patched lab installation.
// Restore the upstream backup BEFORE taking the clean reference fingerprint.
const initialRestore = await core.revertAll(base);
assert.equal(initialRestore.errors.length, 0);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const originals = new Map(await Promise.all(paths.map(async (path) => [path, sha(await readFile(path))])));
const backups = await core.backupAll(base);
assert.equal(backups.errors.length, 0);
const applied = await core.applyPatches(base);
const changed = [];
for (const [file, before] of originals)
  if (sha(await readFile(file)) !== before) changed.push(relative(install, file));
const reverted = await core.revertAll(base);
assert.equal(reverted.errors.length, 0);
for (const [file, before] of originals)
  assert.equal(sha(await readFile(file)), before, 'Upstream Restore differs from original bytes.');
// Reapply for the isolated real-host boot. No shims, global packages, network
// helpers, host discovery scans, update/restart/uninstall functions are called.
await core.backupAll(base);
const second = await core.applyPatches(base);
const report = {
  source: 'YuJunZhiXue/dsh-purge',
  version: '1.1.82',
  commit: '0c933dc7d3252698f3f0f9756932dcc88355f532',
  targetCount: paths.length,
  changedFiles: changed.length,
  restoreExactBytes: true,
  hostPatchFunctionsExecuted: true,
  globalShimPatchingExecuted: false,
  rows: second.map((row) => ({
    id: row.patch_id,
    name: row.name,
    status: row.status,
    optional: core.ALL_PATCHES.find((p) => p.id === row.patch_id)?.optional === true,
  })),
};
await writeFile(join(lab, 'patch-report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    changed: changed.length,
    restoreExactBytes: true,
    statuses: Object.fromEntries(
      [...new Set(applied.map((r) => r.status))].map((s) => [
        s,
        applied.filter((r) => r.status === s).length,
      ]),
    ),
  }),
);
