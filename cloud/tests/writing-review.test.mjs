import test from 'node:test';
import assert from 'node:assert/strict';
import { writingBasis } from '../pages/public/novel-assets/writing-review.mjs';
import { proposalPrompt, writingEdit } from '../pages/public/novel-assets/manuscript-core.mjs';
const hash = 'a'.repeat(64);
const writing = { version: 1, mode: 'continue', instruction: '只写新增场景，保留账簿作为证据。' };
const proposal = {
  id: '12345678-1234-1234-1234-123456789abc',
  writing,
  contextOutlineHash: hash,
  baseHash: 'b'.repeat(64),
  draft: 'drafts/test.md',
  writingContext: {
    outlineHash: hash,
    outline: { chapter: 2, summary: '账簿中两张票的编号相同。', note: '不要提前揭示姐姐去向。' },
  },
};
test('writing intent never implies an append boundary; explicit selections work across all prose intents', () => {
  for (const text of ['已有短章。', '长'.repeat(600000)])
    assert.equal(writingEdit({ text }, 'continue'), null);
  assert.deepEqual(writingEdit({ text: '原文' }, 'rewrite', { text: '文', start: 1, end: 2 }), {
    start: 1,
    end: 2,
  });
  assert.equal(writingEdit({ text: '原文' }, 'rewrite'), null);
  assert.equal(writingEdit({ text: '' }, 'begin'), null);
  for (const mode of ['write', 'continue', 'begin', 'rewrite'])
    assert.deepEqual(writingEdit({ text: '原文' }, mode, { text: '文', start: 1, end: 2 }), {
      start: 1,
      end: 2,
    });
});

test('full chapter generation has explicit frozen purpose, not a relabelled opening-only prompt or reinterpretation of legacy work', () => {
  const full = { ...proposal, writing: { version: 1, mode: 'begin', purpose: 'chapter', instruction: '' } };
  const text = proposalPrompt(
    { root: '/workspace/novels/b-' + 'a'.repeat(32) },
    { path: 'chapters/2.md' },
    full,
    '',
    'begin',
  );
  assert.equal(JSON.parse(text).kind, 'prose');
  assert(!Object.hasOwn(JSON.parse(text), 'executionPrompt'));
  const old = { ...full, writing: { ...full.writing } };
  delete old.writing.purpose;
  assert.equal(
    old.writing.purpose,
    undefined,
    'Legacy intent is not reinterpreted as a new full-chapter purpose.',
  );
  assert.equal(writingBasis({ proposal: full, writingContext: full.writingContext }).label, '按纲生成本章');
});
test('writing comparison reads the original frozen author request and only a version-matched planning projection', () => {
  const review = { proposal, writingContext: proposal.writingContext };
  assert.equal(writingBasis(review).instruction, writing.instruction);
  assert.equal(writingBasis(review).outline.note, proposal.writingContext.outline.note);
  for (const changed of [
    { ...review, contextWarning: 'changed' },
    { ...review, orderWarning: 'reordered' },
    {
      ...review,
      writingContext: { outlineHash: 'c'.repeat(64), outline: { summary: '不是旧依据的新规划' } },
    },
    { proposal },
  ]) {
    assert.equal(writingBasis(changed).outline, undefined);
    assert.match(writingBasis(changed).warning, /不把当前章纲冒充/);
  }
  assert.equal(writingBasis({ proposal: {} }), null, 'Legacy proposals do not invent an author request.');
  const free = writingBasis({
    proposal: { writing, contextOutlineHash: null },
    writingContext: { outlineHash: null },
  });
  assert.equal(free.warning, undefined, 'Writing still does not require an outline.');
});
test('prose prompt uses the frozen matching plan, refuses changed intent/context and asks for action/evidence continuity without extra model calls', () => {
  const book = { root: '/workspace/novels/b-' + 'a'.repeat(32) };
  const prompt = proposalPrompt(
    book,
    { path: 'chapters/2.md', outline: { summary: '未经核对的新规划' } },
    proposal,
    writing.instruction,
    'continue',
  );
  assert.equal(JSON.parse(prompt).request, writing.instruction);
  assert(!prompt.includes('未经核对的新规划'));
  assert(!prompt.includes('证据载体'));
  assert(!Object.hasOwn(JSON.parse(prompt), 'executionPrompt'));
  assert.throws(
    () => proposalPrompt(book, { path: 'chapters/2.md' }, proposal, '换了作者要求', 'continue'),
    /冻结任务不一致/,
  );
  assert.throws(
    () =>
      proposalPrompt(
        book,
        { path: 'chapters/2.md' },
        { ...proposal, writingContext: { outlineHash: 'x' } },
        writing.instruction,
        'continue',
      ),
    /章纲版本与冻结任务不一致/,
  );
});
