import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { waitForNativeCatalogs } from '../pages/public/novel-assets/bridge-core.mjs';

function model() {
  let value = { phase: 'connecting' };
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ready() {
      value = { phase: 'ready' };
      for (const fn of listeners) fn();
    },
    listeners,
  };
}
async function boot() {
  const workspaces = model(),
    sessions = model(),
    timers = [],
    cleanup = [],
    alerts = [],
    opened = [];
  const ctx = {
    workspaces: { list: workspaces },
    sessions: { list: sessions },
    effect(fn) {
      cleanup.push(fn());
    },
  };
  const navigation = { initial() {} };
  const modules = {
    'bridge-core': {
      waitForNativeCatalogs,
      ensureDarkDefault: async () => {},
      openNovel: async (ctx, { signal }) => {
        await waitForNativeCatalogs(ctx, { signal });
        signal.throwIfAborted();
        opened.push(true);
      },
    },
    'harness-navigation': { installNavigation() {} },
    manuscript: { installManuscript() {} },
    application: { installApplication: () => navigation },
    'task-message': { installTaskMessages() {} },
    'proposal-tool-view': { installProposalToolViews() {} },
    'studio-theme': { installStudioTheme() {} },
  };
  let definition;
  const window = {
    location: { href: 'https://novel.example/?novel=b-00000000000000000000000000000001' },
    history: {
      state: null,
      replaceState(_state, _title, url) {
        window.location.href = url;
      },
    },
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  const document = {
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ setAttribute() {}, append() {}, remove() {} }),
    createTextNode: (text) => text,
    body: { prepend: (element) => alerts.push(element) },
  };
  const source = await readFile(
    new URL('../pages/public/novel-assets/harness-bridge.mjs', import.meta.url),
    'utf8',
  );
  runInNewContext(source.replace(/\bimport\(/g, 'loadModule('), {
    window,
    document,
    URL,
    AbortController,
    DOMException,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout() {
        const timer = new AbortController();
        timers.push(timer);
        return timer.signal;
      },
    },
    setInterval: () => 1,
    clearInterval() {},
    loadModule: async (path) => modules[path.split('/').at(-1).replace('.mjs', '')],
  });
  definition.factory(() => ({})).apply(ctx);
  await new Promise(setImmediate);
  return { workspaces, sessions, timers, cleanup, alerts, opened };
}
test('a slow initial catalog can recover after the old startup deadline without a stale timeout notice', async () => {
  const app = await boot();
  for (const timer of app.timers) timer.abort(new DOMException('Timed out', 'TimeoutError'));
  await new Promise(setImmediate);
  app.workspaces.ready();
  app.sessions.ready();
  await new Promise(setImmediate);
  assert.equal(app.opened.length, 1);
  assert.equal(app.alerts.length, 0);
  assert.equal(app.workspaces.listeners.size, 0);
  assert.equal(app.sessions.listeners.size, 0);
  for (const dispose of app.cleanup) dispose?.();
});
test('disposing startup while catalogs connect cancels opening and releases subscriptions', async () => {
  const app = await boot();
  for (const dispose of app.cleanup) dispose?.();
  app.workspaces.ready();
  app.sessions.ready();
  await new Promise(setImmediate);
  assert.equal(app.opened.length, 0);
  assert.equal(app.alerts.length, 0);
  assert.equal(app.workspaces.listeners.size, 0);
  assert.equal(app.sessions.listeners.size, 0);
});
