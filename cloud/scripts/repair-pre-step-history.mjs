// Prepare on a private copy; apply only after the LAN writer stopped and the
// complete update backup exists. Original messages and raw bytes are retained.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, copyFile, rename, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { privateDirectory } from './private-directory.mjs';
import { historyTypes, projectHistory, historyHash } from '../official/novel/history.mjs';
import { repairLegacyPreStepArtifact } from '../official/novel/pre-step-compat.mjs';
import { assertReleasedV4Relationships } from '../official/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';
import { Context } from '../official/node_modules/@deepseek-ai/cordis/lib/index.js';
import * as persistencePlugin from '../official/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
import { JsonStorageBackend } from '../official/node_modules/@deepseek-ai/dsh-storage-json/lib/index.js';
import { projectionCacheDomainSpec as spec } from '../official/node_modules/@deepseek-ai/dsh-session-projection-cache/lib/index.js';

const root = resolve('data/official-validation/integration'),
  stage = join(root, 'lan-staging'),
  home = join(stage, 'home');
const work = join(root, 'session-repair'),
  planPath = join(work, 'plan.json');
const action = process.argv[2];
assert(['preview', 'apply'].includes(action));
const types = await historyTypes();
const sha = (v) => createHash('sha256').update(v).digest('hex');
const visible = (a) =>
  projectHistory(a, types)
    .deriveMessages()
    .filter((m) => m.role !== 'system');
function decode(data) {
  const lines = data.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  const r = types.sessionFormatCatalog.createRestore(lines[0], {
    recovery: 'strict',
    validation: 'transformed',
  });
  for (const line of lines.slice(1)) r.decodeRow(line);
  return r.finish();
}
function safe(path, base) {
  const rel = relative(base, resolve(path));
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
}
async function logs(base) {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      assert(!e.isSymbolicLink());
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name === 'session.v4.jsonl') out.push(p);
    }
  }
  await walk(base);
  return out;
}
await privateDirectory(work);
if (action === 'preview') {
  const folder = join(work, new Date().toISOString().replace(/[:.]/g, '-'));
  await privateDirectory(folder);
  const plan = { folder, files: [], scanned: 0, liveWrites: 0 };
  for (const path of await logs(join(home, 'sessions'))) {
    const before = await readFile(path),
      artifact = decode(before);
    plan.scanned++;
    try {
      assertReleasedV4Relationships(artifact, types.KNOWN_SESSION_EVENT_TYPES);
      continue;
    } catch (error) {
      if (error.message !== 'step/start does not match the open turn and next step') throw error;
    }
    const candidate = repairLegacyPreStepArtifact(artifact);
    assertReleasedV4Relationships(candidate, types.KNOWN_SESSION_EVENT_TYPES);
    assert.equal(
      historyHash(visible(candidate)),
      historyHash(visible(artifact)),
      'Visible history differs; repair refused.',
    );
    const dest = join(folder, artifact.header.id);
    await privateDirectory(dest);
    const ctx = new Context();
    try {
      await ctx.plugin(persistencePlugin, { root: dest, compression: 'none', listConcurrency: 1 }).await();
      const store = ctx.get('sessionPersistence'),
        writer = await store.create(candidate.header, { inheritedEventCount: 0 });
      try {
        await writer.append(candidate.events);
        await writer.flush();
      } finally {
        await writer.close();
      }
    } finally {
      await ctx.fiber.dispose();
    }
    // A fresh native persistence instance must reopen the actual encoded file.
    const cold = new Context();
    try {
      await cold.plugin(persistencePlugin, { root: dest, compression: 'none', listConcurrency: 1 }).await();
      const reader = await cold.get('sessionPersistence').open(artifact.header.id, 'read');
      try {
        const loaded = await reader.read();
        assert.equal(historyHash(loaded.events), historyHash(candidate.events));
      } finally {
        await reader.close();
      }
    } finally {
      await cold.fiber.dispose();
    }
    const generated = await logs(dest);
    assert.equal(generated.length, 1);
    const after = await readFile(generated[0]);
    assert.equal(sha(await readFile(path)), sha(before), 'Live history changed while previewing.');
    await writeFile(join(dest, 'original.jsonl'), before, { mode: 0o600 });
    plan.files.push({
      id: artifact.header.id,
      path: relative(home, path),
      candidate: generated[0],
      previousHash: sha(before),
      hash: sha(after),
      events: candidate.events.length,
      messages: visible(candidate).length,
      messageHash: historyHash(visible(candidate)),
    });
  }
  await writeFile(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      preview: true,
      scanned: plan.scanned,
      repairable: plan.files.length,
      visibleMessagesPreserved: true,
      nativeColdReadPassed: true,
      liveWrites: 0,
    }),
  );
} else {
  const update = JSON.parse(await readFile(join(stage, 'pending-update.json'), 'utf8'));
  assert.equal(update.status, 'applied');
  const old = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p=Get-Process -Id ' + update.previousPid + ' -ErrorAction SilentlyContinue;if($p){exit 1};exit 0',
    ],
    { windowsHide: true },
  );
  assert.equal(old.status, 0, 'LAN writer still active.');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  safe(plan.folder, work);
  const prepared = [];
  for (const file of plan.files) {
    const path = resolve(home, file.path);
    safe(path, join(home, 'sessions'));
    safe(file.candidate, plan.folder);
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    const before = await readFile(path),
      after = await readFile(file.candidate);
    assert.equal(sha(before), file.previousHash);
    assert.equal(sha(after), file.hash);
    const original = decode(before),
      candidate = decode(after);
    assertReleasedV4Relationships(candidate, types.KNOWN_SESSION_EVENT_TYPES);
    assert.equal(historyHash(visible(original)), historyHash(visible(candidate)));
    const backed = await readFile(resolve(update.backup, 'home', file.path));
    assert.equal(
      sha(backed),
      file.previousHash,
      'Complete update backup does not contain the exact original.',
    );
    prepared.push({ file, path, after });
  }
  const cache = new JsonStorageBackend(join(home, 'storages'));
  try {
    const unit = await cache.kv.open({
      name: spec.name,
      version: spec.version,
      tables: Object.keys(spec.tables),
      hasGlobal: false,
      layout: spec.layout,
      compatibleVersions: spec.compatibleVersions,
    });
    for (const { file, path, after } of prepared) {
      const temporary = path + '.repair-tmp';
      await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      // Quarantine only this disposable checkpoint via its ORIGINAL owner;
      // do not reuse a cache folded from the former sequence coordinates.
      const existing = await unit.loadAll();
      if (Object.hasOwn(existing.tables.sessions ?? {}, file.id)) {
        assert.equal(typeof unit.backupRecord, 'function');
        await unit.backupRecord('sessions', file.id);
      }
    }
  } finally {
    await cache.close();
  }
  update.sessionRepairs = plan.files;
  update.historyRepairAppliedAt = new Date().toISOString();
  await writeFile(join(stage, 'pending-update.json'), JSON.stringify(update, null, 2), { mode: 0o600 });
  await writeFile(
    join(plan.folder, 'applied.json'),
    JSON.stringify({ backup: update.backup, files: plan.files }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      applied: true,
      repaired: plan.files.length,
      originalBackedUp: true,
      pinChanged: false,
      productionWrites: 0,
    }),
  );
}
