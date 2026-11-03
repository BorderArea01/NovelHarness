// Node driver for the SAME SQLite VFS schema, not a mirror or text-file copy.
// This experiment deliberately cannot open the production candidate database.
import Database from 'better-sqlite3';
import { resolve, relative, isAbsolute, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
let configuredStorage;

export async function initializeNovelStorage(path, options) {
  if (configuredStorage) {
    if (configuredStorage.path !== resolve(path))
      throw new Error('A second manuscript store is not allowed.');
    return configuredStorage;
  }
  configuredStorage = await openNovelStorage(path, options);
  return configuredStorage;
}
export function isVirtualPath(path) {
  return (
    typeof path === 'string' &&
    ['/workspace', '/tmp'].some((root) => path === root || path.startsWith(root + '/'))
  );
}
export function virtualStat(path) {
  if (!isVirtualPath(path) || !configuredStorage) throw new Error('Virtual filesystem is not initialized.');
  return configuredStorage.fs.statSync(path);
}
export function virtualRealpath(path) {
  if (!isVirtualPath(path) || !configuredStorage) throw new Error('Virtual filesystem is not initialized.');
  const canonical = canonicalVirtualPath(path, configuredStorage);
  if (!isVirtualPath(canonical)) throw new Error('Virtual path points outside its execution world.');
  return canonical;
}
// The upstream provider's realpathSync normalizes spelling but does not return
// the followed symlink spelling. Node DSH needs canonical target identities for
// observations/history, so resolve links through the same provider explicitly.
export function canonicalVirtualPath(path, storage, allowMissing = false) {
  let pending = posix.resolve('/', path).split('/').filter(Boolean),
    parts = [],
    links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    const candidate = '/' + [...parts, part].join('/');
    let stat;
    try {
      stat = storage.fs.lstatSync(candidate);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return posix.resolve(candidate, ...pending);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (++links > 40) {
        const error = new Error('Too many virtual symlinks');
        error.code = 'ELOOP';
        throw error;
      }
      const target = storage.fs.readlinkSync(candidate);
      if (target.startsWith('/')) parts = [];
      pending = target.split('/').concat(pending);
    } else parts.push(part);
  }
  return '/' + parts.join('/');
}
export function ensureVirtualDirectory(path) {
  if (!isVirtualPath(path) || !configuredStorage) throw new Error('Virtual filesystem is not initialized.');
  configuredStorage.fs.mkdirSync(path, { recursive: true });
}

export async function createEmptyNovelStorage(filename, { dataRoot } = {}) {
  const scope = resolve('data/official-validation/integration');
  const path = resolve(filename);
  const rel = relative(scope, path);
  if (
    dataRoot
      ? path !== resolve(dataRoot, 'main.sqlite')
      : !/^visitors[/\\][a-f0-9]{64}[/\\]main\.sqlite$/.test(rel)
  )
    throw new Error('Empty stores may only be created in the anonymous deployment visitor directory.');
  const { initializeSchema } = await import(pathToFileURL(resolve(scope, 'vfs.mjs')));
  const raw = new Database(path);
  try {
    initializeSchema(
      {
        transactionSync: (fn) => raw.transaction(fn)(),
        run: (sql, ...args) => raw.prepare(sql).run(...args),
        one: (sql, ...args) => raw.prepare(sql).get(...args),
      },
      Date.now,
    );
  } finally {
    raw.close();
  }
  const storage = await openNovelStorage(path, { dataRoot });
  try {
    storage.fs.mkdirSync('/workspace/novels', { recursive: true });
    storage.fs.mkdirSync('/tmp', { recursive: true });
  } finally {
    storage.close();
  }
}

export async function openNovelStorage(filename, { dataRoot } = {}) {
  const provider = resolve('data/official-validation/integration');
  const allowed = dataRoot ? resolve(dataRoot) : provider;
  const path = resolve(filename);
  const rel = relative(allowed, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !path.endsWith('.sqlite'))
    throw new Error('Only a dedicated isolated SQLite copy may be opened for writing.');
  const { SQLiteWorkspaceProvider } = await import(pathToFileURL(resolve(provider, 'vfs.mjs')));
  const raw = new Database(path, { fileMustExist: true });
  try {
    if (
      raw.pragma('quick_check', { simple: true }) !== 'ok' ||
      raw.prepare("SELECT v FROM vfs_meta WHERE k='schema_version'").get()?.v !== 8
    )
      throw new Error('The original SQLite VFS schema/integrity does not match.');
    const db = {
      get inTransaction() {
        return raw.inTransaction;
      },
      transactionSync(fn) {
        return raw.transaction(() => {
          const value = fn();
          if (value && typeof value.then === 'function')
            throw new Error('Async work inside a VFS transaction is prohibited.');
          return value;
        })();
      },
      run(sql, ...values) {
        raw.prepare(sql).run(...values);
      },
      all(sql, ...values) {
        return raw.prepare(sql).all(...values);
      },
      one(sql, ...values) {
        return raw.prepare(sql).get(...values);
      },
      scalar(sql, ...values) {
        const row = this.one(sql, ...values);
        return row && Object.values(row)[0];
      },
      sql: {
        exec(sql, ...values) {
          const query = raw.prepare(sql);
          const rows = query.reader ? query.all(...values) : (query.run(...values), []);
          return {
            toArray: () => rows,
            [Symbol.iterator]: function* () {
              yield* rows;
            },
          };
        },
      },
    };
    const fs = new SQLiteWorkspaceProvider(db);
    return {
      fs,
      db,
      raw,
      path,
      close: () => {
        if (raw.open) raw.close();
      },
    };
  } catch (error) {
    raw.close();
    throw error;
  }
}

export function vfsFileFingerprint(storage, prefix = '/workspace/novels/') {
  const rows = storage.raw
    .prepare(
      `WITH RECURSIVE tree(inode,path) AS (
    SELECT 1,'' UNION ALL SELECT d.child_inode,t.path || '/' || d.name
    FROM vfs_dirents d JOIN tree t ON d.parent_inode=t.inode
  ) SELECT t.path,n.inode,n.type,n.size FROM tree t JOIN vfs_nodes n ON t.inode=n.inode ORDER BY t.path`,
    )
    .all();
  const hashes = [];
  for (const row of rows)
    if (row.type === 'file' && row.path.startsWith(prefix)) {
      const content = storage.fs.readFileSync(row.path);
      hashes.push({
        path: row.path,
        bytes: content.length,
        hash: createHash('sha256').update(content).digest('hex'),
      });
    }
  return hashes;
}
