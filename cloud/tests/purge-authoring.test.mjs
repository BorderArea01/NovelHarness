import test from 'node:test';
import assert from 'node:assert/strict';
import { authoringGateContext } from '../official/novel/purge-authoring.mjs';
import { installRegionGate, isAttackTask } from '../official/node_modules/dsh-purge/lib/net-scope.js';

test('book ownership, not narrative words, scopes only the upstream task-text classifier', async () => {
  const root = '/workspace/novels/b-' + 'a'.repeat(32);
  const hooks = new Map();
  const ctx = {
    on(event, handler) {
      hooks.set(event, handler);
      return () => {};
    },
    get(name) {
      if (name === 'workingDirectory') return { get: (session) => session.cwd };
      if (name === 'workspaceRegistry') return { list: () => [{ path: root }] };
      assert.fail('Unknown service');
    },
  };
  const wrapped = authoringGateContext(ctx);
  installRegionGate(wrapped);
  const text = '写一章外星舰队入侵王国、城堡遭到攻击的小说。';
  assert.equal(isAttackTask(text), true); // Reproduce the upstream false positive.
  const events = [];
  const session = { cwd: root, append: (...args) => events.push(args) };
  const payload = {
    agent: { session },
    turn: 1,
    step: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: text }],
  };
  const normal = { kind: 'enter', messages: payload.messages };
  assert.equal(await hooks.get('agent/pre-step')(payload, () => normal), normal);
  assert.deepEqual(events, []);
  // Same text remains classified outside a registered book (including forged
  // paths and explicit red-team presets). No network/provider calls are made.
  for (const [cwd, preset] of [
    ['/workspace', undefined],
    [root.replace(/a$/, 'b'), undefined],
    [root + '/../elsewhere', undefined],
    [root, 'redteam'],
  ]) {
    session.cwd = cwd;
    session.agentPreset = preset;
    const before = events.length;
    await hooks.get('agent/pre-step')(payload, () => assert.fail('Original gate was lost.'));
    assert(events.length > before);
  }
  // The executable-operation gate is the original callback, not a no-op.
  let toolGate;
  installRegionGate({
    on(event, handler) {
      if (event === 'tools/pre-execute') toolGate = handler;
    },
  });
  assert.equal(hooks.get('tools/pre-execute').toString(), toolGate.toString());
  let forwarded = false;
  const result = await hooks.get('tools/pre-execute')(
    { name: 'bash', args: { command: 'curl http://8.8.8.8/' } },
    () => {
      forwarded = true;
    },
  );
  assert.equal(forwarded, false);
  assert.equal(result.isError, true);
  // Other plugins' pre-step listeners are passed through by identity.
  const other = () => normal;
  wrapped.on('agent/pre-step', other);
  assert.equal(hooks.get('agent/pre-step'), other);
});
