// Only the exact synthetic identity created by the LAN acceptance test.
// Use the running owner, never a second SQLite connection or a broad sweep.
import assert from 'node:assert/strict';

export async function cleanupLanBook(fetcher, book) {
  assert(/^b-[a-f0-9]{32}$/.test(book?.id ?? ''));
  assert(/^局域网验收测试小说 \d{13}$/.test(book.title));
  const api = '/api/novels/' + book.id + '/lifecycle';
  async function post(path, body) {
    const response = await fetcher(path, { method: 'POST', body: JSON.stringify(body) });
    const value = await response.json();
    assert(response.ok, `Synthetic cleanup HTTP ${response.status}`);
    return value;
  }
  const preview = await post(api, { action: 'inspect' });
  assert.equal(preview.book.id, book.id);
  assert.equal(preview.book.title, book.title);
  assert.equal(preview.book.root, '/workspace/novels/' + book.id);
  assert.equal(preview.generating, false, 'Do not interrupt a running task.');
  const moved = await post(api, { action: 'delete', expectedRevision: preview.revision });
  assert.equal(moved.deleted, true);
  // The validated ID cannot contain shell syntax or escape this single VFS
  // directory. Only test data already removed atomically from the live catalog.
  const path = '/workspace/.novel-trash/books/' + book.id;
  const removed = await post('/api/workspace/exec', {
    command: 'rm -r -- ' + path,
    cwd: '/workspace',
  });
  assert.equal(removed.exitCode, 0, 'Synthetic trash removal failed.');
  assert.equal(removed.timedOut, false);
  const absent = await fetcher('/api/workspace/file?' + new URLSearchParams({ path: path + '/book.json' }));
  await absent.arrayBuffer();
  assert.equal(absent.status, 404, 'Synthetic book still exists in trash.');
  return { removed: true, id: book.id };
}
