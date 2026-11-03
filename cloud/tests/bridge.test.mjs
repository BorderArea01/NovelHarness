import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  bookAddress,
  openNovel,
  ensureDarkDefault,
  bookPresentation,
} from '../pages/public/novel-assets/bridge-core.mjs';
test('native workspace is the single live book-title authority, import receipt remains an unchanged fallback', () => {
  const book = { root: '/workspace/novels/fixture', title: '导入时名字' };
  assert.equal(bookPresentation(book, { items: [{ path: book.root, title: '作者改名' }] }).title, '作者改名');
  assert.equal(book.title, '导入时名字');
  assert.equal(bookPresentation(book, { items: [] }).title, '导入时名字');
});
import { installNavigation } from '../pages/public/novel-assets/harness-navigation.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';

function snapshot(value) {
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      value = next;
      for (const fn of listeners) fn();
    },
    get listeners() {
      return listeners.size;
    },
  };
}
async function fixture() {
  const { manifest: book } = await makeBookBundle(null, { seed: '修士的求救声' });
  const calls = [];
  const workspace = { workspaceId: 'workspace-book', path: book.root, title: book.id, sessionIds: [] };
  const workspaceList = snapshot({ phase: 'ready', items: [], archivedSessionIds: [] });
  const sessionList = snapshot({ phase: 'ready', byId: {} });
  const ctx = {
    workspaces: {
      list: workspaceList,
      async create(input) {
        calls.push(['workspace', input.path]);
        workspaceList.set({ ...workspaceList.getSnapshot(), items: [workspace] });
        return workspace;
      },
      async rename(id, title) {
        calls.push(['rename', id, title]);
      },
    },
    sessions: { list: sessionList, binding: (id) => ({ sessionId: id }) },
    uiWorkspace: {
      openSession(id) {
        calls.push(['resume', id]);
      },
      async openWorkspace(id, beforeOpen, options) {
        calls.push(['open', id, options]);
        beforeOpen('new-session');
      },
    },
    conversation: {
      input: {
        requestDraftInitialization(binding, options) {
          calls.push(['draft', binding.sessionId, options]);
          return 'accepted';
        },
      },
    },
  };
  const fetcher = async () => Response.json(book);
  const url = `https://novel.example/?novel=${book.id}`;
  return { book, workspace, workspaceList, sessionList, ctx, calls, fetcher, url };
}

test('new book opens native workspace and fills an editable draft without sending a model prompt', async () => {
  const f = await fixture();
  const result = await openNovel(f.ctx, f);
  assert.equal(result.kind, 'draft');
  assert.equal(result.sessionId, 'new-session');
  assert.equal(f.calls[0][1], f.book.root);
  const draft = f.calls.find((entry) => entry[0] === 'draft')[2];
  assert.match(draft.prompt, new RegExp(f.book.id));
  assert.equal(draft.clearPreviousDraft, false);
  assert.equal(f.workspaceList.listeners, 0);
  assert.equal(f.sessionList.listeners, 0);
});
test('unified manuscript mode opens the SAME native workspace without putting technical instructions in the composer', async () => {
  const f = await fixture();
  await openNovel(f.ctx, { ...f, prepareDraft: false });
  assert.ok(f.calls.some((entry) => entry[0] === 'open'));
  assert.ok(!f.calls.some((entry) => entry[0] === 'draft'));
});

test('resume chooses latest non-archived book session and preserves composer / custom workspace name', async () => {
  const f = await fixture();
  f.workspace.title = '作者自己命名';
  f.workspace.sessionIds = ['older', 'latest', 'archived', 'wrong-book'];
  f.workspaceList.set({ phase: 'ready', items: [f.workspace], archivedSessionIds: ['archived'] });
  f.sessionList.set({
    phase: 'ready',
    byId: {
      older: { sessionId: 'older', cwd: f.book.root, updatedAt: 1, blank: false },
      latest: { sessionId: 'latest', cwd: f.book.root, updatedAt: 2, blank: false },
      archived: { sessionId: 'archived', cwd: f.book.root, updatedAt: 99, blank: false },
      'wrong-book': { sessionId: 'wrong-book', cwd: '/workspace/other', updatedAt: 100, blank: false },
    },
  });
  assert.equal((await openNovel(f.ctx, f)).sessionId, 'latest');
  assert.deepEqual(
    f.calls.map((entry) => entry[0]),
    ['resume'],
  );
});

test('existing draft is not cleared or silently overwritten', async () => {
  const f = await fixture();
  f.ctx.conversation.input.requestDraftInitialization = (_binding, options) => {
    assert.equal(options.clearPreviousDraft, false);
    return 'blocked';
  };
  await assert.rejects(openNovel(f.ctx, f), /已有未发送草稿/);
});

test('an existing blank book session uses preserved-draft initialization without clearing it', async () => {
  const f = await fixture();
  f.workspace.sessionIds = ['draft-session'];
  f.workspaceList.set({ phase: 'ready', items: [f.workspace], archivedSessionIds: [] });
  f.sessionList.set({
    phase: 'ready',
    byId: { 'draft-session': { id: 'draft-session', cwd: f.book.root, updatedAt: 5, blank: true } },
  });
  assert.equal((await openNovel(f.ctx, f)).sessionId, 'draft-session');
  assert.deepEqual(
    f.calls.map((entry) => entry[0]),
    ['resume', 'draft'],
  );
  assert.equal(f.calls.at(-1)[2].clearPreviousDraft, false);
});

test('opening the native workspace may replace its own navigation without cancelling draft initialization', async () => {
  const f = await fixture(),
    owner = new AbortController(),
    previousNavigation = new AbortController();
  f.ctx.uiWorkspace.openWorkspace = async (_workspaceId, beforeOpen) => {
    previousNavigation.abort();
    beforeOpen('owned-navigation');
  };
  assert.equal(
    (await openNovel(f.ctx, { ...f, signal: owner.signal, navigationSignal: previousNavigation.signal }))
      .kind,
    'draft',
  );
});

test('invalid paths, missing receipts and mismatched roots never create workspaces', async () => {
  const f = await fixture();
  assert.throws(() => bookAddress('https://novel.example/?novel=../../private'));
  assert.equal(bookAddress('https://novel.example/'), null);
  await assert.rejects(
    openNovel(f.ctx, { ...f, fetcher: async () => new Response('', { status: 404 }) }),
    /尚未完整导入/,
  );
  await assert.rejects(
    openNovel(f.ctx, { ...f, fetcher: async () => Response.json({ ...f.book, root: '/workspace/other' }) }),
    /不一致/,
  );
  assert.deepEqual(f.calls, []);
});

test('navigation abort during controller startup detaches listeners and does not open a session', async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.workspaceList.set({ phase: 'pending', items: [] });
  const opening = openNovel(f.ctx, { ...f, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(f.workspaceList.listeners, 0);
  assert.deepEqual(f.calls, []);
});

test('bootstrap registers a dependency-based native client plugin exactly once', async () => {
  const code = await readFile(
    new URL('../pages/public/novel-assets/harness-boot.mjs', import.meta.url),
    'utf8',
  );
  const graph = {
    rev: 'upstream',
    entries: [
      { id: '@deepseek-ai/dsh-client-ui-workspace' },
      { id: '@deepseek-ai/dsh-api-session-controller' },
      { id: '@deepseek-ai/dsh-api-workspace-controller' },
      { id: '@deepseek-ai/dsh-client-ui-theme' },
      { id: '@deepseek-ai/dsh-client-ui-sidebar' },
      { id: '@deepseek-ai/dsh-client-ui-settings-models' },
      { id: '@deepseek-ai/dsh-client-ui-settings-general' },
      { id: '@deepseek-ai/dsh-client-ui-sidebar-right' },
      { id: '@deepseek-ai/dsh-client-ui-conversation' },
      { id: '@deepseek-ai/dsh-client-ui-session' },
    ],
    batches: [],
  };
  const context = { __DSH_BOOT__: graph };
  runInNewContext(code, context);
  runInNewContext(code, context);
  assert.equal(graph.entries.filter((entry) => entry.id === 'novel-harness-bridge').length, 1);
  assert.equal(graph.batches.length, 1);
  assert.equal(graph.batches[0].phase, 'application');
  assert.equal(graph.entries.at(-1).inject.length, 10);
  assert.equal(
    graph.entries.find((entry) => entry.id === '@deepseek-ai/dsh-client-ui-settings-general').url,
    '/plugins/@deepseek-ai/dsh-client-ui-settings-general/client.js?novel=development',
  );
});

test('navigation uses native settings callbacks and keeps compact controls labelled', () => {
  const registrations = [],
    selected = [];
  const ctx = {
    slots: {
      inject(_name, register) {
        return register();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useRef: () => ({ current: false }),
    useEffect: (fn) => fn(),
  };
  let nextUrl;
  installNavigation(ctx, React, {
    url: 'https://novel.example/?settings=models',
    replaceUrl: (url) => {
      nextUrl = url;
    },
  });
  assert.deepEqual(
    registrations.map(({ options }) => options.name),
    ['settings.launcher', 'sidebar.footer.action'],
  );
  const library = registrations
    .find(({ options }) => options.name === 'sidebar.footer.action')
    .component({ wide: false });
  assert.equal(library.children[0].props.href, '/novels/');
  assert.equal(library.children[0].props['aria-label'], '小说库');
  const launcher = registrations
    .find(({ options }) => options.name === 'settings.launcher')
    .component({
      wide: false,
      openOnboarding: () => {
        throw Error('A settings entry must not restart onboarding.');
      },
      openSettingsSection: (id) => selected.push(id),
      openSettings: () => selected.push('settings'),
    });
  assert.equal(nextUrl.search, '');
  assert.deepEqual(selected, ['models']);
  assert.equal(launcher.children[0].props['aria-label'], '模型设置');
  assert.equal(launcher.children[0].children[1], null);
  launcher.children[0].props.onClick();
  assert.deepEqual(selected, ['models', 'models']);
  launcher.children[1].props.onClick();
  assert.equal(selected.at(-1), 'settings');
});

test('settings deep link waits for native restoration, preserves the current URL and yields to manual settings', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    for (const manual of [false, true]) {
      let Component, release, resolveReady;
      const selected = [],
        replaced = [];
      const ready = new Promise((resolve) => {
        resolveReady = resolve;
      });
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { href: 'https://novel.example/?view=library&keep=author' },
      });
      installNavigation(
        {
          slots: {
            inject: (_name, register) => register(),
            register: ({ name }, component) => {
              if (name === 'settings.launcher') Component = component;
            },
          },
        },
        {
          createElement: (tag, props, ...children) => ({ tag, props, children }),
          useRef: () => ({ current: false }),
          useEffect: (fn) => {
            const cleanup = fn();
            if (cleanup) release = cleanup;
          },
        },
        {
          url: 'https://novel.example/?settings=models',
          ready,
          replaceUrl: (url) => replaced.push(url.href),
        },
      );
      const launcher = Component({
        openSettingsSection: (section) => selected.push(section),
        openSettings: () => selected.push('manual-settings'),
      });
      assert.deepEqual(selected, []);
      if (manual) launcher.children[1].props.onClick();
      resolveReady();
      await ready;
      assert.deepEqual(selected, [manual ? 'manual-settings' : 'models']);
      assert.deepEqual(replaced, [], 'A consumed settings query must not overwrite a newer main view.');
      release();
    }
  } finally {
    if (before) Object.defineProperty(globalThis, 'location', before);
    else delete globalThis.location;
  }
});

test('application model actions delegate to the original section callback and release their binding', () => {
  let Component, bound, release;
  const selected = [];
  installNavigation(
    {
      slots: {
        inject: (_name, fn) => fn(),
        register: (_options, component) => {
          Component = component;
        },
      },
    },
    {
      createElement: () => ({}),
      useRef: () => ({ current: false }),
      useEffect: (fn) => {
        const cleanup = fn();
        if (cleanup) release = cleanup;
      },
    },
    {
      url: 'https://novel.example/?view=library',
      navigation: {
        bindModels: (fn) => {
          bound = fn;
          return () => {
            bound = undefined;
          };
        },
      },
    },
  );
  Component({ openSettingsSection: (section) => selected.push(section) });
  assert.deepEqual(selected, []);
  bound();
  assert.deepEqual(selected, ['models']);
  release();
  assert.equal(bound, undefined);
});

test('dark is initialized via native settings only when no durable user preference exists', async () => {
  const scope = snapshot({ status: 'ready', value: { preference: 'system' }, user: {}, writable: true });
  let written;
  scope.set = async (field, value) => {
    written = [field, value];
    return true;
  };
  assert.equal(await ensureDarkDefault({ configForms: { get: () => scope } }), true);
  assert.deepEqual(written, ['preference', 'dark']);
});

test('explicit light or system preference is never overwritten by the default initializer', async () => {
  for (const preference of ['light', 'system', 'dark']) {
    const scope = snapshot({ status: 'ready', value: { preference }, user: { preference }, writable: true });
    scope.set = () => {
      throw new Error('must not write');
    };
    assert.equal(await ensureDarkDefault({ configForms: { get: () => scope } }), false);
  }
});

test('optional verified release artifact has the plugin graph and public services our bridge needs', async (t) => {
  const base = new URL('../../test-results/dsh-edge-0.30.0/package/dist/', import.meta.url);
  let html;
  try {
    html = await readFile(new URL('index.html', base), 'utf8');
  } catch {
    t.skip('Verified upstream release archive not present; protocol unit tests are still available.');
    return;
  }
  const match = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s);
  assert.ok(match);
  const context = { __DSH_BOOT__: JSON.parse(match[1]) };
  runInNewContext(
    await readFile(new URL('../pages/public/novel-assets/harness-boot.mjs', import.meta.url), 'utf8'),
    context,
  );
  assert.equal(context.__DSH_BOOT__.entries.at(-1).id, 'novel-harness-bridge');
  const workspace = await readFile(
    new URL('plugins/@deepseek-ai/dsh-client-ui-workspace/client.js', base),
    'utf8',
  );
  assert.match(workspace, /openSession\(target\)/);
  assert.match(workspace, /openWorkspace\(workspaceId, beforeOpen/);
  assert.match(workspace, /requestDraftInitialization\(binding, options\)/);
});
