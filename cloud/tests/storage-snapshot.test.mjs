import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { encodeStorageValue, decodeStorageValue } from '../worker/storage-value.mjs';
import { captureStorageSnapshot, restoreStorageSnapshot, snapshotRecords, migrationAuthorized, storageSnapshotResponse } from '../worker/storage-snapshot.mjs';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const values = new Map();
  return {
    db,
    storage: {
      sql: { exec(sql, ...args) { return db.prepare(sql).all(...args.map((v) => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); } },
      kv: { list: () => values, put: (key, value) => values.set(key, value) },
      transactionSync(fn) {
        const before = structuredClone(values);
        db.exec('BEGIN');
        try { const value = fn(); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); values.clear(); for (const entry of before) values.set(...entry); throw error; }
      },
    },
  };
}
test('storage codec preserves references, cycles, sparse arrays, binary views and special values', () => {
  const buffer = new Uint8Array([0, 127, 255, 3]).buffer;
  const value = { text: '\ufeff雨\r\n🌧️', buffer, view: new DataView(buffer, 1, 2), uint: new Uint8Array(buffer, 2), undefined, bigint: 2n ** 63n, nan: NaN, minus: -0, inf: Infinity, date: new Date(NaN), regexp: /雨/gu };
  value.map = new Map([[value, new Set([value])]]);
  value.array = new Array(4); value.array[2] = value;
  value.self = value;
  const next = decodeStorageValue(JSON.parse(JSON.stringify(encodeStorageValue(value))));
  assert.equal(next.self, next);
  assert.equal(next.map.get(next).has(next), true);
  assert.equal(next.view.buffer, next.buffer);
  assert.equal(next.uint.buffer, next.buffer);
  assert.equal(next.array[2], next);
  assert.equal(0 in next.array, false);
  assert.ok(Object.is(next.minus, -0));
  assert.ok(Number.isNaN(next.nan));
  assert.ok(Number.isNaN(+next.date));
  assert.equal(next.inf, Infinity);
  assert.equal(next.bigint, value.bigint);
  assert.equal(next.text, value.text);
  assert.deepEqual([...next.uint], [255, 3]);
  assert.throws(() => encodeStorageValue(new URL('https://example.com')), /Unsupported/);
  assert.throws(() => decodeStorageValue({ version: 1, value: ['ref', 1], nodes: [] }), /reference/);
});
test('complete storage roundtrip preserves SQL integer precision, binary bytes, schema, sequence and all KV', () => {
  const source = fixture(), target = fixture();
  try {
    source.db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
      CREATE TABLE child(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id), payload BLOB, value REAL);
      CREATE INDEX child_parent ON child(p);
      INSERT INTO parent(id,name) VALUES(12,'人物');
      INSERT INTO parent(id,name) VALUES(50,'已删'); DELETE FROM parent WHERE id=50;
      INSERT INTO child VALUES(9223372036854775807,12,X'00FF0100',1.25);`);
    source.storage.kv.put('credentials', { apiKey: 'synthetic-key', models: new Set(['fixture']) });
    source.storage.kv.put('pin-state', { hash: 'synthetic-hash', epoch: 'same-epoch' });
    const snapshot = captureStorageSnapshot(source.storage, { kind: 'main', objectId: 'fixture', alarm: 12345 });
    const restored = restoreStorageSnapshot(target.storage, snapshot.chunks.join(''));
    assert.equal(restored.alarmPaused, 12345);
    assert.equal(target.db.prepare('SELECT CAST(id AS TEXT) AS id,hex(payload) AS payload FROM child').get().id, '9223372036854775807');
    assert.equal(target.db.prepare('SELECT hex(payload) AS payload FROM child').get().payload, '00FF0100');
    assert.equal(target.db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('parent').seq, 50);
    assert.deepEqual(target.storage.kv.list(), source.storage.kv.list());
    assert.throws(() => restoreStorageSnapshot(target.storage, snapshot.chunks.join('')), /nonempty/);
    assert.throws(() => captureStorageSnapshot(source.storage, { kind: 'main', objectId: 'fixture', limit: 50 }), /budget/);
    assert.throws(() => snapshotRecords(snapshot.chunks.slice(0, -1).join('')), /Incomplete/);
  } finally { source.db.close(); target.db.close(); }
});
test('restore rolls back ALL schema/data/KV when any record is corrupt', () => {
  const source = fixture(), target = fixture();
  try {
    source.db.exec('CREATE TABLE data(value TEXT); INSERT INTO data VALUES(\'fixture\')');
    source.storage.kv.put('settings', { enabled: true });
    const parts = captureStorageSnapshot(source.storage, { kind: 'main', objectId: 'fixture' }).chunks;
    const records = snapshotRecords(parts.join(''));
    records.splice(-1, 0, { type: 'kv', key: 'bad', value: { version: 99 } });
    records.at(-1).keys++;
    assert.throws(() => restoreStorageSnapshot(target.storage, records.map((r) => JSON.stringify(r)).join('\n')));
    assert.deepEqual(target.storage.kv.list(), new Map());
    assert.equal(target.db.prepare('SELECT name FROM sqlite_schema').all().length, 0);
  } finally { source.db.close(); target.db.close(); }
});
test('raw snapshots require host recovery secret and explicit migration header, never just a PIN cookie', () => {
  const env = { DSH_EDGE_ACCESS_KEY: 'fixture-owner-secret-0123456789abcdef' };
  const request = (headers) => new Request('https://novel.example/api/host-migration/snapshot/main', { headers });
  const headers = { authorization: 'Bearer ' + env.DSH_EDGE_ACCESS_KEY, 'x-novel-migration': 'export-v1' };
  assert.equal(migrationAuthorized(request(headers), env), true);
  assert.equal(migrationAuthorized(request({ ...headers, origin: 'https://evil.example' }), env), false);
  assert.equal(migrationAuthorized(request({ cookie: 'novel_pin=fixture' }), env), false);
  assert.equal(migrationAuthorized(request({ authorization: headers.authorization }), env), false);
  assert.equal(migrationAuthorized(request({ ...headers, authorization: headers.authorization + 'x' }), env), false);
});
test('busy snapshot refusal does not reject the concurrency gate or reset a running native object', async () => {
  let reset = false;
  const response = await storageSnapshotResponse({
    storage: { getAlarm: async () => null },
    async blockConcurrencyWhile(callback) {
      try { return await callback(); } catch (error) { reset = true; throw error; }
    },
  }, 'main', () => { throw new Error('active writing'); });
  assert.equal(response.status, 503);
  assert.equal(reset, false);
});
