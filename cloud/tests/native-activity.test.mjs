import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeActivity,
  latestNativeTurn,
  bookActivities,
  requireBookSession,
  cancelNativeSession,
  stopBookActivity,
  subscribeBookActivities,
} from '../pages/public/novel-assets/native-activity.mjs';
import { proposalPrompt, canonProposalPrompt } from '../pages/public/novel-assets/manuscript-core.mjs';
import { outlinePrompt } from '../pages/public/novel-assets/outline-core.mjs';
const terminal = (kind) => ({ type: 'turn/end', data: { reason: { kind } } });
test('native activity derives execution only from original session, not file presence or optimistic submission', () => {
  assert.equal(nativeActivity({}, null), null);
  assert.equal(nativeActivity({ removed: true }, terminal('completed')), null);
  assert.equal(nativeActivity({ running: true }, terminal('completed')).kind, 'running');
  assert.equal(nativeActivity({ awaitingFirstTurn: true }, terminal('completed')).kind, 'pending');
  assert.equal(nativeActivity({ pendingSubmissions: [{}] }, terminal('completed')).kind, 'pending');
  assert.equal(nativeActivity({}, { type: 'turn/start' }), null);
  assert.equal(nativeActivity({}, terminal('completed')).kind, 'completed');
  assert.equal(nativeActivity({}, terminal('canceled')).kind, 'ended');
  assert.equal(nativeActivity({}, terminal('unknown-future-reason')).kind, 'ended');
  assert.equal(nativeActivity({}, terminal('error')).kind, 'error');
  assert.equal(nativeActivity({}, terminal('interrupted')).kind, 'error');
  assert.equal(nativeActivity({}, terminal('aborted')).kind, 'stopped');
  assert.match(nativeActivity({}, terminal('max-tokens')).text, /输出上限/);
});
test('native activity does not turn disconnection, submit/stop errors or model failures into success', () => {
  for (const snapshot of [
    { openState: 'error' },
    { openError: {} },
    { lastAgentError: 'synthetic' },
    { promptError: { op: 'send' } },
  ])
    assert.equal(nativeActivity(snapshot, terminal('completed')).kind, 'error');
  const stopping = nativeActivity({ running: true, promptError: { op: 'stop' } }, null);
  assert.equal(stopping.kind, 'error');
  assert.equal(stopping.canStop, true);
  assert.match(stopping.text, /停止失败/);
  assert.equal(nativeActivity({ promptError: { op: 'stop' } }, terminal('aborted')).kind, 'stopped');
  assert.equal(nativeActivity({ promptError: { op: 'send' } }, terminal('aborted')).kind, 'error');
});
test('all native candidate tasks use the same scoped inspect/CAS-submit protocol', () => {
  const book = { root: '/workspace/novels/b-' + 'a'.repeat(32) };
  const proposal = {
    id: '12345678-1234-1234-1234-123456789abc',
    draft: 'drafts/candidate.md',
    baseHash: '0'.repeat(64),
    sources: [],
    plan: { range: { start: 1, end: 1 }, sources: [], hasDirection: false },
  };
  for (const prompt of [
    proposalPrompt(book, { path: 'chapters/1.md' }, proposal, '', 'begin'),
    canonProposalPrompt(book, proposal),
    outlinePrompt(book, { ...proposal, status: 'pending' }, '', []),
  ])
    assert.equal(JSON.parse(prompt).proposal_id, proposal.id);
});

function source(value) {
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      value = next;
      [...listeners].forEach((fn) => fn());
    },
    get count() {
      return listeners.size;
    },
  };
}
function activitiesFixture() {
  const book = { id: 'b-' + 'a'.repeat(32), root: '/workspace/novels/b-' + 'a'.repeat(32) };
  const rows = {
    old: { id: 'old', cwd: book.root, title: '旧对话', updatedAt: 1, blank: false },
    running: {
      id: 'running',
      cwd: book.root,
      running: true,
      title: '生成中的对话',
      updatedAt: 2,
      blank: false,
    },
    foreign: { id: 'foreign', cwd: book.root + '/other', running: true },
    child: { id: 'child', cwd: book.root, origin: 'subagent', running: true },
    archived: { id: 'archived', cwd: book.root, running: true },
    blank: { id: 'blank', cwd: book.root, blank: true },
  };
  const list = source({ phase: 'ready', byId: rows }),
    workspaces = source({ phase: 'ready', archivedSessionIds: ['archived'] });
  const statuses = source(new Map()),
    snapshot = source({ running: true });
  const events = source({ entries: [{ event: { type: 'turn/start' } }] });
  const bindings = new Map([
    ['running', { session: { ...snapshot, eventSource: events, cancel: async () => ({ ok: true }) } }],
  ]);
  let usingCalls = 0,
    releases = 0;
  const ctx = {
    workspaces: { list: workspaces },
    uiSession: { sessionStatus: statuses },
    sessions: {
      list,
      binding: (id) => bindings.get(id),
      async using(id, options, operation) {
        usingCalls++;
        assert.equal(options.source, 'workspaceOperation');
        try {
          return await operation({ binding: bindings.get(id) });
        } finally {
          releases++;
        }
      },
      retain() {
        throw new Error('Listing must never retain histories.');
      },
    },
  };
  return {
    book,
    rows,
    list,
    workspaces,
    statuses,
    snapshot,
    events,
    bindings,
    ctx,
    get usingCalls() {
      return usingCalls;
    },
    get releases() {
      return releases;
    },
  };
}
test('book activity reads native catalogs, exact workspace and original statuses without opening histories', () => {
  const f = activitiesFixture();
  assert.deepEqual(
    bookActivities(f.ctx, f.book).rows.map((row) => row.id),
    ['running', 'old'],
  );
  f.statuses.set(new Map([['old', { pendingInteraction: { kind: 'question' } }]]));
  const rows = bookActivities(f.ctx, f.book).rows;
  assert.equal(rows[0].id, 'old');
  assert.equal(rows[0].kind, 'waiting');
  assert.match(rows[0].text, /回答/);
  assert.equal(rows[0].canStop, false);
  assert.equal(f.usingCalls, 0);
  f.list.set({ ...f.list.getSnapshot(), phase: 'failed' });
  assert.match(bookActivities(f.ctx, f.book).notice, /暂不可用/);
  f.list.set({ ...f.list.getSnapshot(), phase: 'ready' });
  f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'pending' });
  assert.equal(bookActivities(f.ctx, f.book).phase, 'pending');
});
test('book activity uses actual terminal failure and stop, never infers success from unread completion or a file', () => {
  const f = activitiesFixture();
  for (const [reason, expected] of [
    ['error', 'error'],
    ['aborted', 'stopped'],
    ['completed', 'completed'],
  ]) {
    f.snapshot.set({ running: false });
    f.events.set({ entries: [{ event: terminal(reason) }] });
    assert.equal(bookActivities(f.ctx, f.book).rows.find((row) => row.id === 'running').kind, expected);
  }
  f.statuses.set(new Map([['old', { completionUnread: true }]]));
  assert.equal(bookActivities(f.ctx, f.book).rows.find((row) => row.id === 'old').kind, 'ended');
  f.events.set({ entries: [{ event: terminal('completed') }, { event: { type: 'turn/start' } }] });
  assert.equal(latestNativeTurn(f.events.getSnapshot()).type, 'turn/start');
  assert.equal(bookActivities(f.ctx, f.book).rows.find((row) => row.id === 'running').kind, 'idle');
});
test('stop uses the original native operation with release and refuses wrong-book, archived, child and no-longer-running sessions', async () => {
  const f = activitiesFixture();
  for (const id of ['foreign', 'child', 'archived', 'missing']) {
    assert.throws(() => requireBookSession(f.ctx, f.book, id), /对话已变化/);
    await assert.rejects(stopBookActivity(f.ctx, f.book, id), /对话已变化/);
  }
  assert.equal(f.usingCalls, 0);
  await stopBookActivity(f.ctx, f.book, 'running');
  assert.equal(f.releases, 1);
  f.snapshot.set({ running: false });
  await assert.rejects(stopBookActivity(f.ctx, f.book, 'running'), /已不在运行/);
  assert.equal(f.releases, 2);
  await assert.rejects(cancelNativeSession({ cancel: async () => ({ ok: false, error: {} }) }), /未成功/);
  await assert.rejects(
    cancelNativeSession({
      cancel: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
});
test('native status subscriptions borrow existing bindings and release every listener across replacement/unmount', () => {
  const f = activitiesFixture();
  let notifications = 0;
  const dispose = subscribeBookActivities(f.ctx, () => notifications++);
  assert.equal(f.snapshot.count, 1);
  assert.equal(f.events.count, 1);
  f.events.set({ entries: [] });
  assert.ok(notifications >= 2);
  f.bindings.clear();
  f.list.set({ ...f.list.getSnapshot() });
  assert.equal(f.snapshot.count, 0);
  assert.equal(f.events.count, 0);
  dispose();
  assert.equal(f.list.count + f.workspaces.count + f.statuses.count, 0);
  const before = notifications;
  f.statuses.set(new Map());
  assert.equal(notifications, before);
  assert.equal(f.usingCalls, 0);
});
