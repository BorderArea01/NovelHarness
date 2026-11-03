import { encodeStorageValue, decodeStorageValue, toHex, fromHex } from './storage-value.mjs';
import { storagePageResponse } from './storage-pages.mjs';
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const SNAPSHOT_LIMIT = 24 * 1024 * 1024;
export const SNAPSHOT_PATH = '/api/host-migration/snapshot/';
export function migrationAuthorized(request, env) {
  const expected = env.DSH_EDGE_ACCESS_KEY;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (typeof expected !== 'string' || expected.length < 32 || typeof supplied !== 'string') return false;
  let mismatch = supplied.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
  const origin = request.headers.get('origin');
  return mismatch === 0 && request.headers.get('x-novel-migration') === 'export-v1'
    && (!origin || origin === new URL(request.url).origin);
}
// Complete SQL + KV at ONE synchronous storage transaction boundary. No table
// whitelist, no native VFS conversion, and no mutation of source storage.
export function captureStorageSnapshot(storage, { kind, objectId, alarm = null, limit = SNAPSHOT_LIMIT }) {
  return storage.transactionSync(() => {
    if (!storage.kv?.list) throw new Error('Synchronous KV export is unavailable.');
    const chunks = [];
    let bytes = 0, rows = 0, keys = 0;
    const append = (record) => {
      const line = JSON.stringify(record) + '\n';
      bytes += new TextEncoder().encode(line).length;
      if (bytes > limit) throw new Error('Snapshot exceeds the safe memory budget; no partial backup was returned.');
      chunks.push(line);
    };
    // workerd currently spells its private table _cf_KV; older documentation
    // calls it __cf_kv. Both are platform-owned and exported through KV only.
    const schema = [...storage.sql.exec("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE lower(name) NOT GLOB '_cf_*' AND lower(name) NOT GLOB '__cf_*' AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type,name")];
    if (schema.some((item) => item.type === 'table' && /CREATE\s+VIRTUAL\s+TABLE/i.test(item.sql)))
      throw new Error('Virtual table restore requires a validated adapter.');
    const sequence = [...storage.sql.exec("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'")].length > 0;
    append({ type: 'header', version: 1, kind, objectId, capturedAt: new Date().toISOString(), alarm, schema });
    for (const name of [...schema.filter((item) => item.type === 'table').map((item) => item.name), ...(sequence ? ['sqlite_sequence'] : [])]) {
      const columns = [...storage.sql.exec('PRAGMA table_xinfo(' + quote(name) + ')')].filter((c) => c.hidden === 0).map((c) => c.name);
      if (!columns.length) throw new Error('Table without restorable columns.');
      const definition = schema.find((item) => item.name === name)?.sql ?? '';
      if (!/\bWITHOUT\s+ROWID\b/i.test(definition)) {
        const alias = ['_rowid_', 'rowid', 'oid'].find((key) => !columns.some((col) => col.toLowerCase() === key));
        if (!alias) throw new Error('All implicit rowid aliases are shadowed; restore requires an adapter.');
        columns.unshift(alias);
      }
      append({ type: 'table', name, columns });
      // Cast integers inside SQLite before crossing JS's unsafe Number boundary.
      const select = columns.flatMap((name, i) => {
        const col = quote(name);
        return ['typeof(' + col + ') AS ' + quote('t' + i), 'CASE WHEN typeof(' + col + ")='integer' THEN CAST(" + col + ' AS TEXT) ELSE ' + col + ' END AS ' + quote('v' + i)];
      }).join(',');
      for (const row of storage.sql.exec('SELECT ' + select + ' FROM ' + quote(name))) {
        const cells = columns.map((_, i) => {
          const type = row['t' + i], value = row['v' + i];
          if (!['integer', 'real', 'text', 'null', 'blob'].includes(type)) throw new Error('Unknown SQLite storage class.');
          return [type, type === 'blob' ? toHex(value) : type === 'real' ? encodeStorageValue(value) : value];
        });
        append({ type: 'row', cells });
        rows++;
      }
    }
    for (const [key, value] of storage.kv.list()) {
      append({ type: 'kv', key, value: encodeStorageValue(value) });
      keys++;
    }
    append({ type: 'end', rows, keys });
    return { chunks, bytes, rows, keys };
  });
}
export async function storageSnapshotResponse(ctx, kind, beforeCapture = () => {}, request, local = false) {
  if (request && new URL(request.url).searchParams.has('page'))
    return storagePageResponse(ctx, kind, new URL(request.url).searchParams, { beforeCapture, local });
  try {
    const snapshot = await ctx.blockConcurrencyWhile(async () => {
      // A rejected blockConcurrencyWhile resets a DO. Catch INSIDE the gate:
      // an active-writing/budget refusal must never interrupt the native stream.
      try {
        const alarm = await ctx.storage.getAlarm();
        beforeCapture();
        return captureStorageSnapshot(ctx.storage, { kind, objectId: ctx.id.toString(), alarm });
      } catch (error) {
        const message = typeof error?.message === 'string' ? error.message : '';
        return { failure: message.includes('memory budget') ? 'snapshot_budget'
          : message.includes('Synchronous KV') ? 'kv_capability'
          : message.includes('Virtual table') ? 'virtual_table'
          : message.includes('shadowed') ? 'rowid_capability'
          : message.includes('Unsupported stored') || message.includes('storage value') || message.includes('binary view') ? 'structured_type'
          : message.includes('active') ? 'runtime_active' : 'storage_snapshot' };
      }
    });
    if (snapshot.failure) return Response.json({ error: '完整存储快照未完成；原数据未修改。', reason: snapshot.failure }, { status: 503, headers: privateHeaders });
    let index = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (index === snapshot.chunks.length) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode(snapshot.chunks[index++]));
      },
    }), { headers: { ...privateHeaders, 'content-type': 'application/x-ndjson', 'content-length': String(snapshot.bytes) } });
  } catch {
    // Exceptions may contain native row values; never reflect them to a client.
    return Response.json({ error: '完整存储快照未完成；原数据未修改。' }, { status: 503, headers: privateHeaders });
  }
}
export function nativeSnapshotIdle(instance) {
  if (!(instance.activeTurns instanceof Map)) throw new Error('Native activity state unavailable.');
  const agents = instance.sessions?.context?.get('agents');
  if (typeof agents?.list !== 'function') throw new Error('Native agent state unavailable.');
  if (instance.activeTurns.size || [...agents.list()].some((agent) => agent.status === 'running'))
    throw new Error('Native writing is active; snapshot was not started.');
}
export async function migrationSnapshotGateway(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(SNAPSHOT_PATH)) return null;
  const kind = path.slice(SNAPSHOT_PATH.length);
  if (!migrationAuthorized(request, env))
    return Response.json({ error: 'Not found.' }, { status: 404, headers: privateHeaders });
  if (!['main', 'pin'].includes(kind) || request.method !== 'POST')
    return Response.json({ error: 'Unsupported snapshot request.' }, { status: 405, headers: privateHeaders });
  const binding = kind === 'main' ? env.DSH_EDGE_INSTANCE : env.PIN_AUTH;
  return binding.getByName('owner').fetch(new Request('https://storage.internal/__private_storage_snapshot' + new URL(request.url).search, {
    method: 'POST', headers: {
      authorization: request.headers.get('authorization'), 'x-novel-migration': 'export-v1',
    },
  }));
}
export function snapshotRecords(text) {
  if (new TextEncoder().encode(text).length > SNAPSHOT_LIMIT) throw new Error('Snapshot is too large.');
  const records = text.trimEnd().split('\n').map((line) => JSON.parse(line));
  const header = records[0], end = records.at(-1);
  if (header?.type !== 'header' || header.version !== 1 || !['main', 'pin'].includes(header.kind) || end?.type !== 'end')
    throw new Error('Incomplete or unsupported snapshot.');
  if (records.filter((r) => r.type === 'row').length !== end.rows || records.filter((r) => r.type === 'kv').length !== end.keys)
    throw new Error('Snapshot counts do not match.');
  return records;
}
// Bootstrap-only importer; NOT routed or exported by the production Worker.
// Target must be empty, including KV. The original runtime is not constructed
// until both stores have been restored and verified in an isolated directory.
export function restoreStorageSnapshot(storage, text) {
  const records = snapshotRecords(text), header = records[0];
  storage.transactionSync(() => {
    if ([...storage.sql.exec("SELECT name FROM sqlite_schema WHERE lower(name) NOT GLOB '_cf_*' AND lower(name) NOT GLOB '__cf_*' AND name NOT GLOB 'sqlite_*'")].length || [...storage.kv.list()].length)
      throw new Error('Refusing to overwrite nonempty destination storage.');
    storage.sql.exec('PRAGMA defer_foreign_keys = ON');
    for (const item of header.schema.filter((s) => s.type === 'table')) storage.sql.exec(item.sql);
    let table;
    const seenTables = new Set(), seenKeys = new Set();
    for (const record of records.slice(1, -1)) {
      if (record.type === 'table') {
        if (seenTables.has(record.name) || ![...header.schema.filter((s) => s.type === 'table').map((s) => s.name), 'sqlite_sequence'].includes(record.name))
          throw new Error('Invalid or repeated snapshot table.');
        seenTables.add(record.name);
        table = record;
        if (table.name === 'sqlite_sequence') storage.sql.exec('DELETE FROM sqlite_sequence');
      } else if (record.type === 'row') {
        if (!table || record.cells.length !== table.columns.length) throw new Error('Invalid snapshot row.');
        const sql = 'INSERT INTO ' + quote(table.name) + '(' + table.columns.map(quote).join(',') + ') VALUES(' + record.cells.map(([type]) => type === 'integer' ? 'CAST(? AS INTEGER)' : '?').join(',') + ')';
        storage.sql.exec(sql, ...record.cells.map(([type, value]) => type === 'blob' ? fromHex(value) : type === 'real' ? decodeStorageValue(value) : value));
      } else if (record.type === 'kv') {
        if (typeof record.key !== 'string' || seenKeys.has(record.key)) throw new Error('Invalid snapshot key.');
        seenKeys.add(record.key);
        storage.kv.put(record.key, decodeStorageValue(record.value));
      } else throw new Error('Unknown snapshot record.');
    }
    if (header.schema.filter((s) => s.type === 'table').some((s) => !seenTables.has(s.name))) throw new Error('Missing snapshot table.');
    for (const item of header.schema.filter((s) => s.type !== 'table')) storage.sql.exec(item.sql);
    if ([...storage.sql.exec('PRAGMA foreign_key_check')].length) throw new Error('Restored foreign keys are invalid.');
  });
  // Alarms deliberately remain paused during verification: restoring an old
  // scheduled task into a second live host would create a second data writer.
  return { restored: true, kind: header.kind, ...records.at(-1), alarmPaused: header.alarm };
}
