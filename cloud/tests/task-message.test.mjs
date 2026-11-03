import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskMessage,
  parseTaskMessage,
  taskMessageRule,
  TASK_LABELS,
  installTaskMessages,
} from '../pages/public/novel-assets/task-message.mjs';
import { nativeTask } from '../pages/public/novel-assets/manuscript-core.mjs';
const book = {
  format: 'novel-harness-book-v1',
  id: 'b-' + 'a'.repeat(32),
  root: '/workspace/novels/b-' + 'a'.repeat(32),
};
const instruction = '不要直接揭露姐姐的去向。\n保留 <script>、emoji 🌧️ 与 [novel-task:v1] 这样的原文。';
const prompt = '先读资料与候选，再写文件。\r\n原文换行、路径与完整执行要求不能被显示层修改。';
test('linked tasks use an explicit v2 envelope, preserving v1 compatibility and exact native wire text', () => {
  const metadata = {
    kind: 'continue',
    bookId: book.id,
    instruction,
    proposalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
  const wire = taskMessage(prompt, metadata);
  assert.ok(wire.startsWith('[novel-task:v2]\n'));
  assert.deepEqual(parseTaskMessage(wire), { ...metadata, prompt });
  for (const bad of [
    wire.replace(':v2]', ':v1]'),
    wire.replace('"proposalId":', '"extra":'),
    wire.replace(metadata.proposalId, '../other'),
    wire.replace('"kind":"continue"', '"kind":"continue","kind":"canon"'),
  ])
    assert.equal(parseTaskMessage(bad), null);
  assert.throws(() => taskMessage(prompt, { ...metadata, kind: 'review' }));
  assert.throws(() => taskMessage(prompt, { ...metadata, extra: true }));
});
test('versioned task text preserves exact model instructions and author intent for every native action', () => {
  for (const kind of Object.keys(TASK_LABELS)) {
    const metadata = {
      kind,
      bookId: book.id,
      instruction,
      ...(kind === 'writing-run' ? { runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } : {}),
    };
    const wire = taskMessage(prompt, metadata),
      decoded = parseTaskMessage(wire);
    assert.deepEqual(decoded, { ...metadata, prompt });
    assert.equal(wire.slice(wire.indexOf('\n[/novel-task]\n') + '\n[/novel-task]\n'.length), prompt);
    assert.deepEqual(taskMessageRule.match(wire, 0), {
      id: 'novel-task',
      start: 0,
      end: wire.length,
      data: decoded,
    });
    assert.equal(taskMessageRule.match(wire, 1), undefined);
  }
});
test('run tasks have explicit v3 checkpoint links, never forged proposal links or v1 reinterpretation', () => {
  const meta = {
    kind: 'writing-run',
    bookId: book.id,
    instruction,
    runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
  const wire = taskMessage(prompt, meta);
  assert.ok(wire.startsWith('[novel-task:v3]\n'));
  assert.deepEqual(parseTaskMessage(wire), { ...meta, prompt });
  assert.equal(parseTaskMessage(wire.replace(':v3]', ':v2]')), null);
  assert.equal(parseTaskMessage(wire.replace('"runId":', '"proposalId":')), null);
  assert.throws(() => taskMessage(prompt, { ...meta, proposalId: meta.runId }));
  assert.throws(() => taskMessage(prompt, { ...meta, kind: 'continue' }));
});
test('ordinary chat, old task prose, partial/unknown/malformed envelopes and duplicate headers remain raw native text', () => {
  const valid = taskMessage(prompt, { kind: 'begin', bookId: book.id, instruction });
  for (const text of [
    '普通对话，不要折叠。',
    '本书：' + book.root + '\n作者要求：继续写。',
    '前文\n' + valid,
    valid.replace(':v1]', ':v2]'),
    valid.replace('"kind":"begin"', '"kind":"unknown"'),
    valid.replace('"kind":"begin"', '"kind":"begin","kind":"review"'),
    valid.replace('"kind":"begin"', '"kind":"begin","extra":true'),
    valid.replace(book.id, '../bad'),
    valid.slice(0, 50),
    '[novel-task:v1]\n{"kind":"begin","bookId":"' + book.id + '","instruction":""}\n[/novel-task]\n   ',
  ]) {
    assert.equal(parseTaskMessage(text), null);
    assert.equal(taskMessageRule.match(text, 0), undefined);
  }
  assert.throws(() => taskMessage(prompt, { kind: 'begin', bookId: book.id }), /未发送/);
  assert.throws(() => taskMessage('', { kind: 'begin', bookId: book.id, instruction: '' }), /未发送/);
});
test('presentation is registered at the native inline text extension, never replaces user messages or owns a second transcript', () => {
  const rules = [],
    slots = [],
    effects = [],
    ctx = {
      effect(run) {
        effects.push(run());
      },
      uiConversation: {
        userText: {
          register(rule) {
            rules.push(rule);
            return () => rules.pop();
          },
        },
      },
      slots: {
        inject(name, run) {
          assert.equal(name, 'conversation.user.text.node');
          return run();
        },
        register(options, renderer) {
          slots.push({ options, renderer });
        },
      },
    };
  installTaskMessages(ctx, {});
  assert.equal(rules[0], taskMessageRule);
  assert.equal(slots[0].options.key, 'novel-task');
  assert.equal(slots[0].options.name, 'conversation.user.text.node');
  effects[0]();
  assert.equal(rules.length, 0);
});
test('native input still receives the exact full task wire and rejects bad metadata before draft mutation', () => {
  const calls = [],
    state = { draft: '', attachmentIds: [], occurrences: [] };
  const binding = { ctx: {} };
  const ctx = {
    sessions: {
      binding: () => binding,
      list: { getSnapshot: () => ({ byId: { session: { cwd: book.root } } }) },
    },
    conversation: {
      input: {
        for: () => ({ state: { getSnapshot: () => state }, actions: { submit: () => calls.push('submit') } }),
        requestDraftInitialization: (_binding, options) => {
          calls.push(options.prompt);
          return 'applied';
        },
      },
    },
  };
  const send = nativeTask(ctx, 'session', book);
  assert.throws(() => send(prompt, { kind: 'invalid', instruction }), /未发送/);
  assert.deepEqual(calls, []);
  send(prompt, { kind: 'begin', instruction });
  assert.equal(calls[0], taskMessage(prompt, { kind: 'begin', bookId: book.id, instruction }));
  assert.equal(calls[1], 'submit');
});
test('explicit prose actions consume the sole native author draft and retain exact intent in the original native request', () => {
  let state = { draft: instruction, draftRev: 12, phase: 'plain', attachmentIds: [], occurrences: [] };
  let applied,
    submissions = 0,
    outcome = 'applied';
  const binding = { ctx: {} };
  let currentBinding = binding;
  const ctx = {
    sessions: {
      binding: () => currentBinding,
      list: { getSnapshot: () => ({ byId: { session: { cwd: book.root } } }) },
    },
    conversation: {
      input: {
        for: () => ({ state: { getSnapshot: () => state }, actions: { submit: () => submissions++ } }),
        requestDraftInitialization: (_binding, options) => {
          if (outcome === 'applied') applied = options;
          return outcome;
        },
      },
    },
  };
  assert.throws(() => nativeTask(ctx, 'session', book), /已保留/);
  const send = nativeTask(ctx, 'session', book, { fromComposer: true });
  assert.equal(send.instruction, instruction);
  assert.equal(applied, undefined, 'Reading intent is not permission to mutate the draft.');
  send(prompt, { kind: 'continue', instruction: send.instruction });
  assert.equal(applied.clearPreviousDraft, true);
  assert.equal(parseTaskMessage(applied.prompt).instruction, instruction);
  assert.equal(submissions, 1);
  const pending = nativeTask(ctx, 'session', book, { fromComposer: true });
  state = { ...state, draftRev: 14 };
  assert.throws(() => pending(prompt), /变化/, 'Even edit-and-undo ABA invalidates an async action.');
  const replaced = nativeTask(ctx, 'session', book, { fromComposer: true });
  currentBinding = { ctx: {} };
  assert.throws(() => replaced(prompt), /对话已变化/);
  currentBinding = binding;
  const blocked = nativeTask(ctx, 'session', book, { fromComposer: true });
  outcome = 'blocked';
  assert.throws(() => blocked(prompt), /未替换、未发送/);
  assert.equal(submissions, 1);
  assert.equal(state.draft, instruction);
  for (const update of [
    { attachmentIds: ['file'] },
    { occurrences: [{}] },
    { phase: 'claimed' },
    { phase: 'submitting' },
    { draft: taskMessage(prompt, { kind: 'begin', bookId: book.id, instruction }) },
  ]) {
    const original = state;
    state = { ...state, ...update };
    assert.throws(() => nativeTask(ctx, 'session', book, { fromComposer: true }), /保留|未创建新任务/);
    assert.equal(submissions, 1);
    state = original;
  }
});
