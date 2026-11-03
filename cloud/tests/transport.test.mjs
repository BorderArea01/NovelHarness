import test from 'node:test';
import assert from 'node:assert/strict';
import { httpsProxyAddress, existingProxyEnvironment } from '../scripts/verification-transport.mjs';
test('deployment CLI can reuse the existing Windows HTTPS proxy without logging or overriding explicit settings', async () => {
  assert.deepEqual(
    await existingProxyEnvironment({
      env: {},
      platform: 'win32',
      readProxy: async () => 'http://127.0.0.1:8888/',
    }),
    { HTTPS_PROXY: 'http://127.0.0.1:8888/', HTTP_PROXY: 'http://127.0.0.1:8888/' },
  );
  assert.deepEqual(
    await existingProxyEnvironment({
      env: { HTTPS_PROXY: 'http://fixture-proxy/' },
      platform: 'win32',
      readProxy: () => {
        throw new Error('must not read registry');
      },
    }),
    {},
  );
});

test('verification honors an explicitly configured HTTPS system proxy without changing its target', () => {
  assert.equal(httpsProxyAddress('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(httpsProxyAddress('http=127.0.0.1:7890;https=127.0.0.1:7891'), 'http://127.0.0.1:7891/');
  assert.equal(httpsProxyAddress('https://proxy.example:8443'), 'https://proxy.example:8443/');
  assert.equal(httpsProxyAddress(''), null);
  assert.throws(() => httpsProxyAddress('socks=127.0.0.1:7890'));
});
