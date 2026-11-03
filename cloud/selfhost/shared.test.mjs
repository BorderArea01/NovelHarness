// Two independent browser cookie jars, one explicitly shared synthetic store.
// Never opens the owner's production data or calls a model.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSelfHostedServer } from './server.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
const root = await mkdtemp(join(tmpdir(), 'novel-shared-'));
const jars = [new Map(), new Map()];
let app;
const report = { passed: false, modelRequests: 0 };
async function response(who, path, data, method = data ? 'POST' : 'GET') {
  const r = await fetch(app.origin + path, {
    method,
    headers: {
      origin: app.origin,
      cookie: [...jars[who]].map(([k, v]) => k + '=' + v).join('; '),
      ...(data ? { 'content-type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(70000),
    redirect: 'manual',
  });
  for (const value of r.headers.getSetCookie()) {
    const pair = value.split(';')[0],
      at = pair.indexOf('=');
    jars[who].set(pair.slice(0, at), pair.slice(at + 1));
  }
  return r;
}
async function call(who, path, data, method) {
  const r = await response(who, path, data, method);
  const value = await r.json();
  assert.equal(r.status, 200, path + ': ' + JSON.stringify(value));
  return value;
}
async function rpc(who, method, args) {
  const r = await call(who, '/api/' + method, {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload: { args },
  });
  assert.equal(r.result.ok, true);
  return r.result.value;
}
try {
  await assert.rejects(
    startSelfHostedServer({ mode: 'shared', port: 0, dataDirectory: root }),
    /NOVEL_INITIAL_PIN/,
  );
  app = await startSelfHostedServer({ mode: 'shared', port: 0, dataDirectory: root, initialPin: '753951' });
  const unauthorized = await response(0, '/api/novels');
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const hiddenDeployment = await response(0, '/api/deployment/details');
  assert.equal(hiddenDeployment.status, 401);
  assert(!(await hiddenDeployment.text()).includes(root));
  assert.equal((await call(0, '/api/deployment')).mode, 'shared');
  for (const who of [0, 1])
    assert.equal((await call(who, '/api/auth/login', { pin: '753951' })).authenticated, true);
  const deployment = await call(0, '/api/deployment/details');
  assert.equal(deployment.storage.directory, root);
  assert.equal(deployment.storage.database, join(root, 'main.sqlite'));
  assert.equal(deployment.access.ingress, 'lan');
  assert.equal(deployment.access.connectionVerified, false);
  const readOnlyConfig = await response(0, '/api/deployment/details', { dataDirectory: 'some-other-store' });
  assert.equal(readOnlyConfig.status, 405);
  await readOnlyConfig.arrayBuffer();
  const bundle = await makeBookBundle(null, { title: '共享空间验收', seed: '合成测试，不调用模型。' });
  const api = '/api/novels/' + bundle.manifest.id;
  await call(0, api + '/bootstrap', bundle);
  assert.deepEqual((await call(0, '/api/novels')).books, (await call(1, '/api/novels')).books);
  const prose = '# 第一章\n\n从另一台设备继续创作。\n';
  await call(0, api + '/document', { path: 'chapters/1.md', text: prose, expectedHash: null }, 'PUT');
  const chapter = await call(1, api + '/document?path=chapters%2F1.md');
  assert.equal(chapter.text, prose);
  const conflict = await response(
    1,
    api + '/document',
    { path: 'chapters/1.md', text: '不能覆盖', expectedHash: null },
    'PUT',
  );
  assert.equal(conflict.status, 409);
  await conflict.arrayBuffer();
  assert.equal((await call(0, api + '/document?path=chapters%2F1.md')).text, prose);
  await rpc(0, 'credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'fixture-only-no-model-requests' });
  assert.equal(
    (await rpc(1, 'credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })).DEEPSEEK_API_KEY.configured,
    true,
  );
  const session = await rpc(0, 'session/create', { request: { cwd: bundle.manifest.root } });
  const before = await rpc(1, 'session/list', { _request: {} });
  assert(before.items.length > 0);
  const pluginEvents = await response(0, '/plugins/events');
  assert.equal(pluginEvents.status, 200);
  assert.match(pluginEvents.headers.get('content-type'), /^text\/event-stream/);
  // Keep the real native subscription open while stopping an idle service.
  // The subscription is not AI or a save operation and must not block forever.
  await app.close();
  app = null;
  await pluginEvents.body?.cancel().catch(() => {});
  report.passiveSubscriptionDoesNotBlockIdleShutdown = true;
  // Existing cookies and PIN survive restart, even with a different ephemeral
  // listener port. A bootstrap PIN is never used to reset an existing PIN.
  app = await startSelfHostedServer({ mode: 'shared', port: 0, dataDirectory: root, initialPin: '000000' });
  assert.equal((await call(1, api + '/document?path=chapters%2F1.md')).text, prose);
  assert.deepEqual(
    (await rpc(0, 'session/list', { _request: {} })).items.map((s) => s.id),
    before.items.map((s) => s.id),
  );
  const wrong = await response(0, '/api/auth/login', { pin: '000000' });
  assert.equal(wrong.status, 401);
  await wrong.arrayBuffer();
  await call(1, '/api/auth/pin', { currentPin: '753951', newPin: '975319', confirmPin: '975319' });
  const expired = await response(0, '/api/novels');
  assert.equal(expired.status, 401);
  await expired.arrayBuffer();
  const expiredDeployment = await response(0, '/api/deployment/details');
  assert.equal(expiredDeployment.status, 401);
  await expiredDeployment.arrayBuffer();
  await call(0, '/api/auth/login', { pin: '975319' });
  const cross = await fetch(app.origin + '/api/novels', { headers: { origin: 'https://wrong.example' } });
  assert.equal(cross.status, 403);
  await cross.arrayBuffer();
  const logout = await response(0, '/api/auth/logout', {});
  assert.equal(logout.status, 303);
  await logout.arrayBuffer(); // This device only.
  const loggedOut = await response(0, '/api/novels');
  assert.equal(loggedOut.status, 401);
  await loggedOut.arrayBuffer();
  assert.equal((await call(1, '/api/novels')).books.length, 1);
  await app.close();
  app = null;
  const publicOrigin = 'https://novels.example.test';
  app = await startSelfHostedServer({ mode: 'shared', port: 0, dataDirectory: root, publicOrigin });
  const owner = (await readFile(join(root, 'owner-key.txt'), 'utf8')).trim();
  const relay = {
    'x-novel-host-auth': owner,
    'x-novel-forwarded-origin': publicOrigin,
    'x-novel-forward-as': 'harness',
    origin: publicOrigin,
  };
  const login = await fetch(app.localOrigin + '/api/auth/login', {
    method: 'POST',
    headers: { ...relay, 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '975319' }),
  });
  assert.equal(login.status, 200);
  await login.arrayBuffer();
  const cookies = login.headers.getSetCookie();
  assert(cookies.length >= 2 && cookies.every((v) => v.startsWith('__Host-') && v.includes('Secure')));
  const cookie = cookies.map((v) => v.split(';')[0]).join('; ');
  const remote = await fetch(app.localOrigin + '/api/novels', { headers: { ...relay, cookie } });
  assert.equal(remote.status, 200);
  assert.equal((await remote.json()).books.length, 1);
  const spoof = await fetch(app.localOrigin + '/api/novels', {
    headers: { ...relay, 'x-novel-host-auth': 'incorrect', cookie },
  });
  assert.equal(spoof.status, 403);
  await spoof.arrayBuffer();
  report.existingAuthenticatedRelaySupported = true;
  report.sharedBooksChatAndCredentials = true;
  report.restartAndPinChange = true;
  report.optimisticConflict = true;
  report.authenticatedDeploymentDetails = true;
  report.passed = true;
} finally {
  await app?.close();
  assert(root.startsWith(join(tmpdir(), 'novel-shared-')));
  await rm(root, { recursive: true, force: true });
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/shared-integration.json', JSON.stringify(report));
}
console.log(JSON.stringify(report));
