// Explicit, bounded incident diagnostics. No Wrangler logger, raw event files,
// requests, responses, log messages, stacks, cookies or provider keys are kept.
// Only recognized infrastructure errors, counts and opaque fingerprints leave
// memory. Deletion targets ONLY the tail ID returned by this invocation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existingProxyEnvironment, verificationTransport } from './verification-transport.mjs';

if (!process.argv.includes('--owner-consented')) throw new Error('Explicit consent required.');
const state = JSON.parse(await readFile(new URL('../../data/cloud-platform/deployment.json', import.meta.url), 'utf8'));
const token = process.env.CLOUDFLARE_API_TOKEN ||
  (await readFile(resolve(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8'))
    .match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if (!token) throw new Error('Existing management credential unavailable.');
const transport = await verificationTransport();
const requireTool = createRequire(new URL('../tools/package.json', import.meta.url));
const { WebSocket, ProxyAgent, EnvHttpProxyAgent } = requireTool('undici');
const proxy = await existingProxyEnvironment();
let dispatcher;
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
  dispatcher = new EnvHttpProxyAgent();
else if (proxy.HTTPS_PROXY) dispatcher = new ProxyAgent(proxy.HTTPS_PROXY);
const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + state.accountId +
  '/workers/scripts/' + state.workerName + '/tails';
async function api(url, method, body) {
  const response = await transport.request(url, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok || value.success === false) throw new Error('Management request HTTP ' + response.status);
  return value.result;
}
function classify(exception) {
  const raw = String(exception?.message ?? '');
  let message = 'Unknown exception; original message withheld for privacy.';
  if (/Exceeded allowed rows read in Durable Objects free tier/i.test(raw))
    message = 'Exceeded allowed rows read in Durable Objects free tier.';
  else if (/Exceeded allowed rows written in Durable Objects free tier/i.test(raw))
    message = 'Exceeded allowed rows written in Durable Objects free tier.';
  else if (/^Unsupported PIN state\.?$/.test(raw)) message = 'Unsupported PIN state.';
  else if (/^Missing owner secret\.?$/.test(raw)) message = 'Missing owner secret.';
  return {
    name: ['Error', 'TypeError', 'RangeError'].includes(exception?.name) ? exception.name : 'Error',
    message, fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  };
}
let tailId, socket, count = 0, closed = false;
const timers = [];
const pending = new Set();
async function probe() {
  try {
    const response = await transport.request(state.url + '/api/auth/session', {
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    console.log(JSON.stringify({ probe: '/api/auth/session', status: response.status }));
  } catch {
    console.log(JSON.stringify({ probe: '/api/auth/session', status: 'transport-failed' }));
  }
}
try {
  const record = await api(endpoint, 'POST', { filters: [{ outcome: ['exception', 'exceededCpu', 'exceededMemory', 'unknown'] }] });
  if (!/^[a-f0-9-]{16,64}$/i.test(record?.id ?? '')) throw new Error('Invalid temporary tail identity.');
  tailId = record.id;
  if (new URL(record.url).protocol !== 'wss:') throw new Error('Invalid tail transport.');
  socket = new WebSocket(record.url, {
    protocols: ['trace-v1'], headers: { 'user-agent': 'novel-private-incident-diagnostic' },
    ...(dispatcher ? { dispatcher } : {}),
  });
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', ({ data }) => {
    if (closed) return;
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      if (text.length > 1024 * 1024) return;
      const event = JSON.parse(text);
      // Deliberately ignore event.logs, event.event and all request metadata.
      for (const exception of event.exceptions ?? []) {
        count++;
        console.log(JSON.stringify({ exception: classify(exception) }));
      }
    } catch { /* Never echo unparsed/raw data. */ }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tail connection timeout.')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Tail transport failed.')); }, { once: true });
  });
  socket.send(JSON.stringify({ debug: false }));
  console.log(JSON.stringify({ connected: true, maxCaptureSeconds: 25, rawEventsPersisted: false }));
  for (const delay of [2500, 12500]) timers.push(setTimeout(() => {
    const job = probe();
    pending.add(job);
    job.finally(() => pending.delete(job));
  }, delay));
  await new Promise((resolve) => timers.push(setTimeout(resolve, 25000)));
  await Promise.allSettled([...pending]);
  console.log(JSON.stringify({ captureFinished: true, exceptionCount: count }));
} catch (error) {
  console.log(JSON.stringify({ captureFailed: true, error: /^Management request HTTP \d+$|^Tail connection timeout\.$|^Tail transport failed\.$/.test(error.message) ? error.message : 'Private diagnostic failed; details withheld.' }));
  process.exitCode = 1;
} finally {
  closed = true;
  timers.forEach(clearTimeout);
  socket?.close();
  if (tailId) {
    try {
      await api(endpoint + '/' + tailId, 'DELETE');
      console.log(JSON.stringify({ ownTemporaryTailDeleted: true }));
    } catch {
      console.log(JSON.stringify({ ownTemporaryTailDeleted: false, cleanupRequired: true }));
      process.exitCode = 1;
    }
  }
  // A closed tail can leave a WebSocket handshake waiting for the remote peer.
  // Destroy only this diagnostic's private dispatcher; never keep a socket or
  // background capture alive after its bounded observation has ended.
  await dispatcher?.destroy();
  await transport.close();
}
