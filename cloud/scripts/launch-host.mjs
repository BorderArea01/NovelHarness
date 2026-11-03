import { readFile, writeFile, realpath } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { verifyUiRelease } from './verify-ui-release.mjs';
import { bookStorageFingerprint } from './book-storage-fingerprint.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit host activation required.');
const root = resolve('data/local-host');
const candidate = await realpath(process.env.NOVEL_HOST_CANDIDATE ?? 'missing-candidate');
const base = await realpath(resolve(root, 'candidates'));
if (!candidate.startsWith(base + sep)) throw new Error('Owned candidate required.');
const report = JSON.parse(await readFile(resolve(candidate, 'candidate.json'), 'utf8'));
const cutover = JSON.parse(await readFile(resolve(root, 'cutover.json'), 'utf8'));
const deployment = JSON.parse(await readFile('data/cloud-platform/deployment.json', 'utf8'));
if (
  !report.restoreVerified ||
  report.sourceFrozenForTarget !== cutover.targetId ||
  !cutover.stores?.main?.frozen ||
  !cutover.stores?.pin?.frozen
)
  throw new Error('Final verified frozen-source candidate required.');
const probe = createServer();
await new Promise((done, reject) => {
  probe.once('error', reject);
  probe.listen(3211, '0.0.0.0', done);
});
await new Promise((done) => probe.close(done));
let previous;
try {
  previous = JSON.parse(await readFile(resolve(root, 'active.json'), 'utf8'));
} catch {}
const release =
  process.env.NOVEL_HOST_UI_RELEASE ?? (previous?.candidate === candidate ? previous.release : undefined);
let revision = deployment.revision;
if (release) {
  const path = await realpath(release);
  if (!path.startsWith(resolve(root, 'releases') + sep)) throw new Error('Owned UI release required.');
  const receipt = await verifyUiRelease(path);
  const tested = JSON.parse(await readFile(resolve(path, 'tested.json'), 'utf8'));
  if (tested.revision !== receipt.revision)
    throw new Error('Verified unchanged backend and tested UI release required.');
  revision = receipt.revision;
}
const active = {
  candidate,
  targetId: cutover.targetId,
  revision,
  ...(release ? { release } : {}),
  activatedAt: new Date().toISOString(),
  verifiedReady: false,
};
await writeFile(resolve(root, 'active.json'), JSON.stringify(active, null, 2), { mode: 0o600 });
const stdout = openSync(resolve(root, 'host.out.log'), 'a', 0o600),
  stderr = openSync(resolve(root, 'host.error.log'), 'a', 0o600);
const child = spawn(process.execPath, ['--max-old-space-size=192', resolve('cloud/host/serve.mjs')], {
  cwd: resolve('.'),
  windowsHide: true,
  detached: true,
  stdio: ['ignore', stdout, stderr],
});
closeSync(stdout);
closeSync(stderr);
child.on('error', () => {});
child.unref();
active.pid = child.pid;
await writeFile(resolve(root, 'active.json'), JSON.stringify(active, null, 2), { mode: 0o600 });
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (child.exitCode !== null) break;
  try {
    const running = JSON.parse(await readFile(resolve(root, 'running.json'), 'utf8'));
    if (
      running.pid === child.pid &&
      running.targetId === active.targetId &&
      running.candidate === candidate &&
      running.schedulerResumed
    ) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((done) => setTimeout(done, 500));
}
if (!ready)
  throw new Error('Host readiness not confirmed; routing remains unchanged. Inspect private host logs.');
// Verify original PIN session and native data without changing prose or model configuration.
const owner = (await readFile(resolve(candidate, 'owner-key.txt'), 'utf8')).trim();
const origin = 'http://127.0.0.1:3211';
const login = await fetch(origin + '/api/auth/recover', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ accessKey: owner }),
  signal: AbortSignal.timeout(15000),
});
if (!login.ok) throw new Error('Original owner authentication failed; routing remains unchanged.');
const cookie = login.headers
  .getSetCookie()
  .map((item) => item.split(';')[0])
  .join('; ');
await login.arrayBuffer();
const booksResponse = await fetch(origin + '/api/novels', {
  headers: { cookie },
  signal: AbortSignal.timeout(15000),
});
if (!booksResponse.ok) throw new Error('Original books unavailable; routing remains unchanged.');
const books = (await booksResponse.json()).books;
const sessionsResponse = await fetch(origin + '/api/sessions?limit=100', {
  headers: { cookie },
  signal: AbortSignal.timeout(15000),
});
if (!sessionsResponse.ok) throw new Error('Original sessions unavailable; routing remains unchanged.');
const sessions = await sessionsResponse.json();
if (!Array.isArray(books) || !Array.isArray(sessions.sessions) || sessions.hasMore !== false)
  throw new Error('Complete native metadata check required.');
if (release) {
  const backup = JSON.parse(await readFile(resolve(root, 'last-ui-backup.json'), 'utf8'));
  if (backup.bookFingerprint) {
    const fingerprint = bookStorageFingerprint(resolve(candidate, 'storage'));
    if (JSON.stringify(fingerprint) !== JSON.stringify(backup.bookFingerprint))
      throw new Error('Book contents differ from the pre-update backup; no data was restored or overwritten.');
    active.bookStorageFingerprintVerified = true;
  }
}
active.verifiedReady = true;
active.books = books.length;
active.sessions = sessions.sessions.length;
await writeFile(resolve(root, 'active.json'), JSON.stringify(active, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    hostReady: true,
    port: 3211,
    books: active.books,
    sessions: active.sessions,
    originalPinRetained: true,
    modelCalls: 0,
  }),
);
