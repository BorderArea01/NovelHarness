// Online, read-only production snapshots. Destination is an independent
// acceptance environment, never an activation candidate or a migration cutover.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import Database from 'better-sqlite3';
import { prepareOfficialNovel } from './prepare-official-novel.mjs';
import { privateDirectory } from './private-directory.mjs';
import { importLegacyConfiguration } from '../official/novel/configuration.mjs';
import { importHistoricalState } from '../official/novel/history.mjs';

const root = resolve('data/official-validation/integration/lan-staging');
const home = join(root, 'home');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const reportPath = join(root, 'staging.json');
await privateDirectory(root);
assert(!existsSync(reportPath), 'An existing staging copy must never be overwritten.');
const activeBytes = await readFile('data/local-host/active.json');
const active = JSON.parse(activeBytes);
assert.equal((await fetch('http://127.0.0.1:3211/api/health', { signal: AbortSignal.timeout(10000) })).status, 200);
const report = {
  format: 'novel-owner-authorized-lan-staging-v1', status: 'preparing',
  productionSwitched: false, productionWrites: 0, sourceRevision: active.revision,
  snapshotStartedAt: new Date().toISOString(), tables: {},
};
await writeFile(reportPath, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
try {
  await prepareOfficialNovel();
  const stores = join(active.candidate, 'storage/do');
  for (const kind of ['main', 'pin']) {
    const dirs = (await readdir(stores)).filter((name) => name.endsWith('-' + kind));
    assert.equal(dirs.length, 1);
    const dir = join(stores, dirs[0]);
    const files = (await readdir(dir)).filter((name) => /^[a-f0-9]{64}\.sqlite$/.test(name));
    assert.equal(files.length, 1);
    const source = new Database(join(dir, files[0]), { readonly: true, fileMustExist: true });
    try { await source.backup(join(root, 'source-' + kind + '.sqlite')); }
    finally { source.close(); }
    const snapshot = new Database(join(root, 'source-' + kind + '.sqlite'), { readonly: true });
    try {
      assert.equal(snapshot.pragma('quick_check', { simple: true }), 'ok');
      const tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      report.tables[kind] = {};
      for (const { name } of tables) {
        const quoted = '"' + name.replaceAll('"', '""') + '"';
        report.tables[kind][name] = snapshot.prepare('SELECT count(*) AS n FROM ' + quoted).get().n;
      }
      report[kind + 'SnapshotHash'] = sha(await readFile(join(root, 'source-' + kind + '.sqlite')));
    } finally { snapshot.close(); }
  }
  await copyFile(join(root, 'source-main.sqlite'), join(root, 'main.sqlite'));
  await privateDirectory(home);
  const key = (await readFile(join(active.candidate, 'owner-key.txt'), 'utf8')).trim();
  assert(key.length >= 32);
  await writeFile(join(root, 'owner-key.txt'), key, { mode: 0o600, flag: 'wx' });
  report.ownerKeyHash = sha(key);
  const sourcePin = new Database(join(root, 'source-pin.sqlite'), { readonly: true });
  let pinState;
  try {
    const row = sourcePin.prepare('SELECT value FROM _cf_KV WHERE key=?').get('pin-state');
    assert(row, 'Existing PIN state is required; never initialize or reset it.');
    pinState = deserialize(row.value);
    assert.equal(pinState.version, 1);
    assert(pinState.pin && typeof pinState.epoch === 'string');
  } finally { sourcePin.close(); }
  const destinationPin = new Database(join(home, 'web-pin.sqlite'));
  try {
    destinationPin.exec('CREATE TABLE pin_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    destinationPin.prepare('INSERT INTO pin_kv VALUES (?,?)').run('pin-state', JSON.stringify(pinState));
    const roundTrip = JSON.parse(destinationPin.prepare('SELECT value FROM pin_kv WHERE key=?').get('pin-state').value);
    assert.deepEqual(roundTrip, pinState);
    report.pinStatePreserved = true;
  } finally { destinationPin.close(); }
  report.configuration = await importLegacyConfiguration({ sourcePath: join(root, 'source-main.sqlite'), home });
  const history = await importHistoricalState({ sourcePath: join(root, 'source-main.sqlite'), home });
  // The detailed migration receipt stays private and contains only IDs/hashes,
  // not manuscript text or credentials. The public console prints counts only.
  await writeFile(join(root, 'history-import.json'), JSON.stringify(history), { mode: 0o600 });
  report.history = { sessions: history.sessions.length, storedRows: history.storedRows,
    messages: history.projectedMessages, images: history.images, imageBytes: history.imageBytes };
  assert.equal(sha(await readFile('data/local-host/active.json')), sha(activeBytes));
  assert.equal((await fetch('http://127.0.0.1:3211/api/health', { signal: AbortSignal.timeout(10000) })).status, 200);
  report.status = 'prepared';
  report.preparedAt = new Date().toISOString();
  report.outstanding = ['managed plugin lifecycle', 'complete Node-home backup and restore',
    'remaining novel UI regressions', 'production cutover'];
} catch (error) {
  report.status = 'failed';
  // Do not serialize arbitrary exceptions containing source records or secrets.
  report.failure = { name: error.name, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, pinPreserved: report.pinStatePreserved ?? false,
    history: report.history, productionSwitched: false }));
}
