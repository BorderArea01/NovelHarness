import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptNativeShell } from '../scripts/native-shell.mjs';
import { handleRequest } from '../pages/src/gateway.mjs';
import { conversationTitle } from '../pages/public/novel-assets/conversation-title.mjs';
import { runInNewContext } from 'node:vm';
test('native task titles are compact labels in every view; literal author text and native history remain untouched', () => {
  assert.equal(conversationTitle('[novel-task:v2] {"kind":"outline","bookId":"partial'), '规划大纲');
  assert.equal(conversationTitle('[novel-task:v3]\n{"kind":"writing-run","bookId":"partial'), '按纲连写');
  assert.equal(conversationTitle('作者自己的对话标题'), '作者自己的对话标题');
  assert.equal(conversationTitle(''), '新对话');
});

test('novel shell uses explicit pinned native presentation seams without reimplementing conversation/session ownership', async () => {
  for (const [kind, plugin] of [
    ['conversation', 'conversation'],
    ['sidebar', 'sidebar'],
  ]) {
    const input = await readFile(
      new URL(
        '../tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai/dsh-client-ui-' + plugin + '/client.js',
        import.meta.url,
      ),
    );
    const source = adaptNativeShell(kind, input);
    assert.ok(
      source.includes(
        kind === 'conversation'
          ? 'conversation: renderSlot("main.conversation", {})'
          : 'settings: props.renderSlot("sidebar.settings"',
      ),
    );
    assert.ok(source.includes(kind === 'conversation' ? '"novel.workspace"' : '"novel.navigation"'));
    if (kind === 'conversation') {
      assert.ok(
        source.includes(
          'renderSlot("novel.composer", { composer: composerSeat }, { fallback: composerSeat })',
        ),
      );
      assert.ok(source.includes('"novel.composer": { kind: "single", scope: "session-maybe" }'));
      assert.equal(source.match(/const composer = renderSlotChain\("conversation.composer"/g)?.length, 1);
      assert.ok(source.includes('overlay: true'));
      assert.ok(
        source.includes(
          'this.rootCtx.emit("novel/input-submitted", { sessionId: binding.sessionId, source: submission.source })',
        ),
      );
    }
    assert.throws(() => adaptNativeShell(kind, Buffer.concat([input, Buffer.from('unexpected upgrade')])));
  }
});
test('native layout adapts pinned mobile overlay without changing original sidebar state ownership', async () => {
  const input = await readFile(
    new URL(
      '../tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai/dsh-client-ui-layout/client.js',
      import.meta.url,
    ),
  );
  const source = adaptNativeShell('layout', input);
  assert.ok(source.includes('const productTitle = "小说工作台";'));
  assert.ok(source.includes('narrow ? collapsedWidth : cols.sidebar'));
  assert.ok(source.includes('className: "novel-navigation-scrim"'));
  assert.ok(source.includes('onClick: () => actions.toggleSidebar()'));
  assert.ok(source.includes('handleNativeDrawerKey(event, frameRef.current'));
  assert.ok(source.includes('const compact = viewport <= 600'));
  assert.ok(source.includes('hidden: compact && sidebarCollapsed'));
  assert.ok(source.includes('blocked: drawerOpen'));
  assert.ok(source.includes('const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded'));
  assert.throws(() => adaptNativeShell('layout', Buffer.concat([input, Buffer.from('unexpected upgrade')])));
});

test('browser title never subscribes to private session labels, including navigation and unmount', async () => {
  const input = await readFile(
    new URL('../tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai/dsh-client-ui-layout/client.js', import.meta.url),
  );
  const source = adaptNativeShell('layout', input);
  const start = source.indexOf('function DocumentTitle(');
  const end = source.indexOf('\n\t\t//#endregion', start);
  assert.ok(start >= 0 && end > start);
  const titleOwner = source.slice(start, end);
  assert.doesNotMatch(titleOwner, /useSessions|usePanelInfo|retainedBy|displayTitle/);
  assert.doesNotMatch(source, /document\.title = title === void 0/);
  const document = { title: '小说工作台' }, cleanups = [];
  const component = runInNewContext(titleOwner + '; DocumentTitle;', {
    document,
    react: { useEffect(effect, dependencies) {
      assert.deepEqual(Array.from(dependencies), ['小说工作台']);
      cleanups.push(effect());
    } },
  });
  const privateSubscription = () => { throw new Error('Title must not read private state.'); };
  for (const label of ['私密对话一', '另一部小说', '修改后的对话名']) {
    assert.equal(component({ productTitle: '小说工作台', title: label,
      useSessions: privateSubscription, usePanelInfo: privateSubscription }), null);
    assert.equal(document.title, '小说工作台');
  }
  for (const cleanup of cleanups) { cleanup(); assert.equal(document.title, '小说工作台'); }
});

test('settings keep their original forms, focus and store; late automatic onboarding cannot dismiss explicit settings', async () => {
  const input = await readFile(
    new URL(
      '../tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai/dsh-client-ui-settings-general/client.js',
      import.meta.url,
    ),
  );
  const source = adaptNativeShell('settings', input);
  assert.equal(
    source.slice(source.indexOf('window.__ModuleLoader__')),
    String(input)
      .replace(
        'openSettings: actions.open,',
        'openSettings: actions.open, openSettingsSection: actions.openSection,',
      )
      .replace(
        'if (appeared && open) close();',
        'if (appeared && open && requestedOnboarding !== void 0) close();',
      )
      .replace(
        'onboardingStep !== void 0 && renderSlot("settings.onboarding",',
        '!open && onboardingStep !== void 0 && renderSlot("settings.onboarding",',
      ),
  );
  assert.throws(() =>
    adaptNativeShell('settings', Buffer.concat([input, Buffer.from('unexpected upgrade')])),
  );
});
test('actual pinned settings renderer stays open when automatic onboarding arrives late, then restores onboarding on close', async () => {
  const input = await readFile(
    new URL(
      '../tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai/dsh-client-ui-settings-general/client.js',
      import.meta.url,
    ),
  );
  const source = adaptNativeShell('settings', input);
  const start = source.indexOf('\t\tfunction SettingsRoot(props) {');
  assert.ok(start > 0);
  const definition = source.slice(start, source.indexOf('\n\t\t//#endregion', start));
  const hooks = [],
    renderedSteps = [];
  let cursor = 0,
    effects = [],
    steps = [],
    open = true,
    closed = 0;
  const react = {
    useRef(value) {
      const index = cursor++;
      return (hooks[index] ??= { current: value });
    },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
      return [
        hooks[index],
        (next) => {
          hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
        },
      ];
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
    useLayoutEffect: (fn) => effects.push(fn),
  };
  const jsx = (type, props) => ({ type, props });
  const SettingsRoot = runInNewContext(definition + '\nSettingsRoot;', {
    react,
    react_jsx_runtime: { jsx, jsxs: jsx, Fragment: 'fragment' },
    SettingsRoot_module_css_default: {},
    clsx: () => '',
    SettingsPanel: () => {},
    DesktopUpdateIndicator: () => {},
    _deepseek_ai_dsh_client_ui_primitives: { Tooltip: () => {}, ConnectionIndicator: () => {} },
  });
  const props = {
    useStore: (select) => select({ open, activeId: 'models' }),
    useShortcuts: (select) => select([]),
    useSections: (select) => select([{ id: 'models' }]),
    useDesktopUpdate: (select) => select({}),
    useConnectionState: (select) => select('connected'),
    useOnboardingSteps: (select) => select(steps),
    useSessions: (select) => select({ phase: 'ready', byId: {} }),
    actions: {
      close: () => {
        closed++;
        open = false;
      },
      openSection() {},
    },
    t: (name) => name,
    renderSlot(name) {
      if (name === 'settings.onboarding') renderedSteps.push(name);
      return null;
    },
  };
  const render = () => {
    cursor = 0;
    effects = [];
    SettingsRoot(props);
    for (const effect of effects) effect();
  };
  render();
  steps = [{ id: 'welcome-notice' }];
  render();
  assert.equal(closed, 0, 'A late automatic step must not silently dismiss explicit settings.');
  assert.deepEqual(renderedSteps, [], 'No second modal may steal settings focus.');
  open = false;
  render();
  assert.deepEqual(
    renderedSteps,
    ['settings.onboarding'],
    'Closing settings restores the original first-use flow.',
  );
});

test('native UI adapters require authentication and fixed asset routing; no raw generated-file bypass', async () => {
  for (const [plugin, file] of [
    ['conversation', 'conversation'],
    ['settings-general', 'settings'],
  ]) {
    const modulePath = '/plugins/@deepseek-ai/dsh-client-ui-' + plugin + '/client.js';
    for (const authenticated of [true, false]) {
      const paths = [];
      const env = {
        HARNESS: { fetch: async () => Response.json({ authenticated }) },
        ASSETS: {
          fetch: async (request) => {
            paths.push(new URL(request.url).pathname);
            return new Response('synthetic pinned module', {
              headers: { 'content-type': 'text/javascript' },
            });
          },
        },
      };
      const response = await handleRequest({
        request: new Request('https://novel.example' + modulePath),
        env,
      });
      assert.equal(response.status, authenticated ? 200 : 401);
      assert.deepEqual(paths, authenticated ? ['/native-shell/' + file + '.js'] : []);
      const raw = await handleRequest({
        request: new Request('https://novel.example/native-shell/' + file + '.js'),
        env,
      });
      assert.equal(raw.status, 404);
    }
  }
});
test('legacy and arbitrary native HTML paths cannot expose a second unadapted application', async () => {
  const env = {
    HARNESS: {
      fetch: async () =>
        new Response('<html>native SPA fallback</html>', { headers: { 'content-type': 'text/html' } }),
    },
  };
  for (const path of ['/index.html', '/novels/index.html', '/account/index.html', '/old-workspace']) {
    const response = await handleRequest({ request: new Request('https://novel.example' + path), env });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/?view=library');
  }
});
