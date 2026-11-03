const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const denied = () => Response.json({ error: '不接受这个主机来源。' }, { status: 403, headers: { 'cache-control': 'no-store' } });
export function sameHostSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (actual.charCodeAt(i) || 0);
  return mismatch === 0;
}
export function prepareHostRequest(request, env) {
  const url = new URL(request.url), headers = new Headers(request.headers);
  const forwarded = headers.has('x-novel-host-auth') || headers.has('x-novel-forwarded-origin') || headers.has('x-novel-forward-as');
  if (forwarded) {
    if (!sameHostSecret(headers.get('x-novel-host-auth'), env.DSH_EDGE_ACCESS_KEY)
      || !env.NOVEL_PUBLIC_ORIGIN || headers.get('x-novel-forwarded-origin') !== env.NOVEL_PUBLIC_ORIGIN
      || headers.get('x-novel-forward-as') !== 'harness') return { failure: denied() };
    const target = new URL(url.pathname + url.search, env.NOVEL_PUBLIC_ORIGIN);
    if (target.protocol !== 'https:' || target.origin !== env.NOVEL_PUBLIC_ORIGIN) return { failure: denied() };
    for (const name of ['x-novel-host-auth', 'x-novel-forwarded-origin', 'x-novel-forward-as', 'host']) headers.delete(name);
    return { request: new Request(target, { method: request.method, headers, body: request.body, duplex: 'half' }), mode: 'harness' };
  }
  if (loopback.has(url.hostname)) return { request, mode: 'website' };
  const allowed = String(env.NOVEL_LAN_HOSTS ?? '').split(',').filter(Boolean);
  if (url.protocol !== 'http:' || !allowed.includes(url.hostname)) return { failure: denied() };
  const origin = headers.get('origin'), site = headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin && !(origin === 'null' && site === 'same-origin'))
    || (site && !['same-origin', 'none'].includes(site))) return { failure: denied() };
  // Native code intentionally permits plaintext only on loopback. This adapter
  // accepts only enumerated local NIC addresses, validates the ORIGINAL browser
  // origin first, then uses loopback internally. Cookies remain host-only/HTTP.
  const target = new URL(url); target.hostname = 'localhost';
  if (origin === url.origin) headers.set('origin', target.origin);
  headers.delete('host'); headers.delete('cf-connecting-ip');
  return { request: new Request(target, { method: request.method, headers, body: request.body, duplex: 'half' }), mode: 'website', insecureLan: true };
}
