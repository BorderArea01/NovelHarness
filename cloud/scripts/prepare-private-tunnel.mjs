// Prepare a dedicated, outbound-only VPC tunnel. Does not install a system
// service, start a connector, change DNS/routes/firewall, or switch the website.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { verificationTransport } from './verification-transport.mjs';
import { privateDirectory } from './private-directory.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit local-host tunnel preparation required.');
const root = resolve('data/local-host/tunnel');
await privateDirectory(root);
const deployment = JSON.parse(await readFile('data/cloud-platform/deployment.json', 'utf8'));
const oauth = await readFile(resolve(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8');
const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(oauth)?.[1];
if (!token) throw new Error('Cloudflare management authentication is missing.');
const receiptFile = resolve(root, 'tunnel.json');
const state = existsSync(receiptFile) ? JSON.parse(await readFile(receiptFile, 'utf8')) : {
  format: 'novel-private-tunnel-v1', accountId: deployment.accountId,
  name: 'novel-development-host-' + deployment.pagesProject.replace(/^novel-studio-/, ''),
  started: false, websiteSwitched: false, hostPort: 3211,
};
if (state.format !== 'novel-private-tunnel-v1' || state.accountId !== deployment.accountId) throw new Error('Tunnel ownership receipt does not match.');
const transport = await verificationTransport();
const save = () => writeFile(receiptFile, JSON.stringify(state, null, 2), { mode: 0o600 });
async function api(path, method = 'GET', body) {
  const response = await transport.request('https://api.cloudflare.com/client/v4/accounts/' + deployment.accountId + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok || data.success !== true) throw new Error('Cloudflare private tunnel request refused: HTTP ' + response.status + ', codes ' + (data.errors?.map((e) => e.code).join(',') ?? 'unknown'));
  return data.result;
}
try {
  const version = '2026.10.5', expected = 'db4e4c413612a0916f3e1679d3caaf376f94911952d163028fb726fb2e0516a9';
  const binary = resolve(root, 'cloudflared-' + version + '.exe');
  if (!existsSync(binary)) {
    const response = await transport.request('https://github.com/cloudflare/cloudflared/releases/download/' + version + '/cloudflared-windows-amd64.exe', { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Official connector download failed: HTTP ' + response.status);
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, callback) {
      bytes += chunk.length;
      callback(bytes > 100 * 1024 * 1024 ? new Error('Connector download exceeded its size bound.') : null, chunk);
    } }), createWriteStream(binary, { flags: 'wx', mode: 0o700 }));
  }
  if (createHash('sha256').update(await readFile(binary)).digest('hex') !== expected) throw new Error('Official connector SHA-256 mismatch; it was not executed.');
  state.binary = binary; state.binarySha256 = expected;
  if (!state.tunnelId) {
    const all = await api('/cfd_tunnel?is_deleted=false');
    const matches = all.filter((item) => item.name === state.name);
    if (matches.length) throw new Error('A same-name tunnel already exists without this ownership receipt. No tunnel was modified.');
    const created = await api('/cfd_tunnel', 'POST', { name: state.name, config_src: 'cloudflare', tunnel_secret: randomBytes(32).toString('base64') });
    state.tunnelId = created.id; await save();
  }
  if (!state.configured) {
    await api('/cfd_tunnel/' + state.tunnelId + '/configurations', 'PUT', {
      config: { ingress: [{ service: 'http_status:404' }], 'warp-routing': { enabled: true } },
    });
    state.configured = true; await save();
  }
  const tunnelToken = await api('/cfd_tunnel/' + state.tunnelId + '/token');
  if (typeof tunnelToken !== 'string' || tunnelToken.length < 32) throw new Error('Connector token was not returned.');
  await writeFile(resolve(root, 'tunnel-token.txt'), tunnelToken + '\n', { mode: 0o600 });
  if (!state.serviceId) {
    const created = await api('/connectivity/directory/services', 'POST', {
      name: state.name, type: 'http', http_port: state.hostPort,
      host: { ipv4: '127.0.0.1', network: { tunnel_id: state.tunnelId } },
    });
    state.serviceId = created.service_id; await save();
  }
  state.prepared = true; await save();
  console.log(JSON.stringify({ prepared: true, directory: root, connectorVersion: version,
    checksumVerified: true, connectorStarted: false, serviceCreated: !!state.serviceId, websiteSwitched: false, networkConfigurationChanged: false }));
} catch (error) {
  console.error(error.message.replaceAll(token, '[redacted]')); process.exitCode = 1;
} finally { await transport.close(); }
