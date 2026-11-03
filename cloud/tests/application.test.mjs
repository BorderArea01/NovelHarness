import test from 'node:test';
import assert from 'node:assert/strict';
import { installApplication } from '../pages/public/novel-assets/application.mjs';

test('model settings are orthogonal to main navigation; only an explicit book link changes the book intent', () => {
  const before = Object.fromEntries(
    ['location', 'history', 'sessionStorage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const put = (key, value) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  try {
    for (const [query, previous, expected, remembered] of [
      ['?settings=models', 'library', 'novel-library', 'library'],
      ['?settings=models', 'book', undefined, 'book'],
      ['?settings=models&view=account', 'book', 'novel-account', 'account'],
      ['?settings=models&view=library', 'book', 'novel-library', 'library'],
      ['?settings=models&novel=b-' + 'a'.repeat(32), 'library', undefined, 'book'],
    ]) {
      const panels = [],
        cleanup = [];
      let saved = previous;
      put('location', { href: 'https://novel.example/' + query });
      put('history', { state: null, replaceState() {} });
      put('sessionStorage', {
        getItem: () => saved,
        setItem: (_key, value) => {
          saved = value;
        },
      });
      const navigation = installApplication(
        {
          effect(fn) {
            const release = fn();
            if (typeof release === 'function') cleanup.push(release);
          },
          on: () => () => {},
          slots: { inject: (_name, fn) => fn(), register: () => () => {} },
          layout: { selectPanel: (panel) => panels.push(panel) },
        },
        {},
      );
      navigation.initial();
      assert.deepEqual(panels, expected ? [expected] : []);
      assert.equal(saved, remembered);
      navigation.account();
      const afterAuthor = [...panels];
      navigation.initial();
      assert.deepEqual(panels, afterAuthor, 'Late startup must not undo an author navigation.');
      assert.equal(saved, 'account');
      cleanup.reverse().forEach((fn) => fn());
    }
  } finally {
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('one native composer is portalled only into its own session host; toggling assistant never swaps that host', () => {
  const registered = new Map(),
    cleanup = [];
  let submitted;
  const row = {
    id: 'synthetic-book-session',
    cwd: '/workspace/novels/b-' + 'a'.repeat(32),
    retainedBy: { mainView: 1 },
  };
  const catalog = { byId: { [row.id]: row } };
  const statuses = new Map();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [value, () => {}],
    useEffect() {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const ctx = {
    on: (name, callback) => {
      assert.equal(name, 'novel/input-submitted');
      submitted = callback;
      return () => {};
    },
    effect(fn) {
      const release = fn();
      if (typeof release === 'function') cleanup.push(release);
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, Component) => {
        registered.set(options.name, Component);
        return () => {};
      },
    },
    sessions: { list: { getSnapshot: () => catalog } },
    uiSession: { sessionStatus: { subscribe: () => () => {}, getSnapshot: () => statuses } },
    layout: { selectPanel() {} },
  };
  const native = { type: 'ORIGINAL_NATIVE_COMPOSER_WITH_APPROVAL_CHAIN' };
  const createPortal = (node, host, key) => ({ node, host, key });
  try {
    const navigation = installApplication(ctx, React, { createPortal });
    const Desk = registered.get('novel.workspace');
    const Composer = registered.get('novel.composer');
    const compose = Composer;
    const props = { useSessions: (select) => select(catalog), conversation: {} };
    assert.equal(compose({ composer: native, sessionId: row.id }), native);
    assert.equal(compose({ composer: native }), native);
    const dock = Desk(props).children[2];
    assert.equal(dock.props.hidden, true);
    statuses.set('other-session', { pendingInteraction: { kind: 'question' } });
    assert.equal(
      Desk(props).children[2].props.hidden,
      true,
      'Another conversation cannot reveal this input.',
    );
    for (const kind of ['question', 'approval', 'plan-review']) {
      statuses.set(row.id, { pendingInteraction: { kind } });
      assert.equal(Desk(props).children[2].props.hidden, false);
      assert.equal(Desk(props).props['data-assistant'], 'closed', 'Answering never forces navigation.');
    }
    statuses.delete(row.id);
    assert.equal(Desk(props).children[2].props.hidden, true);
    navigation.authorInput(true);
    assert.equal(Desk(props).children[2].props.hidden, false);
    const host = { dataset: { sessionId: row.id } };
    dock.children[0].props.ref(host);
    const first = compose({ composer: native, sessionId: row.id });
    assert.equal(first.node, native);
    assert.equal(first.host, host);
    submitted({ sessionId: row.id }); // Programmatic novel action.
    assert.equal(Desk(props).props['data-assistant'], 'closed');
    submitted({ sessionId: 'different-session', source: 'enter' });
    assert.equal(Desk(props).props['data-assistant'], 'closed');
    submitted({ sessionId: row.id, source: 'enter' });
    assert.equal(Desk(props).props['data-assistant'], 'open');
    navigation.dialogue();
    navigation.authorInput(false);
    assert.equal(Desk(props).children[2].props.hidden, false);
    assert.deepEqual(compose({ composer: native, sessionId: row.id }), first);
    assert.equal(compose({ composer: native, sessionId: 'another-session' }), native);
    const next = {
      id: 'next-book-session',
      cwd: '/workspace/novels/b-' + 'b'.repeat(32),
      retainedBy: { mainView: 1 },
    };
    row.retainedBy.mainView = 0;
    catalog.byId[next.id] = next;
    // DOM attributes are committed after render; use the React session binding,
    // never a previous book's DOM attribute, to decide where input belongs.
    Desk(props).children[2].children[0].props.ref(host);
    assert.equal(compose({ composer: native, sessionId: next.id }).host, host);
    assert.equal(compose({ composer: native, sessionId: row.id }), native);
    dock.children[0].props.ref(null);
    assert.equal(compose({ composer: native, sessionId: row.id }), native);
  } finally {
    cleanup.reverse().forEach((fn) => fn());
  }
});

test('unlinked historical conversations stay in the SAME shell, hidden until explicitly opened and never shown as a manuscript', () => {
  const registered = new Map(),
    cleanup = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect() {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useState: (value) => [value, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const row = {
    id: 'synthetic-old-session',
    cwd: '/workspace/unlinked',
    title: '作者原有对话',
    retainedBy: { mainView: 1 },
    blank: false,
  };
  const catalog = { byId: { [row.id]: row } };
  const workspace = {
    items: [{ path: row.cwd, workspaceId: 'synthetic-workspace', title: '旧目录' }],
    archivedSessionIds: [],
  };
  const ctx = {
    on: () => () => {},
    effect(fn) {
      const release = fn();
      if (typeof release === 'function') cleanup.push(release);
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, Component) => {
        registered.set(options.name, Component);
        return () => {};
      },
    },
    sessions: { list: { getSnapshot: () => catalog } },
    uiSession: { sessionStatus: { subscribe: () => () => {}, getSnapshot: () => new Map() } },
    layout: { selectPanel() {} },
  };
  try {
    const navigation = installApplication(ctx, React);
    const Desk = registered.get('novel.workspace');
    const nativeConversation = { type: 'ORIGINAL_NATIVE_CONVERSATION' };
    const props = { useSessions: (select) => select(catalog), conversation: nativeConversation };
    const initial = Desk(props);
    assert.equal(initial.props['data-has-book'], 'false');
    assert.equal(initial.children[1].children[1].props.hidden, true);
    navigation.dialogue();
    const opened = Desk(props);
    assert.equal(opened.children[1].children[0], null);
    assert.equal(opened.children[1].children[1].props.hidden, false);
    assert.equal(opened.children[1].children[1].children[0], nativeConversation);
    const Sidebar = registered.get('novel.navigation');
    const sidebar = Sidebar({
      collapsed: false,
      settings: null,
      useSessions: (select) => select(catalog),
      useWorkspaces: (select) => select(workspace),
    });
    const history = sidebar.children.find((node) => node?.type === 'details');
    assert.ok(history);
    assert.equal(history.children[0].children[0], '对话历史');
    assert.ok(!JSON.stringify(history).includes('＋ 新对话'));
  } finally {
    cleanup.reverse().forEach((fn) => fn());
  }
});

test('a cancelled older book-open cannot send a newer dialogue intent back to the library', async () => {
  const registered = new Map(),
    cleanup = [],
    panels = [],
    urls = [];
  const root = '/workspace/novels/b-' + 'a'.repeat(32),
    id = root.split('/').pop();
  const row = { id: 'same-native-session', cwd: root, retainedBy: { mainView: 1 } };
  const nativeNavigation = new AbortController(),
    started = Promise.withResolvers(),
    opening = Promise.withResolvers();
  let claimed = false;
  const workspace = { workspaceId: 'same-native-workspace', path: root, title: '作品', sessionIds: [row.id] };
  const store = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect() {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useState: (value) => [value, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const ctx = {
    on: () => () => {},
    effect(fn) {
      const release = fn();
      if (typeof release === 'function') cleanup.push(release);
    },
    slots: {
      inject: (_name, fn) => fn(),
      register(options, Component) {
        registered.set(options.name, Component);
        return () => {};
      },
    },
    sessions: { list: store({ phase: 'ready', byId: { [row.id]: row } }) },
    uiSession: { sessionStatus: store(new Map()) },
    workspaces: {
      // Existing workspaces now open without an unnecessary create RPC. Hold a
      // genuinely new workspace so this still exercises late native completion.
      list: store({ phase: 'ready', items: [] }),
      create: async () => {
        started.resolve();
        return opening.promise;
      },
    },
    layout: {
      beginNavigation: () => {
        claimed = true;
        return nativeNavigation.signal;
      },
      selectPanel: (panel) => {
        panels.push(panel);
        if (claimed) nativeNavigation.abort();
      },
    },
  };
  const before = Object.fromEntries(
    ['fetch', 'location', 'history', 'sessionStorage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const put = (key, value) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  put('location', { origin: 'https://novel.example' });
  put('history', { state: null, replaceState: (_state, _title, url) => urls.push(url) });
  put('sessionStorage', { setItem() {} });
  put('fetch', async () => Response.json({ format: 'novel-harness-book-v1', id, root, files: [] }));
  try {
    const navigation = installApplication(ctx, React);
    const pending = navigation.book({ id, root, format: 'novel-harness-book-v1', files: [] });
    await started.promise;
    navigation.dialogue();
    opening.resolve(workspace);
    await pending;
    assert.equal(nativeNavigation.signal.aborted, true);
    assert.ok(!panels.includes('novel-library'));
    assert.ok(!urls.includes('/?view=library'));
    const desk = registered.get('novel.workspace')({
      useSessions: (select) => select(ctx.sessions.list.getSnapshot()),
      conversation: {},
    });
    assert.equal(desk.props['data-assistant'], 'open');
  } finally {
    cleanup.reverse().forEach((fn) => fn());
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
