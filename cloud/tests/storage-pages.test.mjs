import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { captureStoragePage, beginPagedRestore, restoreStoragePage, commitPagedRestore, storagePageResponse } from '../worker/storage-pages.mjs';
import { transferStoragePages } from '../scripts/storage-transfer.mjs';
function fixture() {
  const db = new DatabaseSync(':memory:'), kv = new Map();
  db.exec('PRAGMA foreign_keys=ON');
  const storage = { sql: { exec(sql, ...args) { return db.prepare(sql).all(...args.map((v) => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); } },
    kv: { list(options = {}) { return new Map([...kv].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => options.startAfter === undefined || k > options.startAfter).slice(0, options.limit)); }, put: (k, v) => kv.set(k, v) },
    transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  return { db, storage, kv };
}
test('paged snapshot restores a larger-than-memory-budget store, exact integers, FK dependencies and KV without whole-database buffering', async () => {
  const source = fixture(), target = fixture();
  try {
    source.db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);
      CREATE TABLE child(id INTEGER PRIMARY KEY,p INTEGER REFERENCES parent(id),payload BLOB);
      CREATE INDEX child_parent ON child(p);
      CREATE TABLE composite(a BLOB,b TEXT,payload TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID;
      INSERT INTO parent(id,name) VALUES(50,'书稿');
      INSERT INTO child VALUES(9223372036854775807,50,X'00FF0100');
      INSERT INTO composite VALUES(X'0001','a','first'),(X'0001','b','second'),(X'FFFF','a','last');
      CREATE TABLE large(id INTEGER PRIMARY KEY,payload BLOB);`);
    const large = new Uint8Array(256 * 1024).fill(221);
    for (let i = 0; i < 60; i++) source.db.prepare('INSERT INTO large VALUES(?,?)').run(i, large);
    source.kv.set('credentials', { apiKey: 'fixture', data: new Set(['test']) });
    let progress, maxPageBytes = 0;
    const readPage = (params) => captureStoragePage(source.storage, 'main', params, { bookmark: 'fixed', objectId: 'fixture', alarm: null });
    const result = await transferStoragePages(readPage, {
      onHeader: (header) => { progress = beginPagedRestore(target.storage, header, 'main'); },
      onPage: (page, ordinal) => {
        const bytes = JSON.stringify(page).length;
        maxPageBytes = Math.max(maxPageBytes, bytes);
        restoreStoragePage(target.storage, progress, page, ordinal);
        assert.throws(() => restoreStoragePage(target.storage, progress, page, ordinal), /refused/);
      },
    });
    assert.ok(result.pages > 50 && maxPageBytes < 600000);
    assert.equal(commitPagedRestore(target.storage, progress, result).committed, true);
    assert.equal(target.db.prepare('SELECT CAST(id AS TEXT) AS n FROM child').get().n, '9223372036854775807');
    assert.equal(target.db.prepare('SELECT SUM(length(payload)) AS n FROM large').get().n, 60 * 256 * 1024);
    assert.deepEqual(target.db.prepare('SELECT hex(a),b,payload FROM composite').all(), source.db.prepare('SELECT hex(a),b,payload FROM composite').all());
    assert.deepEqual(target.kv, source.kv);
    assert.equal(target.db.prepare('SELECT seq FROM sqlite_sequence').get().seq, 50);
    assert.throws(() => beginPagedRestore(target.storage, result.header, 'main'), /refused/);
  } finally { source.db.close(); target.db.close(); }
});
test('source bookmark change refuses export without rejecting the gate or resetting the source object', async () => {
  const source = fixture();
  let reset = false;
  try {
    const response = await storagePageResponse({ storage: { ...source.storage, getCurrentBookmark: async () => 'newer' },
      blockConcurrencyWhile: async (fn) => { try { return await fn(); } catch (e) { reset = true; throw e; } }, id: { toString: () => 'fixture' } },
    'main', new URLSearchParams({ page: 'header', bookmark: 'older' }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, 'source_changed');
    assert.equal(reset, false);
  } finally { source.db.close(); }
});
