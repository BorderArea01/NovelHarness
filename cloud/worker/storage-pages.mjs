import { encodeStorageValue, decodeStorageValue, toHex, fromHex } from './storage-value.mjs';
const q = (name) => '"' + name.replaceAll('"', '""') + '"';
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE lower(name) NOT GLOB '_cf_*' AND lower(name) NOT GLOB '__cf_*' AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type,name";
const headers = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
const PAGE_TARGET = 512 * 1024;
export const PAGE_LIMIT = 8 * 1024 * 1024;
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const fault = (code) => Object.assign(new Error('Storage paging was refused.'), { snapshotCode: code });
function schema(storage) {
  const items = [...storage.sql.exec(schemaQuery)];
  if (items.some((s) => s.type === 'table' && /CREATE\s+VIRTUAL\s+TABLE/i.test(s.sql))) throw fault('virtual_table');
  return items;
}
function describe(storage, name, definition = '') {
  const info = [...storage.sql.exec('PRAGMA table_xinfo(' + q(name) + ')')];
  const columns = info.filter((c) => c.hidden === 0).map((c) => c.name);
  let order;
  if (!/\bWITHOUT\s+ROWID\b/i.test(definition)) {
    const alias = ['_rowid_', 'rowid', 'oid'].find((key) => !columns.some((col) => col.toLowerCase() === key));
    if (!alias) throw fault('rowid_capability');
    columns.unshift(alias); order = [alias];
  } else order = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (!order.length || !columns.length) throw fault('table_capability');
  return { name, columns, order };
}
function tables(storage, items) {
  const pending = items.filter((s) => s.type === 'table').map((s) => describe(storage, s.name, s.sql)), result = [];
  // Each restored batch commits independently in a NEW inactive candidate.
  // Restore referenced tables before their children; never turn off FK checks.
  while (pending.length) {
    const index = pending.findIndex((table) => [...storage.sql.exec('PRAGMA foreign_key_list(' + q(table.name) + ')')]
      .every((fk) => fk.table === table.name || !pending.some((other) => other.name === fk.table)));
    if (index < 0) throw fault('cyclic_schema');
    result.push(...pending.splice(index, 1));
  }
  if ([...storage.sql.exec("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'")].length) result.push(describe(storage, 'sqlite_sequence'));
  return result;
}
function encodeCell(type, value) {
  if (!['integer', 'real', 'text', 'null', 'blob'].includes(type)) throw fault('cell_type');
  return [type, type === 'blob' ? toHex(value) : type === 'real' ? encodeStorageValue(value) : value];
}
function decodeCell([type, value]) {
  if (!['integer', 'real', 'text', 'null', 'blob'].includes(type)) throw fault('cell_type');
  if (type === 'integer' && (typeof value !== 'string' || !/^-?\d{1,20}$/.test(value))) throw fault('cell_type');
  return type === 'blob' ? fromHex(value) : type === 'real' ? decodeStorageValue(value) : value;
}
export function captureStoragePage(storage, kind, params, { bookmark, objectId, alarm }) {
  return storage.transactionSync(() => {
    if (!storage.kv?.list) throw fault('kv_capability');
    const items = schema(storage), descriptions = tables(storage, items), section = params.get('page');
    if (section === 'header') return { version: 2, kind, section, objectId, bookmark, alarm, schema: items,
      tables: descriptions.map((table) => ({ ...table, rows: [...storage.sql.exec('SELECT COUNT(*) AS n FROM ' + q(table.name))][0].n })) };
    const records = [];
    let bytes = 0, after = params.has('after') ? JSON.parse(params.get('after')) : null, done = true;
    if (section === 'sql') {
      const index = Number(params.get('table'));
      if (!/^\d+$/.test(params.get('table') ?? '') || !descriptions[index]) throw fault('table_cursor');
      const table = descriptions[index];
      if (after !== null && (!Array.isArray(after) || after.length !== table.order.length)) throw fault('table_cursor');
      const select = table.columns.flatMap((col, i) => ['typeof(' + q(col) + ') AS ' + q('t' + i), 'CASE WHEN typeof(' + q(col) + ")='integer' THEN CAST(" + q(col) + ' AS TEXT) ELSE ' + q(col) + ' END AS ' + q('v' + i)]).join(',');
      const where = after === null ? '' : ' WHERE (' + table.order.map(q).join(',') + ') > (' + after.map(([type]) => type === 'integer' ? 'CAST(? AS INTEGER)' : '?').join(',') + ')';
      let count = 0;
      for (const row of storage.sql.exec('SELECT ' + select + ' FROM ' + q(table.name) + where + ' ORDER BY ' + table.order.map(q).join(',') + ' LIMIT 17', ...(after?.map(decodeCell) ?? []))) {
        if (count === 16) { done = false; break; }
        const cells = table.columns.map((_, i) => encodeCell(row['t' + i], row['v' + i]));
        const record = { type: 'row', cells }, cost = size(record);
        if (cost > PAGE_LIMIT - 16384) throw fault('row_budget');
        if (records.length && bytes + cost > PAGE_TARGET) { done = false; break; }
        records.push(record); bytes += cost; count++;
        after = table.order.map((column) => cells[table.columns.indexOf(column)]);
      }
      return { version: 2, kind, section, bookmark, table: index, records, after, done };
    }
    if (section !== 'kv' || (after !== null && typeof after !== 'string')) throw fault('page_cursor');
    let count = 0;
    for (const [key, value] of storage.kv.list({ limit: 17, ...(after === null ? {} : { startAfter: after }) })) {
      if (count === 16) { done = false; break; }
      const record = { type: 'kv', key, value: encodeStorageValue(value) }, cost = size(record);
      if (cost > PAGE_LIMIT - 16384) throw fault('row_budget');
      if (records.length && bytes + cost > PAGE_TARGET) { done = false; break; }
      records.push(record); bytes += cost; count++; after = key;
    }
    return { version: 2, kind, section, bookmark, records, after, done };
  });
}
export async function storagePageResponse(ctx, kind, params, { beforeCapture = () => {}, local = false } = {}) {
  const result = await ctx.blockConcurrencyWhile(async () => {
    // Catch inside the gate: a rejected export must NEVER reset the live object.
    try {
      const before = local ? 'offline-local' : await ctx.storage.getCurrentBookmark();
      if (params.has('bookmark') && params.get('bookmark') !== before) throw fault('source_changed');
      const alarm = await ctx.storage.getAlarm();
      beforeCapture();
      const page = captureStoragePage(ctx.storage, kind, params, { bookmark: before, objectId: ctx.id.toString(), alarm });
      if (!local && await ctx.storage.getCurrentBookmark() !== before) throw fault('source_changed');
      return page;
    } catch (error) { return { error: '存储分块未完成；原数据未修改。', reason: error.snapshotCode ?? 'storage_page' }; }
  });
  return Response.json(result, { status: result.error ? (result.reason === 'source_changed' ? 409 : 503) : 200, headers });
}
export function beginPagedRestore(storage, header, kind) {
  if (header?.version !== 2 || header.section !== 'header' || header.kind !== kind || !Array.isArray(header.schema) || !Array.isArray(header.tables)) throw fault('invalid_header');
  storage.transactionSync(() => {
    if ([...storage.sql.exec(schemaQuery)].length || [...storage.kv.list()].length) throw fault('target_not_empty');
    for (const item of header.schema.filter((s) => s.type === 'table')) storage.sql.exec(item.sql);
    if (header.tables.some((t) => t.name === 'sqlite_sequence')) storage.sql.exec('DELETE FROM sqlite_sequence');
  });
  return { header, ordinal: 0, rows: header.tables.map(() => 0), keys: 0, seenKeys: new Set(), committed: false };
}
export function restoreStoragePage(storage, progress, page, ordinal) {
  if (!progress || progress.committed || ordinal !== progress.ordinal || page?.version !== 2
    || page.bookmark !== progress.header.bookmark || page.kind !== progress.header.kind || !Array.isArray(page.records)) throw fault('restore_cursor');
  let rows = 0, keys = 0;
  const newKeys = [];
  storage.transactionSync(() => {
    storage.sql.exec('PRAGMA defer_foreign_keys = ON');
    if (page.section === 'sql') {
      const table = progress.header.tables[page.table];
      if (!table || !Number.isInteger(page.table)) throw fault('restore_cursor');
      if (table.name === 'sqlite_sequence' && progress.rows[page.table] === 0) storage.sql.exec('DELETE FROM sqlite_sequence');
      for (const record of page.records) {
        if (record.type !== 'row' || record.cells.length !== table.columns.length) throw fault('restore_row');
        storage.sql.exec('INSERT INTO ' + q(table.name) + '(' + table.columns.map(q).join(',') + ') VALUES(' + record.cells.map(([type]) => type === 'integer' ? 'CAST(? AS INTEGER)' : '?').join(',') + ')', ...record.cells.map(decodeCell));
        rows++;
      }
    } else if (page.section === 'kv') for (const record of page.records) {
      if (record.type !== 'kv' || typeof record.key !== 'string' || progress.seenKeys.has(record.key) || newKeys.includes(record.key)) throw fault('restore_key');
      storage.kv.put(record.key, decodeStorageValue(record.value)); keys++; newKeys.push(record.key);
    } else throw fault('restore_cursor');
  });
  if (page.section === 'sql') progress.rows[page.table] += rows;
  progress.keys += keys; newKeys.forEach((key) => progress.seenKeys.add(key)); progress.ordinal++;
}
export function commitPagedRestore(storage, progress, { pages, keys }) {
  if (!progress || progress.committed || progress.ordinal !== pages || progress.keys !== keys
    || progress.rows.some((rows, i) => rows !== progress.header.tables[i].rows)) throw fault('restore_incomplete');
  storage.transactionSync(() => {
    for (const type of ['view', 'index', 'trigger'])
      for (const item of progress.header.schema.filter((s) => s.type === type)) storage.sql.exec(item.sql);
    if ([...storage.sql.exec('PRAGMA foreign_key_check')].length) throw fault('restore_foreign_keys');
  });
  progress.committed = true;
  return { committed: true, pages, rows: progress.rows.reduce((a, b) => a + b, 0), keys, alarmsPaused: true };
}
