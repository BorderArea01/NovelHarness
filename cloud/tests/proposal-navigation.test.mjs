import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openTaskProposal,
  proposalConversation,
  openProposalConversation,
  MANUSCRIPT_ADDRESS,
  createProposalOrigin,
} from '../pages/public/novel-assets/proposal-navigation.mjs';
const book = { id: 'b-' + 'a'.repeat(32), root: '/workspace/novels/b-' + 'a'.repeat(32) };
const proposal = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', originSessionId: 'source' };
function fixture() {
  const calls = [];
  const list = {
    phase: 'ready',
    byId: {
      source: { id: 'source', cwd: book.root, title: '原生长对话' },
      other: { id: 'other', cwd: '/workspace/other' },
    },
  };
  const workspace = { phase: 'ready', archivedSessionIds: [] };
  const ctx = {
    sessions: { list: { getSnapshot: () => list } },
    workspaces: { list: { getSnapshot: () => workspace } },
    sidebarRight: {
      mounted: { getSnapshot: () => 'source' },
      openResource: (...args) => calls.push(['resource', ...args]),
    },
    uiWorkspace: { openSession: (id) => calls.push(['session', id]) },
    layout: { selectPanel: (id) => calls.push(['panel', id]) },
  };
  return { ctx, calls, list, workspace };
}
test('native source-view subscriptions preserve class-method owners and release their listeners', () => {
  const f = fixture(),
    releases = [];
  for (const store of [f.ctx.sessions.list, f.ctx.workspaces.list]) {
    const read = store.getSnapshot;
    store.getSnapshot = function () {
      assert.equal(this, store);
      return read();
    };
    store.subscribe = function (listener) {
      assert.equal(this, store);
      this.listener = listener;
      return () => {
        delete this.listener;
      };
    };
  }
  const React = {
    createElement: (...args) => args,
    useSyncExternalStore: (subscribe, read) => {
      releases.push(subscribe(() => {}));
      return read();
    },
  };
  const View = createProposalOrigin(React, f.ctx);
  const result = View({ book, proposal, busy: false, onOpen() {} });
  assert.equal(result[1]['aria-label'], '提案发起对话');
  for (const release of releases) release();
  assert.equal(f.ctx.workspaces.list.listener, undefined);
});
test('task navigation reveals the original book resource with native parameters and never creates a session', () => {
  const f = fixture();
  openTaskProposal(f.ctx, { bookId: book.id, proposalId: proposal.id });
  assert.deepEqual(f.calls, [
    ['resource', MANUSCRIPT_ADDRESS + book.id, { params: { proposalId: proposal.id } }],
  ]);
  assert.equal(proposalConversation(f.ctx, book, proposal).title, '原生长对话');
  openProposalConversation(f.ctx, book, proposal);
  assert.deepEqual(f.calls.slice(1), [
    ['session', 'source'],
    ['panel', null],
  ]);
});
test('pasted cross-book links, removed/archived/subagent origins and unready catalogs never redirect to another story', () => {
  for (const change of [
    (f) => {
      f.list.byId.source.cwd = '/workspace/other';
    },
    (f) => {
      f.workspace.archivedSessionIds.push('source');
    },
    (f) => {
      f.list.byId.source.origin = 'subagent';
    },
    (f) => {
      f.list.phase = 'pending';
    },
    (f) => {
      delete f.list.byId.source;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => openTaskProposal(f.ctx, { bookId: book.id, proposalId: proposal.id }));
    assert.throws(() => openProposalConversation(f.ctx, book, proposal));
    assert.equal(proposalConversation(f.ctx, book, proposal).kind, 'unavailable');
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  assert.throws(() => openTaskProposal(f.ctx, { bookId: book.id, proposalId: '../target' }));
  assert.throws(() => openTaskProposal(f.ctx, { bookId: 'b-' + 'b'.repeat(32), proposalId: proposal.id }));
  assert.equal(proposalConversation(f.ctx, book, {}).kind, 'legacy');
  assert.throws(() => openProposalConversation(f.ctx, book, {}), /未猜测或新建/);
  assert.deepEqual(f.calls, []);
});
