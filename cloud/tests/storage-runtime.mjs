// Synthetic, offline workerd validation. No cloud account, real keys or AI calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from '../tools/node_modules/miniflare/dist/src/index.js';
import { snapshotRecords } from '../worker/storage-snapshot.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const persist = await mkdtemp(resolve(tmpdir(), 'novel-storage-fixture-'));
const options = {
  host: '127.0.0.1', port: 0, cf: false,
  compatibilityDate: '2026-08-14', compatibilityFlags: ['nodejs_compat'],
  modulesRoot: root,
  modules: ['cloud/tests/fixtures/storage-worker.mjs', 'cloud/worker/storage-snapshot.mjs', 'cloud/worker/storage-pages.mjs', 'cloud/worker/storage-value.mjs'].map((path) => ({ type: 'ESModule', path: resolve(root, path) })),
  durableObjects: { STORE: { className: 'Store', useSQLite: true, unsafeUniqueKey: 'novel-storage-roundtrip-v1' } },
};
const config = { ...convertV4MiniflareOptions(options), resourcePersistencePath: persist, logRequests: false };
let runtime;
const call = async (namespace, name, path, text) => namespace.get(namespace.idFromName(name)).fetch('https://fixture.internal' + path, text === undefined ? undefined : { method: 'POST', body: text });
try {
  runtime = new Miniflare(config);
  let namespace = await runtime.getDurableObjectNamespace('STORE');
  console.log('Synthetic storage runtime: ready, seeding.');
  const seeded = await call(namespace, 'source', '/seed');
  assert.equal(seeded.status, 200, await seeded.text());
  console.log('Synthetic storage runtime: capturing.');
  const source = await call(namespace, 'source', '/snapshot');
  const snapshot = await source.text();
  assert.equal(source.status, 200, snapshot);
  const records = snapshotRecords(snapshot);
  assert.equal(records.at(-1).keys, 2);
  assert.equal(records.at(-1).rows, 3);
  assert.ok(records.some((r) => r.type === 'row' && r.cells.some((cell) => cell[1] === '9223372036854775807') && r.cells.some((cell) => cell[1] === '00ff0100')));
  const restored = await call(namespace, 'destination', '/restore', snapshot);
  assert.equal(restored.status, 200, await restored.text());
  assert.equal((await call(namespace, 'destination', '/restore', snapshot)).status, 409);
  await runtime.dispose(); runtime = null;
  runtime = new Miniflare(config);
  namespace = await runtime.getDurableObjectNamespace('STORE');
  const after = snapshotRecords(await (await call(namespace, 'destination', '/snapshot')).text());
  const comparable = (list) => list.slice(1).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(comparable(after), comparable(records));
  console.log(JSON.stringify({ complete: true, sqlAndKvRoundtrip: true, restartVerified: true, overwriteRejected: true, modelCalls: 0, cloudRequests: 0 }));
} finally {
  await runtime?.dispose();
  // Only this mkdtemp-owned synthetic directory, after its runtime is stopped.
  await rm(persist, { recursive: true });
}
await import('./host-migration-scenario.mjs');
