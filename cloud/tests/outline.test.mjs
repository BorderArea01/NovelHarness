import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOutline, mergeOutline, planningRange } from '../worker/outline-plans.mjs';
import {
  parseOutline,
  editOutline,
  outlinePrompt,
  DIRECTION_PATH,
} from '../pages/public/novel-assets/outline-core.mjs';
import { proposalPrompt } from '../pages/public/novel-assets/manuscript-core.mjs';
const row = (chapter, extra = {}) => ({
  chapter,
  title: '钟楼 ' + chapter,
  summary: '沈澄决定留下证据，并承担失去值夜资格的代价。',
  plotPoints: ['取得来信', '留下独立记录'],
  ...extra,
});
const plan = (start = 1, end = 2) => ({
  range: { start, end },
  blueprintHash: null,
  hasDirection: false,
  sources: [],
});
const draft = (rows) =>
  JSON.stringify({
    storyPlan: '以独立记录挑战被垄断的记忆，姐姐的去向牵动钟楼禁令，最终兑现保留证据的承诺。',
    chapters: rows,
  });
test('outline editor preserves root shape, chapter metadata, mixed beat identities and progress while editing/reordering', () => {
  const source =
    '\ufeff' +
    JSON.stringify({
      architecture: { keep: true },
      chapters: [
        row('1', {
          note: '不揭开谜底',
          extension: [1],
          plotPoints: [{ id: 'beat-a', desc: '取得来信', done: true, unknown: 'keep' }, '留下独立记录'],
        }),
      ],
    }) +
    '\n';
  let next = editOutline(source, { kind: 'field', index: 0, field: 'summary', value: '新概要' });
  next = editOutline(next, { kind: 'move-point', index: 0, point: 0, to: 1 });
  const shape = parseOutline(next);
  assert.ok(next.startsWith('\ufeff') && next.endsWith('\n'));
  assert.deepEqual(shape.value.architecture, { keep: true });
  assert.equal(shape.rows[0].chapter, '1');
  assert.equal(shape.rows[0].note, '不揭开谜底');
  assert.deepEqual(shape.rows[0].plotPoints[1], {
    id: 'beat-a',
    desc: '取得来信',
    done: true,
    unknown: 'keep',
  });
  assert.throws(() => editOutline(source, { kind: 'field', index: 0, field: 'extension', value: 'lost' }));
  assert.equal(parseOutline(editOutline(next, { kind: 'add' })).rows[1].chapter, 2);
  assert.equal(parseOutline(source).rows[0].summary, row(1).summary);
});
test('outline imports fail visibly instead of normalizing unknown root or beat structures', () => {
  assert.throws(() => parseOutline('{"unknown":[]}'));
  assert.throws(() => parseOutline('[null]'));
  const source = JSON.stringify([row(1, { plotPoints: [{ strange: 'must survive' }] })]);
  assert.throws(() => editOutline(source, { kind: 'point', index: 0, point: 0, value: 'overwrite' }));
});
test('bounded outline batches require complete exact coverage and a first whole-story direction with actionable errors', () => {
  assert.equal(planningRange({ start: 1, end: 12 }), true);
  assert.equal(planningRange({ start: 1, end: 13 }), false);
  assert.equal(assessOutline('[]', draft([row(1), row(2)]), plan()).valid, true);
  assert.ok(assessOutline('[]', draft([row(1)]), plan()).issues.some((s) => s.includes('缺少第 2')));
  assert.ok(
    assessOutline('[]', draft([row(1), row(1), row(3)]), plan()).issues.some((s) =>
      s.includes('顺序无法对应'),
    ),
  );
  assert.ok(assessOutline('[]', '[', plan()).issues[0].includes('尚未完整'));
  assert.ok(
    assessOutline('[]', JSON.stringify([row(1)]), plan(1, 1)).issues.some((s) => s.includes('storyPlan')),
  );
  assert.equal(assessOutline('[]', JSON.stringify([row(1)]), plan(1, 1), '既定全篇方向').valid, true);
  assert.equal(assessOutline('[]', draft([row(1)]), plan(1, 1), '既定全篇方向').valid, false);
});

test('ordered chapter content receives application-owned numbers from the frozen batch, without model identifiers', () => {
  const rows = [row(70), row(71)].map(({ chapter, ...content }) => content);
  const assessed = assessOutline('[]', draft(rows), plan(7, 8));
  assert.equal(assessed.valid, true);
  assert.deepEqual(
    assessed.chapters.map((r) => r.chapter),
    [7, 8],
  );
  assert.deepEqual(
    parseOutline(mergeOutline('[]', assessed)).rows.map((r) => r.chapter),
    [7, 8],
  );
  assert.equal(assessOutline('[]', draft(rows.slice(0, 1)), plan(7, 8)).valid, false);
  assert.equal(assessOutline('[]', draft([...rows, rows[0]]), plan(7, 8)).valid, false);
  assert.equal(assessOutline('[]', draft([row(7), row(7)]), plan(7, 8)).valid, false);
});
test('AI merge owns only generated outline fields; author notes, root data, unchanged progress and out-of-range order survive', () => {
  let counter = 0;
  const source =
    '\ufeff' +
    JSON.stringify({
      worldPlan: 'kept',
      chapters: [
        row(3, { unknown: true }),
        row('1', {
          note: '原章要求',
          chapterPath: 'chapters/one.md',
          unknown: { kept: true },
          plotPoints: [
            { id: 'stable', desc: '取得来信', done: true },
            { id: 'old', desc: '旧未完成事件', done: false },
          ],
        }),
      ],
    });
  const proposed = row(1, { plotPoints: ['取得来信', '改变值夜名单'], note: 'AI 偷改' });
  const assessment = assessOutline(source, draft([proposed, row(2)]), plan());
  assert.equal(assessment.valid, true);
  const merged = parseOutline(mergeOutline(source, assessment, () => 'new-' + ++counter));
  const first = merged.rows.find((item) => Number(item.chapter) === 1);
  assert.equal(first.chapter, '1');
  assert.equal(first.note, '原章要求');
  assert.equal(first.chapterPath, 'chapters/one.md');
  assert.deepEqual(first.unknown, { kept: true });
  assert.equal(merged.value.worldPlan, 'kept');
  assert.deepEqual(first.plotPoints[0], { id: 'stable', desc: '取得来信', done: true });
  assert.equal(first.plotPoints[1].done, false);
  assert.notEqual(first.plotPoints[1].id, 'old');
  assert.ok(
    merged.rows.indexOf(merged.rows.find((r) => Number(r.chapter) === 3)) < merged.rows.indexOf(first),
    'Existing out-of-range relative order must not be sorted away.',
  );
});
test('written outlines and completed beats are protected, while untouched written metadata stays exact', () => {
  const before = JSON.stringify([row(1, { privateRule: { keep: true } })]);
  const protectedPlan = {
    ...plan(1, 1),
    sources: [{ chapter: 1, path: 'chapters/1.md', hash: 'a'.repeat(64), written: true }],
  };
  const unchanged = assessOutline(before, draft([row(1)]), protectedPlan);
  assert.equal(unchanged.valid, true);
  assert.deepEqual(parseOutline(mergeOutline(before, unchanged)).rows[0], JSON.parse(before)[0]);
  assert.equal(
    assessOutline(before, draft([row(1, { summary: '重构已经发生的剧情' })]), protectedPlan).valid,
    false,
  );
  const done = JSON.stringify([row(1, { plotPoints: [{ id: 'done', desc: '完成的选择', done: true }] })]);
  assert.equal(assessOutline(done, draft([row(1)]), plan(1, 1)).valid, false);
  assert.doesNotThrow(() => assessOutline(done, draft([row(1, { plotPoints: {} })]), plan(1, 1)));
});
test('read-only review of resolved or unknown proposals cannot produce another outline writing task', () => {
  for (const status of ['accepted', 'rejected', undefined, 'unknown'])
    assert.throws(() => outlinePrompt({}, { status }, '', []), /未发送补全任务/);
});
test('native outline tasks retain one whole-story direction and writing uses the specifically linked chapter', () => {
  const book = { root: '/workspace/novels/book' },
    p = {
      id: '12345678-1234-1234-1234-123456789abc',
      status: 'pending',
      baseHash: 'hash',
      draft: 'drafts/p.md',
      plan: plan(),
    };
  const prompt = outlinePrompt(book, p, '', [{ path: 'seed.md' }]);
  assert.equal(JSON.parse(prompt).kind, 'outline');
  assert.equal(JSON.parse(prompt).proposal_id, p.id);
  assert.match(JSON.parse(prompt).draft, /drafts\/p.md/);
  const writing = JSON.parse(
    proposalPrompt(
      book,
      { path: 'chapters/8.md', outline: row(8) },
      { id: p.id, baseHash: 'h', draft: p.draft },
      '',
      'begin',
    ),
  );
  assert.equal(writing.target, book.root + '/chapters/8.md');
  assert(!Object.hasOwn(writing, 'executionPrompt'));
});
