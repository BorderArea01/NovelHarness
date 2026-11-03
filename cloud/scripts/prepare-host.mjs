// Restore an explicitly selected FULL native snapshot into a NEW private local
// candidate. Never starts the native runtime, changes routing or touches cloud.
import { readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { privateDirectory } from './private-directory.mjs';
import { stageHostRelease } from '../host/stage.mjs';
import { hostRuntime } from '../host/runtime.mjs';
import { snapshotRecords } from '../worker/storage-snapshot.mjs';
import { transferStoragePages } from './storage-transfer.mjs';
import { decodeStorageValue } from '../worker/storage-value.mjs';
import { FREEZE_KEY } from '../worker/host-cutover.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit migration preparation required.');
const exportsRoot = resolve('data/cloud-platform/storage-exports');
const snapshot = resolve(process.env.NOVEL_STORAGE_EXPORT ?? 'missing-snapshot');
if (!snapshot.startsWith(exportsRoot + sep)) throw new Error('Explicit owned full-storage export directory required.');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(await readFile(resolve(snapshot, 'storage-report.json'), 'utf8'));
if (!['novel-native-storage-export-v1', 'novel-native-storage-export-v2'].includes(source.format) || source.complete !== true
    || !['main', 'pin'].every((kind) => source.stores?.[kind]?.doubleReadVerified === true || source.stores?.[kind]?.bookmarkConsistent === true))
  throw new Error('The source is not a complete verified native snapshot.');
const ownerKey = (await readFile(resolve(snapshot, 'owner-key.txt'), 'utf8')).trim();
if (sha(ownerKey) !== source.ownerKeySha256) throw new Error('Source owner key integrity check failed.');
const candidate = resolve('data/local-host/candidates', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
await privateDirectory(candidate);
const report = { format: 'novel-local-host-candidate-v1', sourceSnapshot: snapshot, sourceOrigin: source.source,
  createdAt: new Date().toISOString(), namespaceKey: 'novel-host-' + randomUUID(),
  candidate, restoreVerified: false, nativeRuntimeStarted: false, activated: false, cloudStillAuthoritative: true, stores: {} };
let runtime;
try {
  await cp(resolve(snapshot, 'owner-key.txt'), resolve(candidate, 'owner-key.txt'));
  const release = resolve(candidate, 'release');
  await stageHostRelease(release);
  runtime = await hostRuntime({ release, persist: resolve(candidate, 'storage'), namespaceKey: report.namespaceKey, ownerKey, bootstrap: true });
  for (const kind of ['main', 'pin']) {
    if (source.format === 'novel-native-storage-export-v2') {
      const item = source.stores[kind];
      const load = async (receipt, expectedPath) => {
        if (receipt.file !== expectedPath) throw new Error('Unexpected snapshot page path.');
        const bytes = await readFile(resolve(snapshot, expectedPath));
        if (sha(bytes) !== receipt.sha256 || bytes.length !== receipt.bytes) throw new Error('Source page checksum mismatch.');
        return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      };
      const header = await load(item.header, kind + '/header.json');
      if (header.kind !== kind || header.objectId !== item.objectId) throw new Error('Source store identity mismatch.');
      const namespace = await runtime.getDurableObjectNamespace(kind === 'main' ? 'DSH_EDGE_INSTANCE' : 'PIN_AUTH', 'novel-host-harness');
      const stub = namespace.get(namespace.idFromName('owner'));
      const headers = { authorization: 'Bearer ' + ownerKey, 'x-novel-migration': 'export-v1' };
      const post = async (path, value) => {
        const response = await stub.fetch('http://localhost/' + path, { method: 'POST', headers, body: JSON.stringify(value) });
        if (!response.ok) throw new Error('Paged restore was refused; candidate is not approved.');
        await response.arrayBuffer();
      };
      await post('begin', header);
      for (let ordinal = 0; ordinal < item.pages.length; ordinal++) {
        const page = await load(item.pages[ordinal], kind + '/page-' + String(ordinal).padStart(6, '0') + '.json');
        for (const record of page.records ?? []) if (record.type === 'kv' && record.key === FREEZE_KEY) {
          report.stores[kind] = { freeze: decodeStorageValue(record.value) };
        }
        await post('page', { page, ordinal });
      }
      await post('commit', { pages: item.pages.length, keys: item.keys });
      const verified = await transferStoragePages(async (params) => {
        const response = await stub.fetch('http://localhost/?' + params, { headers });
        if (!response.ok) throw new Error('Restored page verification failed.');
        return response.json();
      }, {
        onHeader: async (after) => { assert.deepEqual(after.schema, header.schema); assert.deepEqual(after.tables, header.tables); },
        onPage: async (after, ordinal) => {
          const before = await load(item.pages[ordinal], kind + '/page-' + String(ordinal).padStart(6, '0') + '.json');
          assert.deepEqual({ ...after, bookmark: before.bookmark }, before);
        },
      });
      assert.equal(verified.rows, item.rows); assert.equal(verified.keys, item.keys); assert.equal(verified.pages, item.pages.length);
      report.stores[kind] = { ...report.stores[kind], rows: item.rows, keys: item.keys, pages: item.pages.length, originalAlarm: header.alarm, alarmPaused: true, sqlAndKvIdentical: true };
      console.log(JSON.stringify({ stage: 'local-restore-verified', kind, rows: item.rows, keys: item.keys, pages: item.pages.length }));
      continue;
    }
    if (source.stores[kind].file !== kind + '.ndjson') throw new Error('Invalid source snapshot filename.');
    const bytes = await readFile(resolve(snapshot, kind + '.ndjson'));
    if (sha(bytes) !== source.stores[kind].sha256 || bytes.length !== source.stores[kind].bytes) throw new Error('Source snapshot integrity check failed.');
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes), before = snapshotRecords(text);
    if (before[0].kind !== kind || before[0].objectId !== source.stores[kind].objectId) throw new Error('Source object identity mismatch.');
    const namespace = await runtime.getDurableObjectNamespace(kind === 'main' ? 'DSH_EDGE_INSTANCE' : 'PIN_AUTH', 'novel-host-harness');
    const stub = namespace.get(namespace.idFromName('owner'));
    const headers = { authorization: 'Bearer ' + ownerKey, 'x-novel-migration': 'export-v1' };
    const restored = await stub.fetch('http://localhost/', { method: 'POST', headers, body: text });
    if (!restored.ok) throw new Error('Atomic restore was refused. The candidate was not activated.');
    await restored.arrayBuffer();
    const verify = await stub.fetch('http://localhost/', { headers });
    if (!verify.ok) throw new Error('Local restored-store verification failed.');
    const after = snapshotRecords(await verify.text());
    assert.deepEqual(after[0].schema, before[0].schema);
    assert.deepEqual(after.slice(1), before.slice(1));
    report.stores[kind] = { rows: before.at(-1).rows, keys: before.at(-1).keys,
      sourceSha256: source.stores[kind].sha256, originalAlarm: before[0].alarm, alarmPaused: true, sqlAndKvIdentical: true };
    console.log(JSON.stringify({ stage: 'local-restore-verified', kind, rows: before.at(-1).rows, keys: before.at(-1).keys }));
  }
  report.restoreVerified = true;
  const mainFreeze = report.stores.main.freeze, pinFreeze = report.stores.pin.freeze;
  report.sourceFrozenForTarget = mainFreeze?.phase === 'frozen' && pinFreeze?.phase === 'frozen'
    && mainFreeze.targetId === pinFreeze.targetId ? mainFreeze.targetId : null;
} catch {
  report.error = 'Local candidate was not approved. Source backups and cloud remain unchanged.';
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
  await writeFile(resolve(candidate, 'candidate.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ candidate, restoreVerified: report.restoreVerified, activated: false, cloudStillAuthoritative: true }));
}
