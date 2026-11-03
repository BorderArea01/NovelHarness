// Public-edition acceptance: synthetic data only, no model or owner data.
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startAnonymousServer } from './server.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';

let app;
const report = { passed: false, modelRequests: 0 };
const jars = [new Map(), new Map()];
await mkdir('test-results', { recursive: true });
async function call(who, path, data, method = data ? 'POST' : 'GET') {
  const cookie = [...jars[who]].map(([k, v]) => k + '=' + v).join('; ');
  const response = await fetch(app.origin + path, {
    method,
    headers: { cookie, origin: app.origin, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(70000),
  });
  for (const value of response.headers.getSetCookie()) {
    const [k, v] = value.split(';')[0].split('=');
    jars[who].set(k, v);
  }
  const text = await response.text();
  assert.equal(response.status, 200, path + ': ' + text.slice(0, 250));
  return JSON.parse(text);
}
async function rpc(who, method, args) {
  const response = await call(who, '/api/' + method, {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload: { args },
  });
  assert.equal(response.result.ok, true, method + ': ' + JSON.stringify(response.result));
  return response.result.value;
}
try {
  app = await startAnonymousServer({ port: 0, maxVisitors: 2 });
  const hostDetails = await fetch(app.origin + '/api/deployment/details');
  assert.equal(hostDetails.status, 404);
  assert(!(await hostDetails.text()).includes('dataDirectory'));
  assert.deepEqual((await call(0, '/api/novels')).books, []);
  assert.deepEqual((await call(1, '/api/novels')).books, []);
  const bundle = await makeBookBundle(null, { title: '访客隔离测试', seed: '独立测试，不使用真实小说。' });
  const path = '/api/novels/' + bundle.manifest.id;
  await call(0, path + '/bootstrap', bundle);
  assert.equal((await call(0, '/api/novels')).books.length, 1);
  assert.equal((await call(1, '/api/novels')).books.length, 0);
  const denied = await fetch(app.origin + path + '/documents', {
    headers: { origin: app.origin, cookie: [...jars[1]].map(([k, v]) => k + '=' + v).join('; ') },
  });
  assert([404, 409].includes(denied.status), 'B can read A book: ' + denied.status);
  await denied.arrayBuffer();
  assert.equal((await call(0, '/api/auth/pin')).mode, 'anonymous');
  await rpc(0, 'credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'fixture-only-no-model-requests' });
  assert.equal(
    (await rpc(0, 'credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })).DEEPSEEK_API_KEY.configured,
    true,
  );
  assert.equal(
    (await rpc(1, 'credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })).DEEPSEEK_API_KEY.configured,
    false,
  );
  const session = await rpc(0, 'session/create', {
    request: { cwd: '/workspace/novels/' + bundle.manifest.id },
  });
  const listA = await rpc(0, 'session/list', { _request: {} });
  const listB = await rpc(1, 'session/list', { _request: {} });
  assert(listA.items.length > listB.items.length);
  const forged = await fetch(app.origin + '/api/novels', { headers: { origin: 'https://wrong.example' } });
  assert.equal(forged.status, 403);
  await forged.arrayBuffer();
  await app.close();
  app = await startAnonymousServer({ port: 0, maxVisitors: 1 });
  assert.equal((await call(0, '/api/novels')).books.length, 1);
  assert.equal((await call(1, '/api/novels')).books.length, 0);
  assert.equal(
    (await rpc(0, 'credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })).DEEPSEEK_API_KEY.configured,
    true,
  );
  assert.equal(
    (await rpc(1, 'credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })).DEEPSEEK_API_KEY.configured,
    false,
  );
  const blocked = await call(0, '/api/terminal/create', {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method: 'terminal/create',
    payload: { args: {} },
  });
  assert.equal(blocked.result.ok, false);
  const outside = await call(0, '/api/session/create', {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method: 'session/create',
    payload: { args: { request: { cwd: '/etc' } } },
  });
  assert.equal(outside.result.ok, false);
  report.idleEvictionAndHostBoundary = true;
  report.isolatedCredentialsAndSessions = true;
  report.independentBooks = true;
  report.restartPreserved = true;
  await app.close();
  app = null;
  report.passed = true;
} finally {
  if (app) await app.close();
  for (const jar of jars)
    for (const value of jar.values()) {
      const id = value.split('.')[0];
      assert(/^[a-f0-9]{64}$/.test(id));
      await rm(
        resolve(
          process.env.NOVEL_RUNTIME_DIR ?? 'data/anonymous-runtime',
          'data/official-validation/integration/visitors',
          id,
        ),
        {
          recursive: true,
          force: true,
        },
      );
    }
  await writeFile(resolve('test-results/public-isolation.json'), JSON.stringify(report));
}
console.log(JSON.stringify(report));
