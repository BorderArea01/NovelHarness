// Shared protocol driver: bounded pages, keyset cursors, stable source bookmark.
// Callers own networking/files and must not expose source payloads in logs.
export async function transferStoragePages(readPage, { onHeader = async () => {}, onPage = async () => {} } = {}) {
  const header = await readPage(new URLSearchParams({ page: 'header' }));
  if (header?.version !== 2 || header.section !== 'header' || typeof header.bookmark !== 'string'
      || !Array.isArray(header.tables)) throw new Error('Invalid native storage header.');
  await onHeader(header);
  let ordinal = 0, rows = 0, keys = 0;
  for (const [section, table] of [...header.tables.map((_, i) => ['sql', i]), ['kv', null]]) {
    let after = null, sectionRows = 0;
    for (let count = 0; ; count++) {
      if (count >= 100000) throw new Error('Storage transfer exceeded its page bound.');
      const params = new URLSearchParams({ page: section, bookmark: header.bookmark });
      if (table !== null) params.set('table', String(table));
      if (after !== null) params.set('after', JSON.stringify(after));
      const page = await readPage(params);
      if (page?.version !== 2 || page.bookmark !== header.bookmark || page.section !== section || page.kind !== header.kind
          || (table !== null && page.table !== table) || !Array.isArray(page.records) || typeof page.done !== 'boolean')
        throw new Error('Storage source changed or returned an invalid page.');
      if (!page.done && (!page.records.length || JSON.stringify(page.after) === JSON.stringify(after)))
        throw new Error('Storage page cursor did not advance.');
      if (page.records.some((r) => r.type !== (section === 'sql' ? 'row' : 'kv'))) throw new Error('Unexpected storage record.');
      await onPage(page, ordinal++);
      sectionRows += page.records.length;
      if (section === 'sql') rows += page.records.length; else keys += page.records.length;
      after = page.after;
      if (page.done) break;
    }
    if (table !== null && sectionRows !== header.tables[table].rows) throw new Error('Storage row counts do not match.');
  }
  const final = await readPage(new URLSearchParams({ page: 'header', bookmark: header.bookmark }));
  if (JSON.stringify(final) !== JSON.stringify(header)) throw new Error('Storage source changed during export.');
  return { header, pages: ordinal, rows, keys, bookmarkConsistent: true };
}
