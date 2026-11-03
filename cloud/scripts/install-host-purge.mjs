// Explicit owner-requested installation of this release's scoped adapter only.
// Never touches model credentials, PIN, book paths, session logs or networking.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyUiRelease } from './verify-ui-release.mjs';
import { bookStorageFingerprint } from './book-storage-fingerprint.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit plugin installation required.');
const active = JSON.parse(await readFile('data/local-host/active.json', 'utf8'));
const receipt = await verifyUiRelease(active.release);
if (receipt.feature !== 'dsh-purge-novel' || !active.verifiedReady) throw new Error('Tested, active purge adapter release required.');
const before = bookStorageFingerprint(resolve(active.candidate, 'storage'));
const origin = 'http://127.0.0.1:3211';
const secret = (await readFile(resolve(active.candidate, 'owner-key.txt'), 'utf8')).trim();
const login = await fetch(origin + '/api/auth/recover', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ accessKey: secret }), signal: AbortSignal.timeout(15000) });
if (!login.ok) throw new Error('Original owner authentication failed.'); await login.arrayBuffer();
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const get = async () => {
  const r = await fetch(origin + '/api/novel-plugins/dsh-purge', { headers: { cookie }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Plugin status unavailable.'); return r.json();
};
const status = await get();
if (status.warning) throw new Error('Existing plugin configuration needs inspection; nothing overwritten.');
if (!status.installed) {
  const r = await fetch(origin + '/api/novel-plugins/dsh-purge', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install', revision: null }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Plugin not installed; active or changed state preserved (HTTP ' + r.status + ').');
  await r.arrayBuffer();
}
const after = await get();
if (!after.installed || !after.enabled || after.adapter !== 'novel-1') throw new Error('Installation state not confirmed; no existing choices overwritten.');
const unchanged = JSON.stringify(bookStorageFingerprint(resolve(active.candidate, 'storage'))) === JSON.stringify(before);
if (!unchanged) throw new Error('Book fingerprint changed during installation; inspect concurrent author activity without restoring data.');
const record = { installed: true, enabled: true, adapter: after.adapter, upstreamVersion: after.version,
  at: new Date().toISOString(), revision: active.revision, bookBytesUnchanged: true, realModelCalls: 0 };
await writeFile('data/local-host/purge-installation.json', JSON.stringify(record, null, 2), { mode: 0o600 });
console.log(JSON.stringify(record));
