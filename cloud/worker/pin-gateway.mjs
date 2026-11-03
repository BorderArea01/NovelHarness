import { serviceFailure } from './service-failure.mjs';
const AGE = 30 * 24 * 60 * 60;
const local = new Set(['localhost', '127.0.0.1', '[::1]']);
class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const json = (body, status = 200, headers = {}) => {
  const h = new Headers(headers);
  h.set('cache-control', 'no-store');
  h.set('x-content-type-options', 'nosniff');
  return Response.json(body, { status, headers: h });
};
export function cookieValue(request, name) {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
function names(request) {
  return new URL(request.url).protocol === 'https:'
    ? ['__Host-dsh_edge_owner', '__Host-novel_pin']
    : ['dsh_edge_owner', 'novel_pin'];
}
function gateCookie(request, value, clear = false) {
  return `${names(request)[1]}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : AGE}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function body(request) {
  let length = 0;
  const chunks = [],
    reader = request.body?.getReader();
  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) {
          await reader.cancel();
          throw new InputError(413, '认证请求过大。');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = (request.headers.get('content-type') ?? '').includes('application/json')
      ? JSON.parse(text)
      : Object.fromEntries(new URLSearchParams(text));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-body');
    return value;
  } catch {
    throw new InputError(400, '认证请求格式不正确。');
  }
}

export async function handlePinRequest(request, env, ctx, native) {
  const url = new URL(request.url),
    path = url.pathname;
  if (url.protocol !== 'https:' && !local.has(url.hostname))
    return json({ error: '公网访问必须使用 HTTPS。' }, 400);
  if (path === '/api/health') return native.fetch(request, env, ctx);
  if (!env.PIN_AUTH) return json({ error: 'PIN 服务尚未绑定。' }, 503);
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const [ownerName, pinName] = names(request),
    cookie = cookieValue(request, ownerName);
  const auth = env.PIN_AUTH.getByName('owner');
  const call = (data) =>
    auth.fetch(
      new Request('https://pin.internal/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...data, ip }),
      }),
    );
  const nativeSession = async () => {
    const response = await native.fetch(
      new Request(new URL('/api/auth/session', url), {
        headers: { cookie: request.headers.get('cookie') ?? '' },
      }),
      env,
      ctx,
    );
    if (!response.ok) throw new Error('native-session');
    return (await response.json()).authenticated === true;
  };
  const nativeLogin = async (key) =>
    native.fetch(
      new Request(new URL('/api/auth/login', url), {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ accessKey: key ?? '' }),
      }),
      env,
      ctx,
    );
  const issued = async (response, epoch) => {
    if (response.status !== 303) return json({ error: '原生会话未能建立，请重试。' }, 503);
    const cookies = response.headers.getSetCookie(),
      owner = cookies
        .find((item) => item.startsWith(ownerName + '='))
        ?.split(';')[0]
        .slice(ownerName.length + 1);
    if (!owner) throw new Error('native-cookie');
    const gated = await call({ action: 'issue', cookie: owner, epoch });
    if (!gated.ok) return gated;
    const { gate } = await gated.json();
    const headers = new Headers();
    for (const value of cookies) headers.append('set-cookie', value);
    headers.append('set-cookie', gateCookie(request, gate));
    return json({ authenticated: true }, 200, headers);
  };
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.get('origin'),
        site = request.headers.get('sec-fetch-site');
      if (
        (origin && origin !== url.origin && !(origin === 'null' && site === 'same-origin')) ||
        (site && !['same-origin', 'none'].includes(site))
      )
        return json({ error: '不接受跨来源请求。' }, 403);
    }
    const statusResponse = await call({ action: 'authorize', cookie, gate: cookieValue(request, pinName) });
    if (!statusResponse.ok) return statusResponse;
    const state = await statusResponse.json();
    if (path === '/api/auth/session' && request.method === 'GET')
      return json({
        authenticated: state.allowed && (await nativeSession()),
        pinConfigured: state.configured,
      });
    if (path === '/api/auth/pin' && request.method === 'GET')
      return json({
        configured: state.configured,
        authenticated: state.allowed && (await nativeSession()),
        minDigits: 4,
        maxDigits: 12,
      });
    if (path === '/api/auth/logout' && request.method === 'POST') {
      const response = await native.fetch(request, env, ctx),
        headers = new Headers(response.headers);
      headers.append('set-cookie', gateCookie(request, '', true));
      return new Response(response.body, { status: response.status, headers });
    }
    if (path === '/api/auth/recover' && request.method === 'POST') {
      const input = await body(request);
      const limited = await call({ action: 'recovery-check' });
      if (!limited.ok) return limited;
      const response = await nativeLogin(typeof input.accessKey === 'string' ? input.accessKey : '');
      if (response.status === 401) return call({ action: 'recovery-failed' });
      if (response.status !== 303) return json({ error: '原生认证服务暂不可用。' }, 503);
      let checked = await call({ action: 'recovery-ok' });
      if (input.newPin !== undefined)
        checked = await call({
          action: 'set',
          recoveryAuthorized: true,
          newPin: input.newPin,
          confirmPin: input.confirmPin,
        });
      if (!checked.ok) return checked;
      return issued(response, (await checked.json()).epoch);
    }
    if (path === '/api/auth/login' && request.method === 'POST') {
      const input = await body(request);
      // Transitional compatibility only until the owner explicitly sets a PIN.
      // Once configured, the old long key belongs exclusively to /auth/recover.
      if (!state.configured && typeof input.accessKey === 'string') return nativeLogin(input.accessKey);
      const checked = await call({ action: 'verify', pin: input.pin });
      if (!checked.ok) return checked;
      return issued(await nativeLogin(env.DSH_EDGE_ACCESS_KEY), (await checked.json()).epoch);
    }
    if (path === '/api/auth/pin' && request.method === 'POST') {
      if (!state.allowed || !(await nativeSession())) return json({ error: '请先登录。' }, 401);
      const input = await body(request);
      const changed = await call({
        action: 'set',
        currentPin: input.currentPin,
        newPin: input.newPin,
        confirmPin: input.confirmPin,
      });
      if (!changed.ok) return changed;
      return issued(await nativeLogin(env.DSH_EDGE_ACCESS_KEY), (await changed.json()).epoch);
    }
    if (path === '/login') return native.fetch(request, env, ctx); // Pages owns the PIN UI.
    if (!state.allowed) {
      if (path === '/' || !path.startsWith('/api/'))
        return new Response(null, {
          status: 302,
          headers: { location: '/login', 'cache-control': 'no-store' },
        });
      return json({ error: '请使用当前 PIN 重新登录。' }, 401);
    }
    // Preserve original native streaming/101 Response objects, not buffered copies.
    return native.fetch(request, env, ctx);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    const failure = serviceFailure(error);
    return json(failure.body, failure.status, failure.headers);
  }
}
