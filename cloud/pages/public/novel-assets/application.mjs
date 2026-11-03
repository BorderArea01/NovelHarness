import { mountLibrary } from './studio.mjs';
import { openNovel, bookPresentation } from './bridge-core.mjs';
import { bindWorkspaceNavigator } from './workspace-navigation.mjs';
import { conversationTitle } from './conversation-title.mjs';
import { bindVisibleViewport } from './visual-viewport.mjs';
import { resetBookConversation } from './conversation-reset.mjs';
import { createTitleEditor, renameConversation, renameBook } from './title-editor.mjs';
import { icon } from './ui-icons.mjs';
import {
  bookActivities,
  subscribeBookActivities,
  requireBookSession,
  stopBookActivity,
} from './native-activity.mjs';

// One navigation owner, one native application frame. Library, account, books
// and conversations share the same settings/session services and VFS owner.
export function installApplication(ctx, React, { createPortal } = {}) {
  const h = React.createElement;
  const anonymous = globalThis.document?.body?.dataset.novelAuth === 'anonymous';
  const TitleEditor = createTitleEditor(React);
  ctx.effect(() => bindVisibleViewport(), 'novel: original browser visual viewport');
  let modelLauncher;
  let Editor;
  let navigationRevision = 0;
  let initialRevision;
  let view = {
    area: 'library',
    assistant: false,
    request: null,
    revision: 0,
    composerHost: null,
    composerSessionId: null,
    authorInput: false,
    compact: globalThis.matchMedia?.('(max-width: 600px)').matches ?? false,
  };
  const listeners = new Set();
  const publish = (patch) => {
    view = { ...view, ...patch, revision: view.revision + 1 };
    for (const listener of listeners) listener();
  };
  const remember = (view) => {
    try {
      sessionStorage.setItem('novel-last-view', view);
    } catch {}
  };
  const bookView = (patch) => {
    navigationRevision++;
    publish({ ...patch, area: 'book' });
    ctx.layout.selectPanel(null);
    remember('book');
    globalThis.history?.replaceState(globalThis.history.state, '', '/');
  };
  const navigation = {
    bindEditor(component) {
      Editor = component;
      publish({});
    },
    dialogue() {
      bookView({ assistant: true });
    },
    manuscript() {
      bookView({ assistant: false });
    },
    authorInput(enabled) {
      if (view.authorInput !== enabled) publish({ authorInput: enabled });
    },
    reveal(bookId, params) {
      const row = Object.values(ctx.sessions.list.getSnapshot().byId).find(
        (row) => (row.retainedBy.mainView ?? 0) > 0,
      );
      if (row?.cwd !== '/workspace/novels/' + bookId) return false;
      if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
      bookView({ assistant: false, request: { params, revision: view.revision + 1 } });
      return true;
    },
    bindModels(callback) {
      modelLauncher = callback;
      return () => {
        if (modelLauncher === callback) modelLauncher = undefined;
      };
    },
    openModels() {
      if (!modelLauncher) throw new Error('模型设置尚未就绪，请稍后重试。');
      modelLauncher();
    },
    library() {
      navigationRevision++;
      publish({ area: 'library' });
      ctx.layout.selectPanel('novel-library');
      remember('library');
      history.replaceState(history.state, '', '/?view=library');
    },
    account() {
      navigationRevision++;
      publish({ area: 'account' });
      ctx.layout.selectPanel('novel-account');
      remember('account');
      history.replaceState(history.state, '', '/?view=account');
    },
    async book(book) {
      const revision = ++navigationRevision;
      // Default view belongs to this navigation intent, not to its potentially
      // late completion. Never close an assistant the author opened meanwhile.
      publish({ assistant: false, request: null });
      try {
        const result = await openNovel(ctx, {
          url: location.origin + '/?novel=' + book.id,
          signal: AbortSignal.timeout(30000),
          prepareDraft: false,
          receipt: book,
        });
        if (revision !== navigationRevision || result?.kind === 'cancelled') return;
        // Keep the current library responsive until the NEW native session is
        // selected. Showing the last book first mounts/reads the wrong editor
        // and competes with the book the author is actually opening.
        ctx.layout.selectPanel(null);
        publish({ area: 'book' });
        remember('book');
        history.replaceState(history.state, '', '/');
      } catch (error) {
        if (revision !== navigationRevision || error.name === 'AbortError') return;
        navigation.library();
        throw error;
      }
    },
    session(book, id) {
      navigationRevision++;
      requireBookSession(ctx, book, id);
      ctx.uiWorkspace.openSession(id);
      ctx.layout.selectPanel(null);
      publish({ assistant: true, request: null, area: 'book' });
      remember('book');
      history.replaceState(history.state, '', '/');
    },
    initial() {
      // The native catalog restoration may finish after the first paint. It
      // may be reconciled once ready, but never over a newer author gesture.
      if (initialRevision !== undefined && navigationRevision !== initialRevision) return;
      const url = new URL(location.href);
      // A model-settings deep link opens native chrome, not a different book
      // or main panel. Only an explicit book-open request owns that change.
      if (url.searchParams.has('novel')) {
        publish({ area: 'book' });
        remember('book');
        initialRevision = navigationRevision;
        return;
      }
      if (url.searchParams.get('view') === 'account') navigation.account();
      else if (url.searchParams.get('view') === 'library') navigation.library();
      else {
        let previous;
        try {
          previous = sessionStorage.getItem('novel-last-view');
        } catch {}
        if (previous !== 'book') navigation.library();
        else publish({ area: 'book' });
      }
      initialRevision = navigationRevision;
    },
  };
  ctx.effect(() => bindWorkspaceNavigator(navigation), 'novel: workspace presentation routing');
  ctx.effect(
    () =>
      ctx.on('novel/input-submitted', ({ sessionId, source }) => {
        // Native UI gestures fire after actual message adjudication/commit. Writing
        // actions use programmatic submit (no source); they keep their review view.
        // No text copy, transient pending-echo observer or guessed keyboard event.
        if (!['enter', 'click'].includes(source)) return;
        const row = ctx.sessions.list.getSnapshot().byId[sessionId];
        if ((row?.retainedBy.mainView ?? 0) > 0 && /^\/workspace\/novels\/b-[a-f0-9]{32}$/.test(row.cwd))
          navigation.dialogue();
      }),
    'novel: original native message submission',
  );
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const snapshot = () => view;
  ctx.effect(() => {
    const media = globalThis.matchMedia?.('(max-width: 600px)');
    if (!media) return;
    const update = () => publish({ compact: media.matches });
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, 'novel: responsive author shortcuts');
  const bindComposerHost = (composerHost, composerSessionId) => {
    if (view.composerHost !== composerHost || view.composerSessionId !== composerSessionId)
      publish({ composerHost, composerSessionId });
  };
  // Relocate the ORIGINAL native subtree, including approvals and queue/stop
  // controls. A stable portal target keeps the input's DOM, focus and selection
  // intact when switching between manuscript and conversation. No draft copy.
  function NativeComposer({ composer, sessionId }) {
    const state = React.useSyncExternalStore(subscribe, snapshot);
    const host = state.composerHost;
    return createPortal && host && state.composerSessionId === sessionId
      ? createPortal(composer, host, 'native-novel-composer')
      : composer;
  }
  function NovelDesk({ useSessions, conversation }) {
    const state = React.useSyncExternalStore(subscribe, snapshot);
    const [actionHost, setActionHost] = React.useState(null);
    const [headingHost, setHeadingHost] = React.useState(null);
    const [resetting, setResetting] = React.useState(false);
    const [resetError, setResetError] = React.useState('');
    const session = useSessions((list) =>
      Object.values(list.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0),
    );
    // Pending questions/approvals belong to the ORIGINAL composer chain. Keep
    // that chain visible even when an optional manuscript tab hides ordinary
    // writing input, including after reload. Never switch the author's page.
    const statuses = React.useSyncExternalStore(
      ctx.uiSession.sessionStatus.subscribe,
      ctx.uiSession.sessionStatus.getSnapshot,
    );
    const needsAnswer = !!statuses.get(session?.id)?.pendingInteraction;
    const bindSessionComposerHost = React.useCallback(
      (node) => bindComposerHost(node, session?.id),
      [session?.id],
    );
    const bookId = /^\/workspace\/novels\/(b-[a-f0-9]{32})$/.exec(session?.cwd ?? '')?.[1];
    React.useEffect(() => {
      // Retire a previously persisted manuscript drawer, without deleting its
      // record, touching files or closing an unrelated native file inspector.
      const retire = () => {
        if (ctx.sidebarRight.active()?.kind === 'novel-manuscript' && ctx.sidebarRight.isExpanded())
          ctx.sidebarRight.toggleExpanded();
      };
      retire();
      const a = ctx.sidebarRight.openTabs.subscribe(retire);
      const b = ctx.sidebarRight.mounted.subscribe(retire);
      return () => {
        a();
        b();
      };
    }, [bookId]);
    return h(
      'main',
      {
        className: 'novel-desk',
        'data-has-book': bookId ? 'true' : 'false',
        'data-assistant': state.assistant ? 'open' : 'closed',
        'data-running': session?.running ? 'true' : 'false',
        'aria-label': '小说创作工作台',
      },
      h(
        'header',
        { className: 'novel-desk-bar' },
        bookId
          ? h('div', { className: 'novel-desk-heading-host', ref: setHeadingHost })
          : h('span', { className: 'novel-desk-label' }, '未关联作品'),
        bookId && state.assistant
          ? h(
              'button',
              {
                type: 'button',
                disabled: resetting,
                title: '只重开当前聊天；正文、大纲、记忆、设定和草稿仍保留。彻底换故事请在书库选择重新开始。',
                onClick: async () => {
                  const running = !!session.running || !!statuses.get(session.id)?.pendingInteraction;
                  if (
                    !globalThis.confirm(
                      running
                        ? '停止当前生成并重开聊天？只清对话，书内记忆、设定、草稿、大纲和正文仍可被AI读取。要换掉旧故事，请在书库选择“重新开始”。'
                        : '重开当前聊天？只清对话，书内记忆、设定、草稿、大纲和正文仍可被AI读取。要换掉旧故事，请在书库选择“重新开始”。',
                    )
                  )
                    return;
                  setResetting(true);
                  setResetError('');
                  const revision = ++navigationRevision;
                  try {
                    await resetBookConversation(ctx, session, {
                      stopActivity: running,
                      isCurrent: () => revision === navigationRevision,
                    });
                    navigation.dialogue();
                  } catch (error) {
                    if (error.name !== 'AbortError') setResetError(error.message);
                  } finally {
                    setResetting(false);
                  }
                },
              },
              resetting ? '正在清空…' : '清空聊天',
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': state.assistant,
            'data-variant': 'primary',
            onClick: () =>
              !bookId && state.assistant
                ? navigation.library()
                : state.assistant
                  ? navigation.manuscript()
                  : navigation.dialogue(),
          },
          bookId ? (state.assistant ? '返回书稿' : '创作助手') : state.assistant ? '返回书库' : '对话历史',
        ),
        resetError ? h('p', { role: 'alert', className: 'novel-reset-error' }, resetError) : null,
      ),
      h(
        'div',
        { className: 'novel-desk-panes' },
        bookId && Editor
          ? h(
              'div',
              { className: 'novel-desk-writing' },
              h(Editor, {
                key: bookId,
                bookId,
                sessionId: session.id,
                navigation: state.request,
                onDialogue: navigation.dialogue,
                actionHost,
                headingHost,
              }),
            )
          : !state.assistant
            ? h(
                'section',
                { className: 'novel-desk-empty' },
                h('h1', null, '打开一本小说，开始创作'),
                h('button', { onClick: navigation.library }, '前往书库'),
              )
            : null,
        // Exactly one original Conversation subtree, kept mounted while browsing
        // the manuscript so streaming, approvals and the unsent draft survive.
        h(
          'aside',
          {
            className: 'novel-desk-assistant',
            'aria-label': '创作助手对话',
            hidden: !state.assistant,
          },
          conversation,
        ),
      ),
      bookId
        ? h(
            'section',
            {
              className: 'novel-author-dock',
              'aria-label': '创作要求与操作',
              'data-pending-interaction': needsAnswer ? 'true' : 'false',
              hidden: !state.assistant && !state.authorInput && !needsAnswer,
            },
            h('div', {
              className: 'novel-author-input',
              ref: bindSessionComposerHost,
              'data-session-id': session.id,
            }),
            h(
              'details',
              { className: 'novel-author-shortcuts', open: !state.compact },
              h('summary', null, '写作操作'),
              h('div', { className: 'novel-author-actions', ref: setActionHost }),
            ),
          )
        : null,
    );
  }
  function NovelSidebar({ collapsed, settings, useSessions, useWorkspaces }) {
    const wide = !collapsed;
    const area = React.useSyncExternalStore(subscribe, snapshot).area;
    const catalog = useSessions((value) => value);
    const workspaces = useWorkspaces((value) => value);
    const current = Object.values(catalog.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0);
    const workspace = workspaces.items.find((item) => item.path === current?.cwd);
    const isBook = /^\/workspace\/novels\/b-[a-f0-9]{32}$/.test(current?.cwd ?? '');
    const archived = new Set(workspaces.archivedSessionIds ?? []);
    const conversations = Object.values(catalog.byId)
      .filter(
        (row) =>
          row.cwd === current?.cwd &&
          row.origin !== 'subagent' &&
          !archived.has(row.id) &&
          (!row.blank || row.id === current?.id),
      )
      .sort(
        (a, b) =>
          (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) -
          (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0),
      );
    const [error, setError] = React.useState('');
    const [visible, setVisible] = React.useState(30);
    const past = Object.values(catalog.byId).filter(
      (row) => row.cwd === current?.cwd && row.origin !== 'subagent' && archived.has(row.id),
    );
    const title = (row) => conversationTitle(row.title);
    return h(
      'aside',
      {
        className: 'novel-studio-sidebar',
        'data-wide': wide ? 'true' : 'false',
        'aria-label': '创作导航',
        onClick: (event) => {
          if (
            wide &&
            globalThis.matchMedia?.('(max-width: 1023px)').matches &&
            event.target.closest(
              'a, .novel-studio-brand, .novel-studio-links button, .novel-studio-conversations [data-open-conversation], .novel-studio-settings button',
            )
          )
            ctx.layout.toggleSidebar();
        },
      },
      h(
        'button',
        { className: 'novel-studio-brand', onClick: navigation.library, title: '小说库' },
        icon(React, 'book'),
        wide ? h('span', null, '小说工作台') : null,
      ),
      h(
        'button',
        {
          className: 'novel-sidebar-toggle',
          onClick: () => ctx.layout.toggleSidebar(),
          'aria-label': wide ? '收起导航' : '展开导航',
          title: wide ? '收起导航' : '展开导航',
          'aria-expanded': wide,
        },
        icon(React, 'panel'),
        wide ? h('span', null, '收起导航') : null,
      ),
      h(
        'nav',
        { className: 'novel-studio-links' },
        h(
          'a',
          {
            href: '/novels/',
            'aria-label': '小说库',
            title: '小说库',
            'aria-current': area === 'library' ? 'page' : undefined,
            onClick: (e) => {
              e.preventDefault();
              navigation.library();
            },
          },
          icon(React, 'library'),
          wide ? h('span', null, '我的书库') : null,
        ),
        h(
          'button',
          {
            onClick: navigation.manuscript,
            title: '当前作品',
            'aria-label': '当前作品',
            disabled: !isBook,
            'aria-current': area === 'book' ? 'page' : undefined,
          },
          icon(React, 'file'),
          wide ? h('span', null, '当前作品') : null,
        ),
      ),
      wide && workspace
        ? h(
            isBook ? 'section' : 'details',
            { className: 'novel-studio-conversations', 'aria-label': '作品对话' },
            isBook ? h('h2', null, workspace.title || '当前作品') : h('summary', null, '对话历史'),
            isBook
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: async () => {
                      try {
                        await ctx.uiWorkspace.openWorkspace(workspace.workspaceId, () => {});
                        navigation.dialogue();
                      } catch (fault) {
                        setError(fault.message);
                      }
                    },
                  },
                  '＋ 新对话',
                )
              : null,
            ...conversations.slice(0, visible).map((row) =>
              h(
                'div',
                { key: row.id, className: 'novel-session-row', 'data-session-id': row.id },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-open-conversation': true,
                    'aria-current': row.id === current.id ? 'true' : undefined,
                    title: title(row),
                    onClick: () => {
                      ctx.uiWorkspace.openSession(row.id);
                      navigation.dialogue();
                    },
                  },
                  (row.running ? '◌ ' : '') + title(row),
                ),
                h(TitleEditor, {
                  value: title(row),
                  label: '对话标题',
                  disabled: !!row.blank,
                  onSave: (value) => renameConversation(ctx, row.id, value, row.title),
                }),
              ),
            ),
            conversations.length > visible
              ? h('button', { onClick: () => setVisible(visible + 30) }, '显示更多对话')
              : null,
            past.length
              ? h(
                  'details',
                  { className: 'novel-archived-conversations' },
                  h('summary', null, '归档对话 · ' + past.length),
                  ...past.slice(0, visible).map((row) =>
                    h(
                      'button',
                      {
                        key: row.id,
                        type: 'button',
                        title: title(row),
                        'data-open-conversation': true,
                        onClick: () => {
                          ctx.uiWorkspace.openSession(row.id);
                          navigation.dialogue();
                        },
                      },
                      title(row),
                    ),
                  ),
                  past.length > visible
                    ? h('button', { onClick: () => setVisible(visible + 30) }, '显示更多归档')
                    : null,
                )
              : null,
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
      h('div', { className: 'novel-studio-settings' }, settings),
      h(
        'a',
        {
          href: '/account/',
          'aria-label': '数据与访问',
          title: '数据与访问',
          onClick: (e) => {
            e.preventDefault();
            navigation.account();
          },
        },
        icon(React, 'user'),
        wide ? h('span', null, '数据与访问') : null,
      ),
    );
  }
  ctx.effect(
    () =>
      ctx.slots.inject('novel.composer', () =>
        ctx.slots.register({ name: 'novel.composer' }, NativeComposer),
      ),
    'novel: single native author input',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('novel.workspace', () => ctx.slots.register({ name: 'novel.workspace' }, NovelDesk)),
    'novel: manuscript-first main workspace',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('novel.navigation', () =>
        ctx.slots.register({ name: 'novel.navigation' }, NovelSidebar),
      ),
    'novel: author navigation',
  );
  function Library() {
    const ref = React.useRef(null);
    React.useEffect(
      () =>
        mountLibrary(ref.current, {
          navigateBook: navigation.book,
          renameBook: async (book, title) => {
            await renameBook(ctx, book, title);
          },
          decorateBook: (book) => bookPresentation(book, ctx.workspaces.list.getSnapshot()),
          subscribeBooks: (fn) => ctx.workspaces.list.subscribe(fn),
          getActivity: (book) => bookActivities(ctx, book),
          subscribeActivity: (fn) => subscribeBookActivities(ctx, fn),
          navigateSession: navigation.session,
          stopActivity: (book, id) => stopBookActivity(ctx, book, id),
          refreshActivity: () => ctx.sessions.refresh(),
          archiveBookSessions: async (book, replacement) => {
            // Native archive reconciliation may unmount the library when the
            // selected session closes. Navigation belongs to this root app,
            // not to an already disposed card/management component.
            const revision = ++navigationRevision;
            let warning = '';
            try {
              await ctx.sessions.refresh();
              const rows = Object.values(ctx.sessions.list.getSnapshot().byId).filter(
                (row) => row.cwd === book.root && row.origin !== 'subagent',
              );
              for (const row of rows) await ctx.workspaces.archiveSession(row.id, { stopActivity: false });
            } catch {
              warning = '旧聊天未完全归档，原记录保留；新书不会继承旧对话。';
            }
            if (revision === navigationRevision) {
              if (replacement) await navigation.book(replacement);
              else navigation.library();
            }
            return { handled: true, warning };
          },
        }),
      [],
    );
    return h(
      'main',
      { className: 'novel-application novel-library', ref, 'aria-label': '小说库' },
      h(
        'header',
        { className: 'novel-app-heading' },
        h('h1', null, '我的小说'),
        h('button', { id: 'new-book', type: 'button' }, icon(React, 'plus'), '新建小说'),
      ),
      h(
        'section',
        { className: 'novel-create-guide', id: 'create-guide', hidden: true, 'aria-label': '新建小说引导' },
        h('h2', { id: 'create-step-title' }, '1 / 2 · 为作品命名'),
        h(
          'form',
          { id: 'seed-form' },
          h(
            'div',
            { id: 'create-identity' },
            h('label', { htmlFor: 'book-title' }, '书名'),
            h('input', {
              id: 'book-title',
              maxLength: 120,
              required: true,
              placeholder: '暂定名也可以',
              autoComplete: 'off',
            }),
            h('label', { htmlFor: 'book-genre' }, '类型（选填）'),
            h('input', {
              id: 'book-genre',
              list: 'book-genres',
              maxLength: 80,
              placeholder: '选择或自由输入',
            }),
            h(
              'datalist',
              { id: 'book-genres' },
              ...['玄幻', '仙侠', '悬疑', '科幻', '都市', '言情', '奇幻', '历史'].map((name) =>
                h('option', { key: name, value: name }),
              ),
            ),
          ),
          h(
            'div',
            { id: 'create-premise', hidden: true },
            h('label', { htmlFor: 'seed' }, '故事起点（选填）'),
            h('textarea', {
              id: 'seed',
              rows: 4,
              maxLength: 12000,
              placeholder: '一句灵感或一段简介。也可以留空，进书后再规划。',
            }),
            h('p', { className: 'novel-app-hint' }, '保存为作品资料，不会发送对话或自动调用 AI。'),
          ),
          h(
            'div',
            { className: 'seed-actions' },
            h('button', { id: 'create-dismiss', type: 'button' }, '取消建书'),
            h('button', { id: 'create-back', type: 'button', hidden: true }, '上一步'),
            h('button', { id: 'create-next', type: 'button' }, '下一步'),
            h('button', { id: 'create-book', type: 'submit', hidden: true }, '创建并打开'),
          ),
        ),
      ),
      h(
        'div',
        { className: 'status-row' },
        h('p', { id: 'status', role: 'status', 'aria-live': 'polite' }, '正在读取书库…'),
        h('button', { id: 'cancel', hidden: true, type: 'button' }, '停止'),
      ),
      h(
        'section',
        { id: 'import-preview', className: 'preview', hidden: true },
        h('h2', { id: 'preview-heading' }, '导入预览'),
        h('p', { id: 'preview-title' }),
        h('p', { id: 'preview-counts' }),
        h('p', { id: 'preview-warning' }),
        h(
          'div',
          { className: 'actions' },
          h('button', { id: 'upload' }, '确认导入'),
          h('button', { id: 'dismiss' }, '取消'),
        ),
      ),
      h(
        'div',
        { className: 'section-heading' },
        h(
          'div',
          { className: 'novel-library-filter' },
          icon(React, 'search'),
          h('input', {
            id: 'book-search',
            type: 'search',
            'aria-label': '搜索小说',
            placeholder: '搜索书名',
            autoComplete: 'off',
          }),
        ),
        h('span', { id: 'library-count', className: 'novel-library-count', 'aria-live': 'polite' }),
        h(
          'div',
          { className: 'novel-library-tools' },
          h(
            'label',
            { className: 'import-button', htmlFor: 'project-file' },
            icon(React, 'download'),
            '导入 / 恢复',
            h('input', { id: 'project-file', type: 'file', accept: '.json,application/json' }),
          ),
          h(
            'button',
            { id: 'show-trash', type: 'button' },
            icon(React, 'trash'),
            h('span', { id: 'trash-label' }, '回收站'),
          ),
          h('button', { id: 'refresh' }, icon(React, 'refresh'), '刷新'),
        ),
      ),
      h('div', { id: 'books', className: 'books' }),
      h(
        'section',
        { id: 'library-empty', className: 'novel-library-empty', hidden: true },
        icon(React, 'book'),
        h('h2', { id: 'library-empty-title' }, '还没有小说'),
        h('p', { id: 'library-empty-message' }, '新建一本，或导入已有作品。'),
      ),
    );
  }
  function AccountHeading() {
    return h(
      'header',
      { className: 'novel-app-heading' },
      h('h1', null, '数据与访问'),
      h(
        'button',
        { type: 'button', onClick: () => navigation.library() },
        icon(React, 'library'),
        '返回书库',
      ),
    );
  }
  function SpaceSummary() {
    return h(
      'section',
      { className: 'novel-space-summary', 'aria-label': '当前写作空间' },
      h(
        'div',
        { className: 'novel-space-heading' },
        h('h2', null, anonymous ? '访客独立空间' : '私人共享空间'),
        h('span', { className: 'novel-mode-badge' }, anonymous ? '浏览器识别' : 'PIN 登录'),
      ),
      h(
        'p',
        null,
        anonymous
          ? '你的书稿、对话和模型配置与其他访客分开保存。'
          : '登录后的电脑和手机共用书稿、对话与模型配置。',
      ),
      h(
        'dl',
        { className: 'novel-space-facts' },
        h(
          'div',
          null,
          h('dt', null, '访问凭证'),
          h('dd', null, anonymous ? '当前浏览器 Cookie' : '你设置的登录 PIN'),
        ),
        h(
          'div',
          null,
          h('dt', null, '换设备'),
          h('dd', null, anonymous ? '进入新的独立空间' : '输入 PIN，继续创作'),
        ),
      ),
    );
  }
  function Account() {
    if (anonymous)
      return h(
        'main',
        { className: 'novel-application novel-account', 'aria-label': '数据与访问' },
        h(AccountHeading),
        h(SpaceSummary),
        h(
          'section',
          { className: 'novel-account-note' },
          h('h2', null, '保留访问凭证'),
          h('p', null, '请保留当前浏览器的网站数据。清除 Cookie 后不会自动找回原空间，也无法通过 PIN 找回。'),
        ),
        h(
          'section',
          { className: 'novel-account-note' },
          h('h2', null, '作品备份'),
          h('p', null, '在书库的「管理作品」中导出备份。单本备份不含原生对话和全局模型配置。'),
          h('p', { className: 'novel-app-hint' }, '部署者仍可管理服务器数据，此空间不提供端到端加密。'),
        ),
      );
    const [configured, setConfigured] = React.useState(null),
      [message, setMessage] = React.useState('正在检查账号…'),
      [busy, setBusy] = React.useState(false);
    async function call(data) {
      const response = await fetch('/api/auth/pin', {
        method: data ? 'POST' : 'GET',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15000),
        headers: data ? { 'content-type': 'application/json' } : {},
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '账号请求失败。');
      return result;
    }
    React.useEffect(() => {
      let active = true;
      call()
        .then((state) => {
          if (!active) return;
          if (!state.authenticated) {
            location.assign('/login');
            return;
          }
          setConfigured(state.configured);
          setMessage('');
        })
        .catch((error) => {
          if (active) setMessage(error.message);
        });
      return () => (active = false);
    }, []);
    async function submit(event) {
      event.preventDefault();
      if (busy) return;
      const form = event.currentTarget,
        data = Object.fromEntries(new FormData(form));
      if (data.newPin !== data.confirmPin) {
        setMessage('两次输入的新 PIN 不一致。');
        return;
      }
      setBusy(true);
      try {
        await call(data);
        setConfigured(true);
        form.reset();
        const disclosure = form.closest('details');
        if (disclosure) disclosure.open = false;
        setMessage('PIN 已保存，书稿、对话与模型配置未改动。');
      } catch (error) {
        setMessage(error.name === 'TimeoutError' ? '请求超时；如刚保存，请尝试新 PIN。' : error.message);
      } finally {
        setBusy(false);
      }
    }
    const input = (id, name, label, required = true) =>
      h(
        React.Fragment,
        { key: id },
        h('label', { htmlFor: id }, label),
        h('input', {
          id,
          name,
          type: 'password',
          inputMode: 'numeric',
          pattern: '[0-9]{4,12}',
          minLength: 4,
          maxLength: 12,
          autoComplete: name === 'currentPin' ? 'current-password' : 'new-password',
          required,
          disabled: busy,
        }),
      );
    return h(
      'main',
      { className: 'novel-application novel-account', 'aria-label': '数据与访问' },
      h(AccountHeading),
      h(SpaceSummary),
      configured === null
        ? null
        : h(
            'details',
            { className: 'novel-access-details', open: !configured },
            h('summary', null, configured ? '修改登录 PIN' : '设置登录 PIN'),
            h(
              'form',
              { id: 'pin-form', onSubmit: submit },
              configured ? input('current-pin', 'currentPin', '当前 PIN') : null,
              input('new-pin', 'newPin', '新 PIN'),
              input('confirm-pin', 'confirmPin', '再次输入新 PIN'),
              h(
                'button',
                { id: 'save-pin', type: 'submit', disabled: busy },
                configured ? '保存新 PIN' : '设置 PIN',
              ),
              h(
                'p',
                { className: 'novel-app-hint' },
                '4–12 位数字，建议至少 6 位。修改后其他设备需重新登录。',
              ),
              h(
                'p',
                { className: 'novel-app-hint' },
                '忘记 PIN 时，可用部署数据目录中的 owner-key.txt 恢复。',
              ),
            ),
          ),
      h('p', { id: 'message', role: 'status', 'aria-live': 'polite' }, message),
      h(
        'section',
        { className: 'novel-account-note' },
        h('h2', null, '作品备份'),
        h('p', null, '单本作品可在书库导出。完整的书稿、对话和配置由部署者备份数据目录。'),
      ),
      h('form', { method: 'post', action: '/api/auth/logout' }, h('button', { type: 'submit' }, '退出登录')),
    );
  }
  for (const [key, component] of [
    ['novel-library', Library],
    ['novel-account', Account],
  ])
    ctx.effect(
      () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key }, component)),
      'novel: ' + key,
    );
  // Workspace/preset selection belongs to book creation, not a second coding
  // workspace picker inside a blank writing conversation.
  for (const name of ['conversation.hero.workspace', 'conversation.hero.agentPreset'])
    ctx.effect(
      () => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -20 }, () => null)),
      'novel: book-owned assistant context',
    );
  return navigation;
}
