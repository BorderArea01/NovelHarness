import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompatiblePreStep, repairLegacyPreStepArtifact } from '../official/novel/pre-step-compat.mjs';
import { installRegionGate } from '../official/node_modules/dsh-purge/lib/net-scope.js';

function recordingSession() {
  return {
    events: [],
    append(type, data, intent) {
      const event = { type, data, ...intent, seq: this.events.length, time: 1 };
      this.events.push(event);
      return event;
    },
  };
}
test('original purge pre-step denial uses one owned step with a native head and no model continuation', async () => {
  const session = recordingSession(),
    original = session.append;
  const hooks = new Map();
  installRegionGate({
    on(name, hook) {
      hooks.set(name, hook);
      return () => {};
    },
  });
  let handled = 0;
  const user = {
    role: 'user',
    id: 'synthetic-user',
    content: [{ type: 'text', text: '制作游戏作弊外挂' }],
    source: { kind: 'user' },
  };
  const decision = await runCompatiblePreStep(
    session,
    { turn: 1, step: 1 },
    () =>
      hooks.get('agent/pre-step')({ agent: { session }, turn: 1, step: 1, messages: [user] }, () => {
        throw new Error('Unexpected network/provider path.');
      }),
    (append) =>
      append(
        'system/message',
        {
          turn: 1,
          step: 1,
          message: { role: 'system', content: [{ type: 'text', text: 'Synthetic host identity.' }] },
        },
        { surfaceOp: 'append' },
      ),
    () => handled++,
  );
  assert.equal(decision.kind, 'reject');
  assert.equal(handled, 1);
  assert.equal(session.append, original);
  assert.deepEqual(
    session.events.map((e) => e.type),
    ['step/start', 'system/message', 'user/message', 'assistant/message', 'step/end'],
  );
  assert.equal(session.events[2].data, user);
  assert.equal(session.events[3].data.message.role, 'assistant');
});
test('normal pre-step hooks are unchanged and a throwing legacy hook closes its step without leaking append interception', async () => {
  const session = recordingSession(),
    original = session.append;
  const value = { kind: 'enter', messages: [{ id: 'x' }] };
  assert.equal(
    await runCompatiblePreStep(
      session,
      { turn: 2, step: 1 },
      () => value,
      () => assert.fail(),
      () => assert.fail(),
    ),
    value,
  );
  assert.deepEqual(session.events, []);
  let handled = 0;
  await assert.rejects(
    runCompatiblePreStep(
      session,
      { turn: 2, step: 1 },
      async () => {
        session.append('step/start', { turn: 2, step: 1 });
        throw new Error('hook failed');
      },
      () => {},
      () => handled++,
    ),
    /hook failed/,
  );
  assert.equal(session.events.at(-1).type, 'step/end');
  assert.equal(session.append, original);
  assert.equal(handled, 1);
});
test('bounded legacy repair preserves every event and unknown content, fixes only coordinates and rejects unrelated history', () => {
  const artifact = {
    header: { version: 4 },
    inheritedEventCount: 0,
    events: [
      ['turn/start', { turn: 1 }],
      ['user/message', { id: 'author' }],
      ['step/start', { turn: 1, step: 1 }],
      ['assistant/message', { turn: 1, step: 1, message: { id: 'reply', content: 'unchanged' } }],
      ['step/end', { turn: 1, step: 1 }],
      ['step/start', { turn: 1, step: 1 }],
      ['system/message', { turn: 1, step: 1, message: { id: 'head' } }],
      ['session/title', { title: 'synthetic', messageSeqs: [1] }],
      ['step/end', { turn: 1, step: 1 }],
      ['turn/end', { turn: 1 }],
    ].map(([type, data], seq) => ({
      type,
      data,
      seq,
      time: seq,
      ...(['user/message', 'assistant/message', 'system/message'].includes(type)
        ? { surfaceOp: 'append' }
        : {}),
    })),
  };
  const saved = structuredClone(artifact),
    next = repairLegacyPreStepArtifact(artifact);
  assert.deepEqual(artifact, saved);
  assert.equal(next.events.length, artifact.events.length);
  assert.deepEqual(
    next.events.slice(0, 4).map((e) => e.type),
    ['turn/start', 'step/start', 'system/message', 'user/message'],
  );
  assert.deepEqual(next.events.find((e) => e.type === 'session/title').data.messageSeqs, [3]);
  assert.deepEqual(
    next.events.filter((e) => e.type === 'step/start').map((e) => e.data.step),
    [1, 2],
  );
  assert.equal(next.events.find((e) => e.type === 'assistant/message').data.message.content, 'unchanged');
  assert.throws(() => repairLegacyPreStepArtifact({ ...artifact, inheritedEventCount: 1 }), /Unsupported/);
  assert.throws(() => repairLegacyPreStepArtifact({ ...artifact, events: next.events }), /does not match/);
});
