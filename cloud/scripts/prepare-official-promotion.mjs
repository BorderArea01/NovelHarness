// Formal-only online snapshot and lossless offline conversion. This does NOT
// activate a runtime or read any staging manuscript/session/credential data.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, copyFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import Database from 'better-sqlite3';
import { requireIdleRuntime } from './runtime-activity.mjs';
import { privateDirectory } from './private-directory.mjs';
import { importLegacyConfiguration } from '../official/novel/configuration.mjs';
import { importHistoricalState } from '../official/novel/history.mjs';
import { openNovelStorage, vfsFileFingerprint } from '../official/novel/storage.mjs';

assert(process.argv.includes('--owner-requested'), 'Explicit formal promotion request required.');
const base = resolve('data/local-host');
const request = JSON.parse(await readFile(join(base, 'official-promotion-request.json'), 'utf8'));
assert.equal(request.dataPolicy, 'preserve-current-formal-only');
assert.equal(request.includeStagingBooks, false);
assert.equal(request.includeStagingSessions, false);
const stage = JSON.parse(await readFile('data/official-validation/integration/baseline.json', 'utf8'));
assert.equal(stage.sourceRelease, request.sourceRevision, 'The requested CODE revision changed.');
const activeBytes = await readFile(join(base, 'active.json'));
const active = JSON.parse(activeBytes);
const folder = resolve('data/official-validation/integration/formal-promotion');
try { await access(join(folder, 'promotion.json')); throw new Error('Existing promotion receipt must be inspected, never overwritten.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await privateDirectory(folder);
const owner = (await readFile(join(active.candidate, 'owner-key.txt'), 'utf8')).trim();
const idle = await requireIdleRuntime('http://127.0.0.1:3211', owner, fetch, { pinWrapper: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { format: 'novel-formal-only-promotion-v1', status: 'preparing', at: new Date().toISOString(),
  dataPolicy: request.dataPolicy, codeRevision: request.sourceRevision, formalActiveHash: sha(activeBytes),
  sourceCandidate: active.candidate, idle, sourceDatabases: {}, productionSwitched: false, modelCalls: 0 };
await writeFile(join(folder, 'promotion.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
try {
  const stores = join(active.candidate, 'storage/do');
  for (const kind of ['main', 'pin']) {
    const dirs = (await readdir(stores)).filter(name => name.endsWith('-' + kind));
    assert.equal(dirs.length, 1);
    const dir = join(stores, dirs[0]);
    const files = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
    assert.equal(files.length, 1);
    const sourcePath = join(dir, files[0]);
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try { await db.backup(join(folder, 'source-' + kind + '.sqlite')); }
    finally { db.close(); }
    const snapshot = new Database(join(folder, 'source-' + kind + '.sqlite'), { readonly: true });
    try { assert.equal(snapshot.pragma('quick_check', { simple: true }), 'ok'); }
    finally { snapshot.close(); }
    report.sourceDatabases[kind] = { path: sourcePath, snapshotHash: sha(await readFile(join(folder, 'source-' + kind + '.sqlite'))) };
  }
  await copyFile(join(folder, 'source-main.sqlite'), join(folder, 'main.sqlite'));
  const home = join(folder, 'home');
  await privateDirectory(home);
  await writeFile(join(folder, 'owner-key.txt'), owner, { mode: 0o600, flag: 'wx' });
  const pinSource = new Database(join(folder, 'source-pin.sqlite'), { readonly: true });
  let pinState;
  try {
    pinState = deserialize(pinSource.prepare('SELECT value FROM _cf_KV WHERE key=?').get('pin-state').value);
    assert.equal(pinState.version, 1);
    assert(pinState.pin && typeof pinState.epoch === 'string');
  } finally { pinSource.close(); }
  const pinTarget = new Database(join(home, 'web-pin.sqlite'));
  try {
    pinTarget.exec('CREATE TABLE pin_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    pinTarget.prepare('INSERT INTO pin_kv VALUES (?,?)').run('pin-state', JSON.stringify(pinState));
    assert.deepEqual(JSON.parse(pinTarget.prepare('SELECT value FROM pin_kv WHERE key=?').get('pin-state').value), pinState);
  } finally { pinTarget.close(); }
  report.pinPreserved = true;
  report.configuration = await importLegacyConfiguration({ sourcePath: join(folder, 'source-main.sqlite'), home });
  const history = await importHistoricalState({ sourcePath: join(folder, 'source-main.sqlite'), home });
  await writeFile(join(folder, 'history-import.json'), JSON.stringify(history), { mode: 0o600 });
  report.history = { sessions: history.sessions.length, storedRows: history.storedRows, messages: history.projectedMessages,
    images: history.images, imageBytes: history.imageBytes };
  const storage = await openNovelStorage(join(folder, 'main.sqlite'));
  try {
    const files = vfsFileFingerprint(storage);
    await writeFile(join(folder, 'book-fingerprints.json'), JSON.stringify(files), { mode: 0o600 });
    report.bookFiles = files.length;
    report.bookBytes = files.reduce((n, item) => n + item.bytes, 0);
    report.bookFingerprintsHash = sha(JSON.stringify(files));
  } finally { storage.close(); }
  assert.deepEqual(await readFile(join(base, 'active.json')), activeBytes, 'Formal active pointer changed; candidate not accepted.');
  report.status = 'offline-conversion-verified';
} catch (error) {
  report.status = 'failed';
  report.failure = { name: error.name, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  await writeFile(join(folder, 'promotion.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, bookFiles: report.bookFiles, pinPreserved: report.pinPreserved,
    history: report.history, configurationCounts: report.configuration ? { credentials: report.configuration.credentials,
      namespaces: report.configuration.settingsNamespaces } : undefined, productionSwitched: false, modelCalls: 0 }));
}
