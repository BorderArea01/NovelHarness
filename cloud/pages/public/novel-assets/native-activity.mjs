// A view of the ORIGINAL session, never a second job lifecycle or proposal receipt.
export function nativeActivity(snapshot, terminal, status) {
  if (!snapshot || snapshot.removed) return null;
  if (snapshot.openError || snapshot.openState === 'error')
    return { kind: 'error', text: '对话连接中断 · 结果尚未确认', canStop: !!snapshot.running };
  const stopped =
    terminal?.type === 'turn/end' && terminal.data?.reason?.kind === 'aborted' && !snapshot.running;
  if (snapshot.promptError && !(snapshot.promptError.op === 'stop' && stopped))
    return {
      kind: 'error',
      text: snapshot.promptError.op === 'stop' ? '停止失败 · 详情见对话' : '提交失败 · 详情见对话',
      canStop: !!snapshot.running,
    };
  const waiting = { approval: '等待你确认操作', 'plan-review': '等待你审核计划', question: '等待你回答' }[
    status?.pendingInteraction?.kind
  ];
  if (waiting) return { kind: 'waiting', text: waiting, canStop: !!snapshot.running };
  if (snapshot.running) return { kind: 'running', text: 'AI 执行中 · 可继续编辑和浏览', canStop: true };
  if (snapshot.pendingSubmissions?.length || snapshot.awaitingFirstTurn)
    return { kind: 'pending', text: '请求待处理', canStop: false };
  if (snapshot.lastAgentError) return { kind: 'error', text: 'AI 执行失败 · 详情见对话', canStop: false };
  if (terminal?.type !== 'turn/end') return null;
  const reason = terminal.data?.reason?.kind;
  if (reason === 'error' || reason === 'interrupted')
    return {
      kind: 'error',
      text: reason === 'interrupted' ? 'AI 执行被中断 · 详情见对话' : 'AI 执行失败 · 详情见对话',
      canStop: false,
    };
  if (reason === 'aborted') return { kind: 'stopped', text: 'AI 已停止 · 候选可能不完整', canStop: false };
  if (reason === 'max-tokens')
    return { kind: 'ended', text: '已达本轮输出上限 · 候选可能不完整', canStop: false };
  return {
    kind: reason === 'completed' ? 'completed' : 'ended',
    text: reason === 'completed' ? 'AI 已结束' : '本轮已结束 · 结果请核对',
    canStop: false,
  };
}

export function latestNativeTurn(events) {
  const entries = events?.entries ?? [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.type === 'turn/start' || event.type === 'turn/end') return event;
  }
  return null;
}

// Catalog/status are original root-scoped projections. Merely displaying a book
// must not retain every conversation, open its history, or invent a job record.
export function bookActivities(ctx, book) {
  const list = ctx.sessions.list.getSnapshot();
  const workspace = ctx.workspaces.list.getSnapshot();
  const phase = list.phase !== 'ready' ? list.phase : workspace.phase;
  if (phase !== 'ready')
    return { phase, rows: [], notice: phase === 'pending' ? '正在连接对话…' : '对话状态暂不可用，请刷新。' };
  const archived = new Set(workspace.archivedSessionIds ?? []);
  const statuses = ctx.uiSession.sessionStatus.getSnapshot();
  const rows = Object.values(list.byId)
    .filter((row) => row.cwd === book.root && row.origin !== 'subagent' && !archived.has(row.id))
    .map((row) => {
      const status = statuses.get(row.id);
      const session = ctx.sessions.binding(row.id)?.session;
      const snapshot = session?.getSnapshot();
      const activity = nativeActivity(
        snapshot ?? { running: status?.running ?? row.running },
        session ? latestNativeTurn(session.eventSource.getSnapshot()) : null,
        status,
      );
      return {
        id: row.id,
        title: typeof row.title === 'string' && row.title.trim() ? row.title : '未命名对话',
        updatedAt: Number(row.updatedAt) || Date.parse(row.updatedAt) || 0,
        blank: row.blank,
        kind: activity?.kind ?? (status?.completionUnread ? 'ended' : 'idle'),
        text: activity?.text ?? (status?.completionUnread ? '本轮已结束 · 打开核对结果' : '最近对话'),
        canStop: activity?.canStop ?? false,
      };
    })
    .filter((row) => !row.blank || ['running', 'waiting', 'pending'].includes(row.kind));
  const priority = {
    waiting: 0,
    running: 1,
    pending: 2,
    error: 3,
    ended: 4,
    completed: 4,
    stopped: 4,
    idle: 5,
  };
  rows.sort(
    (a, b) => priority[a.kind] - priority[b.kind] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
  return { phase: 'ready', rows };
}

export function requireBookSession(ctx, book, id) {
  const list = ctx.sessions.list.getSnapshot(),
    row = list.byId[id],
    workspace = ctx.workspaces.list.getSnapshot(),
    archived = workspace.archivedSessionIds ?? [];
  if (
    list.phase !== 'ready' ||
    workspace.phase !== 'ready' ||
    !row ||
    row.cwd !== book.root ||
    row.origin === 'subagent' ||
    archived.includes(id)
  )
    throw new Error('本书对话已变化，请刷新后重试；没有打开或停止其他对话。');
  return row;
}

export async function cancelNativeSession(session) {
  const result = await session.cancel();
  if (!result?.ok) throw new Error('停止请求未成功，请打开原对话查看。');
}

export async function stopBookActivity(ctx, book, id) {
  requireBookSession(ctx, book, id);
  // Same short-lived native operation reference used by workspace operations.
  // Release even on failure; no background retention owned by this view.
  await ctx.sessions.using(
    id,
    { source: 'workspaceOperation', signal: AbortSignal.timeout(15000) },
    async (reference) => {
      requireBookSession(ctx, book, id);
      const session = reference.binding.session;
      if (!session.getSnapshot().running) throw new Error('该对话已不在运行，请查看当前结果。');
      await cancelNativeSession(session);
    },
  );
}

export function subscribeBookActivities(ctx, notify) {
  const bindings = new Map();
  let disposed = false;
  const change = () => {
    if (!disposed) notify();
  };
  function reconcile() {
    if (disposed) return;
    const wanted = new Map();
    for (const row of Object.values(ctx.sessions.list.getSnapshot().byId)) {
      if (row.origin === 'subagent' || !/^\/workspace\/novels\/b-[a-f0-9]{32}$/.test(row.cwd ?? '')) continue;
      const session = ctx.sessions.binding(row.id)?.session;
      if (session) wanted.set(row.id, session);
    }
    for (const [id, entry] of bindings)
      if (wanted.get(id) !== entry.session) {
        entry.release();
        bindings.delete(id);
      }
    for (const [id, session] of wanted)
      if (!bindings.has(id)) {
        const a = session.subscribe(change),
          b = session.eventSource.subscribe(change);
        bindings.set(id, {
          session,
          release: () => {
            a();
            b();
          },
        });
      }
    change();
  }
  const sources = [ctx.sessions.list, ctx.workspaces.list, ctx.uiSession.sessionStatus];
  const releases = sources.map((source) => source.subscribe(reconcile));
  reconcile();
  return () => {
    disposed = true;
    releases.forEach((release) => release());
    bindings.forEach((entry) => entry.release());
    bindings.clear();
  };
}

const EMPTY = Object.freeze({});
export function createNativeActivity(React) {
  const h = React.createElement;
  return function NativeActivity({ ctx, sessionId }) {
    const session = ctx.sessions.binding(sessionId)?.session;
    const stores = React.useMemo(
      () => ({
        subscribe: (notify) => session?.subscribe(notify) ?? (() => {}),
        snapshot: () => session?.getSnapshot() ?? EMPTY,
        subscribeEvents: (notify) => session?.eventSource.subscribe(notify) ?? (() => {}),
        events: () => session?.eventSource.getSnapshot() ?? EMPTY,
      }),
      [session],
    );
    const snapshot = React.useSyncExternalStore(stores.subscribe, stores.snapshot);
    const events = React.useSyncExternalStore(stores.subscribeEvents, stores.events);
    const statuses = React.useSyncExternalStore(
      ctx.uiSession.sessionStatus.subscribe,
      ctx.uiSession.sessionStatus.getSnapshot,
    );
    const terminal = React.useMemo(
      () => (snapshot.running ? null : latestNativeTurn(events)),
      [snapshot.running, events],
    );
    const activity = nativeActivity(snapshot, terminal, statuses.get(sessionId));
    const [stopping, setStopping] = React.useState(false);
    const [stopError, setStopError] = React.useState(false);
    React.useEffect(() => setStopError(false), [session, snapshot.running]);
    if (!activity) return null;
    return h(
      'div',
      { className: 'novel-native-activity', 'data-state': activity.kind, 'aria-label': '当前对话执行状态' },
      h('span', { role: 'status', 'aria-live': 'polite' }, '当前对话：' + activity.text),
      activity.canStop
        ? h(
            'button',
            {
              type: 'button',
              disabled: stopping,
              onClick: async () => {
                setStopping(true);
                setStopError(false);
                try {
                  await cancelNativeSession(session);
                } catch {
                  setStopError(true);
                } finally {
                  setStopping(false);
                }
              },
            },
            stopping ? '正在停止…' : '停止 AI',
          )
        : null,
      stopError ? h('span', { role: 'alert' }, '停止请求失败，请在对话中重试。') : null,
    );
  };
}
