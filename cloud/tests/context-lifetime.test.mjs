import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { rotateFixtureContext } from './context-lifetime.mjs';

const state = () => ({
  cookies: [{ name: 'fixture-session', value: 'synthetic', domain: '127.0.0.1', path: '/' }],
  origins: [
    {
      origin: 'http://127.0.0.1:8792',
      localStorage: [
        { name: 'first', value: 'literal' },
        { name: 'second', value: 'draft' },
      ],
      indexedDB: [
        {
          name: 'fixture-drafts',
          version: 1,
          stores: [
            {
              name: 'drafts',
              records: [{ key: 'same-book', value: { text: '完整未提交稿', baseText: '原稿' } }],
            },
          ],
        },
      ],
    },
  ],
});

test('fixture context rotation preserves all browser data and seeds session intent only into an empty context', async () => {
  const saved = state(),
    restored = structuredClone(saved);
  restored.origins[0].localStorage.reverse();
  let closed = false,
    init,
    payload;
  const next = {
    storageState: async (options) => {
      assert.equal(options.indexedDB, true);
      return restored;
    },
    addInitScript: async (fn, data) => {
      init = fn;
      payload = data;
    },
    newPage: async () => ({ id: 'next-owned-page' }),
    close: async () => assert.fail('Successful context belongs to its caller.'),
  };
  const result = await rotateFixtureContext({
    browser: {
      newContext: async (options) => {
        assert.equal(closed, true);
        assert.deepEqual(options.storageState, saved);
        return next;
      },
    },
    context: {
      storageState: async (options) => {
        assert.equal(options.indexedDB, true);
        return saved;
      },
      close: async () => {
        closed = true;
      },
    },
    page: { evaluate: async () => [['novel-last-view', 'book']] },
    origin: 'http://127.0.0.1:8792',
  });
  assert.equal(result.context, next);
  const entries = new Map();
  const storage = {
    get length() {
      return entries.size;
    },
    setItem: (key, value) => entries.set(key, value),
  };
  const run = () =>
    runInNewContext('(' + init.toString() + ')(payload)', {
      payload,
      location: { origin: payload.origin },
      sessionStorage: storage,
    });
  run();
  assert.equal(entries.get('novel-last-view'), 'book');
  entries.set('novel-last-view', 'library');
  run();
  assert.equal(entries.get('novel-last-view'), 'library', 'Real reloads must not replay an older view.');
  assert.deepEqual(saved, state());
});

test('fixture rotation refuses production and fails closed on any lost restored data', async () => {
  await assert.rejects(rotateFixtureContext({ origin: 'https://novel.example' }));
  let nextClosed = false;
  await assert.rejects(
    rotateFixtureContext({
      origin: 'http://127.0.0.1:8792',
      context: { storageState: async () => state(), close: async () => {} },
      page: { evaluate: async () => [] },
      browser: {
        newContext: async () => ({
          storageState: async () => ({ cookies: [], origins: [] }),
          close: async () => {
            nextClosed = true;
          },
        }),
      },
    }),
  );
  assert.equal(nextClosed, true);
});
