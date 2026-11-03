import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, renameConversation, renameBook } from '../pages/public/novel-assets/title-editor.mjs';
test('manual titles normalize Unicode, allow literal markup, reject empty/multiline/control/oversized values', () => {
  assert.equal(cleanTitle('  Cafe\u0301  '), 'Café');
  assert.equal(cleanTitle('<标题> 🌙'), '<标题> 🌙');
  assert.equal(cleanTitle('🌙'.repeat(120)), '🌙'.repeat(120));
  for (const value of ['', ' ', 'a\nb', 'x\u0000y', 'a'.repeat(121)]) assert.throws(() => cleanTitle(value));
});
test('conversation rename uses the original retained native session and refuses a stale title or native failure', async () => {
  let title = '原名',
    calls = [];
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { s1: { title } } }) },
      using: async (id, opts, run) => {
        calls.push([id, opts]);
        await run({
          binding: {
            session: {
              rename: async (next) => {
                title = next;
              },
            },
          },
        });
        return { ok: true };
      },
    },
  };
  await renameConversation(ctx, 's1', '新名', '原名');
  assert.equal(title, '新名');
  assert.deepEqual(calls[0], ['s1', { source: 'workspaceOperation' }]);
  await assert.rejects(renameConversation(ctx, 's1', '不覆盖', '原名'), /已更新/);
  assert.equal(title, '新名');
  ctx.sessions.using = async () => ({ ok: false, error: { message: '网络异常' } });
  await assert.rejects(renameConversation(ctx, 's1', '其他', '新名'), /网络异常/);
});
test('book rename preserves the original workspace identity and refuses changed metadata or wrong paths', async () => {
  let title = '旧书名',
    calls = [];
  const ctx = {
    workspaces: {
      create: async ({ path }) => ({ workspaceId: 'w1', path }),
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', title }] }) },
      rename: async (id, next) => {
        calls.push(id);
        title = next;
      },
    },
  };
  await renameBook(ctx, { root: '/workspace/novels/book' }, '新书名', '旧书名');
  assert.equal(title, '新书名');
  assert.deepEqual(calls, ['w1']);
  await assert.rejects(renameBook(ctx, { root: '/workspace/novels/book' }, '不覆盖', '旧书名'), /已更新/);
  ctx.workspaces.create = async () => ({ path: '/workspace/elsewhere' });
  await assert.rejects(renameBook(ctx, { root: '/workspace/novels/book' }, '不改'), /不匹配/);
});
