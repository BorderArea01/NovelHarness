import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBackupSnapshot } from './backup-snapshot-client.mjs';
test('bounded browser backup verification compares every source/restored byte, preserving BOM/CRLF and catching a changed tail', async () => {
  const originalFetch = globalThis.fetch;
  const bookId = 'b-' + 'a'.repeat(32),
    authored = '\ufeff雨夜。\r\n🌧️';
  const files = [
    { path: 'book.json', data: Buffer.from('{}').toString('base64') },
    { path: 'chapters/新章 (二).md', data: Buffer.from(authored).toString('base64') },
    { path: 'chapters/尾章.md', data: Buffer.from('结尾').toString('base64') },
  ];
  const snapshot = JSON.stringify({ sourceId: bookId, files }),
    seen = [];
  let corrupt = false;
  globalThis.fetch = async (url) => {
    const path = new URL(url, 'http://localhost').searchParams.get('path');
    seen.push(path);
    const file = files.find((f) => path.endsWith('/' + f.path));
    return new Response(corrupt && path.endsWith('尾章.md') ? '被改动' : Buffer.from(file.data, 'base64'));
  };
  const page = { evaluate: (callback, args) => callback(args) };
  try {
    globalThis.__nativeVerificationBackupFile = new File([snapshot], 'backup.json');
    const meta = await verifyBackupSnapshot(page, { bookId, authored });
    assert.equal(meta.files, files.length);
    assert.equal(seen.length, 0);
    const result = await verifyBackupSnapshot(page, { bookId, authored, restoredRoot: '/workspace/copy' });
    assert.equal(result.allBytesCompared, true);
    assert.equal(seen.length, files.length * 2 - 1);
    assert.equal(globalThis.__nativeVerificationBackupFile, undefined);
    globalThis.__nativeVerificationBackupFile = new File([snapshot], 'backup.json');
    corrupt = true;
    await assert.rejects(
      verifyBackupSnapshot(page, { bookId, authored, restoredRoot: '/workspace/copy' }),
      /byte mismatch/,
    );
    await assert.rejects(verifyBackupSnapshot(page, { bookId: 'wrong', authored }), /identity mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__nativeVerificationBackupFile;
  }
});
