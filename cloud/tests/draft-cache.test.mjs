import test from 'node:test';
import assert from 'node:assert/strict';
import { settledRecord } from '../pages/public/novel-assets/draft-cache.mjs';
test('settling a saved version rebases only newer local input from the same page and baseline', () => {
  const previousHash = 'a'.repeat(64),
    hash = 'b'.repeat(64),
    owner = 'page-a';
  const pending = {
    key: 'doc',
    owner,
    hash: previousHash,
    baseText: '旧基线',
    text: '保存期间输入的新稿',
    unknown: true,
  };
  const saved = { previousHash, hash, text: '刚保存的旧稿' };
  assert.deepEqual(settledRecord(pending, saved, owner), { ...pending, hash, baseText: saved.text });
  assert.equal(pending.hash, previousHash);
  assert.equal(settledRecord({ ...pending, text: saved.text }, saved, owner), null);
  assert.equal(settledRecord(pending, saved, 'another-page'), pending);
  assert.equal(settledRecord({ ...pending, hash }, saved, owner).baseText, pending.baseText);
  assert.equal(settledRecord(undefined, saved, owner), undefined);
});
