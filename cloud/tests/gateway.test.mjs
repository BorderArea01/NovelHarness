import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, releaseAssetBase, rewriteNovelHtml } from '../pages/src/gateway.mjs';

const origin = 'https://novel.example';
const request = (path, init) => new Request(origin + path, init);
const proxy = (fn) => ({ HARNESS: { fetch: fn } });
test('an authenticated login bookmark redirects on the server without rendering a checking screen', async () => {
  let calls = 0;
  const result = await handleRequest({
    request: request('/login'),
    env: {
      HARNESS: {
        fetch: async (req) => {
          calls++;
          assert.equal(new URL(req.url).pathname, '/api/auth/pin');
          return Response.json({ authenticated: true, configured: true });
        },
      },
      ASSETS: {
        fetch() {
          throw Error('Must not render login');
        },
      },
    },
  });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get('location'), '/?view=library');
  assert.equal(calls, 1);
});
test('login renders current server state without an extra browser auth request and never caches it', async () => {
  for (const state of [
    { authenticated: false, configured: true },
    { authenticated: true, configured: false },
  ]) {
    const result = await handleRequest({
      request: request('/login'),
      env: {
        HARNESS: { fetch: async () => Response.json(state) },
        ASSETS: {
          fetch: async () =>
            new Response('<body data-page="login">PIN</body>', { headers: { 'content-type': 'text/html' } }),
        },
      },
    });
    const text = await result.text();
    assert(text.includes('data-authenticated="' + state.authenticated + '"'));
    assert(text.includes('data-pin-configured="' + state.configured + '"'));
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
});

test('server-rendered title is generic before browser modules start', () => {
  const previous = globalThis.HTMLRewriter;
  const handlers = new Map();
  globalThis.HTMLRewriter = class {
    on(selector, handler) {
      handlers.set(selector, handler);
      return this;
    }
    transform(response) {
      return response;
    }
  };
  try {
    const response = new Response('<title>private fixture title</title>');
    assert.equal(rewriteNovelHtml(response), response);
    let title;
    handlers.get('title').element({
      setInnerContent(value) {
        title = value;
      },
    });
    assert.equal(title, '小说工作台');
  } finally {
    if (previous === undefined) delete globalThis.HTMLRewriter;
    else globalThis.HTMLRewriter = previous;
  }
});

test('missing binding fails closed, without any public upstream fallback', async () => {
  const result = await handleRequest({ request: request('/'), env: {} });
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('public HTTP is rejected, local HTTP is usable', async () => {
  const env = proxy(() => Response.json({ ok: true }));
  assert.equal((await handleRequest({ request: new Request('http://novel.example/'), env })).status, 400);
  assert.equal((await handleRequest({ request: new Request('http://127.0.0.1/'), env })).status, 200);
});

test('native requests retain original URL, origin, cookie, stream and response identity', async () => {
  const req = request('/api/sessions/a/turn', {
    method: 'POST',
    headers: { origin, cookie: 'owner=signed', 'content-type': 'application/json' },
    body: '{"message":"hi"}',
  });
  let streamRead = false;
  const stream = new ReadableStream(
    {
      pull() {
        streamRead = true;
      },
    },
    { highWaterMark: 0 },
  );
  const upstream = new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'set-cookie': 'owner=signed; HttpOnly; Secure' },
  });
  const result = await handleRequest({
    request: req,
    env: proxy((forwarded) => {
      assert.equal(forwarded, req);
      return upstream;
    }),
  });
  assert.equal(result, upstream);
  assert.equal(streamRead, false);
  assert.equal(result.headers.get('set-cookie'), 'owner=signed; HttpOnly; Secure');
  await result.body.cancel();
});

test('WebSocket handle is not reconstructed as a standard Response', async () => {
  const upstream = { status: 101, webSocket: { nativeHandle: true } };
  const result = await handleRequest({
    request: request('/api/events.mux', { headers: { upgrade: 'websocket', origin } }),
    env: proxy(() => upstream),
  });
  assert.equal(result, upstream);
});

test('cross-origin writes, logins and WebSockets never reach the backend', async () => {
  let calls = 0;
  const env = proxy(() => {
    calls++;
    return new Response();
  });
  for (const req of [
    request('/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.example' } }),
    request('/api/workspace/file', {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: 'bad',
    }),
    request('/api/events.mux', { headers: { upgrade: 'websocket', origin: 'https://evil.example' } }),
  ])
    assert.equal((await handleRequest({ request: req, env })).status, 403);
  assert.equal(calls, 0);
});

test('same-origin no-referrer form POST may have Origin null; cross-site/opaque WebSockets remain blocked', async () => {
  let calls = 0;
  const env = proxy(() => {
    calls++;
    return new Response(null, { status: 303 });
  });
  const form = request('/api/auth/login', {
    method: 'POST',
    headers: {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'accessKey=fixture',
  });
  assert.equal((await handleRequest({ request: form, env })).status, 303);
  assert.equal(calls, 1);
  for (const site of ['same-site', 'cross-site', 'none']) {
    assert.equal(
      (
        await handleRequest({
          request: request('/api/auth/login', {
            method: 'POST',
            headers: { origin: 'null', 'sec-fetch-site': site },
          }),
          env,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await handleRequest({
        request: request('/api/events.mux', {
          headers: { origin: 'null', 'sec-fetch-site': 'same-origin', upgrade: 'websocket' },
        }),
        env,
      })
    ).status,
    403,
  );
  assert.equal(calls, 1);
});

test('novel documents/assets require upstream owner authentication', async () => {
  let assetReads = 0;
  const env = {
    ...proxy(() => Response.json({ authenticated: false })),
    ASSETS: {
      fetch() {
        assetReads++;
        return new Response('secret');
      },
    },
  };
  const page = await handleRequest({ request: request('/novels/'), env });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await handleRequest({ request: request('/novel-assets/studio.mjs'), env })).status, 401);
  assert.equal(
    (await handleRequest({ request: request('/worker/shared/writing-prompts.mjs'), env })).status,
    401,
  );
  assert.equal((await handleRequest({ request: request('/novels.html'), env })).status, 404);
  assert.equal(assetReads, 0);
});

test('library and account canonicalize into views of ONE root app, never independent public documents', async () => {
  const env = {
    ...proxy((req) => {
      assert.equal(req.headers.get('cookie'), 'owner=signed');
      if (new URL(req.url).pathname === '/')
        return new Response('<main>native application</main>', {
          headers: { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'" },
        });
      assert.equal(new URL(req.url).pathname, '/api/auth/session');
      return Response.json({ authenticated: true });
    }),
    ASSETS: {
      fetch(req) {
        throw new Error('Library/account must not request a separate static page.');
      },
    },
  };
  for (const path of ['/novels/', '/account/']) {
    const result = await handleRequest({
      request: request(path, { headers: { cookie: 'owner=signed' } }),
      env,
      rewriteHtml: (response) => response,
    });
    assert.equal(result.status, 302);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('location'), path === '/account/' ? '/?view=account' : '/?view=library');
  }
});

test('backend and auth failures do not fall through to public static files or disclose errors', async () => {
  const env = proxy(() => {
    throw new Error('key=do-not-disclose');
  });
  for (const path of ['/', '/novels/', '/api/settings']) {
    const result = await handleRequest({ request: request(path), env });
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /do-not-disclose/);
  }
});

test('HTML entry navigation uses the client plugin extension; non-document responses keep identity', async () => {
  const upstream = new Response('<head></head>', { headers: { 'content-type': 'text/html' } });
  let rewrites = 0;
  const env = proxy(() => upstream);
  const result = await handleRequest({
    request: request('/?novel=b-' + '1'.repeat(32)),
    env,
    rewriteHtml(response) {
      assert.equal(response, upstream);
      rewrites++;
      return new Response('<head><script src="/novel-assets/harness-boot.mjs"></script></head>');
    },
  });
  assert.equal(rewrites, 1);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const plain = new Response('native data');
  assert.equal(await handleRequest({ request: request('/api/health'), env: proxy(() => plain) }), plain);
});

test('successful owner login lands in the novel library and preserves the signed Cookie', async () => {
  const native = new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': '__Host-owner=signed; Secure; HttpOnly' },
  });
  const result = await handleRequest({
    request: request('/api/auth/login', { method: 'POST', headers: { origin } }),
    env: proxy(() => native),
  });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/novels/');
  assert.equal(result.headers.get('set-cookie'), native.headers.get('set-cookie'));
});

test('public platform revision is credential-free and not a proxy for other Worker settings', async () => {
  let called = false;
  const result = await handleRequest({
    request: request('/api/platform/version'),
    env: {
      ...proxy(() => {
        called = true;
      }),
      PLATFORM_REVISION: 'expected-revision',
      SOME_SECRET: 'not-public',
    },
  });
  assert.equal((await result.json()).revision, 'expected-revision');
  assert.equal(called, false);
});

test('only current version-addressed code gets private immutable caching; auth and API data stay uncached', async () => {
  const revision = 'a'.repeat(64),
    paths = [];
  let authenticated = true;
  const env = {
    PLATFORM_REVISION: revision,
    HARNESS: { fetch: () => Response.json({ authenticated }, { headers: { 'cache-control': 'no-store' } }) },
    ASSETS: {
      fetch: (req) => {
        paths.push(new URL(req.url).pathname);
        return new Response('code', { headers: { 'content-type': 'text/javascript' } });
      },
    },
  };
  const base = releaseAssetBase(revision);
  for (const [path, canonical] of [
    [base + 'application.mjs', '/novel-assets/application.mjs'],
    [
      new URL('../../../worker/shared/illustrations.mjs', origin + base + 'prose-editor.mjs').pathname,
      '/worker/shared/illustrations.mjs',
    ],
    [
      new URL('../../../worker/shared/writing-context.mjs', origin + base + 'reference-core.mjs').pathname,
      '/worker/shared/writing-context.mjs',
    ],
    ['/plugins/@deepseek-ai/dsh-client-ui-layout/client.js?novel=' + revision, '/native-shell/layout.js'],
  ]) {
    const response = await handleRequest({ request: request(path), env });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(paths.at(-1), canonical);
  }
  for (const path of ['/novel-assets/application.mjs', '/api/novels', '/api/auth/session']) {
    assert.equal(
      (await handleRequest({ request: request(path), env })).headers.get('cache-control'),
      'no-store',
    );
  }
  authenticated = false;
  assert.equal((await handleRequest({ request: request(base + 'application.mjs'), env })).status, 401);
  const before = paths.length;
  const stale = await handleRequest({
    request: request('/studio/' + 'b'.repeat(64) + '/pages/public/novel-assets/application.mjs'),
    env,
  });
  assert.equal(stale.status, 404);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.equal(paths.length, before);
});
