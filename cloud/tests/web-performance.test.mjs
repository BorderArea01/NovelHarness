import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import {
  compressibleAsset,
  assetDeliveryHeaders,
  streamBrowserBody,
  novelModulePreloads,
  invalidatesNativeTransports,
} from '../official/novel/web-performance.mjs';

const headers = {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'public, max-age=31536000, immutable',
};
const request = (path, encoding = 'gzip, br', method = 'GET') =>
  new Request('https://novel.example' + path, { method, headers: { 'accept-encoding': encoding } });
test('large immutable native modules are streamed compressed without changing their bytes', async () => {
  const text = 'const 中文小说 = "完整的正文与插件";\n'.repeat(20000);
  const response = new Response(text, {
    headers: { ...headers, 'content-length': String(Buffer.byteLength(text)), vary: 'Origin' },
  });
  assert(compressibleAsset(request('/plugins/?combo=revision'), response));
  const delivery = assetDeliveryHeaders(response.headers, true);
  assert.equal(delivery.get('content-encoding'), 'gzip');
  assert.equal(delivery.get('content-length'), null);
  assert.equal(delivery.get('vary'), 'Origin, Accept-Encoding');
  const chunks = [];
  await streamBrowserBody(
    response,
    new Writable({
      write(chunk, encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
    true,
  );
  const encoded = Buffer.concat(chunks);
  assert.equal(gunzipSync(encoded).toString('utf8'), text);
  assert(encoded.length < Buffer.byteLength(text) / 10);
});
test('compression excludes live streams, private files, disabled encodings and already encoded responses', () => {
  for (const path of [
    '/api/session/prompt',
    '/api/remote.mux',
    '/api/novels/book/documents',
    '/plugins/events',
  ])
    assert.equal(
      compressibleAsset(
        request(path),
        new Response('event', { headers: { 'content-type': 'text/event-stream' } }),
      ),
      false,
    );
  for (const encoding of ['gzip;q=0, br', 'gzip;q=0, *;q=1', 'identity', 'gzip;q=no'])
    assert.equal(compressibleAsset(request('/plugins/', encoding), new Response('code', { headers })), false);
  for (const extra of [
    { 'content-encoding': 'br' },
    { 'cache-control': 'private' },
    { 'cache-control': 'public, no-transform' },
  ])
    assert.equal(
      compressibleAsset(request('/plugins/'), new Response('code', { headers: { ...headers, ...extra } })),
      false,
    );
  assert(
    compressibleAsset(request('/studio/revision/runtime.mjs', '*;q=1'), new Response('code', { headers })),
  );
  assert.equal(
    compressibleAsset(request('/plugins/', 'gzip', 'HEAD'), new Response('code', { headers })),
    false,
  );
});
test('native shell preloads the same versioned novel entries before plugin activation', () => {
  const html = novelModulePreloads('/studio/current/pages/public/novel-assets/');
  assert.equal((html.match(/rel="modulepreload"/g) ?? []).length, 7);
  assert(html.includes('/studio/current/pages/public/novel-assets/manuscript.mjs'));
});
test('a normal recovery login preserves other devices; PIN epoch changes still disconnect stale carriers', () => {
  const base = {
    method: 'POST',
    status: 200,
    path: '/api/auth/recover',
    beforeEpoch: 'existing',
    afterEpoch: 'existing',
  };
  assert.equal(invalidatesNativeTransports(base), false);
  assert.equal(invalidatesNativeTransports({ ...base, afterEpoch: 'new' }), true);
  assert.equal(invalidatesNativeTransports({ ...base, path: '/api/auth/pin', afterEpoch: 'new' }), true);
  assert.equal(invalidatesNativeTransports({ ...base, status: 401 }), false);
  assert.equal(invalidatesNativeTransports({ ...base, path: '/api/auth/logout' }), true);
});
