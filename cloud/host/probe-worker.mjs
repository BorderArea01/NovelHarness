// Isolated synthetic transport probe, NOT a second novel service.
// Fixed paths only: it cannot proxy the actual app, credentials or database.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.PROBE_TOKEN || request.headers.get('authorization') !== 'Bearer ' + env.PROBE_TOKEN)
      return new Response('', { status: 404 });
    if (!['/__probe_http', '/__probe_stream', '/__probe_ws'].includes(url.pathname)) return new Response('', { status: 404 });
    const headers = new Headers(request.headers);
    headers.delete('authorization'); headers.set('x-novel-probe', env.PROBE_TOKEN);
    try {
      return await env.LOCAL_SERVICE.fetch(new Request('http://localhost' + url.pathname, {
        method: request.method, headers, body: request.body, redirect: 'manual',
      }));
    } catch { return new Response('Private transport unavailable.', { status: 503 }); }
  },
};
