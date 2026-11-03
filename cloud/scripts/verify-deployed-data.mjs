// Read-only post-publication check against an owner-requested recovery export.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { verificationTransport } from './verification-transport.mjs';

const folder = resolve(process.argv[2] ?? '');
assert.ok(folder.startsWith(resolve('data/cloud-platform/exports') + sep));
const state = JSON.parse(await readFile('data/cloud-platform/deployment.json', 'utf8'));
const backup = JSON.parse(await readFile(resolve(folder, 'export-report.json'), 'utf8'));
const key = (await readFile('data/cloud-platform/owner-key.txt', 'utf8')).trim();
const transport = await verificationTransport();
let cookie = '';
const report = { checkedAt: new Date().toISOString(), revision: state.currentUi?.revision ?? state.uploadedRevision,
  verified: false, productionStoryWrites: 0, modelCalls: 0, filesChecked: 0, chapterFilesChecked: 0,
  changedFiles: [], addedBooks: 0, addedSessions: 0 };
const request = async (path, init = {}) => {
  const response = await transport.request(new URL(path, state.url), {
    ...init, headers: { origin: state.url, ...(cookie ? { cookie } : {}), ...init.headers },
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, 'Authenticated preservation check failed: HTTP ' + response.status);
  return response;
};
try {
  const login = await request('/api/auth/recover', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }) });
  cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  assert.equal((await login.json()).authenticated, true);
  const catalog = await (await request('/api/novels')).json();
  const ids = new Set(catalog.books.map((b) => b.id));
  assert.ok(backup.books.every((b) => ids.has(b.id)), 'An original book is missing.');
  report.booksPreserved = backup.books.length;
  report.addedBooks = ids.size - backup.books.length;
  for (const entry of backup.books) {
    const book = JSON.parse(await readFile(resolve(folder, entry.path), 'utf8'));
    const files = book.files.filter((f) => /^chapters\//.test(f.path) ||
      /^(?:outline\.json|canon\.json|memory\.json|rules\.json|setting\.md|notes\/story-plan\.md)$/.test(f.path));
    for (const file of files) {
      const path = '/workspace/novels/' + entry.id + '/' + file.path;
      const response = await request('/api/workspace/file?path=' + encodeURIComponent(path));
      const bytes = new Uint8Array(await response.arrayBuffer());
      report.filesChecked++;
      if (/^chapters\//.test(file.path)) report.chapterFilesChecked++;
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        report.changedFiles.push({ bookId: entry.id, pathHash: createHash('sha256').update(file.path).digest('hex') });
    }
  }
  const sessions = new Set();
  let after;
  for (let page = 0; page < 100; page++) {
    const url = new URL('/api/sessions?limit=100', state.url);
    if (after) url.searchParams.set('after', after);
    const data = await (await request(url)).json();
    for (const session of data.sessions) sessions.add(session.id);
    if (data.hasMore === false) { report.sessionCatalogComplete = true; break; }
    assert.ok(typeof data.nextAfter === 'string' && data.nextAfter !== after);
    after = data.nextAfter;
  }
  assert.equal(report.sessionCatalogComplete, true);
  assert.ok(backup.sessions.every((s) => sessions.has(s.id)), 'An original conversation is missing.');
  report.sessionsPreserved = backup.sessions.length;
  report.addedSessions = sessions.size - backup.sessions.length;
  report.verified = report.changedFiles.length === 0;
  report.scope = 'All original book/session identities, every chapter file, outline, canon, memory, rules, setting and story direction compared to the private pre-publication backup. Not a full database byte comparison.';
  await writeFile('test-results/cloud-public-data-preservation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.equal(report.verified, true, 'Content changed since backup; original and backup both retained.');
} finally { await transport.close(); }
