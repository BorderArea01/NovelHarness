import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChapterOrder, reorderChapterFiles } from '../worker/chapter-order.mjs';
import {
  moveChapter,
  orderReviewOf,
  acknowledgeOrderReview,
} from '../pages/public/novel-assets/chapter-order-core.mjs';
test('order movements use immutable stable keys, not titles, and reject out-of-range positions', () => {
  const keys = ['a', 'b', 'c'];
  assert.deepEqual(moveChapter(keys, 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveChapter(keys, 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(keys, ['a', 'b', 'c']);
  assert.throws(() => moveChapter(keys, 'missing', 0));
  assert.throws(() => moveChapter(keys, 'a', 3));
});
test('acknowledging order review is an explicit unsaved JSON edit preserving BOM, unknown fields and source immutability', () => {
  const data = {
    chapterOrderReview: { format: 'novel-chapter-order-review-v1', required: true, version: 'old' },
    unknown: { chapter: 1 },
    memory: { content: '第1章原文不改' },
  };
  const text = '\ufeff' + JSON.stringify(data) + '\n';
  const next = acknowledgeOrderReview(text);
  assert.equal(orderReviewOf(next), null);
  assert.equal(orderReviewOf(text).required, true);
  assert.ok(next.startsWith('\ufeff') && next.endsWith('\n'));
  assert.deepEqual(JSON.parse(next.slice(1)), {
    ...data,
    chapterOrderReview: { ...data.chapterOrderReview, required: false },
  });
  assert.throws(() => acknowledgeOrderReview('{}'));
});
test('reordering refuses ambiguous provenance and never maps unknown fields or overwrites an owned-marker collision', () => {
  const files = [
    { category: 'chapter', path: 'chapters/a.md', title: '甲' },
    { category: 'chapter', path: 'chapters/b.md', title: '乙' },
  ];
  assert.throws(
    () =>
      prepareChapterOrder([], [], files, [
        { chapter: 1, paths: [files[0].path] },
        { chapter: 2, paths: [files[0].path] },
      ]),
    /多个章号/,
  );
  const prepared = prepareChapterOrder(
    [
      { chapter: 1, title: '甲' },
      { chapter: 2, title: '乙' },
    ],
    [{ paths: [files[0].path] }, { paths: [files[1].path] }],
    files,
    [],
  );
  const docs = { 'rules.json': { text: JSON.stringify({ chapterOrderReview: '作者自定义字段，不能覆盖' }) } };
  assert.throws(
    () => reorderChapterFiles(prepared, ['chapters/b.md', 'chapters/a.md'], docs, 'v'),
    /已有不同格式/,
  );
});
