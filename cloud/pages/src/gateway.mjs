const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NATIVE_SHELL_MODULES = new Map([
  ['/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', '/native-shell/conversation.js'],
  ['/plugins/@deepseek-ai/dsh-client-ui-sidebar/client.js', '/native-shell/sidebar.js'],
  ['/plugins/@deepseek-ai/dsh-client-ui-layout/client.js', '/native-shell/layout.js'],
  ['/plugins/@deepseek-ai/dsh-client-ui-settings-general/client.js', '/native-shell/settings.js'],
]);

// Mirror source directory depth so existing relative imports (including shared
// Worker modules) resolve within the SAME immutable release, without rewriting JS.
export function releaseAssetBase(revision) {
  return '/studio/' + encodeURIComponent(revision) + '/pages/public/novel-assets/';
}
function releaseAsset(pathname, revision) {
  const prefix = '/studio/' + encodeURIComponent(revision) + '/';
  if (!pathname.startsWith(prefix)) return null;
  const path = pathname.slice(prefix.length);
  if (/^pages\/public\/novel-assets\/[a-z0-9-]+\.(mjs|css)$/.test(path))
    return '/' + path.slice('pages/public/'.length);
  if (/^worker\/shared\/(writing-context|writing-prompts)\.mjs$/.test(path)) return '/' + path;
  return null;
}

function failure(message, status) {
  return Response.json(
    { error: message },
    {
      status,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    },
  );
}

export function rewriteNovelHtml(response, revision = 'development') {
  const encoded = encodeURIComponent(revision);
  const base = releaseAssetBase(revision);
  return (
    new HTMLRewriter()
      .on('title', {
        element(element) {
          element.setInnerContent('小说工作台');
        },
      })
      // Library/account routes canonicalize to ONE root shell. Resolve its
      // release-owned relative assets at that root, without adding a
      // CSP-blocked <base> or changing API origins.
      .on('script[src], link[href]', {
        element(element) {
          const attr = element.tagName === 'script' ? 'src' : 'href';
          const value = element.getAttribute(attr);
          if (value?.startsWith('./')) element.setAttribute(attr, '/' + value.slice(2));
        },
      })
      .on('head', {
        element(element) {
          element.append(
            ['harness-navigation.css', 'manuscript.css', 'application.css']
              .map((name) => `<link rel="stylesheet" href="${base}${name}">`)
              .join('') +
              [
                'bridge-core.mjs',
                'harness-navigation.mjs',
                'manuscript.mjs',
                'application.mjs',
                'task-message.mjs',
                'proposal-tool-view.mjs',
                'studio-theme.mjs',
              ]
                .map((name) => `<link rel="modulepreload" href="${base}${name}">`)
                .join('') +
              `<script src="${base}harness-boot.mjs" data-novel-revision="${encoded}"></script>`,
            { html: true },
          );
        },
      })
      .transform(response)
  );
}

export async function handleRequest({ request, env, rewriteHtml = rewriteNovelHtml }) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
    return failure('公网访问必须使用 HTTPS。', 400);
  }
  if (!env.HARNESS?.fetch) return failure('尚未绑定独立的 DSH Worker。', 503);

  // Keep the public URL, Cookie and Origin unchanged across the service binding.
  // A configurable upstream URL would turn this into an SSRF/credential proxy.
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const isSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  // Referrer-Policy: no-referrer can give same-origin HTML form POSTs an opaque
  // Origin: null. Fetch Metadata is browser-controlled; allow this combination
  // only for same-origin writes, never cross-site requests or opaque WebSockets.
  const opaqueSameOriginWrite = origin === 'null' && fetchSite === 'same-origin' && isWrite;
  if (
    (origin && origin !== url.origin && !opaqueSameOriginWrite) ||
    ((isWrite || isSocket) && fetchSite && !['same-origin', 'none'].includes(fetchSite))
  ) {
    return failure('不接受跨来源请求。', 403);
  }

  try {
    const revision = env.PLATFORM_REVISION ?? 'development';
    const versionedAsset = releaseAsset(url.pathname, revision);
    if (url.pathname.startsWith('/studio/') && !versionedAsset)
      return failure('此界面版本已更新，请刷新页面。', 404);
    if (url.pathname === '/api/platform/version' && request.method === 'GET') {
      return Response.json(
        {
          platform: 'novel-harness-pages',
          revision: env.PLATFORM_REVISION ?? 'development',
          runtimeVersion: '0.30.0',
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const loginPage = url.pathname === '/login' || url.pathname === '/login/';
    const accountPage = url.pathname === '/account' || url.pathname === '/account/';
    const authAsset = /^\/auth-assets\/(?:auth\.mjs|auth\.css)$/.test(url.pathname);
    const novelPage = url.pathname === '/novels' || url.pathname === '/novels/';
    const novelAsset = /^\/novel-assets\/[a-z0-9-]+\.(?:mjs|css)$/.test(url.pathname);
    const sharedAsset = /^\/worker\/shared\/(?:writing-context|writing-prompts)\.mjs$/.test(url.pathname);
    const nativeShell = NATIVE_SHELL_MODULES.get(url.pathname);
    if (
      novelPage ||
      novelAsset ||
      sharedAsset ||
      accountPage ||
      loginPage ||
      authAsset ||
      nativeShell ||
      versionedAsset
    ) {
      if (!['GET', 'HEAD'].includes(request.method)) return failure('不支持此请求方式。', 405);
      if (!loginPage && !authAsset) {
        const auth = await env.HARNESS.fetch(
          new Request(new URL('/api/auth/session', url), {
            headers: { cookie: request.headers.get('cookie') ?? '' },
            redirect: 'manual',
          }),
        );
        if (!auth.ok) return failure('DSH 身份验证暂不可用。', 503);
        const session = await auth.json();
        if (session.authenticated !== true) {
          return novelPage || accountPage
            ? new Response(null, {
                status: 302,
                headers: { location: '/login', 'cache-control': 'no-store' },
              })
            : failure('请先登录。', 401);
        }
      }
      if (novelPage || accountPage) {
        // Native HTTP/WebSocket carriers resolve relative to the boot URL.
        // Keep ONE canonical root document; navigation changes only its query.
        return new Response(null, {
          status: 302,
          headers: {
            location: '/?view=' + (accountPage ? 'account' : 'library'),
            'cache-control': 'no-store',
          },
        });
      }
      const assetUrl = new URL(
        versionedAsset ||
          nativeShell ||
          (novelPage ? '/novels/' : loginPage ? '/login/' : accountPage ? '/account/' : url.pathname),
        url,
      );
      const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
      const headers = new Headers(asset.headers);
      // Only version-addressed static CODE may persist in this browser. Book
      // data, HTML, auth and unversioned compatibility imports remain no-store.
      const immutable =
        revision !== 'development' &&
        asset.status === 200 &&
        (versionedAsset || (nativeShell && url.searchParams.get('novel') === revision));
      headers.set('cache-control', immutable ? 'private, max-age=31536000, immutable' : 'no-store');
      headers.set('x-content-type-options', 'nosniff');
      headers.set('referrer-policy', 'no-referrer');
      headers.set(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      return new Response(asset.body, { status: asset.status, headers });
    }
    // /novels.html must not bypass the authenticated document route.
    if (
      url.pathname === '/novels.html' ||
      url.pathname.startsWith('/novel-assets/') ||
      url.pathname.startsWith('/native-shell/')
    ) {
      return failure('页面不存在。', 404);
    }
    // Return the ORIGINAL response: never buffer SSE or reconstruct a 101 response.
    // This preserves native WebSocket handles, Set-Cookie and upstream CSP.
    const upstream = await env.HARNESS.fetch(request);
    if (
      url.pathname === '/api/auth/login' &&
      request.method === 'POST' &&
      upstream.status === 303 &&
      upstream.headers.get('location') === '/'
    ) {
      const headers = new Headers(upstream.headers);
      headers.set('location', '/novels/');
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if (
      !url.pathname.startsWith('/api/') &&
      url.pathname !== '/' &&
      upstream.status === 200 &&
      upstream.headers.get('content-type')?.includes('text/html')
    ) {
      // Native asset fallback must never expose an unadapted second application
      // through /index.html, /novels/index.html or a stale bookmarked SPA path.
      return new Response(null, {
        status: 302,
        headers: { location: '/?view=library', 'cache-control': 'no-store' },
      });
    }
    if (
      url.pathname === '/' &&
      upstream.status === 200 &&
      upstream.headers.get('content-type')?.includes('text/html')
    ) {
      if (url.searchParams.has('novel') && !/^b-[a-f0-9]{32}$/.test(url.searchParams.get('novel')))
        return failure('小说地址无效。', 400);
      const rewritten = await rewriteHtml(upstream, env.PLATFORM_REVISION ?? 'development');
      rewritten.headers.set('cache-control', 'no-store');
      return rewritten;
    }
    return upstream;
  } catch {
    // Do not put cookies, provider errors, keys or book contents in diagnostics.
    return failure('无法连接 DSH 后端，请稍后重试；未切换到其他数据源。', 503);
  }
}
