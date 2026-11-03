import { FORMAT, writingPrompt } from './bundle.mjs';
export function bookPresentation(book, workspaces) {
  const workspace = workspaces.items.find((item) => item.path === book.root);
  return {
    ...book,
    title: typeof workspace?.title === 'string' && workspace.title.trim() ? workspace.title : book.title,
  };
}

export function bookAddress(url) {
  const id = new URL(url).searchParams.get('novel');
  if (id === null) return null;
  if (!/^b-[a-f0-9]{32}$/.test(id)) throw new Error('小说地址无效，请从小说库重新打开。');
  return { id, root: `/workspace/novels/${id}` };
}

function waitForReady(source, signal) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const check = () => {
      if (settled) return;
      if (signal?.aborted) {
        abort();
        return;
      }
      const value = source.getSnapshot();
      const phase = value.phase ?? value.status;
      if (phase === 'ready') finish();
      else if (phase === 'failed' || phase === 'error') finish(new Error('DSH 工作区暂不可用，请稍后重试。'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = source.subscribe(check);
    if (settled) unsubscribe();
    check();
  });
}

export function waitForNativeCatalogs(ctx, { signal } = {}) {
  return Promise.all([waitForReady(ctx.workspaces.list, signal), waitForReady(ctx.sessions.list, signal)]);
}

export async function ensureDarkDefault(ctx, { signal } = {}) {
  const scope = ctx.configForms.get('ui-theme');
  await waitForReady(scope, signal);
  signal?.throwIfAborted();
  const current = scope.getSnapshot();
  // Native ConfigForm exposes durable user overrides separately from defaults.
  // Respect an explicit light/system/dark choice; only initialize missing data.
  if (
    !current.writable ||
    Object.hasOwn(current.user ?? {}, 'preference') ||
    current.value?.preference !== 'system'
  )
    return false;
  if (!(await scope.set('preference', 'dark')))
    throw new Error('默认暗色主题未能保存，请在 DSH 设置中检查。');
  return true;
}

export async function openNovel(
  ctx,
  { url, signal, navigationSignal, fetcher = fetch, prepareDraft = true, receipt },
) {
  const address = bookAddress(url);
  if (!address) return { kind: 'none' };
  // Upstream restoration claims a navigation when controllers become ready.
  // Claim ours after that policy, not while the plugin module is still loading.
  await waitForNativeCatalogs(ctx, { signal });
  const navigation = navigationSignal ?? ctx.layout?.beginNavigation();
  const preparing = navigation ? AbortSignal.any([navigation, ...(signal ? [signal] : [])]) : signal;
  preparing?.throwIfAborted();
  let book = receipt;
  if (!book) {
    const response = await fetcher(
      `/api/workspace/file?path=${encodeURIComponent(address.root + '/book.json')}`,
      {
        signal: preparing,
        credentials: 'same-origin',
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 401 ? '登录已过期，请重新登录后从小说库打开。' : '小说尚未完整导入，未创建对话。',
      );
    book = await response.json();
  }
  if (book.format !== FORMAT || book.id !== address.id || book.root !== address.root)
    throw new Error('小说收据与地址不一致，未创建对话。');
  preparing?.throwIfAborted();
  const before = ctx.workspaces.list.getSnapshot();
  const existed = before.items.find((workspace) => workspace.path === address.root);
  const workspace = existed ?? (await ctx.workspaces.create({ path: address.root }));
  if (workspace.path !== address.root || typeof workspace.workspaceId !== 'string')
    throw new Error('DSH 返回了不匹配的工作区，未打开对话。');
  preparing?.throwIfAborted();
  if (!existed) await ctx.workspaces.rename(workspace.workspaceId, book.title);
  preparing?.throwIfAborted();
  const workspaceState = ctx.workspaces.list.getSnapshot();
  const current =
    workspaceState.items.find((item) => item.workspaceId === workspace.workspaceId) ?? workspace;
  const archived = new Set(workspaceState.archivedSessionIds ?? []);
  const sessions = ctx.sessions.list.getSnapshot();
  const candidates = (current.sessionIds ?? [])
    .filter((id) => !archived.has(id))
    .map((id) => sessions.byId[id])
    .filter((item) => item && item.cwd === address.root)
    .sort(
      (a, b) =>
        (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) -
        (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0),
    );
  if (candidates.length) {
    const sessionId = candidates[0].id ?? candidates[0].sessionId;
    if (typeof sessionId !== 'string') throw new Error('DSH 对话标识无效，未打开其他对话。');
    ctx.uiWorkspace.openSession(sessionId);
    if (candidates[0].blank && prepareDraft) {
      const binding = ctx.sessions.binding(sessionId);
      if (binding)
        ctx.conversation.input.requestDraftInitialization(binding, {
          prompt: writingPrompt(book),
          clearPreviousDraft: false,
        });
    }
    return { kind: 'resumed', sessionId, workspaceId: workspace.workspaceId };
  }
  // Use the upstream draft-initialization contract. Never synthesize a DOM click,
  // replace an existing draft, submit a paid prompt, or create a second chat engine.
  let openedSessionId;
  await ctx.uiWorkspace.openWorkspace(
    workspace.workspaceId,
    (sessionId) => {
      signal?.throwIfAborted();
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw new Error('DSH 对话尚未就绪，未写入提示词。');
      if (prepareDraft) {
        const result = ctx.conversation.input.requestDraftInitialization(binding, {
          prompt: writingPrompt(book),
          clearPreviousDraft: false,
        });
        if (result === 'blocked')
          throw new Error('该对话已有未发送草稿，已保留。请使用新对话或处理现有草稿。');
      }
      openedSessionId = sessionId;
    },
    {},
  );
  signal?.throwIfAborted();
  if (!openedSessionId) return { kind: 'cancelled' };
  return { kind: 'draft', sessionId: openedSessionId, workspaceId: workspace.workspaceId };
}
