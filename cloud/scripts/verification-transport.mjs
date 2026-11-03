import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireTool = createRequire(new URL('../tools/package.json', import.meta.url));

export function httpsProxyAddress(server) {
  if (typeof server !== 'string' || !server.trim()) return null;
  const parts = server
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const named = parts.filter((part) => /^(?:https|http)=/i.test(part));
  const selected =
    named.find((part) => /^https=/i.test(part)) ?? named[0] ?? parts.find((part) => !/^[a-z]+=/.test(part));
  if (!selected) throw new Error('System proxy does not include an HTTP/HTTPS transport.');
  const address = selected.replace(/^(?:https|http)=/i, '');
  const url = new URL(address.includes('://') ? address : 'http://' + address);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported system proxy transport.');
  return url.href;
}

async function windowsProxy() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('./read-system-proxy.ps1', import.meta.url)),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('Cannot read the existing Windows proxy settings.')));
    child.on('exit', (code) => {
      try {
        if (code !== 0) throw new Error();
        const settings = JSON.parse(output);
        resolve(settings.enabled ? httpsProxyAddress(settings.server) : null);
      } catch {
        reject(new Error('Cannot interpret the existing Windows proxy settings.'));
      }
    });
  });
}

export async function existingProxyEnvironment({
  env = process.env,
  platform = process.platform,
  readProxy = windowsProxy,
} = {}) {
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || platform !== 'win32')
    return {};
  const address = await readProxy();
  return address ? { HTTPS_PROXY: address, HTTP_PROXY: address } : {};
}

export async function verificationTransport() {
  const { fetch: transportFetch, ProxyAgent, EnvHttpProxyAgent, WebSocket } = requireTool('undici');
  let dispatcher;
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
    dispatcher = new EnvHttpProxyAgent();
  else if (process.platform === 'win32') {
    const address = await windowsProxy();
    if (address) dispatcher = new ProxyAgent(address);
  }
  // Same target HTTPS origin and normal certificate validation. No insecure TLS,
  // proxy credentials in logs/files/arguments, or alternate data-source fallback.
  return {
    request: (input, init) => transportFetch(input, { ...init, ...(dispatcher ? { dispatcher } : {}) }),
    openWebSocket: (url, headers) => new WebSocket(url, { headers, ...(dispatcher ? { dispatcher } : {}) }),
    close: async () => {
      await dispatcher?.close();
    },
  };
}
