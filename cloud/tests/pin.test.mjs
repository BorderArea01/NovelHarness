import test from 'node:test';
import assert from 'node:assert/strict';
import { PinAuth } from '../worker/pin-store.mjs';
import { handlePinRequest } from '../worker/pin-gateway.mjs';
const secret = 'public-fixture-recovery-key-not-a-user-secret-0123456789abcdef';
const origin = 'https://novel.example';
function fixture(existing) {
  const storage = {
    value: existing,
    fail: false,
    async get() {
      return structuredClone(this.value);
    },
    async put(_key, value) {
      if (this.fail) throw new Error('storage unavailable');
      this.value = structuredClone(value);
    },
  };
  const make = () =>
    new PinAuth({ storage, blockConcurrencyWhile: (fn) => fn() }, { DSH_EDGE_ACCESS_KEY: secret });
  const store = make();
  const call = (data) =>
    store.fetch(
      new Request('https://pin.internal/', {
        method: 'POST',
        body: JSON.stringify({ ip: '203.0.113.1', ...data }),
      }),
    );
  return { storage, store, call, make };
}
const setup = (f, pin = '561904') => f.call({ action: 'set', newPin: pin, confirmPin: pin });

test('PIN persists salted peppered hash, survives a new DO instance and never stores plaintext', async () => {
  const f = fixture();
  assert.equal((await setup(f)).status, 200);
  const record = f.storage.value;
  assert.equal(record.pin.iterations, 100000);
  assert.equal(record.pin.hash.length, 64);
  assert.ok(!Object.values(record.pin).includes('561904'));
  assert.ok(!JSON.stringify(record).includes(secret));
  const next = f.make();
  const response = await next.fetch(
    new Request('https://pin.internal/', {
      method: 'POST',
      body: JSON.stringify({ action: 'verify', pin: '561904' }),
    }),
  );
  assert.equal(response.status, 200);
});

test('PIN setup validates confirmation and races serialize; change requires current PIN', async () => {
  const f = fixture();
  assert.equal((await f.call({ action: 'set', newPin: '123', confirmPin: '123' })).status, 400);
  assert.equal((await f.call({ action: 'set', newPin: '1234', confirmPin: '4321' })).status, 400);
  const results = await Promise.all([setup(f, '561904'), setup(f, '815703')]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 401],
  );
  assert.equal(
    (await f.call({ action: 'set', currentPin: 'wrong', newPin: '815703', confirmPin: '815703' })).status,
    401,
  );
  assert.equal((await f.call({ action: 'verify', pin: '561904' })).status, 200);
  assert.equal(
    (await f.call({ action: 'set', currentPin: '561904', newPin: '815703', confirmPin: '815703' })).status,
    200,
  );
  assert.equal((await f.call({ action: 'verify', pin: '561904' })).status, 401);
  assert.equal((await f.call({ action: 'verify', pin: '815703' })).status, 200);
});

test('five failures lock an IP; global bound limits distributed guesses', async () => {
  const f = fixture();
  await setup(f);
  for (let i = 0; i < 5; i++) assert.equal((await f.call({ action: 'verify', pin: '000000' })).status, 401);
  const locked = await f.call({ action: 'verify', pin: '561904' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  for (let n = 2; n <= 4; n++)
    for (let i = 0; i < 5; i++) await f.call({ action: 'verify', pin: '000000', ip: `203.0.113.${n}` });
  assert.equal((await f.call({ action: 'verify', pin: '561904', ip: '203.0.113.99' })).status, 429);
  // Recovery remains a separate strong-secret path, not blocked by global PIN guesses.
  assert.equal((await f.call({ action: 'recovery-check', ip: '203.0.113.99' })).status, 200);
});

test('cookie gate binds native cookie and PIN epoch; old devices and stale verification cannot reconnect after change', async () => {
  const f = fixture(),
    initial = await (await setup(f)).json();
  const { gate } = await (
    await f.call({ action: 'issue', cookie: 'native-signed-session', epoch: initial.epoch })
  ).json();
  assert.equal(
    (await (await f.call({ action: 'authorize', cookie: 'native-signed-session', gate })).json()).allowed,
    true,
  );
  assert.equal(
    (await (await f.call({ action: 'authorize', cookie: 'forged-cookie', gate })).json()).allowed,
    false,
  );
  await f.call({ action: 'set', currentPin: '561904', newPin: '815703', confirmPin: '815703' });
  assert.equal(
    (await (await f.call({ action: 'authorize', cookie: 'native-signed-session', gate })).json()).allowed,
    false,
  );
  assert.equal(
    (await f.call({ action: 'issue', cookie: 'native-signed-session', epoch: initial.epoch })).status,
    409,
  );
});

test('storage failure does not replace the old PIN', async () => {
  const f = fixture();
  await setup(f);
  const previous = structuredClone(f.storage.value);
  f.storage.fail = true;
  assert.equal(
    (await f.call({ action: 'set', currentPin: '561904', newPin: '815703', confirmPin: '815703' })).status,
    503,
  );
  assert.deepEqual(f.storage.value, previous);
  f.storage.fail = false;
  assert.equal((await f.call({ action: 'verify', pin: '561904' })).status, 200);
});

test('unknown persisted schema fails closed without replacing it', async () => {
  const saved = { version: 90, epoch: 'future', privateField: 'preserve' };
  const f = fixture(saved);
  assert.equal((await f.call({ action: 'authorize' })).status, 503);
  assert.deepEqual(f.storage.value, saved);
});

test('expired lock permits a correct PIN after a new durable instance', async () => {
  const f = fixture();
  await setup(f);
  for (let i = 0; i < 5; i++) await f.call({ action: 'verify', pin: '000000' });
  for (const row of Object.values(f.storage.value.attempts)) row.until = Date.now() - 1;
  const restarted = fixture(f.storage.value);
  assert.equal((await restarted.call({ action: 'verify', pin: '561904' })).status, 200);
});

test('bounded recovery overflow bucket is enforced for new identities', async () => {
  const f = fixture();
  await f.call({ action: 'authorize' });
  for (let i = 0; i < 128; i++)
    f.storage.value.attempts['recovery:fixture-' + i] = { count: 1, until: Date.now() + 60000 };
  const restarted = fixture(f.storage.value);
  for (let i = 0; i < 5; i++) await restarted.call({ action: 'recovery-failed', ip: '203.0.113.' + i });
  assert.equal((await restarted.call({ action: 'recovery-check', ip: '203.0.113.200' })).status, 429);
  assert.ok(Object.keys(restarted.storage.value.attempts).length <= 129);
});

function gatewayFixture() {
  const f = fixture(),
    calls = [];
  const native = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === '/api/auth/session')
        return Response.json({
          authenticated:
            request.headers.get('cookie')?.includes('__Host-dsh_edge_owner=native-signed') ?? false,
        });
      if (path === '/api/auth/login') {
        const value = new URLSearchParams(await request.text()).get('accessKey');
        return value === secret
          ? new Response(null, {
              status: 303,
              headers: {
                location: '/',
                'set-cookie':
                  '__Host-dsh_edge_owner=native-signed; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000',
              },
            })
          : new Response('invalid', { status: 401 });
      }
      if (path === '/api/socket') return native.socket;
      return new Response('native-data');
    },
  };
  const env = { DSH_EDGE_ACCESS_KEY: secret, PIN_AUTH: { getByName: () => f.store } };
  const request = (path, data, cookie = '', extra = {}) =>
    new Request(origin + path, {
      method: data ? 'POST' : 'GET',
      headers: { ...(data ? { 'content-type': 'application/json', origin } : {}), cookie, ...extra },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const run = (req) => handlePinRequest(req, env, {}, native);
  return { ...f, native, calls, request, run };
}
const cookieHeader = (response) =>
  response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');

test('native owner bootstrap sets PIN without altering runtime; subsequent login issues two secure cookies', async () => {
  const f = gatewayFixture();
  const recovered = await f.run(f.request('/api/auth/recover', { accessKey: secret }));
  assert.equal(recovered.status, 200);
  const prior = cookieHeader(recovered);
  const setup = await f.run(f.request('/api/auth/pin', { newPin: '561904', confirmPin: '561904' }, prior));
  assert.equal(setup.status, 200);
  assert.equal((await f.run(f.request('/api/auth/session', null, prior))).status, 200);
  assert.equal(
    (await (await f.run(f.request('/api/auth/session', null, prior))).json()).authenticated,
    false,
  );
  const login = await f.run(f.request('/api/auth/login', { pin: '561904' }));
  assert.equal(login.status, 200);
  assert.equal(login.headers.getSetCookie().length, 2);
  for (const cookie of login.headers.getSetCookie())
    assert.match(cookie, /HttpOnly.*SameSite=Strict|HttpOnly.*Secure.*SameSite=Strict/);
  assert.match(
    login.headers.getSetCookie().find((s) => s.startsWith('__Host-novel_pin=')),
    /Secure/,
  );
  assert.equal((await f.run(f.request('/api/workspace/file', null, cookieHeader(login)))).status, 200);
});

test('configured PIN cannot be bypassed by native cookie alone, fake JSON flags, legacy key login or cross-origin writes', async () => {
  const f = gatewayFixture();
  await setup(f);
  const raw = '__Host-dsh_edge_owner=native-signed';
  assert.equal((await f.run(f.request('/api/workspace/file', null, raw))).status, 401);
  assert.equal(
    (
      await f.run(
        f.request('/api/auth/pin', { newPin: '815703', confirmPin: '815703', recoveryAuthorized: true }, raw),
      )
    ).status,
    401,
  );
  assert.equal((await f.run(f.request('/api/auth/login', { accessKey: secret }))).status, 401);
  assert.equal(
    (
      await f.run(
        f.request('/api/auth/recover', { accessKey: secret }, '', { origin: 'https://evil.example' }),
      )
    ).status,
    403,
  );
  assert.equal((await f.run(f.request('/api/auth/recover', { accessKey: 'wrong' }))).status, 401);
});
test('stale first-setup browser cannot overwrite PIN configured by another device between verification and save', async () => {
  const f = gatewayFixture();
  const first = await f.run(f.request('/api/auth/recover', { accessKey: secret }));
  const other = await f.run(f.request('/api/auth/recover', { accessKey: secret }));
  assert.equal(
    (await f.run(f.request('/api/auth/pin', { newPin: '561904', confirmPin: '561904' }, cookieHeader(other))))
      .status,
    200,
  );
  const stale = await f.run(
    f.request('/api/auth/pin', { newPin: '815703', confirmPin: '815703' }, cookieHeader(first)),
  );
  assert.equal(stale.status, 401);
  assert.equal((await f.call({ action: 'verify', pin: '561904' })).status, 200);
  assert.equal((await f.call({ action: 'verify', pin: '815703' })).status, 401);
});

test('strong recovery login does not reset PIN; explicit recovery reset revokes old gates', async () => {
  const f = gatewayFixture();
  await setup(f);
  const old = await f.run(f.request('/api/auth/login', { pin: '561904' }));
  assert.equal((await f.run(f.request('/api/auth/recover', { accessKey: secret }))).status, 200);
  assert.equal((await f.call({ action: 'verify', pin: '561904' })).status, 200);
  const reset = await f.run(
    f.request('/api/auth/recover', { accessKey: secret, newPin: '815703', confirmPin: '815703' }),
  );
  assert.equal(reset.status, 200);
  assert.equal((await f.run(f.request('/api/workspace/file', null, cookieHeader(old)))).status, 401);
  assert.equal((await f.run(f.request('/api/auth/login', { pin: '815703' }))).status, 200);
});

test('authorized WebSocket Response is preserved, never reconstructed or buffered', async () => {
  const f = gatewayFixture();
  await setup(f);
  const login = await f.run(f.request('/api/auth/login', { pin: '561904' }));
  f.native.socket = { status: 101, webSocket: { ownedNativeHandle: true } };
  assert.equal(await f.run(f.request('/api/socket', null, cookieHeader(login))), f.native.socket);
});

test('malformed and oversized credential bodies are rejected without returning secrets', async () => {
  const f = gatewayFixture();
  for (const [body, status] of [
    ['{', 400],
    ['[]', 400],
    ['x'.repeat(4097), 413],
  ]) {
    const response = await f.run(
      new Request(origin + '/api/auth/recover', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body,
      }),
    );
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes(secret));
  }
});
