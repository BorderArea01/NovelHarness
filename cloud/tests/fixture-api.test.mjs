import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('scoped fixture HTTP clients preserve browser cookies and release their own request lifetime without closing the browser', async () => {
  // Load the HTTP-only Playwright API after the large pure-data cases. This
  // starts no browser/Worker and never reads deployment or personal credentials.
  const { newFixtureApi } = await import('./fixture-api.mjs');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let calls = 0,
    client;
  const browser = {
    cookies: async () => {
      calls++;
      return [
        {
          name: 'session',
          value: 'synthetic-fixture-only',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Strict',
          expires: -1,
        },
      ];
    },
  };
  try {
    client = await newFixtureApi(browser);
    const response = await client.get(origin);
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { cookie: 'session=synthetic-fixture-only' });
    assert.equal(calls, 1);
    await response.dispose();
    const closed = client;
    await client.dispose();
    client = null;
    await assert.rejects(() => closed.get(origin), /closed|disposed/i);
  } finally {
    await client?.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fixture GET can recover one real socket reset; HTTP failures and uncertain writes are never replayed', async () => {
  const { newFixtureApi } = await import('./fixture-api.mjs');
  const counts = new Map();
  const server = createServer((req, res) => {
    const key = req.method + req.url;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (req.url === '/http-failure') {
      res.writeHead(503);
      res.end('fixture failure');
    } else if (req.method !== 'GET' || req.url === '/no-retry' || counts.get(key) === 1) req.socket.destroy();
    else {
      res.writeHead(200);
      res.end('fixture recovered');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const client = await newFixtureApi({ cookies: async () => [] });
  try {
    const response = await client.get(origin + '/reset');
    assert.equal(await response.text(), 'fixture recovered');
    assert.equal(counts.get('GET/reset'), 2);
    await response.dispose();
    const failed = await client.get(origin + '/http-failure');
    assert.equal(failed.status(), 503);
    assert.equal(counts.get('GET/http-failure'), 1);
    await failed.dispose();
    await assert.rejects(
      () => client.get(origin + '/no-retry', { maxRetries: 0 }),
      /socket hang up|ECONNRESET/,
    );
    assert.equal(counts.get('GET/no-retry'), 1);
    await assert.rejects(
      () => client.put(origin + '/write', { data: 'uncertain write' }),
      /socket hang up|ECONNRESET/,
    );
    assert.equal(counts.get('PUT/write'), 1);
  } finally {
    await client.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
