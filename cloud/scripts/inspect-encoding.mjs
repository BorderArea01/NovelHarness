// Read-only incident inspection. Never writes manuscripts, sessions or PINs.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, access } from 'node:fs/promises';
const file = resolve('data/official-validation/integration/lan-staging/main.sqlite');
let raw = new Database(file, { readonly: true, fileMustExist: true });
if (process.argv.includes('--snapshot')) {
  const folder = resolve('data/official-validation/integration/encoding-recovery-1030');
  await mkdir(folder, { recursive: true });
  const snapshot = resolve(folder, 'incident.sqlite');
  let exists = true;
  try {
    await access(snapshot);
  } catch {
    exists = false;
  }
  if (!exists) await raw.backup(snapshot);
  raw.close();
  raw = new Database(snapshot, { readonly: true, fileMustExist: true });
}
const db = {
  one: (sql, ...args) => raw.prepare(sql).get(...args),
  all: (sql, ...args) => raw.prepare(sql).all(...args),
  scalar(sql, ...args) {
    return Object.values(this.one(sql, ...args) ?? {})[0];
  },
  run() {
    throw new Error('Read-only incident inspector');
  },
};
const { SQLiteWorkspaceProvider } = await import(
  pathToFileURL(resolve('data/official-validation/integration/vfs.mjs'))
);
const fs = new SQLiteWorkspaceProvider(db);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const measure = (b) => {
  const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(b);
  return {
    bytes: b.length,
    characters: text.length,
    han: (text.match(/\p{Script=Han}/gu) ?? []).length,
    replacement: (text.match(/\ufffd/g) ?? []).length,
    hash: sha(b),
  };
};
try {
  const rows = raw
    .prepare(
      `WITH RECURSIVE tree(inode,path) AS (
    SELECT 1,'' UNION ALL SELECT d.child_inode,t.path || '/' || d.name
    FROM vfs_dirents d JOIN tree t ON d.parent_inode=t.inode
  ) SELECT t.path,n.type,n.size,n.mtime FROM tree t JOIN vfs_nodes n ON t.inode=n.inode ORDER BY t.path`,
    )
    .all();
  const books = rows.filter((r) => /\/novels\/b-[a-f0-9]{32}\/book.json$/.test(r.path));
  const found = [];
  for (const b of books) {
    const meta = JSON.parse(fs.readFileSync(b.path, 'utf8'));
    if (meta.title !== '1030_1') continue;
    const root = b.path.slice(0, -'/book.json'.length);
    found.push({
      root,
      title: meta.title,
      files: rows
        .filter(
          (r) =>
            r.type === 'file' &&
            r.path.startsWith(root + '/') &&
            (/\/(chapters|drafts)\//.test(r.path) || r.path.includes('/.novel-history/')),
        )
        .map((r) => {
          try {
            return {
              path: r.path.slice(root.length + 1),
              at: new Date(r.mtime).toISOString(),
              ...measure(fs.readFileSync(r.path)),
            };
          } catch (e) {
            return { path: r.path.slice(root.length + 1), bytes: r.size, invalidUtf8: true };
          }
        }),
    });
  }
  console.log(JSON.stringify({ books: found }, null, 2));
} finally {
  raw.close();
}
