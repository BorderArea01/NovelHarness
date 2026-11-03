import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, serializeRules, editRules } from '../pages/public/novel-assets/rules-core.mjs';
import {
  withoutRetiredWritingOptions,
  RETIRED_WRITING_OPTIONS,
} from '../worker/shared/retired-writing-options.mjs';
import { proposalPrompt } from '../pages/public/novel-assets/manuscript-core.mjs';
import { outlinePrompt } from '../pages/public/novel-assets/outline-core.mjs';

test('remaining template edits preserve unknown metadata/BOM, reject incompatible types and treat unsafe keys as data', () => {
  const input = {
    extension: { preserve: [1, 2] },
    savedPrompts: { write: '旧模板', unknown: { keep: true } },
  };
  const before = structuredClone(input);
  const next = editRules(input, { kind: 'prompt', key: 'write', value: '作者新模板' });
  assert.deepEqual(input, before);
  assert.deepEqual(next.extension, before.extension);
  assert.deepEqual(next.savedPrompts.unknown, before.savedPrompts.unknown);
  assert.deepEqual(parseRules(serializeRules(next, '\uFEFF{}\n')), next);
  const text = serializeRules(next, '\uFEFF{}\n');
  assert(text.startsWith('\uFEFF') && text.endsWith('\n'));
  assert.throws(() => parseRules('[]'));
  assert.throws(() => editRules(input, { kind: 'prompt', key: 'unknown', value: '不要覆盖旧对象' }));
  const unusual = editRules(input, { kind: 'prompt', key: '__proto__', value: '普通数据' });
  assert(Object.hasOwn(unusual.savedPrompts, '__proto__'));
  assert.equal(unusual.savedPrompts.__proto__, '普通数据');
  assert.equal({}.polluted, undefined);
});

test('style, POV and card operations no longer exist; retired configuration removal keeps project, templates and unknown fields', () => {
  const input = {
    project: { wordsPerChapter: 3000 },
    savedPrompts: { write: '按本次对话写' },
    assistantPrompt: '作者总规则',
    extension: { keep: true },
    creativeRules: { narrativePOV: 'first-person', styleConstraints: '已退役' },
    methodologyCards: [{ name: '已退役' }],
    referenceText: '旧参考',
    activeMethodologyCardId: 'old',
  };
  const before = structuredClone(input);
  for (const kind of [
    'text',
    'flag',
    'preset',
    'pov',
    'pov-character',
    'override',
    'card-add',
    'card',
    'card-delete',
    'reference',
  ])
    assert.throws(() => editRules(input, { kind }), /不支持/);
  const cleaned = withoutRetiredWritingOptions(input);
  for (const key of RETIRED_WRITING_OPTIONS) assert(!Object.hasOwn(cleaned, key));
  for (const key of ['project', 'savedPrompts', 'assistantPrompt', 'extension'])
    assert.deepEqual(cleaned[key], input[key]);
  assert.deepEqual(input, before);
  assert.deepEqual(withoutRetiredWritingOptions(cleaned), cleaned);
  assert.throws(() => withoutRetiredWritingOptions([]));
});

test('generated tasks no longer select style, POV, card or reference scopes; template and submission checks remain', () => {
  const book = { root: '/workspace/novels/b-' + 'a'.repeat(32) };
  const proposal = {
    id: '12345678-1234-1234-1234-123456789abc',
    draft: 'drafts/x.md',
    baseHash: '0'.repeat(64),
  };
  const prose = proposalPrompt(book, { path: 'chapters/1.md' }, proposal, '', 'continue', '', [
    { path: 'rules.json' },
  ]);
  const outline = outlinePrompt(
    book,
    { ...proposal, status: 'pending', plan: { range: { start: 1, end: 1 }, sources: [] } },
    '',
    [],
  );
  for (const text of [prose, outline]) {
    assert.doesNotMatch(
      text,
      /creativeRules|methodologyCards|chapterPOVOverrides|injectInto|enabledForOutline/,
    );
    assert.equal(JSON.parse(text).proposal_id, proposal.id);
    assert.equal(Object.hasOwn(JSON.parse(text), 'executionPrompt'), false);
  }
});
