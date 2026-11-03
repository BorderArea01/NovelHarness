import test from 'node:test';
import assert from 'node:assert/strict';
import { resetBookConversation } from '../pages/public/novel-assets/conversation-reset.mjs';
const cwd = '/workspace/novels/b-' + 'a'.repeat(32);
function fixture() {
  const session = { id: 'old', cwd },
    calls = [],
    nav = new AbortController();
  const ctx = {
    layout: { beginNavigation: () => nav.signal },
    sessions: {
      list: { getSnapshot: () => ({ byId: { old: session } }) },
      create: async (request) => {
        calls.push(['create', request]);
        return 'fresh';
      },
    },
    workspaces: {
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'book', path: cwd }] }) },
      archiveSession: async (...args) => calls.push(['archive', ...args]),
    },
    uiWorkspace: { openSession: (id) => calls.push(['open', id]) },
  };
  return { ctx, session, calls, nav };
}
test('clearing chat creates a fresh native session without fork, summary, old prompt or copied draft; book workspace stays identical', async () => {
  const f = fixture();
  assert.deepEqual(await resetBookConversation(f.ctx, f.session), {
    sessionId: 'fresh',
    archivedSessionId: 'old',
  });
  assert.deepEqual(f.calls, [
    ['create', { workspaceId: 'book' }],
    ['archive', 'old', { stopActivity: false }],
    ['open', 'fresh'],
  ]);
});
test('reset failure does not remove old history or replace the selected conversation; active-work stop is explicit', async () => {
  const f = fixture();
  f.ctx.sessions.create = async () => {
    throw new Error('offline');
  };
  await assert.rejects(resetBookConversation(f.ctx, f.session), /offline/);
  assert.deepEqual(f.calls, []);
  const g = fixture();
  g.ctx.workspaces.archiveSession = async () => {
    throw new Error('session active');
  };
  await assert.rejects(resetBookConversation(g.ctx, g.session), /session active/);
  assert.equal(g.calls.length, 1);
  const h = fixture();
  await resetBookConversation(h.ctx, h.session, { stopActivity: true });
  assert.deepEqual(h.calls[1], ['archive', 'old', { stopActivity: true }]);
});
test('a later navigation or wrong book cannot be stolen by delayed reset', async () => {
  const f = fixture();
  f.ctx.sessions.create = async () => {
    f.nav.abort();
    return 'fresh';
  };
  await assert.rejects(resetBookConversation(f.ctx, f.session), { name: 'AbortError' });
  assert.deepEqual(f.calls, [['archive', 'fresh', { stopActivity: false }]]);
  const g = fixture();
  await assert.rejects(resetBookConversation(g.ctx, { ...g.session, cwd: '/workspace' }), /打开一本小说/);
  assert.deepEqual(g.calls, []);
});
test('native archive reconciliation does not strand a fresh session; an actual later author navigation still wins', async () => {
  const f = fixture();
  f.ctx.workspaces.archiveSession = async () => {
    f.nav.abort();
  };
  await resetBookConversation(f.ctx, f.session);
  assert.deepEqual(f.calls.at(-1), ['open', 'fresh']);
  const g = fixture();
  let current = true;
  g.ctx.workspaces.archiveSession = async () => {
    current = false;
  };
  await assert.rejects(resetBookConversation(g.ctx, g.session, { isCurrent: () => current }), {
    name: 'AbortError',
  });
  assert.equal(
    g.calls.some((call) => call[0] === 'open'),
    false,
  );
});
