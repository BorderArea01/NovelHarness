// Explicit owner-run migration controls. No model calls, PIN changes or network configuration.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { FormData } from '../tools/node_modules/undici/index.js';
import { verificationTransport } from './verification-transport.mjs';
import { requireIdleRuntime } from './runtime-activity.mjs';
import { privateDirectory } from './private-directory.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit migration control required.');
const action = process.argv[2], root = resolve('data/local-host');
await privateDirectory(root);
const deployment = JSON.parse(await readFile('data/cloud-platform/deployment.json', 'utf8'));
const tunnel = JSON.parse(await readFile(resolve(root, 'tunnel/tunnel.json'), 'utf8'));
const owner = (await readFile('data/cloud-platform/owner-key.txt', 'utf8')).trim();
const origin = new URL(deployment.url).origin;
const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(resolve(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8'))?.[1];
if (!token || tunnel.accountId !== deployment.accountId) throw new Error('Cloud management ownership mismatch.');
const transport = await verificationTransport();
async function save(name, value) { await writeFile(resolve(root, name), JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function api(path, method = 'GET', body, multipart = false) {
  const response = await transport.request('https://api.cloudflare.com/client/v4/accounts/' + deployment.accountId + path, {
    method, headers: { authorization: 'Bearer ' + token, ...(multipart ? {} : { 'content-type': 'application/json' }) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error('Cloud control HTTP ' + response.status + ': ' + (result.errors ?? []).map(e => e.code).join(','));
  return result.result;
}
try {
  if (action === 'prepare-relay') {
    const worker = 'novel-host-relay-' + deployment.pagesProject.replace(/^novel-studio-/, '');
    const code = await readFile('cloud/host/relay-worker.mjs');
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({ main_module: 'relay.mjs', compatibility_date: '2026-10-27',
      bindings: [{ type: 'vpc_service', name: 'LOCAL_SERVICE', service_id: tunnel.serviceId },
        { type: 'secret_text', name: 'DSH_EDGE_ACCESS_KEY', text: owner },
        { type: 'plain_text', name: 'NOVEL_PUBLIC_ORIGIN', text: origin }], observability: { enabled: false } })], { type: 'application/json' }));
    form.set('relay.mjs', new Blob([code], { type: 'application/javascript+module' }), 'relay.mjs');
    await api('/workers/scripts/' + worker, 'PUT', form, true);
    await api('/workers/scripts/' + worker + '/subdomain', 'POST', { enabled: false, previews_enabled: false });
    await save('relay.json', { worker, serviceId: tunnel.serviceId, origin, sha256: createHash('sha256').update(code).digest('hex'), preparedAt: new Date().toISOString(), websiteSwitched: false });
    const project = await api('/pages/projects/' + deployment.pagesProject);
    await save('pages-before-cutover.json', project);
    console.log(JSON.stringify({ relayPrepared: true, websiteSwitched: false, currentBackend: project.deployment_configs.production.services?.HARNESS?.service }));
  } else if (action === 'verify-relay') {
    const relay = JSON.parse(await readFile(resolve(root, 'relay.json'), 'utf8'));
    const worker = 'novel-host-transport-probe-' + deployment.pagesProject.replace(/^novel-studio-/, '');
    const probeKey = randomBytes(32).toString('base64url');
    const code = `export default { async fetch(r,e) { if(r.headers.get('authorization')!=='Bearer '+e.PROBE_TOKEN || new URL(r.url).pathname!=='/__relay_health') return new Response('',{status:404}); return e.RELAY.fetch(new Request(${JSON.stringify(origin + '/api/health')})); } };`;
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({ main_module: 'probe.mjs', compatibility_date: '2026-10-27',
      bindings: [{ type: 'service', name: 'RELAY', service: relay.worker }, { type: 'secret_text', name: 'PROBE_TOKEN', text: probeKey }], observability: { enabled: false } })], { type: 'application/json' }));
    form.set('probe.mjs', new Blob([code], { type: 'application/javascript+module' }), 'probe.mjs');
    await api('/workers/scripts/' + worker, 'PUT', form, true);
    const subdomain = await api('/workers/subdomain');
    try {
      await api('/workers/scripts/' + worker + '/subdomain', 'POST', { enabled: true, previews_enabled: false });
      const response = await transport.request('https://' + worker + '.' + subdomain.subdomain + '.workers.dev/__relay_health', {
        headers: { authorization: 'Bearer ' + probeKey }, signal: AbortSignal.timeout(20000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new Error('Private relay did not reach the activated native host: HTTP ' + response.status); }
      const health = await response.json();
      if (health.runtime !== 'dsh-edge' && health.version !== '0.30.0') throw new Error('Unexpected relay health identity.');
      relay.liveHostVerifiedAt = new Date().toISOString(); await save('relay.json', relay);
      console.log(JSON.stringify({ liveRelayToNativeHost: true, websiteSwitched: false, modelCalls: 0 }));
    } finally { await api('/workers/scripts/' + worker + '/subdomain', 'POST', { enabled: false, previews_enabled: false }); }
  } else if (action === 'freeze') {
    let receipt;
    try { receipt = JSON.parse(await readFile(resolve(root, 'cutover.json'), 'utf8')); } catch {}
    if (!receipt) {
      const idle = await requireIdleRuntime(origin, owner, transport.request, { pinWrapper: true });
      console.log(JSON.stringify(idle));
      receipt = { source: origin, targetId: randomUUID(), startedAt: new Date().toISOString(), stores: {} };
      await save('cutover.json', receipt);
    }
    if (receipt.source !== origin) throw new Error('Cutover source mismatch.');
    for (const kind of ['main', 'pin']) {
      const response = await transport.request(origin + '/api/host-migration/freeze/' + kind, { method: 'POST',
        signal: AbortSignal.timeout(25000), headers: { authorization: 'Bearer ' + owner, 'x-novel-host-control': 'cutover-v1', 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: receipt.targetId }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Freeze refused for ' + kind + ': HTTP ' + response.status); }
      const result = await response.json();
      if (!result.frozen || result.targetId !== receipt.targetId) throw new Error('Freeze receipt mismatch.');
      receipt.stores[kind] = result; await save('cutover.json', receipt);
      console.log(JSON.stringify({ stage: 'source-frozen', kind, noAIStopped: result.noAIStopped }));
    }
  } else if (action === 'switch-pages') {
    const receipt = JSON.parse(await readFile(resolve(root, 'cutover.json'), 'utf8'));
    const active = JSON.parse(await readFile(resolve(root, 'active.json'), 'utf8'));
    const relay = JSON.parse(await readFile(resolve(root, 'relay.json'), 'utf8'));
    if (!receipt.stores?.main?.frozen || !receipt.stores?.pin?.frozen || active.targetId !== receipt.targetId || !active.verifiedReady || !relay.liveHostVerifiedAt)
      throw new Error('Frozen source and verified active host required.');
    const project = await api('/pages/projects/' + deployment.pagesProject);
    const production = project.deployment_configs.production;
    if (![deployment.workerName, relay.worker].includes(production.services?.HARNESS?.service))
      throw new Error('Unexpected Pages backend; no routing changed.');
    const services = { ...production.services, HARNESS: { service: relay.worker, environment: 'production' } };
    const changed = await api('/pages/projects/' + deployment.pagesProject, 'PATCH', { deployment_configs: { production: { services } } });
    if (changed.deployment_configs.production.services.HARNESS.service !== relay.worker) throw new Error('Pages binding update not confirmed.');
    receipt.pagesBindingUpdatedAt = new Date().toISOString(); receipt.relayWorker = relay.worker;
    await save('cutover.json', receipt);
    console.log(JSON.stringify({ pagesProjectBindingUpdated: true, backend: relay.worker, deploymentMayBeRequired: true }));
  } else throw new Error('Unknown host control action.');
} catch (error) {
  console.error(error.message.replaceAll(owner, '[redacted]').replaceAll(token, '[redacted]')); process.exitCode = 1;
} finally { await transport.close(); }
