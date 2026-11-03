import test from 'node:test';
import assert from 'node:assert/strict';
import { historyFrameMatches, mergeHistoryPage } from '../pages/public/novel-assets/document-history.mjs';
test('history load is tied to the exact compared path, original version and local text', () => {
  const doc = { path: 'chapters/one.md', hash: 'a'.repeat(64) };
  const text = '\ufeff原稿\r\n未保存的修改\r\n';
  const frame = { ...doc, text };
  assert.equal(historyFrameMatches(doc, text, frame), true);
  assert.equal(historyFrameMatches({ ...doc, path: 'chapters/two.md' }, text, frame), false);
  assert.equal(historyFrameMatches({ ...doc, hash: 'b'.repeat(64) }, text, frame), false);
  assert.equal(historyFrameMatches(doc, text + '新输入', frame), false);
  assert.equal(historyFrameMatches(doc, text.replaceAll('\r\n', '\n'), frame), false);
  assert.equal(historyFrameMatches(null, text, frame), false);
  assert.equal(historyFrameMatches(doc, text, null), false);
});

test('history metadata pages append without losing the active preview; bad or non-advancing pages do not mutate the prior state', () => {
  const row = (n) => ({ hash: String(n).padStart(64, '0'), updatedAt: n });
  const first = mergeHistoryPage(
    { version: { text: '当前比较内容' }, owner: {} },
    { versions: [row(3), row(2)], hasMore: true, nextCursor: 'cursor-2' },
  );
  const next = mergeHistoryPage(first, { versions: [row(1)], hasMore: false, nextCursor: null }, 'cursor-2');
  assert.deepEqual(next.versions, [row(3), row(2), row(1)]);
  assert.equal(next.version, first.version);
  assert.equal(next.owner, first.owner);
  assert.equal(first.versions.length, 2);
  for (const bad of [
    { versions: [row(2)], hasMore: false },
    { versions: [], hasMore: true, nextCursor: 'next' },
    { versions: [row(1)], hasMore: true, nextCursor: 'cursor-2' },
    { versions: [row(1)], hasMore: false, nextCursor: 'next' },
  ])
    assert.throws(() => mergeHistoryPage(first, bad, 'cursor-2'));
  assert.throws(() => mergeHistoryPage(first, { versions: [row(1)], hasMore: false }, 'stale-cursor'));
  assert.equal(first.versions.length, 2);
  assert.equal(mergeHistoryPage({}, { versions: [], hasMore: false }).nextCursor, null);
  const legacy = mergeHistoryPage({}, { versions: [row(1)], hasMore: true });
  assert.equal(
    legacy.paginationUnavailable,
    true,
    'Older servers must not silently claim that the first page is complete.',
  );
});
