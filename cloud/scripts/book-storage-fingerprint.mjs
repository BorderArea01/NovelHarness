// Read-only, consistent SQLite snapshot. Only hashes/counts leave this helper;
// no prose, file names, credentials or raw database values are logged.
import Database from 'better-sqlite3';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export function bookStorageFingerprint(storage) {
  const dir = resolve(storage, 'do');
  const namespaces = readdirSync(dir).filter(name => name.endsWith('-main'));
  if (namespaces.length !== 1) throw new Error('Unambiguous native main storage required.');
  const folder = resolve(dir, namespaces[0]);
  const files = readdirSync(folder).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
  if (files.length !== 1) throw new Error('Unambiguous main SQLite required.');
  const db = new Database(resolve(folder, files[0]), { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      let parent = 1;
      for (const name of ['workspace', 'novels']) {
        const row = db.prepare('SELECT child_inode FROM vfs_dirents WHERE parent_inode=? AND name=?').get(parent, name);
        if (!row) throw new Error('Native novel root unavailable.');
        parent = row.child_inode;
      }
      const nodes = db.prepare(`WITH RECURSIVE tree(inode,path) AS (
        SELECT child_inode,name FROM vfs_dirents WHERE parent_inode=?
        UNION ALL SELECT d.child_inode,t.path || '/' || d.name FROM vfs_dirents d JOIN tree t ON d.parent_inode=t.inode
      ) SELECT t.path,n.inode,n.type,n.size,n.link_target,n.manifest_hash,n.stub_size FROM tree t JOIN vfs_nodes n ON n.inode=t.inode ORDER BY t.path`).all(parent);
      const hash = createHash('sha256'); let chunks = 0, bytes = 0;
      for (const node of nodes) {
        hash.update(JSON.stringify([node.path, node.type, node.size, node.link_target, node.manifest_hash, node.stub_size]) + '\n');
        for (const chunk of db.prepare('SELECT c.idx,b.bytes FROM vfs_chunks c JOIN vfs_blob_bytes b ON b.hash=c.hash WHERE c.inode=? ORDER BY c.idx').iterate(node.inode)) {
          hash.update(String(chunk.idx) + '\0'); hash.update(chunk.bytes); chunks++; bytes += chunk.bytes.length;
        }
      }
      return { algorithm: 'native-books-sha256-v1', sha256: hash.digest('hex'), nodes: nodes.length, chunks, bytes };
    })();
  } finally { db.close(); }
}
