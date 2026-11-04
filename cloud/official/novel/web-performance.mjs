import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Only public immutable program assets. Never buffer/compress RPC streams,
// conversations, authenticated documents, uploads or WebSocket traffic here.
export function compressibleAsset(request, response) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' || response.status !== 200 || !response.body) return false;
  if (!/^\/(?:plugins|assets|studio|__host-assets)\//.test(path)) return false;
  if (!/\bpublic\b/i.test(response.headers.get('cache-control') ?? '')) return false;
  if (
    response.headers.has('content-encoding') ||
    /\bno-transform\b/i.test(response.headers.get('cache-control'))
  )
    return false;
  if (
    !/^(?:text\/(?:javascript|css)|application\/(?:javascript|wasm))(?:;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    return false;
  const encodings = (request.headers.get('accept-encoding') ?? '').split(',').map((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.find((p) => /^\s*q\s*=/.test(p));
    return [name, quality ? Number(quality.split('=')[1]) : 1];
  });
  const explicit = encodings.find(([name]) => name === 'gzip');
  return (explicit ?? encodings.find(([name]) => name === '*'))?.[1] > 0;
}

export function assetDeliveryHeaders(headers, gzip) {
  const result = new Headers(headers);
  if (gzip) {
    result.delete('content-length');
    result.set('content-encoding', 'gzip');
    const vary = result.get('vary');
    if (!vary?.split(',').some((v) => ['*', 'accept-encoding'].includes(v.trim().toLowerCase())))
      result.set('vary', [vary, 'Accept-Encoding'].filter(Boolean).join(', '));
  }
  return result;
}

export async function streamBrowserBody(response, destination, gzip = false) {
  const input = Readable.fromWeb(response.body);
  if (gzip) await pipeline(input, createGzip({ level: 4 }), destination);
  else await pipeline(input, destination);
}

export function novelModulePreloads(asset) {
  return [
    'bridge-core',
    'harness-navigation',
    'manuscript',
    'application',
    'task-message',
    'proposal-tool-view',
    'studio-theme',
  ]
    .map((name) => '<link rel="modulepreload" href="' + asset + name + '.mjs">')
    .join('');
}

export function invalidatesNativeTransports({ method, status, path, beforeEpoch, afterEpoch }) {
  return (
    method === 'POST' &&
    status >= 200 &&
    status < 400 &&
    (path === '/api/auth/logout' || beforeEpoch !== afterEpoch)
  );
}
