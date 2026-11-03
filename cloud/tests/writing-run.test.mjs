import test from 'node:test';
import assert from 'node:assert/strict';
import {
  writingRunPrompt,
  validRunId,
  runItemStatus,
} from '../pages/public/novel-assets/writing-run-core.mjs';
import { openTaskRun } from '../pages/public/novel-assets/proposal-navigation.mjs';
test('continuous writing sends native tool references, immutable scope and resume guidance, never a second provider loop', () => {
  const book = { id: 'b-' + 'a'.repeat(32), root: '/workspace/novels/b-' + 'a'.repeat(32) };
  const run = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    range: { start: 2, end: 4 },
    publication: 'review',
    phase: 'open',
    completed: false,
  };
  const prompt = writingRunPrompt(book, run);
  assert.ok(validRunId(run.id));
  assert.ok(!validRunId('../other'));
  assert.equal(JSON.parse(prompt).run_id, run.id);
  assert.deepEqual(JSON.parse(prompt).range, run.range);
  assert.equal(
    JSON.parse(writingRunPrompt(book, { ...run, publication: 'new-chapters' })).kind,
    'writing-run',
  );
  for (const change of [
    { phase: 'closed' },
    { phase: 'blocked' },
    { completed: true },
    { id: '../other' },
    { publication: 'overwrite' },
  ])
    assert.throws(() => writingRunPrompt(book, { ...run, ...change }));
  assert.match(runItemStatus({ skipped: true }), /跳过/);
  assert.match(runItemStatus({ partial: true }), /部分草稿/);
  assert.match(runItemStatus({ generated: true }), /尚未保存/);
  assert.match(runItemStatus({ published: true }), /已保存/);
});
test('run task card navigates the same native book resource with explicit parameters and refuses cross-book context', () => {
  const bookId = 'b-' + 'a'.repeat(32),
    runId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    calls = [];
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ phase: 'ready', byId: { s: { id: 's', cwd: '/workspace/novels/' + bookId } } }),
      },
    },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready' }) } },
    sidebarRight: { mounted: { getSnapshot: () => 's' }, openResource: (...args) => calls.push(args) },
  };
  openTaskRun(ctx, { bookId, runId });
  assert.deepEqual(calls, [['dsh-resource://novel/' + bookId, { params: { runId } }]]);
  assert.throws(() => openTaskRun(ctx, { bookId: 'b-' + 'b'.repeat(32), runId }));
  assert.throws(() => openTaskRun(ctx, { bookId, runId: '../other' }));
  assert.equal(calls.length, 1);
});
