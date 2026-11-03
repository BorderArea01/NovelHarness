// Complete native SQL/KV export in bounded pages. No deploy, restore or AI calls.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verificationTransport } from './verification-transport.mjs';
import { requireIdleRuntime } from './runtime-activity.mjs';
import { privateDirectory } from './private-directory.mjs';
import { SNAPSHOT_PATH } from '../worker/storage-snapshot.mjs';
import { PAGE_LIMIT } from '../worker/storage-pages.mjs';
import { transferStoragePages } from './storage-transfer.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit whole-storage export request required.');
const owned = resolve('data/cloud-platform');
const deployment = JSON.parse(await readFile(resolve(owned, 'deployment.json'), 'utf8'));
const origin = new URL(deployment.url).origin;
if (!origin.endsWith('.pages.dev')) throw new Error('Unexpected source origin.');
const owner = (await readFile(resolve(owned, 'owner-key.txt'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{64}$/.test(owner)) throw new Error('Existing host recovery secret is invalid.');
const folder = resolve(owned, 'storage-exports', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
await privateDirectory(folder);
const transport = await verificationTransport();
const sha = (data) => createHash('sha256').update(data).digest('hex');
const report = { format: 'novel-native-storage-export-v2', source: origin, startedAt: new Date().toISOString(), complete: false,
  databaseSwitched: false, modelCalls: 0, storyWrites: 0, requests: 0, stores: {} };
async function save(file, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(resolve(folder, file) + '.partial', bytes, { mode: 0o600, flag: 'wx' });
  await rename(resolve(folder, file) + '.partial', resolve(folder, file));
  if (sha(await readFile(resolve(folder, file))) !== sha(bytes)) throw new Error('Local snapshot checksum mismatch.');
  return { file, bytes: bytes.length, sha256: sha(bytes) };
}
async function readPage(kind, params) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (++report.requests > 50000) throw new Error('Bounded storage request limit reached.');
    try {
      response = await transport.request(origin + SNAPSHOT_PATH + kind + '?' + params, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { authorization: 'Bearer ' + owner, origin, 'x-novel-migration': 'export-v1' },
      });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      console.log(JSON.stringify({ stage: 'same-read-page-network-retry', kind, attempt: attempt + 1 }));
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
    }
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    let reason = '';
    if ([409, 503].includes(response.status) && response.headers.get('content-type')?.includes('application/json')) {
      const data = await response.json();
      if (/^[a-z_]{1,40}$/.test(data.reason ?? '')) reason = ' (' + data.reason + ')';
    } else await response.body?.cancel();
    throw new Error('Storage page did not complete: HTTP ' + response.status + reason);
  }
  const chunks = [], reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > PAGE_LIMIT) { await reader.cancel(); throw new Error('Storage page exceeds memory budget.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
}
try {
  if (!process.argv.includes('--frozen-source')) await requireIdleRuntime(origin, owner, transport.request, { pinWrapper: true });
  else {
    const control = JSON.parse(await readFile('data/local-host/cutover.json', 'utf8'));
    if (!control.stores?.main?.frozen || !control.stores?.pin?.frozen || control.source !== origin)
      throw new Error('Verified frozen source receipt required.');
    report.frozenTargetId = control.targetId;
  }
  for (const kind of ['main', 'pin']) {
    await mkdir(resolve(folder, kind), { mode: 0o700 });
    const item = report.stores[kind] = { complete: false, pages: [] };
    const result = await transferStoragePages((params) => readPage(kind, params), {
      onHeader: async (header) => {
        if (header.kind !== kind) throw new Error('Store identity mismatch.');
        item.header = await save(kind + '/header.json', header); item.objectId = header.objectId;
      },
      onPage: async (page, ordinal) => {
        item.pages.push(await save(kind + '/page-' + String(ordinal).padStart(6, '0') + '.json', page));
        if (ordinal % 20 === 0) console.log(JSON.stringify({ stage: 'storage-page', kind, pages: ordinal + 1 }));
      },
    });
    Object.assign(item, { complete: true, rows: result.rows, keys: result.keys,
      tables: result.header.tables.length, bookmarkConsistent: true, bytes: item.header.bytes + item.pages.reduce((s, p) => s + p.bytes, 0) });
    await writeFile(resolve(folder, 'storage-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: 'store-complete', kind, rows: item.rows, keys: item.keys, bytes: item.bytes, pages: item.pages.length }));
  }
  await writeFile(resolve(folder, 'owner-key.txt'), owner + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(folder, 'source-deployment.json'), JSON.stringify(deployment, null, 2), { mode: 0o600, flag: 'wx' });
  report.ownerKeySha256 = sha(owner); report.complete = true;
} catch (error) {
  report.error = error.message.replaceAll(owner, '[redacted]'); process.exitCode = 1;
} finally {
  await writeFile(resolve(folder, 'storage-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await transport.close();
  console.log(JSON.stringify({ complete: report.complete, folder, stores: Object.keys(report.stores), requests: report.requests, databaseSwitched: false, ...(report.error ? { error: report.error } : {}) }));
}
