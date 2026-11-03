import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitorIdentity, checkOrigin, sharedCookies } from './identity.mjs';

test('unguessable signed visitor identity is scoped to one deployment', () => {
  const a = visitorIdentity('test-a', 'first'),
    b = visitorIdentity('test-b', 'second');
  const value = a.issue(),
    cookie = a.cookie(value, true);
  assert.equal(a.read(cookie), value.split('.')[0]);
  assert.equal(b.read(cookie), null);
  assert.equal(visitorIdentity('other-secret', 'first').read(cookie), null);
  assert.equal(a.read(cookie.replace(value[0], value[0] === 'a' ? 'b' : 'a')), null);
  assert.equal(a.read(cookie + '; ' + a.name + '=' + value), null);
  assert.equal(a.read(a.name + '=../../other'), null);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /; Secure$/);
  assert.notEqual(a.issue(), value);
});

test('private deployments on the same host have distinct cookies; legacy migration is explicit and logout clears it', () => {
  const a = sharedCookies('owner-a', ['novel_stage_owner', 'novel_stage_pin'], 'store-a');
  const b = sharedCookies('owner-b', undefined, 'store-b');
  const issued = a.write('dsh_edge_owner=one; Path=/; HttpOnly', true);
  assert.match(issued[0], /^__Host-novelharness_owner_/);
  assert.match(issued[0], /; Secure$/);
  assert.equal(b.read(issued[0], true), 'dsh_edge_owner=; novel_pin=');
  assert.equal(
    sharedCookies('owner-a', undefined, 'cloned-store').read(issued[0], true),
    'dsh_edge_owner=; novel_pin=',
  );
  assert.equal(
    a.read('__Host-novel_stage_owner=old; __Host-novel_stage_pin=gate', true),
    'dsh_edge_owner=old; novel_pin=gate',
  );
  assert.match(issued[1], /__Host-novel_stage_owner=;.*Max-Age=0/);
  assert.equal(b.read('__Host-novel_stage_owner=old', true), 'dsh_edge_owner=; novel_pin=');
});
test('cross-origin HTTP and WebSocket requests cannot select a visitor runtime', () => {
  const origin = 'https://novels.example';
  const req = (extra = {}, url = '/') => ({ url, headers: { host: 'novels.example', ...extra } });
  assert(checkOrigin(req({ origin }), origin));
  assert(!checkOrigin(req({ host: 'evil.example' }), origin));
  assert(!checkOrigin(req({ origin: 'https://evil.example' }), origin));
  assert(!checkOrigin(req({ 'sec-fetch-site': 'cross-site' }), origin));
  assert(!checkOrigin(req({}, '//evil.example'), origin));
});
