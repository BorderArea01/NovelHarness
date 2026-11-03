// Real outbound QUIC + VPC HTTP/stream/WebSocket check with synthetic payloads.
// Never reads a candidate database, provider credentials or production stories.
import { readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from '../tools/node_modules/ws/wrapper.mjs';
import { FormData } from '../tools/node_modules/undici/index.js';
import { verificationTransport } from './verification-transport.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit private host connection test required.');
const root = resolve('data/local-host/tunnel');
const state = JSON.parse(await readFile(resolve(root, 'tunnel.json'), 'utf8'));
if (state.format !== 'novel-private-tunnel-v1' || !state.prepared || state.websiteSwitched) throw new Error('Prepared, unswitched tunnel receipt required.');
if (createHash('sha256').update(await readFile(state.binary)).digest('hex') !== state.binarySha256) throw new Error('Connector checksum changed.');
const deployment = JSON.parse(await readFile('data/cloud-platform/deployment.json', 'utf8'));
const oauth = await readFile(resolve(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8');
const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(oauth)?.[1];
if (!token || state.accountId !== deployment.accountId) throw new Error('Cloud management ownership mismatch.');
const probeToken = randomBytes(32).toString('base64url');
const worker = 'novel-host-transport-probe-' + deployment.pagesProject.replace(/^novel-studio-/, '');
const transport = await verificationTransport();
let connector, socket, publicEnabled = false, success = false;
const report = { at: new Date().toISOString(), syntheticOnly: true, cloudDatabaseRead: false,
  quicConnected: false, http: false, streaming: false, webSocket: false, websiteSwitched: false, networkConfigurationChanged: false };
const server = createServer((request, response) => {
  if (request.headers['x-novel-probe'] !== probeToken) { response.writeHead(404).end(); return; }
  if (request.url === '/__probe_stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write('data: first\n\n'); setTimeout(() => response.end('data: second\n\n'), 1500); return;
  }
  if (request.url !== '/__probe_http') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ synthetic: true }));
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/__probe_ws' || request.headers['x-novel-probe'] !== probeToken) { socket.destroy(); return; }
  sockets.handleUpgrade(request, socket, head, (client) => client.on('message', (data, binary) => client.send(data, { binary })));
});
async function api(path, method = 'GET', body, multipart = false) {
  report.managementStage = method + ' ' + path.replace(/\/workers\/scripts\/[^/]+/, '/workers/scripts/owned-probe');
  const response = await transport.request('https://api.cloudflare.com/client/v4/accounts/' + state.accountId + path, {
    method, headers: { authorization: 'Bearer ' + token, ...(multipart ? {} : { 'content-type': 'application/json' }) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok || data.success !== true) throw new Error('Transport test management request failed: HTTP ' + response.status + ', codes ' + data.errors?.map((e) => e.code).join(',') + ', ' + data.errors?.map((e) => String(e.message).slice(0, 300)).join('; '));
  return data.result;
}
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(state.hostPort, '127.0.0.1', done); });
  const out = openSync(resolve(root, 'connector.out.log'), 'a', 0o600), err = openSync(resolve(root, 'connector.error.log'), 'a', 0o600);
  connector = spawn(state.binary, ['tunnel', '--no-autoupdate', '--protocol', 'quic', '--metrics', '127.0.0.1:3219', 'run', '--token-file', resolve(root, 'tunnel-token.txt')],
    { windowsHide: true, detached: true, stdio: ['ignore', out, err] });
  closeSync(out); closeSync(err);
  connector.on('error', () => {});
  state.connectorPid = connector.pid; await writeFile(resolve(root, 'tunnel.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  const started = Date.now();
  while (Date.now() - started < 45000) {
    if (connector.exitCode !== null) throw new Error('Owned QUIC connector exited before becoming ready.');
    try { const response = await fetch('http://127.0.0.1:3219/ready', { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) { report.quicConnected = true; break; } } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!report.quicConnected) throw new Error('Existing network did not establish outbound QUIC; no network settings were changed.');
  console.log(JSON.stringify({ stage: 'outbound-quic-ready', originalWebsiteUnchanged: true }));
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({ main_module: 'probe.mjs', compatibility_date: '2026-10-27',
    bindings: [{ type: 'vpc_service', name: 'LOCAL_SERVICE', service_id: state.serviceId }, { type: 'secret_text', name: 'PROBE_TOKEN', text: probeToken }],
    observability: { enabled: false } })], { type: 'application/json' }));
  form.set('probe.mjs', new Blob([await readFile('cloud/host/probe-worker.mjs')], { type: 'application/javascript+module' }), 'probe.mjs');
  await api('/workers/scripts/' + worker, 'PUT', form, true);
  const subdomain = await api('/workers/subdomain');
  await api('/workers/scripts/' + worker + '/subdomain', 'POST', { enabled: true, previews_enabled: false }); publicEnabled = true;
  const origin = 'https://' + worker + '.' + subdomain.subdomain + '.workers.dev';
  const headers = { authorization: 'Bearer ' + probeToken };
  let response;
  for (let n = 0; n < 6; n++) {
    response = await transport.request(origin + '/__probe_http', { headers, signal: AbortSignal.timeout(15000) });
    if (response.ok) break;
    await response.arrayBuffer(); await new Promise((done) => setTimeout(done, 1000));
  }
  if (!response.ok || (await response.json()).synthetic !== true) throw new Error('Private VPC HTTP probe did not reach the synthetic host.');
  report.http = true;
  response = await transport.request(origin + '/__probe_stream', { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Private VPC streaming probe failed.');
  const reader = response.body.getReader(), first = await reader.read();
  report.streaming = !first.done && new TextDecoder().decode(first.value) === 'data: first\n\n';
  await reader.cancel();
  if (!report.streaming) throw new Error('Private VPC transport buffered the streaming probe.');
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { socket?.close(); reject(new Error('Private VPC WebSocket probe timed out.')); }, 15000);
    socket = transport.openWebSocket(origin.replace('https:', 'wss:') + '/__probe_ws', headers);
    socket.onopen = () => socket.send('synthetic-echo');
    socket.onmessage = (event) => { if (event.data === 'synthetic-echo') { report.webSocket = true; clearTimeout(timer); socket.close(); done(); } };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Private VPC WebSocket upgrade was not verified.')); };
  });
  success = true; connector.unref();
} catch (error) {
  report.error = error.message.replaceAll(token, '[redacted]').replaceAll(probeToken, '[redacted]'); process.exitCode = 1;
} finally {
  socket?.close(); for (const client of sockets.clients) client.terminate(); sockets.close();
  await new Promise((done) => server.close(done));
  if (publicEnabled) try { await api('/workers/scripts/' + worker + '/subdomain', 'POST', { enabled: false, previews_enabled: false }); } catch { report.probeEndpointDisablePending = true; }
  if (!success && connector && connector.exitCode === null) connector.kill();
  state.connectorStarted = success; state.transportVerified = success;
  await writeFile(resolve(root, 'tunnel.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  await writeFile(resolve(root, 'transport-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await transport.close(); console.log(JSON.stringify(report));
}
