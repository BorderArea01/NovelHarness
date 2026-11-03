import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeHostStore, FREEZE_KEY, hostLeaseFetch } from '../worker/host-cutover.mjs';
import { prepareHostRequest } from '../host/host-wire.mjs';
import relay from '../host/relay-worker.mjs';
const key = 'fixture-only-owner-key-0123456789abcdef';
const origin = 'https://novel.example';
const id = '12345678-abcd-abcd-abcd-123456789abc';
function fixture() {
  const map = new Map(); let alarm = 12345;
  const instance = { env: { DSH_EDGE_ACCESS_KEY: key }, hostRequestLeases: new Set(),
    ctx: { storage: { kv: { get: (k) => map.get(k), put: (k, v) => map.set(k, v), delete: (k) => map.delete(k) },
      getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; }, sync: async () => {} },
    blockConcurrencyWhile: async (fn) => fn() } };
  return { instance, map, alarm: () => alarm };
}
const freezeRequest = () => new Request('https://host.internal/__host_freeze', { method: 'POST',
  headers: { authorization: 'Bearer ' + key, 'x-novel-host-control': 'cutover-v1' }, body: JSON.stringify({ targetId: id }) });
test('freeze refuses running work without clearing alarms, changing state or closing a socket', async () => {
  const { instance, map, alarm } = fixture(); let closed = false;
  const response = await freezeHostStore(instance, freezeRequest(), { kind: 'main',
    ensureIdle() { throw new Error('running'); }, closeChannels() { closed = true; } });
  assert.equal(response.status, 409); assert.equal(map.size, 0); assert.equal(alarm(), 12345); assert.equal(closed, false);
});
test('cutover drains admitted requests, rejects new leases, persists a frozen marker and pauses alarm without changing native PIN/data', async () => {
  const { instance, map, alarm } = fixture(); map.set('pin-state', { pin: 'fixture-hash', epoch: 'same' });
  let closed = false; instance.hostRequestLeases.add('existing');
  const freezing = freezeHostStore(instance, freezeRequest(), { kind: 'main', closeChannels() { closed = true; } });
  await new Promise((done) => setTimeout(done, 5));
  const request = new Request('https://host.internal/__host_lease/enter', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'x-novel-host-control': 'lease-v1' } });
  assert.equal((await hostLeaseFetch(instance, request)).status, 503);
  assert.equal(closed, false); instance.hostRequestLeases.delete('existing');
  assert.equal((await freezing).status, 200);
  assert.equal(map.get(FREEZE_KEY).phase, 'frozen'); assert.equal(map.get(FREEZE_KEY).targetId, id);
  assert.equal(alarm(), null); assert.equal(closed, true);
  assert.deepEqual(map.get('pin-state'), { pin: 'fixture-hash', epoch: 'same' });
  assert.equal((await freezeHostStore(instance, freezeRequest(), { kind: 'main' })).status, 200);
});
test('host accepts only a secret-bound fixed cloud origin or exact local NIC addresses; original LAN CSRF validation precedes normalization', async () => {
  const env = { DSH_EDGE_ACCESS_KEY: key, NOVEL_PUBLIC_ORIGIN: origin, NOVEL_LAN_HOSTS: '192.168.1.20' };
  const forwarded = prepareHostRequest(new Request('http://localhost/api/auth/session', { headers: {
    'x-novel-host-auth': key, 'x-novel-forwarded-origin': origin, 'x-novel-forward-as': 'harness', cookie: '__Host-novel_pin=fixture',
  } }), env);
  assert.equal(forwarded.mode, 'harness'); assert.equal(forwarded.request.url, origin + '/api/auth/session');
  assert.equal(forwarded.request.headers.get('x-novel-host-auth'), null);
  assert.equal(forwarded.request.headers.get('cookie'), '__Host-novel_pin=fixture');
  const lan = prepareHostRequest(new Request('http://192.168.1.20:3211/api/auth/login', { method: 'POST', headers: { origin: 'http://192.168.1.20:3211' }, body: 'fixture' }), env);
  assert.equal(lan.request.url, 'http://localhost:3211/api/auth/login');
  assert.equal(lan.request.headers.get('origin'), 'http://localhost:3211'); assert.equal(await lan.request.text(), 'fixture');
  assert.equal(prepareHostRequest(new Request('http://192.168.1.20:3211/', { headers: { origin: 'https://evil.example' } }), env).failure.status, 403);
  assert.equal(prepareHostRequest(new Request('http://evil.example/'), env).failure.status, 403);
  assert.equal(prepareHostRequest(new Request('http://localhost/', { headers: { 'x-novel-forwarded-origin': origin } }), env).failure.status, 403);
});
test('cloud relay preserves streaming/socket response identity, overwrites spoofed forwarding headers and never falls back to cloud storage', async () => {
  const response = { originalNativeSocketResponse: true }; let seen;
  const env = { NOVEL_PUBLIC_ORIGIN: origin, DSH_EDGE_ACCESS_KEY: key, LOCAL_SERVICE: { fetch(request) { seen = request; return response; } } };
  assert.equal(await relay.fetch(new Request(origin + '/api/connect', { headers: { 'x-novel-host-auth': 'spoofed' } }), env), response);
  assert.equal(seen.url, 'http://localhost/api/connect'); assert.equal(seen.headers.get('x-novel-host-auth'), key);
  env.LOCAL_SERVICE.fetch = () => { throw new Error('offline'); };
  const offline = await relay.fetch(new Request(origin + '/api/sessions'), env);
  assert.equal(offline.status, 503); assert.match((await offline.json()).error, /未切换到旧云端/);
});
