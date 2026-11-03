// Owner-requested recovery export. No deployments, restore, model calls or story writes.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { verificationTransport } from './verification-transport.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';

if (!process.argv.includes('--owner-requested')) throw new Error('Explicit export request required.');
const owned = resolve('data/cloud-platform');
const state = JSON.parse(await readFile(resolve(owned, 'deployment.json'), 'utf8'));
const origin = new URL(state.url).origin;
if (!origin.endsWith('.pages.dev')) throw new Error('Unexpected configured production origin.');
const key = (await readFile(resolve(owned, 'owner-key.txt'), 'utf8')).trim();
const folder = resolve(owned, 'exports', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
await mkdir(folder, { recursive: true, mode: 0o700 });
if (process.platform === 'win32') {
  const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=$env:NOVEL_EXPORT_FOLDER; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[IO.Directory]::GetAccessControl($p); $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit",[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)); [IO.Directory]::SetAccessControl($p,$a); if(![IO.Directory]::GetAccessControl($p).AreAccessRulesProtected){throw "ACL verification failed"}'],
  { windowsHide: true, env: { ...process.env, NOVEL_EXPORT_FOLDER: folder }, encoding: 'utf8' });
  if (acl.status !== 0) {
    console.log(JSON.stringify({ stage: 'directory-permissions', exitCode: acl.status,
      launchError: acl.error?.code, diagnostic: acl.stderr?.slice(0, 2500) }));
    throw new Error('Private backup directory permissions could not be set.');
  }
}
const report = {
  format: 'novel-live-recovery-export-v1', startedAt: new Date().toISOString(),
  source: origin, storage: 'original-production-durable-object',
  databaseSwitched: false, deployed: false, modelCalls: 0, storyWrites: 0,
  globalCredentialsExported: false, rawDatabaseDump: false,
  books: [], sessions: [], issues: [], requests: 0, complete: false,
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function store(path, bytes) {
  const dest = resolve(folder, path);
  if (!dest.startsWith(folder + sep) || relative(folder, dest).startsWith('..')) throw new Error('Unsafe local export path.');
  await mkdir(resolve(dest, '..'), { recursive: true, mode: 0o700 });
  await writeFile(dest, bytes, { mode: 0o600 });
}
async function checkpoint() {
  await store('export-report.json', JSON.stringify(report, null, 2));
}
const transport = await verificationTransport();
let cookie = '';
async function request(path, init = {}) {
  if (++report.requests > 3000) throw new Error('Bounded export request limit reached.');
  const target = new URL(path, origin);
  if (target.origin !== origin) throw new Error('Cross-origin export denied.');
  const headers = new Headers(init.headers);
  headers.set('origin', origin);
  if (cookie) headers.set('cookie', cookie);
  return transport.request(target, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
}
async function requireOk(response, stage) {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(`${stage}: HTTP ${response.status}`);
}
try {
  const login = await request('/api/auth/recover', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }),
  });
  await requireOk(login, 'owner authentication');
  cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  if ((await login.json()).authenticated !== true || !cookie) throw new Error('Authenticated session not established.');
  console.log(JSON.stringify({ stage: 'authenticated', folder }));
  // Retain every successfully retrieved file immediately, even if later validation fails.
  const client = makeWorkspaceClient(async (path, init) => {
    if (init?.method === 'PUT' || init?.method === 'DELETE') throw new Error('Story mutation denied by export.');
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      if (path !== '/api/workspace/exec' || body.cwd !== '/workspace' ||
          !/^find \/workspace\/novels\/b-[a-f0-9]{32} (?:-type f|! -type f ! -type d) -print0$/.test(body.command))
        throw new Error('Non-read-only scan denied by export.');
    }
    const response = await request(path, init);
    const url = new URL(path, origin);
    if (response.ok && url.pathname === '/api/workspace/file' && (!init?.method || init.method === 'GET')) {
      const source = url.searchParams.get('path');
      if (!source?.startsWith('/workspace/novels/')) throw new Error('Unexpected book file source.');
      const bytes = Buffer.from(await response.arrayBuffer());
      const relativePath = source.slice('/workspace/novels/'.length);
      const slash = relativePath.indexOf('/');
      // The remote POSIX filesystem is case-sensitive; Windows is not. Never
      // merge different remote names (or interpret a name as a Windows ADS).
      await store('retrieved-files-by-pathhash/' + relativePath.slice(0, slash) + '/' + hash(relativePath.slice(slash + 1)) + '.bin', bytes);
      return new Response(bytes, { status: response.status, headers: response.headers });
    }
    return response;
  });
  const books = await client.list();
  await store('book-catalog.json', JSON.stringify(books, null, 2));
  console.log(JSON.stringify({ stage: 'book-catalog', books: books.length }));
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const item = { id: book.id, complete: false };
    report.books.push(item);
    try {
      const backup = await client.backup(book.id, { onProgress: ({ phase, done, total }) => {
        if (done === total || done % 20 === 0) console.log(JSON.stringify({ stage: 'book-' + phase, book: i + 1, done, total }));
      } });
      const bytes = Buffer.from(JSON.stringify(backup));
      const path = `books/${book.id}.json`;
      await store(path, bytes);
      const saved = JSON.parse(await readFile(resolve(folder, path), 'utf8'));
      for (const file of saved.files) {
        const bytes = Buffer.from(file.data, 'base64');
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Local backup integrity check failed.');
        const raw = await readFile(resolve(folder, 'retrieved-files-by-pathhash', book.id, hash(file.path) + '.bin'));
        if (!raw.equals(bytes)) throw new Error('Retrieved file and backup mismatch.');
      }
      Object.assign(item, { complete: true, path, files: backup.files.length,
        bytes: backup.files.reduce((s, f) => s + f.bytes, 0), sha256: hash(bytes),
        remoteDoubleReadVerified: true, localHashesVerified: true,
        chapters: backup.files.filter((f) => /^chapters\/.*\.md$/.test(f.path)).length,
        historyFiles: backup.files.filter((f) => /(?:history|snapshots|versions)/i.test(f.path)).length });
    } catch (error) {
      item.error = /^.*HTTP \d+$/.test(error.message) ? error.message : 'Book export or consistency verification failed; retrieved files retained.';
    }
    await checkpoint();
    console.log(JSON.stringify({ stage: 'book-finished', book: i + 1, complete: item.complete, files: item.files }));
  }
  const sessions = [];
  let after;
  for (let page = 0; page < 100; page++) {
    const url = new URL('/api/sessions', origin);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const response = await request(url);
    await requireOk(response, 'session catalog');
    const data = await response.json();
    if (!Array.isArray(data.sessions)) throw new Error('Invalid session catalog.');
    sessions.push(...data.sessions);
    await store('session-catalog.json', JSON.stringify(sessions, null, 2));
    if (data.hasMore === false) { report.sessionCatalogComplete = true; break; }
    if (typeof data.nextAfter !== 'string' || data.nextAfter === after) throw new Error('Incomplete session pagination.');
    after = data.nextAfter;
  }
  console.log(JSON.stringify({ stage: 'session-catalog', sessions: sessions.length }));
  const seen = new Set();
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    if (typeof session.id !== 'string' || seen.has(session.id)) throw new Error('Invalid or duplicate session identity.');
    seen.add(session.id);
    const name = hash(session.id).slice(0, 24);
    const item = { id: session.id, path: `sessions/${name}.zip`, complete: false, statusAtCatalog: session.status };
    report.sessions.push(item);
    try {
      const response = await request('/api/session.export?sessionId=' + encodeURIComponent(session.id) + '&includeDescendants=false');
      await requireOk(response, 'session export');
      if (!response.headers.get('content-type')?.includes('application/zip')) throw new Error('Unexpected export content type.');
      await mkdir(resolve(folder, 'sessions'), { recursive: true, mode: 0o700 });
      const partial = resolve(folder, item.path + '.partial');
      const checksum = createHash('sha256');
      let size = 0;
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > 512 * 1024 * 1024) return cb(new Error('Session export exceeds safety bound.'));
        checksum.update(chunk); cb(null, chunk);
      } }), createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      if (size < 22) throw new Error('Empty session archive.');
      await rename(partial, resolve(folder, item.path));
      Object.assign(item, { complete: true, bytes: size, sha256: checksum.digest('hex') });
    } catch (error) {
      item.error = /^.*HTTP \d+$/.test(error.message) ? error.message : 'Session archive export failed; partial file retained if present.';
    }
    await checkpoint();
    console.log(JSON.stringify({ stage: 'session-finished', session: i + 1, complete: item.complete, bytes: item.bytes }));
  }
  report.complete = report.books.every((b) => b.complete) && report.sessionCatalogComplete === true && report.sessions.every((s) => s.complete);
  report.scope = 'Book-directory files and native session exports; not a raw SQLite dump or global credential backup.';
} catch (error) {
  report.issues.push(/^.*HTTP \d+$/.test(error.message) ? error.message : 'Export stopped safely; any retrieved data remains in this directory.');
} finally {
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  await transport.close();
  console.log(JSON.stringify({ stage: 'finished', folder, complete: report.complete,
    books: report.books.length, booksComplete: report.books.filter((b) => b.complete).length,
    sessions: report.sessions.length, sessionsComplete: report.sessions.filter((s) => s.complete).length,
    requests: report.requests, issues: report.issues }));
}
