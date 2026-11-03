import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { selectableCanonKeys } from '../pages/public/novel-assets/canon-review.mjs';
import { assessCanon, mergeCanonSelection, evidencePath } from '../worker/canon-proposals.mjs';
import { canonProposalPrompt } from '../pages/public/novel-assets/manuscript-core.mjs';
const path = 'chapters/1.md',
  hash = 'a'.repeat(64),
  text = '沈澄推开旧钟楼的门。钟声响了第三次。';
const sources = [{ path, hash }];
const read = (p) => {
  assert.equal(p, path);
  return { path, hash, text };
};
const base = () => ({
  notice: '原文保留',
  extension: { unknown: [1] },
  characters: [{ id: 'p1', name: '沈澄', trust: 'confirmed', notes: '人工设定' }],
  locations: [],
  relations: [],
});
const candidate = () => ({
  ...base(),
  locations: [
    {
      id: 'l1',
      name: '旧钟楼',
      trust: 'auto',
      notes: '第三次钟声出现的地点',
      evidenceSources: [{ path, quote: '沈澄推开旧钟楼的门。' }],
    },
  ],
  relations: [
    {
      id: 'r1',
      label: '进入',
      sourceType: 'character',
      sourceId: 'p1',
      targetType: 'location',
      targetId: 'l1',
      trust: 'auto',
      evidenceSources: [{ path, quote: '沈澄推开旧钟楼的门。' }],
    },
  ],
});
const inspect = (value = candidate(), reader = read) =>
  assessCanon(JSON.stringify(base()), JSON.stringify(value), sources, reader);
test('AI canon suggestions cite frozen real book text and selective acceptance preserves author metadata and pending trust', () => {
  const a = inspect();
  assert.equal(a.validCount, 2);
  assert.deepEqual(a.issues, []);
  const before = '\ufeff' + JSON.stringify(base()) + '\n';
  const accepted = mergeCanonSelection(before, a, ['locations:0']);
  assert.ok(accepted.startsWith('\ufeff') && accepted.endsWith('\n'));
  const value = JSON.parse(accepted.slice(1));
  assert.deepEqual(value.characters, base().characters);
  assert.deepEqual(value.extension, base().extension);
  assert.equal(value.locations[0].trust, 'auto');
  assert.equal(value.relations.length, 0);
  assert.throws(() => mergeCanonSelection(before, a, ['relations:0']), /同时勾选/);
  assert.equal(
    JSON.parse(mergeCanonSelection(JSON.stringify(base()), a, ['locations:0', 'relations:0'])).relations
      .length,
    1,
  );
});
test('fabricated, changed, unrelated, deleted, linked or non-text sources are never certified', () => {
  for (const quote of ['原文没有的句子', '', '字'.repeat(2001)]) {
    const value = candidate();
    value.locations[0].evidenceSources[0].quote = quote;
    assert.equal(inspect(value).changes.find((c) => c.collection === 'locations').valid, false);
  }
  for (const sourcePath of [
    'memory.json',
    'outline.json',
    '../secrets.txt',
    'chapters/../x.md',
    'chapters\\x.md',
    '/workspace/x',
    'notes/missing.md',
  ]) {
    const value = candidate();
    value.locations[0].evidenceSources[0].path = sourcePath;
    assert.equal(inspect(value).changes[0].valid, false);
  }
  assert.equal(inspect(candidate(), () => ({ hash: 'b'.repeat(64), text })).validCount, 0);
  assert.equal(
    inspect(candidate(), () => {
      throw new Error('symlink');
    }).validCount,
    0,
  );
});
test('AI cannot promote itself, delete old records, reorder identities or discard root/legacy fields', () => {
  const promoted = candidate();
  promoted.locations[0].confirmed = true;
  assert.equal(inspect(promoted).changes[0].valid, false);
  const deleted = candidate();
  deleted.characters = [];
  assert.ok(inspect(deleted).issues.some((s) => s.includes('删除')));
  assert.throws(() => mergeCanonSelection(JSON.stringify(base()), inspect(deleted), ['locations:0']));
  const changed = candidate();
  changed.characters[0].notes = 'AI 偷改';
  const result = inspect(changed);
  assert.equal(result.changes.find((c) => c.collection === 'characters').valid, false);
  // A bad unrelated edit does not force losing otherwise usable suggestions.
  assert.deepEqual(
    JSON.parse(mergeCanonSelection(JSON.stringify(base()), result, ['locations:0'])).characters,
    base().characters,
  );
  const unknown = candidate();
  delete unknown.extension;
  assert.ok(inspect(unknown).issues.some((s) => s.includes('extension')));
  const prior = { characters: [{ id: 'a', name: '待确认', trust: 'auto', unknown: 'keep' }] };
  const next = {
    characters: [{ id: 'a', name: '待确认', trust: 'auto', evidenceSources: [{ path, quote: text }] }],
  };
  assert.equal(assessCanon(JSON.stringify(prior), JSON.stringify(next), sources, read).validCount, 0);
});
test('relationship ambiguity and duplicate identity substitutions are refused after selective merge', () => {
  const broken = candidate();
  broken.relations[0].targetId = 'missing';
  assert.equal(inspect(broken).changes.find((c) => c.collection === 'relations').valid, false);
  const duplicate = candidate();
  duplicate.locations.push({ ...duplicate.locations[0] });
  assert.equal(
    inspect(duplicate)
      .changes.filter((c) => c.collection === 'locations')
      .every((c) => !c.valid),
    true,
  );
  const substitution = candidate();
  substitution.characters[0].id = 'renamed';
  substitution.characters.push({
    id: 'p1',
    name: '冒名',
    trust: 'auto',
    evidenceSources: [{ path, quote: text }],
  });
  const a = inspect(substitution);
  assert.throws(() => mergeCanonSelection(JSON.stringify(base()), a, ['characters:1']), /重复/);
});
test('obvious duplicate names and aliases stay out of AI canon collection', () => {
  const value = candidate();
  value.characters.push({
    id: 'duplicate',
    name: '未说明身份',
    aliases: ['沈澄'],
    trust: 'auto',
    evidenceSources: [{ path, quote: '沈澄' }],
  });
  const row = inspect(value).changes.find((change) => change.after.id === 'duplicate');
  assert.equal(row.valid, false);
  assert.ok(row.issues.some((message) => message.includes('别名重合')));
});
test('partial JSON is inspectable without publication and old unscoped proposals cannot bypass evidence checks', () => {
  assert.ok(assessCanon('{}', '{"characters":[', sources, read).issues[0].includes('尚未完整'));
  assert.ok(assessCanon('{}', '{}', undefined, read).issues[0].includes('原文范围'));
  assert.throws(() => mergeCanonSelection('{}', inspect(), []));
  assert.equal(evidencePath('notes/补充.txt'), true);
  assert.equal(evidencePath('drafts/future.md'), false);
  assert.equal(
    evidencePath('notes/story-plan.md'),
    false,
    'Dedicated future planning is not canon evidence.',
  );
});
test('canon task uses native candidate files, verifiable excerpts and author-only confirmation, not another model API', () => {
  const prompt = canonProposalPrompt(
    { root: '/workspace/novels/test' },
    { id: '12345678-1234-1234-1234-123456789abc', baseHash: hash, draft: 'drafts/test.md', sources },
  );
  const task = JSON.parse(prompt);
  assert.equal(task.kind, 'canon');
  assert.equal(task.proposal_id, '12345678-1234-1234-1234-123456789abc');
  assert.match(task.draft, /drafts\/test.md/);
  assert(!Object.hasOwn(task, 'executionPrompt'));
});

test('name/alias hints and relationship interpretations require individual review but never falsely claim semantic proof or erase a useful display name', () => {
  const value = candidate();
  value.locations[0].name = '门口';
  const review = inspect(value);
  const place = review.changes.find((row) => row.collection === 'locations');
  assert.equal(place.valid, true, 'Lexical mismatch is a disclosed hint, not a new blanket rejection rule.');
  assert.equal(place.requiresIndividualReview, true);
  assert.match(place.warnings[0], /名称或别名未出现在/);
  assert.deepEqual(selectableCanonKeys(review), []);
  assert.equal(
    JSON.parse(mergeCanonSelection(JSON.stringify(base()), review, [place.key])).locations[0].name,
    '门口',
  );
  value.locations[0].aliases = ['旧钟楼'];
  const named = inspect(value);
  assert.equal(named.changes.find((row) => row.collection === 'locations').requiresIndividualReview, false);
  assert.equal(named.changes.find((row) => row.collection === 'relations').requiresIndividualReview, true);
  assert.deepEqual(selectableCanonKeys(named), ['locations:0']);
});

test('saved real-model failure is replayed offline: a cited pronoun cannot bulk-certify an unseen name or relation, and missing relation id still fails', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/quality-regression.json', import.meta.url), 'utf8'),
  );
  const source = fixture.source.prose,
    path = 'chapters/2.md';
  const hash = createHash('sha256').update(source).digest('hex');
  const result = assessCanon(
    JSON.stringify(fixture.before),
    JSON.stringify(fixture.canon),
    [{ path, hash }],
    () => ({ path, hash, text: source }),
  );
  const sister = result.changes.find((row) => row.after.name === '沈遥');
  assert.equal(
    sister.valid,
    true,
    'Quotation validity alone is intentionally not treated as factual correctness.',
  );
  assert.equal(sister.requiresIndividualReview, true);
  assert.equal(selectableCanonKeys(result).includes(sister.key), false);
  const relation = result.changes.find((row) => row.collection === 'relations');
  assert.equal(relation.valid, false);
  assert.ok(relation.issues.some((issue) => issue.includes('唯一、非空的 id')));
  assert.equal(relation.requiresIndividualReview, true);
  assert.deepEqual(
    fixture.before.characters[0],
    fixture.canon.characters[0],
    'The real sample preserved author facts; the replay must preserve them too.',
  );
});
