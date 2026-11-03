import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentProposalCalls,
  observeProposalPresentation,
} from '../pages/public/novel-assets/proposal-presentation.mjs';

const root = '/workspace/novels/b-' + 'a'.repeat(32);
function store(value) {
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      value = next;
      for (const fn of [...listeners]) fn();
    },
    get count() {
      return listeners.size;
    },
  };
}
function snapshot(blocks, turn = 9) {
  const nodes = new Map(
    blocks.map((block, i) => ['node-' + i, { kind: 'tool-call', data: { root: block } }]),
  );
  return {
    timeline: { turnOrder: [1, turn] },
    nodes: {
      get: (key) => nodes.get(key),
      values: () => {
        throw new Error('Must not scan old conversation history.');
      },
    },
    locations: {
      getTurn: (requested) => {
        assert.equal(requested, turn);
        return [...nodes.keys()];
      },
    },
  };
}
const live = (id = 'native-call') => ({
  callId: id,
  name: 'novel_proposal_submit',
  phase: 'preparing',
  args: { text: () => '原生增量参数' },
});
const settled = (block) => ({ ...block, kind: 'tool-result', call: { name: block.name }, content: [] });
test('settled native outline operations notify a read-only refresh once, including on late attachment, without replaying mutations', () => {
  const block = settled({ ...live('clear-outline'), name: 'novel_outline_update' });
  const f = fixture(snapshot([block]));
  const events = [];
  const release = observeProposalPresentation(f.ctx, { sessionId: f.id, root }, (event) =>
    events.push(event),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].block, block);
  f.chat.set(snapshot([block]));
  assert.equal(events.length, 1);
  release();
});
function fixture(initial) {
  const id = 'native-session',
    owner = { sessionId: id },
    chat = store(initial);
  const catalog = store({ byId: { [id]: { cwd: root } } });
  let current = owner;
  const ctx = {
    sessions: { list: catalog, binding: (sid) => (sid === id ? current : undefined) },
    uiConversation: {
      binding: (binding) => {
        assert.equal(binding, current);
        return {
          target: (name) => {
            assert.equal(name, 'chat');
            return chat;
          },
        };
      },
    },
  };
  return {
    ctx,
    chat,
    catalog,
    owner,
    id,
    replace: () => {
      current = { sessionId: id };
      catalog.set({ ...catalog.getSnapshot() });
    },
  };
}

test('a late manuscript subscriber immediately reads the original active block without a tool row, a copied stream or a history scan', () => {
  const block = live(),
    f = fixture(snapshot([block])),
    events = [];
  const release = observeProposalPresentation(f.ctx, { sessionId: f.id, root }, (event) =>
    events.push(event),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].block, block);
  assert.equal(events[0].binding, f.owner);
  const newer = { ...block, args: { text: () => '下一段原生文字' } };
  f.chat.set(snapshot([newer]));
  assert.equal(events.at(-1).block, newer);
  f.chat.set(snapshot([settled(newer)]));
  assert.equal(events.at(-1).block.kind, 'tool-result');
  const count = events.length;
  f.chat.set(snapshot([settled(newer)]));
  assert.equal(events.length, count, 'Settled history must not cause repeated redirects.');
  release();
  assert.equal(f.chat.count + f.catalog.count, 0);
  f.chat.set(snapshot([live('after-unmount')]));
  assert.equal(events.length, count);
});

test('already settled history does not auto-open; re-subscription recovers a held native call without resending it', () => {
  const current = live(),
    f = fixture(snapshot([settled(live('old')), current]));
  const events = [];
  let release = observeProposalPresentation(f.ctx, { sessionId: f.id, root }, (e) => events.push(e));
  assert.deepEqual(
    events.map((e) => e.block.callId),
    ['native-call'],
  );
  release();
  events.length = 0;
  release = observeProposalPresentation(f.ctx, { sessionId: f.id, root }, (e) => events.push(e));
  assert.equal(events[0].block, current);
  release();
});

test('binding replacement and book changes release original projections, reset presentation, and do not attach to a foreign book', () => {
  const f = fixture(snapshot([live()])),
    events = [];
  const release = observeProposalPresentation(f.ctx, { sessionId: f.id, root }, (e) => events.push(e));
  f.replace();
  assert.equal(events[1].reset, true);
  assert.equal(events[2].block.callId, 'native-call');
  assert.equal(f.chat.count, 1);
  f.catalog.set({ byId: { [f.id]: { cwd: '/workspace/novels/b-' + 'b'.repeat(32) } } });
  assert.equal(events.at(-1).reset, true);
  assert.equal(f.chat.count, 0);
  const count = events.length;
  f.chat.set(snapshot([live('foreign')]));
  assert.equal(events.length, count);
  release();
});

test('current-turn selection preserves native nested block identity, skips unrelated tools and terminates cyclic references', () => {
  const child = live(),
    parent = { callId: 'container', name: 'parallel', subCalls: [child] };
  parent.subCalls.push(parent);
  assert.equal(
    currentProposalCalls(snapshot([parent, { callId: 'read-call', name: 'read' }]))[0].block,
    child,
  );
  assert.deepEqual(currentProposalCalls(undefined), []);
  assert.throws(() => currentProposalCalls({ timeline: { turnOrder: [1] } }), /接口不兼容/);
});
