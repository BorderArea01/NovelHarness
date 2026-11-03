import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupLanBook } from './cleanup-lan-book.mjs';

const book = { id: 'b-' + 'a'.repeat(32), title: '局域网验收测试小说 1793677504733' };
test('LAN cleanup refuses ordinary books, changed identities and running tasks before mutation', async () => {
  for (const item of [
    { input: { ...book, title: '作者的小说' } },
    { input: book, reply: { book: { ...book, title: '作者改过的书名' }, generating: false } },
    { input: book, reply: { book: { ...book, root: '/workspace/novels/' + book.id }, generating: true } },
  ]) {
    const calls = [];
    await assert.rejects(
      cleanupLanBook(async (path, init) => {
        calls.push(JSON.parse(init.body).action);
        return Response.json(item.reply);
      }, item.input),
    );
    assert(calls.every((action) => action === 'inspect'));
  }
});
test('LAN cleanup removes only the exact synthetic tree through the running host', async () => {
  const calls = [];
  const fetcher = async (path, init) => {
    const body = init ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (body?.action === 'inspect')
      return Response.json({
        book: { ...book, root: '/workspace/novels/' + book.id },
        generating: false,
        revision: 'v1',
      });
    if (body?.action === 'delete') return Response.json({ deleted: true });
    if (body?.command) return Response.json({ exitCode: 0, timedOut: false });
    return new Response(null, { status: 404 });
  };
  assert.equal((await cleanupLanBook(fetcher, book)).removed, true);
  assert.deepEqual(calls[1].body, { action: 'delete', expectedRevision: 'v1' });
  assert.equal(calls[2].body.command, 'rm -r -- /workspace/.novel-trash/books/' + book.id);
});
