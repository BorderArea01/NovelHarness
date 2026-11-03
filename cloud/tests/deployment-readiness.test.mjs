import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDeploymentRevision } from '../scripts/deployment-readiness.mjs';
import { requireIdleRuntime } from '../scripts/runtime-activity.mjs';
import { runtimeConfig } from '../scripts/runtime-config.mjs';

test('PIN runtime adds a separate migration while retaining the native data class and private routing', () => {
  const config = runtimeConfig({
    name: 'test-worker',
    accountId: 'fixture',
    entry: 'D:\\fixture\\entry.mjs',
    assets: 'D:\\fixture\\dist',
  });
  assert.match(config, /workers_dev = false/);
  assert.match(config, /new_sqlite_classes = \["DshEdgeInstance"\]/);
  assert.match(config, /tag = "pin-v1"\s+new_sqlite_classes = \["PinAuth"\]/);
  assert.match(config, /find_additional_modules = true/);
  assert.ok(!config.includes('deleted_classes') && !config.includes('renamed_classes'));
});

test('deployment checks idle metadata only and refuses active, invalid or incomplete session lists', async () => {
  for (const listing of [
    { sessions: [{ status: 'running' }], hasMore: false },
    { sessions: [{ status: 'unknown' }], hasMore: false },
    { sessions: [], hasMore: true },
  ]) {
    const calls = [];
    await assert.rejects(
      requireIdleRuntime('https://novel.example', 'fixture-secret', async (url) => {
        calls.push(url);
        return calls.length === 1
          ? new Response(null, { status: 303, headers: { 'set-cookie': 'owner=fixture; HttpOnly' } })
          : Response.json(listing);
      }),
      /no Worker upload started|not started/,
    );
    assert.equal(calls.length, 2);
  }
});

test('PIN-aware deployment recovery authenticates without changing PIN and follows bounded idle pagination', async () => {
  const calls = [];
  const result = await requireIdleRuntime(
    'https://novel.example',
    'fixture-secret',
    async (url, options) => {
      calls.push(url);
      if (calls.length === 1) {
        assert.equal(new URL(url).pathname, '/api/auth/recover');
        assert.deepEqual(JSON.parse(options.body), { accessKey: 'fixture-secret' });
        return new Response('{}', { status: 200, headers: { 'set-cookie': 'owner=fixture; HttpOnly' } });
      }
      assert.equal(options.headers.cookie, 'owner=fixture');
      assert.equal(options.method, undefined);
      if (calls.length === 2)
        return Response.json({ sessions: [{ status: 'idle' }], hasMore: true, nextAfter: 'cursor' });
      assert.equal(new URL(url).searchParams.get('after'), 'cursor');
      return Response.json({ sessions: [{ status: 'idle' }], hasMore: false });
    },
    { pinWrapper: true },
  );
  assert.deepEqual(result, { idle: true, sessionsChecked: 2 });
});

test('source propagation wait only reads the fixed version endpoint, then returns the expected revision', async () => {
  let calls = 0,
    time = 0;
  const result = await waitForDeploymentRevision(
    'https://novel.example',
    'new',
    async (url, options) => {
      assert.equal(url, 'https://novel.example/api/platform/version');
      assert.equal(options.method, undefined);
      return Response.json({ revision: ++calls < 3 ? 'old' : 'new' });
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      intervalMs: 2,
      timeoutMs: 10,
    },
  );
  assert.equal(result.revision, 'new');
  assert.equal(calls, 3);
});

test('propagation timeout stops without re-upload or unbounded retry', async () => {
  let calls = 0,
    time = 0;
  await assert.rejects(
    waitForDeploymentRevision(
      'https://novel.example',
      'new',
      async () => {
        calls++;
        return Response.json({ revision: 'old' });
      },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        intervalMs: 2,
        timeoutMs: 4,
      },
    ),
    /expected source revision/,
  );
  assert.equal(calls, 3);
});

test('an invalid response or failed revision check does not advance to login or other writes', async () => {
  for (const response of [new Response('bad', { status: 503 }), Response.json({ unexpected: true })]) {
    let calls = 0;
    await assert.rejects(
      waitForDeploymentRevision('https://novel.example', 'new', async () => {
        calls++;
        return response;
      }),
    );
    assert.equal(calls, 1);
  }
});
