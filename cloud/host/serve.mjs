// Serve ONLY an explicitly activated, fully verified final frozen-source copy.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { hostRuntime } from './runtime.mjs';
const root = resolve('data/local-host');
const active = JSON.parse(await readFile(resolve(root, 'active.json'), 'utf8'));
const base = await realpath(resolve(root, 'candidates'));
const candidate = await realpath(active.candidate);
if (!candidate.startsWith(base + sep)) throw new Error('Active data is outside the owned candidates root.');
const report = JSON.parse(await readFile(resolve(candidate, 'candidate.json'), 'utf8'));
const cutover = JSON.parse(await readFile(resolve(root, 'cutover.json'), 'utf8'));
if (
  !report.restoreVerified ||
  !report.sourceFrozenForTarget ||
  report.sourceFrozenForTarget !== cutover.targetId ||
  active.targetId !== cutover.targetId ||
  !cutover.stores?.main?.frozen ||
  !cutover.stores?.pin?.frozen
)
  throw new Error('Lossless restore and sole-owner freeze proof required.');
const ownerKey = (await readFile(resolve(candidate, 'owner-key.txt'), 'utf8')).trim();
const release = await realpath(active.release ?? resolve(candidate, 'release'));
if (
  release !== (await realpath(resolve(candidate, 'release'))) &&
  !release.startsWith(resolve(root, 'releases') + sep)
)
  throw new Error('Runtime release is outside owned immutable releases.');
const lanHosts = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && !n.internal && n.family === 'IPv4')
  .map((n) => n.address);
const runtime = await hostRuntime({
  release,
  persist: resolve(candidate, 'storage'),
  ownerKey,
  namespaceKey: report.namespaceKey,
  host: '0.0.0.0',
  port: 3211,
  publicOrigin: report.sourceOrigin,
  lanHosts,
  revision: active.revision || 'verified-local-host',
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.dispose();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await runtime.ready;
  const main = await runtime.getDurableObjectNamespace('DSH_EDGE_INSTANCE', 'novel-host-harness');
  const response = await main.get(main.idFromName('owner')).fetch('http://localhost/__host_activate', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + ownerKey,
      'x-novel-host-control': 'activate-v1',
      'x-novel-target': active.targetId,
    },
  });
  if (!response.ok || !(await response.json()).schedulerResumed)
    throw new Error('Original scheduler activation failed.');
  const health = await runtime.dispatchFetch('http://localhost:3211/api/health');
  if (!health.ok) throw new Error('Host health did not become ready.');
  await health.arrayBuffer();
  await writeFile(
    resolve(root, 'running.json'),
    JSON.stringify(
      {
        pid: process.pid,
        candidate,
        readyAt: new Date().toISOString(),
        targetId: active.targetId,
        port: 3211,
        lanHosts,
        schedulerResumed: true,
        release,
        revision: active.revision,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ready: true, port: 3211, lanHosts, schedulerResumed: true }));
} catch {
  console.error('Local host did not become ready; original cloud and all snapshots retained.');
  await runtime.dispose();
  process.exitCode = 1;
}
