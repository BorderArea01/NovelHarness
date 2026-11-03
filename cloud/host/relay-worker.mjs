// Public Cloudflare service-binding replacement. NO database or fallback owner.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.NOVEL_PUBLIC_ORIGIN || url.protocol !== 'https:' || !env.LOCAL_SERVICE || !env.DSH_EDGE_ACCESS_KEY)
      return new Response('Host relay is not configured.', { status: 503 });
    const headers = new Headers(request.headers);
    // Client-supplied forwarding fields never determine routing or credentials.
    headers.set('x-novel-host-auth', env.DSH_EDGE_ACCESS_KEY);
    headers.set('x-novel-forwarded-origin', env.NOVEL_PUBLIC_ORIGIN);
    headers.set('x-novel-forward-as', 'harness');
    headers.delete('host');
    try {
      return await env.LOCAL_SERVICE.fetch(new Request('http://localhost' + url.pathname + url.search, {
        method: request.method, headers, body: request.body, redirect: 'manual', duplex: 'half',
      }));
    } catch {
      return Response.json({ error: '开发机主机暂时离线或连接未就绪。请稍后重试；未切换到旧云端数据。' },
        { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } });
    }
  },
};
