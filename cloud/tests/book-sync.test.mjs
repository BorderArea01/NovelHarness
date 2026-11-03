import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookSync } from '../pages/public/novel-assets/book-sync.mjs';
import { createReadSnapshots, readWorkspaceRevision } from '../worker/read-snapshot.mjs';
import { serviceFailure } from '../worker/service-failure.mjs';
import { makeDocumentClient } from '../pages/public/novel-assets/manuscript-core.mjs';
import { handlePinRequest } from '../worker/pin-gateway.mjs';

function fixture() {
  let time = 0,
    revision = 'a',
    failure = null,
    reads = 0,
    serial = 0;
  const jobs = new Map(),
    events = new EventTarget(),
    visibility = new EventTarget();
  visibility.visibilityState = 'visible';
  const sync = createBookSync(
    async (route) => {
      assert.equal(route, 'changes');
      reads++;
      if (failure) throw failure;
      return { revision: typeof revision === 'function' ? revision() : revision };
    },
    {
      clock: () => time,
      schedule: (fn, delay) => {
        jobs.set(++serial, { fn, delay });
        return serial;
      },
      cancel: (id) => jobs.delete(id),
      events,
      visibility,
    },
  );
  return {
    sync,
    events,
    visibility,
    get reads() {
      return reads;
    },
    get nextDelay() {
      return [...jobs.values()][0]?.delay;
    },
    revision: (v) => {
      revision = v;
    },
    fail: (e) => {
      failure = e;
    },
    async next() {
      assert.equal(jobs.size, 1);
      const [id, job] = jobs.entries().next().value;
      jobs.delete(id);
      time += job.delay;
      await job.fn();
    },
  };
}
test('24 hours of unchanged visible book only checks revisions; manuscript/run refresh once', async () => {
  const f = fixture();
  let manuscript = 0,
    run = 0;
  f.sync.subscribe({
    refresh: async () => {
      manuscript++;
    },
  });
  f.sync.subscribe({
    refresh: async () => {
      run++;
    },
  });
  await f.next();
  for (let i = 0; i < 8640; i++) await f.next();
  assert.equal(manuscript, 1);
  assert.equal(run, 1);
  assert.equal(f.reads, 8641);
  assert.equal(f.nextDelay, 10000);
  f.revision('b');
  await f.next();
  assert.equal(manuscript, 2);
  assert.equal(run, 2);
  let newView = 0;
  f.sync.subscribe({
    refresh: async () => {
      newView++;
    },
  });
  await f.next();
  assert.equal(manuscript, 2);
  assert.equal(newView, 1);
  f.sync.dispose();
  assert.equal(f.nextDelay, undefined);
});
test('hidden/busy views do not read, active writing uses bounded checks, failed navigation is not acknowledged', async () => {
  const f = fixture();
  let refreshes = 0,
    ready = false,
    accept = false;
  f.sync.subscribe({
    ready: () => ready,
    active: () => true,
    refresh: async () => {
      refreshes++;
      return accept;
    },
  });
  await f.next();
  assert.equal(f.reads, 0);
  ready = true;
  f.visibility.visibilityState = 'hidden';
  await f.next();
  assert.equal(f.reads, 0);
  f.visibility.visibilityState = 'visible';
  f.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.nextDelay, 0);
  await f.next();
  await f.next();
  assert.equal(refreshes, 2);
  assert.equal(f.nextDelay, 4000);
  accept = true;
  await f.next();
  await f.next();
  assert.equal(refreshes, 3);
  f.sync.dispose();
});

test('repeated Durable Object cold starts do not look like edits or trigger repeated full reads', async () => {
  const f = fixture();
  f.revision(() => createReadSnapshots().token('42'));
  let fullReads = 0;
  f.sync.subscribe({
    refresh: async () => {
      fullReads++;
    },
  });
  for (let i = 0; i < 100; i++) await f.next();
  assert.equal(f.reads, 100);
  assert.equal(fullReads, 1);
  f.sync.dispose();
});
test('quota stops automatic retries until reset, focus/online cannot cause a retry storm; transient errors back off', async () => {
  const f = fixture();
  let errors = 0,
    refreshes = 0;
  f.sync.subscribe({
    refresh: async () => {
      refreshes++;
    },
    error: () => {
      errors++;
    },
  });
  f.fail(
    Object.assign(new Error('quota'), {
      code: 'STORAGE_DAILY_LIMIT',
      retryAt: new Date(3600000).toISOString(),
    }),
  );
  await f.next();
  assert.equal(f.nextDelay, 3600000);
  for (let i = 0; i < 100; i++) {
    f.events.dispatchEvent(new Event('focus'));
    f.events.dispatchEvent(new Event('online'));
  }
  assert.equal(f.reads, 1);
  assert.equal(f.nextDelay, 3600000);
  f.fail(null);
  await f.next();
  assert.equal(refreshes, 1);
  assert.equal(errors, 1);
  f.fail(new Error('network'));
  await f.next();
  assert.equal(f.nextDelay, 30000);
  await f.next();
  assert.equal(f.nextDelay, 60000);
  f.sync.dispose();
});
test('unmount during in-flight revision or refresh cannot notify released views', async () => {
  let done,
    refreshes = 0;
  const jobs = [];
  const sync = createBookSync(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
    {
      schedule: (fn) => {
        jobs.push(fn);
        return 1;
      },
      cancel: () => {},
      events: null,
      visibility: null,
    },
  );
  sync.subscribe({
    refresh: () => {
      refreshes++;
    },
  });
  const pending = jobs[0]();
  sync.dispose();
  done({ revision: 'a' });
  await pending;
  assert.equal(refreshes, 0);
});

test('a new panel mounted during an in-flight check loads immediately, without waiting for the idle interval', async () => {
  let releaseFirst,
    secondReads = 0,
    first = true;
  const jobs = new Map();
  let id = 0;
  const sync = createBookSync(async () => ({ revision: 'same' }), {
    schedule: (fn, delay) => {
      jobs.set(++id, { fn, delay });
      return id;
    },
    cancel: (key) => jobs.delete(key),
    events: null,
    visibility: null,
  });
  sync.subscribe({
    refresh: () =>
      first
        ? ((first = false),
          new Promise((resolve) => {
            releaseFirst = resolve;
          }))
        : undefined,
  });
  const run = async () => {
    const [key, job] = jobs.entries().next().value;
    jobs.delete(key);
    return job.fn();
  };
  const pending = run();
  await Promise.resolve();
  sync.subscribe({
    refresh: () => {
      secondReads++;
    },
  });
  releaseFirst();
  await pending;
  assert.equal([...jobs.values()][0].delay, 0);
  await run();
  assert.equal(secondReads, 1);
  sync.dispose();
});
test('snapshot cache invalidates on every original VFS writer, bounds memory and has no cold stale fallback', () => {
  let revision = 1,
    queries = 0;
  const fs = {
    db: {
      one(sql) {
        assert.equal(sql, "SELECT v FROM vfs_meta WHERE k = 'rev'");
        queries++;
        return { v: revision };
      },
    },
  };
  const cache = createReadSnapshots({ maxBytes: 32, maxEntries: 2 });
  cache.put('book/document', readWorkspaceRevision(fs), { text: 'original' });
  assert.equal(JSON.parse(cache.get('book/document', readWorkspaceRevision(fs))).text, 'original');
  revision++;
  assert.equal(cache.get('book/document', readWorkspaceRevision(fs)), null);
  assert.equal(queries, 3);
  cache.put('a', '2', {});
  cache.put('b', '2', {});
  cache.put('c', '2', {});
  assert.equal(cache.get('a', '2'), null);
  cache.put('huge', '2', { text: 'x'.repeat(40) });
  assert.equal(cache.get('huge', '2'), null);
  const cold = createReadSnapshots();
  assert.equal(cache.token('2'), cold.token('2'), 'Sleeping or restarting is not a content change.');
  assert.equal(cold.get('b', '2'), null);
  assert.throws(() => readWorkspaceRevision({}), /unavailable/);
  fs.db.one = () => ({ v: NaN });
  assert.throws(() => readWorkspaceRevision(fs), /Invalid/);
});
test('quota failures are explicit, redacted, and reset at UTC midnight rather than suggesting a PIN reset', async () => {
  const error = new Error('Exceeded allowed rows read in Durable Objects free tier. secret-body');
  const failure = serviceFailure(error, Date.parse('2026-10-27T17:00:00Z'));
  assert.equal(failure.body.code, 'STORAGE_DAILY_LIMIT');
  assert.equal(failure.headers['retry-after'], '25200');
  assert.equal(failure.body.retryAt, '2026-10-28T00:00:00.000Z');
  assert.ok(!JSON.stringify(failure).includes('secret-body'));
  const response = await handlePinRequest(
    new Request('https://fixture.example/api/auth/session'),
    {
      PIN_AUTH: {
        getByName: () => ({
          fetch: async () => {
            throw error;
          },
        }),
      },
    },
    {},
    {},
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'STORAGE_DAILY_LIMIT');
  const api = makeDocumentClient('b-' + 'a'.repeat(32), async () =>
    Response.json(failure.body, { status: 503, headers: failure.headers }),
  );
  await assert.rejects(
    api('changes'),
    (e) => e.code === 'STORAGE_DAILY_LIMIT' && e.retryAfterMs === 25200000,
  );
});
