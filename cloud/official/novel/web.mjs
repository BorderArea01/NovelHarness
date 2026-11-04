// Isolated unified product entry. Reuses the current Pages/PIN/editor owners;
// an official native Connection cookie remains the upstream authentication.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { productionAuthority, productionCookies } from './production-wire.mjs';
import { clientMediaFile } from './client-media.mjs';
import {
  compressibleAsset,
  assetDeliveryHeaders,
  streamBrowserBody,
  novelModulePreloads,
  invalidatesNativeTransports,
} from './web-performance.mjs';

const json = (value, status = 200, headers = {}) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });
const sha = (value) => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
async function boundedBody(request, limit) {
  const chunks = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) {
          await reader.cancel();
          const error = new Error('请求过大。');
          error.status = 413;
          throw error;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks, length);
}

export async function startNovelWeb(
  app,
  { ownerKey, home, lanHosts = [], port = 0, publicOrigin = '', isPublished = () => true, initialPin },
) {
  // This adapter is not a deployment switch. Production secrets cannot be
  // accidentally supplied to the present synthetic, loopback-only lab.
  const staging = app.staging === true;
  const production = app.production === true;
  const anonymous = app.anonymous === true;
  const shared = app.shared === true;
  assert(
    ownerKey.length >= 32 &&
      (staging || production || anonymous || shared || ownerKey.startsWith('fixture-only-')),
  );
  assert(staging || production || (!lanHosts.length && port === 0));
  if (production) assert(new URL(publicOrigin).protocol === 'https:');
  assert(lanHosts.every((host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host)));
  assert(Number.isInteger(port) && port >= 0 && port < 65536);
  const root = resolve('data/official-validation/integration');
  const homeRelative = relative(resolve(app.dataRoot ?? root), resolve(home));
  assert(homeRelative && !homeRelative.startsWith('..') && !isAbsolute(homeRelative));
  const { novelAssetsRevision: revision } = JSON.parse(await readFile(join(root, 'baseline.json'), 'utf8'));
  assert(/^official-novel-[a-f0-9]{16}$/.test(revision));
  const base = join(root, 'baseline');
  const load = (name) => import(pathToFileURL(join(base, 'worker', name + '.mjs')));
  const [
    { handlePinRequest, cookieValue },
    { PinAuth },
    { novelGateway },
    { fetchNovelDocument },
    { createReadSnapshots },
    { handleRequest },
  ] = await Promise.all([
    load('pin-gateway'),
    load('pin-store'),
    load('novel-gateway'),
    load('official-document-route'),
    load('read-snapshot'),
    import(pathToFileURL(join(base, 'page-gateway.mjs'))),
  ]);
  const db = new Database(join(home, 'web-pin.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS pin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const kv = {
    get: (key) => {
      const row = db.prepare('SELECT value FROM pin_kv WHERE key=?').get(key);
      return row ? JSON.parse(row.value) : undefined;
    },
    put: (key, value) =>
      db
        .prepare('INSERT INTO pin_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, JSON.stringify(value)),
  };
  const pin = new PinAuth(
    { blockConcurrencyWhile: (fn) => fn(), storage: kv },
    { DSH_EDGE_ACCESS_KEY: ownerKey, NOVEL_STORAGE_ROLE: 'host' },
  );
  await pin.ready;
  if (shared && !pin.state.pin) {
    if (typeof initialPin !== 'string' || !/^[0-9]{4,12}$/.test(initialPin)) {
      db.close();
      const error = new Error(
        '首次启动私人模式需要设置 4–12 位数字 PIN。请设置 NOVEL_INITIAL_PIN，已有 PIN 不会被重设。',
      );
      error.code = 'PIN_SETUP_REQUIRED';
      throw error;
    }
    const initialized = await pin.fetch(
      new Request('https://pin.internal/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'set',
          recoveryAuthorized: true,
          newPin: initialPin,
          confirmPin: initialPin,
          ip: 'local-initialization',
        }),
      }),
    );
    assert.equal(initialized.status, 200, 'Initial PIN configuration failed.');
    await initialized.arrayBuffer();
  }
  const host = app.ctx.get('novelHost');
  assert(host && app.ctx.get('fs'));
  host.env.DSH_EDGE_ACCESS_KEY = ownerKey;
  host.novelReadSnapshots = createReadSnapshots();
  host.sessions.waitForInitialization = async () => {};
  host.sessions.getApiSessionSummary = async (id) =>
    (await app.ctx.get('sessionController').inspect(id)).meta;
  const env = {
    DSH_EDGE_ACCESS_KEY: ownerKey,
    PLATFORM_REVISION: revision,
    PIN_AUTH: { getByName: () => pin },
    DSH_EDGE_INSTANCE: { getByName: () => ({ fetch: (request) => fetchNovelDocument.call(host, request) }) },
  };
  let origin;
  let authorities;
  const internalOrigin = (authority) => 'http://localhost:' + authority.port;
  const stageCookies = (text, reverse = false) => {
    if (!staging) return text;
    const pairs = reverse
      ? [
          ['dsh_edge_owner', 'novel_stage_owner'],
          ['novel_pin', 'novel_stage_pin'],
        ]
      : [
          ['novel_stage_owner', 'dsh_edge_owner'],
          ['novel_stage_pin', 'novel_pin'],
        ];
    // Drop formal cookies before translating acceptance-copy cookies. Cookies
    // are scoped to a host, not a port; never clobber the running site's login.
    if (!reverse)
      text = text
        .split(';')
        .filter((part) => !/^\s*(?:dsh_edge_owner|novel_pin)=/.test(part))
        .join(';');
    for (const [from, to] of pairs)
      text = text.replace(new RegExp('(^|;\\s*)' + from + '=', 'g'), '$1' + to + '=');
    return text;
  };
  const incoming = (req) => {
    if ((anonymous || shared) && !equal(req.headers['x-novelharness-internal'], ownerKey)) return null;
    if (production) return productionAuthority(req, { ownerKey, publicOrigin, port, authorities });
    if (!authorities.has(req.headers.host)) return null;
    const outside = new URL('http://' + req.headers.host);
    if (
      req.headers.origin &&
      req.headers.origin !== outside.origin &&
      !(req.headers.origin === 'null' && req.headers['sec-fetch-site'] === 'same-origin')
    )
      return null;
    if (req.headers['sec-fetch-site'] === 'cross-site') return null;
    // Shared browser credentials keep a stable internal audience across child
    // restarts; the supervisor still verifies the real external origin.
    return {
      outside,
      inside: shared ? 'http://' + app.sharedAudience : staging ? internalOrigin(outside) : outside.origin,
    };
  };
  const trace = [];
  const mark = (phase, path, status) => {
    if (trace.length < 300) trace.push({ phase, path, status });
  };
  const backend = new URL(app.origin);
  const sockets = new Set();
  const anonymousNativeCookies = new Map();
  const nativeCookie = (request) => {
    const url = new URL(request.url);
    if (anonymous) {
      if (!anonymousNativeCookies.has(url.host)) {
        const tokenUrl = new URL(app.ctx.get('connection').authenticatedUrl(url.origin));
        let cookie;
        app.ctx.get('connection').authorizeIndex(
          { method: 'GET', url: tokenUrl.pathname + tokenUrl.search, headers: { host: url.host } },
          {
            writeHead(code, headers) {
              assert.equal(code, 303);
              cookie = headers['set-cookie'].split(';')[0];
            },
            end() {},
          },
        );
        assert(cookie);
        anonymousNativeCookies.set(url.host, cookie);
      }
      return anonymousNativeCookies.get(url.host);
    }
    const ownerName = url.protocol === 'https:' ? '__Host-dsh_edge_owner' : 'dsh_edge_owner';
    const value = cookieValue(request, ownerName);
    return value ? 'dsh-auth-' + sha(url.host) + '=' + value : '';
  };
  const nativeHeaders = (request) => {
    const headers = Object.fromEntries(request.headers);
    headers.host = new URL(request.url).host;
    headers.cookie = nativeCookie(request);
    delete headers['cf-connecting-ip'];
    delete headers['content-length'];
    delete headers['x-novelharness-internal'];
    return headers;
  };
  const authenticated = (request) =>
    !('rejection' in app.ctx.get('connection').admit({ headers: nativeHeaders(request) }));
  async function nativeFetch(request) {
    const url = new URL(request.url);
    mark('native', url.pathname);
    if (url.pathname === '/api/auth/session') return json({ authenticated: authenticated(request) });
    if (anonymous && url.pathname.startsWith('/api/auth/'))
      return url.pathname === '/api/auth/pin' && request.method === 'GET'
        ? json({ authenticated: true, configured: false, mode: 'anonymous' })
        : json({ error: '此部署使用独立访客空间，不使用 PIN。' }, 404);
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const input = Object.fromEntries(new URLSearchParams(await request.text()));
      if (!equal(input.accessKey, ownerKey)) return json({ error: '恢复口令不正确。' }, 401);
      const urlWithToken = new URL(app.ctx.get('connection').authenticatedUrl(url.origin));
      let status, headers;
      const response = {
        writeHead(code, value) {
          status = code;
          headers = value;
        },
        end() {},
      };
      app.ctx
        .get('connection')
        .authorizeIndex(
          { method: 'GET', url: urlWithToken.pathname + urlWithToken.search, headers: { host: url.host } },
          response,
        );
      assert.equal(status, 303);
      const original = headers['set-cookie'];
      assert(original.startsWith('dsh-auth-'));
      return new Response(null, {
        status: 303,
        headers: {
          location: '/',
          'cache-control': 'no-store',
          'set-cookie': 'dsh_edge_owner=' + original.slice(original.indexOf('=') + 1),
        },
      });
    }
    if (url.pathname === '/api/auth/logout')
      return new Response(null, {
        status: 303,
        headers: {
          location: '/login',
          'cache-control': 'no-store',
          'set-cookie': 'dsh_edge_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        },
      });
    // PIN is deliberately unconfigured on first boot; the original PIN gate
    // then delegates owner authentication. Unlike stock DSH's private plugin
    // routes, every delegated route here must still prove its native owner.
    if (!authenticated(request))
      return url.pathname === '/'
        ? new Response(null, { status: 302, headers: { location: '/login', 'cache-control': 'no-store' } })
        : json({ error: '请先登录。' }, 401);
    if (
      anonymous &&
      /^\/dsh-purge\/(skills?|rules|update|apply|revert|uninstall|restart|drill-grant)(\/|$)/.test(
        url.pathname,
      )
    )
      return json(
        { ok: false, error: '访客可编辑自己的插件提示词；宿主安装、规则文件与更新由部署者维护。' },
        403,
      );
    if (
      (staging || production || anonymous || shared) &&
      /^\/dsh-purge\/(apply|revert|uninstall|restart|update|drill-grant)(\/|$)/.test(url.pathname) &&
      request.method !== 'GET'
    )
      return json(
        { ok: false, error: '局域网验收版暂不执行宿主安装、恢复、卸载或重启；正式服务未改变。' },
        409,
      );
    if (url.pathname === '/api/workspace/file') {
      const path = url.searchParams.get('path');
      if (
        !path?.startsWith('/workspace/') ||
        path.includes('\\') ||
        path.includes('\0') ||
        posix.normalize(path) !== path
      )
        return json({ error: '无效工作区路径。' }, 400);
      const fs = app.storage.fs;
      if (request.method === 'GET') {
        if (!fs.existsSync(path)) return new Response(null, { status: 404 });
        return new Response(fs.readFileSync(path), {
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
        });
      }
      if (request.method === 'PUT') {
        let content;
        try {
          content = await boundedBody(request, 1024 * 1024);
        } catch (error) {
          if (error.status) return json({ error: error.message }, error.status);
          throw error;
        }
        app.storage.db.transactionSync(() => {
          fs.mkdirSync(posix.dirname(path), { recursive: true });
          fs.writeFileSync(path, content);
        });
        return json({ written: true });
      }
      return json({ error: '不支持此请求方式。' }, 405);
    }
    if (url.pathname === '/api/workspace/exec') {
      if (request.method !== 'POST') return json({ error: '不支持此请求方式。' }, 405);
      let input;
      try {
        input = JSON.parse((await boundedBody(request, 65536)).toString('utf8'));
      } catch (error) {
        return json({ error: error.status ? error.message : '请求格式不正确。' }, error.status ?? 400);
      }
      if (
        typeof input.command !== 'string' ||
        !input.command.trim() ||
        !(input.cwd === '/workspace' || input.cwd?.startsWith('/workspace/')) ||
        posix.normalize(input.cwd) !== input.cwd
      )
        return json({ error: '无效工作区命令。' }, 400);
      const shell = app.ctx.get('shell');
      const execution = await shell.execute(
        shell.resolve({
          command: input.command,
          workdir: input.cwd,
          stdoutMaxBytes: 1024 * 1024,
          timeoutMs: 15000,
          signal: request.signal,
        }),
      );
      const result = await execution.result();
      return json({
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputTruncated: result.stdout.truncated || result.stderr.truncated,
      });
    }
    // Static assets and original streaming HTTP RPC are forwarded without a
    // bearer key in browser scripts, buffering the stream, or a new Agent loop.
    return new Promise((resolveResponse, reject) => {
      const outgoing = httpRequest(
        {
          hostname: backend.hostname,
          port: backend.port,
          path: url.pathname + url.search,
          method: request.method,
          headers: {
            ...nativeHeaders(request),
            ...(url.pathname === '/' ? { 'accept-encoding': 'identity' } : {}),
          },
          signal: request.signal,
        },
        (incoming) => {
          mark('backend-response', url.pathname, incoming.statusCode);
          const headers = new Headers();
          for (const [key, values] of Object.entries(incoming.headers))
            for (const value of Array.isArray(values) ? values : [values])
              if (value !== undefined && !['connection', 'transfer-encoding'].includes(key))
                headers.append(key, String(value));
          resolveResponse(
            new Response(
              request.method === 'HEAD' || [204, 304].includes(incoming.statusCode)
                ? null
                : Readable.toWeb(incoming),
              { status: incoming.statusCode, headers },
            ),
          );
        },
      );
      outgoing.on('error', reject);
      if (request.body) pipeline(Readable.fromWeb(request.body), outgoing).catch(reject);
      else outgoing.end();
    });
  }
  const extended = { fetch: (request, env) => novelGateway(request, env, {}, { fetch: nativeFetch }) };
  host.nativeFetch = nativeFetch;
  env.HARNESS = {
    fetch: (request) =>
      anonymous ? extended.fetch(request, env) : handlePinRequest(request, env, {}, extended),
  };
  env.ASSETS = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const media = clientMediaFile(path);
      if (media) {
        try {
          return new Response(
            request.method === 'HEAD'
              ? null
              : await readFile(join(base, 'host-assets/client-media', media.name)),
            {
              headers: { 'content-type': media.type, 'cache-control': 'public, max-age=31536000, immutable' },
            },
          );
        } catch (error) {
          if (error.code === 'ENOENT') return new Response(null, { status: 404 });
          throw error;
        }
      }
      let file;
      if (path === '/login/') file = join(base, 'login/index.html');
      else if (/^\/auth-assets\/auth\.(mjs|css)$/.test(path)) file = join(base, path.slice(1));
      else if (/^\/novel-assets\/[a-z0-9-]+\.(mjs|css)$/.test(path))
        file = join(base, 'assets', path.slice('/novel-assets/'.length));
      else if (/^\/native-shell\/(conversation|sidebar|layout|settings)\.js$/.test(path))
        file = join(base, path.slice(1));
      else if (/^\/worker\/shared\/(writing-context|writing-prompts)\.mjs$/.test(path))
        file = join(base, path.slice(1));
      else if (
        (staging || production || anonymous || shared) &&
        /^\/__host-assets\/(crypto-boot\.js|crypto-runtime\.mjs)$/.test(path)
      )
        file = join(base, 'host-assets', path.slice('/__host-assets/'.length));
      if (!file) return new Response(null, { status: 404 });
      try {
        const type = file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.html')
            ? 'text/html'
            : 'text/javascript';
        return new Response(await readFile(file), { headers: { 'content-type': type + '; charset=utf-8' } });
      } catch (error) {
        if (error.code === 'ENOENT') return new Response(null, { status: 404 });
        throw error;
      }
    },
  };
  const rewriteHtml = async (response) => {
    mark('rewrite-begin', '/');
    let html = await response.text();
    mark('rewrite-read', '/');
    const asset = '/studio/' + revision + '/pages/public/novel-assets/';
    html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>小说工作台</title>');
    if (staging || production || anonymous || shared)
      html = html.replace('</head>', '<script src="/__host-assets/crypto-boot.js"></script></head>');
    if (staging) html = html.replace('<body', '<body data-novel-environment="lan-staging"');
    if (anonymous) html = html.replace('<body', '<body data-novel-auth="anonymous"');
    if (anonymous || shared)
      html = html.replace('<body', '<body data-novel-mode="' + (shared ? 'shared' : 'isolated') + '"');
    html = html.replace(/\b(src|href)="\.\//g, '$1="/');
    html = html.replace(
      '</head>',
      ['harness-navigation.css', 'manuscript.css', 'application.css']
        .map((name) => '<link rel="stylesheet" href="' + asset + name + '">')
        .join('') +
        novelModulePreloads(asset) +
        '</head>',
    );
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(html, { status: response.status, headers });
  };
  const server = createServer(async (req, res) => {
    if (production && req.url === '/api/health') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-novel-host-runtime': 'official-v1',
      });
      res.end(JSON.stringify({ runtime: 'deepseek-harness', revision, published: isPublished(req) }));
      return;
    }
    if (
      production &&
      !isPublished(req) &&
      !req.url.startsWith('/api/auth/') &&
      !req.url.startsWith('/api/platform/')
    ) {
      res.writeHead(503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': '5',
      });
      res.end('{"error":"小说工作台正在更新，已保存数据保留，请稍后刷新。"}');
      return;
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const authority = incoming(req);
      if (!authority) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, authority.inside);
      if (
        url.origin !== authority.inside ||
        url.searchParams.has('token') ||
        (url.pathname.startsWith('/__') &&
          !(
            (staging || production || anonymous || shared) &&
            (/^\/__host-assets\/(crypto-boot\.js|crypto-runtime\.mjs)$/.test(url.pathname) ||
              clientMediaFile(url.pathname))
          ))
      ) {
        res.writeHead(404).end();
        return;
      }
      const headers = new Headers();
      for (const [key, values] of Object.entries(req.headers))
        for (const value of Array.isArray(values) ? values : [values])
          if (
            value !== undefined &&
            !['cf-connecting-ip', 'x-forwarded-host', 'x-forwarded-proto'].includes(key)
          )
            headers.append(key, value);
      headers.set(
        'cf-connecting-ip',
        shared
          ? String(req.headers['x-novelharness-peer'] ?? 'unknown')
          : (req.socket.remoteAddress ?? 'unknown'),
      );
      for (const name of ['x-novel-host-auth', 'x-novel-forwarded-origin', 'x-novel-forward-as'])
        headers.delete(name);
      headers.delete('x-novel-verification');
      if (req.headers.origin && req.headers.origin !== 'null') headers.set('origin', authority.inside);
      if (staging) headers.set('cookie', stageCookies(headers.get('cookie') ?? ''));
      if (authority.secure) headers.set('cookie', productionCookies(headers.get('cookie') ?? ''));
      const request = new Request(url, {
        method: req.method,
        headers,
        signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const beforeEpoch = pin.state.epoch;
      const response =
        (staging || production || anonymous || shared) && url.pathname.startsWith('/__host-assets/')
          ? await env.ASSETS.fetch(request)
          : await handleRequest({ request, env, rewriteHtml });
      mark('response', url.pathname, response.status);
      if (
        invalidatesNativeTransports({
          method: request.method,
          status: response.status,
          path: url.pathname,
          beforeEpoch,
          afterEpoch: pin.state.epoch,
        })
      ) {
        // A PIN epoch change must invalidate established transports as well
        // as new requests. Disconnect the browser carrier, not its AI Agent.
        for (const socket of sockets) socket.destroy();
      }
      const gzip = compressibleAsset(request, response);
      for (const [key, value] of assetDeliveryHeaders(response.headers, gzip))
        if (!['set-cookie', 'transfer-encoding', 'connection'].includes(key)) res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length)
        res.setHeader(
          'set-cookie',
          cookies.map((cookie) =>
            authority.secure ? productionCookies(cookie, true) : stageCookies(cookie, true),
          ),
        );
      if (staging) res.setHeader('x-novel-environment', 'lan-staging-independent-copy');
      if (production) res.setHeader('x-novel-host-runtime', 'official-v1');
      res.writeHead(response.status);
      if (response.body && req.method !== 'HEAD') await streamBrowserBody(response, res, gzip);
      else res.end();
    } catch {
      if (!res.headersSent)
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (!res.destroyed) res.end('{"error":"隔离工作台请求未完成，未切换数据源。"}');
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    const reject = (status) => {
      if (!socket.destroyed)
        socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    try {
      if (production && !isPublished(req)) return reject('503 Service Unavailable');
      const authority = incoming(req);
      if (!authority) return reject('403 Forbidden');
      const url = new URL(req.url, authority.inside);
      if (url.origin !== authority.inside || url.searchParams.has('token') || url.pathname.startsWith('/__'))
        return reject('404 Not Found');
      const headers = new Headers(req.headers);
      for (const name of ['x-novel-host-auth', 'x-novel-forwarded-origin', 'x-novel-forward-as'])
        headers.delete(name);
      headers.delete('x-novel-verification');
      if (req.headers.origin) headers.set('origin', authority.inside);
      if (staging) headers.set('cookie', stageCookies(headers.get('cookie') ?? ''));
      if (authority.secure) headers.set('cookie', productionCookies(headers.get('cookie') ?? ''));
      const request = new Request(url, { headers });
      const state = anonymous
        ? json({ allowed: true })
        : await pin.fetch(
            new Request('https://pin.internal/', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'authorize',
                cookie: cookieValue(request, 'dsh_edge_owner'),
                gate: cookieValue(request, 'novel_pin'),
              }),
            }),
          );
      if (!state.ok || !(await state.json()).allowed || !authenticated(request))
        return reject('401 Unauthorized');
      // Preserve the original native WebSocket byte stream, including protocol
      // negotiation and compression. The gateway owns no RPC or Agent state.
      const outgoing = httpRequest({
        hostname: backend.hostname,
        port: backend.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: nativeHeaders(request),
      });
      sockets.add(socket);
      socket.on('error', () => outgoing.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        outgoing.destroy();
      });
      outgoing.on('error', () => {
        if (!socket.destroyed) reject('502 Bad Gateway');
      });
      outgoing.on('response', (response) => {
        response.resume();
        reject(String(response.statusCode) + ' Upgrade Rejected');
      });
      outgoing.on('upgrade', (response, upstream, upstreamHead) => {
        sockets.add(upstream);
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => {
          sockets.delete(upstream);
          socket.destroy();
        });
        socket.on('close', () => upstream.destroy());
        let handshake = 'HTTP/1.1 ' + response.statusCode + ' ' + response.statusMessage + '\r\n';
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          handshake += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n';
        socket.write(handshake + '\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      outgoing.end();
    } catch {
      reject('503 Service Unavailable');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, (staging || production) && lanHosts.length ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  authorities = new Set(
    ['127.0.0.1', 'localhost', ...lanHosts].map((host) => host + ':' + server.address().port),
  );
  return {
    origin,
    trace,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pin.queue;
      db.close();
    },
  };
}
