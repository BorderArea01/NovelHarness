// Read-only promotion preflight. No runtime boot, model call, restore or switch.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const activePath = resolve('data/local-host/active.json');
const activeBytes = await readFile(activePath);
const active = JSON.parse(activeBytes);
const stores = join(active.candidate, 'storage/do');
const main = (await readdir(stores)).filter(name => name.endsWith('-main'));
assert.equal(main.length, 1);
const databases = (await readdir(join(stores, main[0]))).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
assert.equal(databases.length, 1);
const { SQLiteWorkspaceProvider } = await import(pathToFileURL(resolve('data/official-validation/integration/vfs.mjs')));
function inspect(path) {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  const db = {
    one: (sql, ...args) => raw.prepare(sql).get(...args),
    all: (sql, ...args) => raw.prepare(sql).all(...args),
    scalar(sql, ...args) { return Object.values(this.one(sql, ...args) ?? {})[0]; },
    run() { throw new Error('Promotion audit is read-only.'); },
  };
  try {
    assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
    const fs = new SQLiteWorkspaceProvider(db);
    const rows = raw.prepare(`WITH RECURSIVE tree(inode,path) AS (
      SELECT 1,'' UNION ALL SELECT d.child_inode,t.path || '/' || d.name
      FROM vfs_dirents d JOIN tree t ON d.parent_inode=t.inode
    ) SELECT t.path,n.type,n.size FROM tree t JOIN vfs_nodes n ON t.inode=n.inode ORDER BY t.path`).all();
    const books = new Map();
    for (const row of rows) {
      if (row.type !== 'file' || !/^\/workspace\/novels\/b-[a-f0-9]{32}\//.test(row.path)) continue;
      const id = row.path.split('/')[3];
      if (!books.has(id)) books.set(id, new Map());
      books.get(id).set(row.path, createHash('sha256').update(fs.readFileSync(row.path)).digest('hex'));
    }
    return { books, legacySessions: raw.prepare('SELECT count(*) AS n FROM dsh_sessions').get().n };
  } finally { raw.close(); }
}
const formal = inspect(join(stores, main[0], databases[0]));
const stage = inspect(resolve('data/official-validation/integration/lan-staging/main.sqlite'));
let identical = 0, changed = 0, onlyFormal = 0, onlyStage = 0;
for (const [id, files] of formal.books) {
  const other = stage.books.get(id);
  if (!other) { onlyFormal++; continue; }
  if (files.size === other.size && [...files].every(([path, hash]) => other.get(path) === hash)) identical++;
  else changed++;
}
for (const id of stage.books.keys()) if (!formal.books.has(id)) onlyStage++;
assert.deepEqual(await readFile(activePath), activeBytes, 'Formal pointer changed during read-only audit.');
console.log(JSON.stringify({
  formalIntegrity: 'ok', stagingIntegrity: 'ok', formalBooksIncludingArchivedFiles: formal.books.size,
  stagingBooksIncludingArchivedFiles: stage.books.size, identicalBooks: identical, divergedBooks: changed,
  onlyInFormal: onlyFormal, onlyInStaging: onlyStage, formalLegacySessionRows: formal.legacySessions,
  formalRuntime: 'dsh-edge/workerd', stagingRuntime: 'official-dsh/node-jsonl',
  sourceChanged: false, formalWrites: 0, modelCalls: 0,
}));
