// Online SQLite backup, no exports through Cloudflare, no story/settings changes.
import { readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import Database from 'better-sqlite3';
import { requireIdleRuntime } from './runtime-activity.mjs';
import { privateDirectory } from './private-directory.mjs';
import { bookStorageFingerprint } from './book-storage-fingerprint.mjs';
if (!process.argv.includes('--owner-approved-idle-restart'))
  throw new Error('Specific idle restart authorization required.');
const root = resolve('data/local-host');
const active = JSON.parse(await readFile(resolve(root, 'active.json'), 'utf8'));
const running = JSON.parse(await readFile(resolve(root, 'running.json'), 'utf8'));
if (running.pid !== active.pid || running.candidate !== active.candidate)
  throw new Error('Host process identity is not confirmed.');
const owner = (await readFile(resolve(active.candidate, 'owner-key.txt'), 'utf8')).trim();
const origin = 'http://127.0.0.1:3211';
const idle = await requireIdleRuntime(origin, owner, fetch, { pinWrapper: true });
if (process.argv.includes('--check-only')) {
  console.log(JSON.stringify(idle));
} else {
  const folder = resolve(root, 'backups', 'before-ui-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await privateDirectory(folder);
  await writeFile(resolve(folder, 'active-before.json'), JSON.stringify(active, null, 2), { mode: 0o600 });
  const storage = resolve(active.candidate, 'storage'),
    files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !/-(wal|shm)$/.test(path)) files.push(path);
    }
  }
  await visit(storage);
  let count = 0;
  for (const path of files) {
    const rel = relative(storage, path),
      target = resolve(folder, 'storage', rel);
    await privateDirectory(resolve(target, '..'));
    if (path.endsWith('.sqlite')) {
      const source = new Database(path, { readonly: true, fileMustExist: true });
      try {
        await source.backup(target);
      } finally {
        source.close();
      }
      const copied = new Database(target, { readonly: true, fileMustExist: true });
      try {
        if (copied.pragma('quick_check', { simple: true }) !== 'ok')
          throw new Error('Online backup integrity check failed.');
      } finally {
        copied.close();
      }
      count++;
    } else await copyFile(path, target);
  }
  await copyFile(resolve(active.candidate, 'owner-key.txt'), resolve(folder, 'owner-key.txt'));
  await copyFile(resolve(active.candidate, 'candidate.json'), resolve(folder, 'candidate.json'));
  const receipt = {
    format: 'novel-local-online-backup-v1',
    folder,
    at: new Date().toISOString(),
    candidate: active.candidate,
    namespaceStable: true,
    sqliteFiles: count,
    integrityChecked: true,
    sourceNotStopped: true,
    aiStopped: false,
    previousActive: active,
  };
  const login = await fetch(origin + '/api/auth/recover', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: owner }),
  });
  if (!login.ok) throw new Error('Native metadata authentication failed; live host not stopped.');
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  await login.arrayBuffer();
  const booksResponse = await fetch(origin + '/api/novels', { headers: { cookie } });
  const sessionsResponse = await fetch(origin + '/api/sessions?limit=100', { headers: { cookie } });
  if (!booksResponse.ok || !sessionsResponse.ok)
    throw new Error('Native identity verification failed; live host not stopped.');
  const books = await booksResponse.json(),
    sessions = await sessionsResponse.json();
  if (sessions.hasMore !== false)
    throw new Error('Complete session identities required; live host not stopped.');
  receipt.identities = {
    books: books.books.map((book) => book.id).sort(),
    sessions: sessions.sessions.map((session) => session.id ?? session.sessionId).sort(),
  };
  receipt.bookFingerprint = bookStorageFingerprint(resolve(folder, 'storage'));
  await writeFile(resolve(folder, 'backup.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await writeFile(resolve(root, 'last-ui-backup.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      backupReady: true,
      sqliteFiles: count,
      integrityChecked: true,
      folder,
      sourceNotStopped: true,
    }),
  );
}
