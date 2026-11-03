import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitorIdentity, checkOrigin } from './identity.mjs';

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
test('cross-origin HTTP and WebSocket requests cannot select a visitor runtime', () => {
  const origin = 'https://novels.example';
  const req = (extra = {}, url = '/') => ({ url, headers: { host: 'novels.example', ...extra } });
  assert(checkOrigin(req({ origin }), origin));
  assert(!checkOrigin(req({ host: 'evil.example' }), origin));
  assert(!checkOrigin(req({ origin: 'https://evil.example' }), origin));
  assert(!checkOrigin(req({ 'sec-fetch-site': 'cross-site' }), origin));
  assert(!checkOrigin(req({}, '//evil.example'), origin));
});
