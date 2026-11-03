import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readEditor, fillEditor, clickSidebarEntry } from './editor-client.mjs';

export async function verifyImportRecords({ page, context, origin, root, restoreBookId }) {
  const source = {
    state: {
      project: { title: '迁移记录可用性样本' },
      outline: [],
      chapters: [],
      chatWindows: [
        {
          name: '最初的钟声讨论',
          messages: [
            { role: 'user', content: '谁在钟里？不是正式剧情。' },
            { role: 'assistant', content: '历史猜想，不是当前设定。' },
          ],
        },
      ],
      chapterSnapshots: [{ chapter: 9, content: '旧快照🌙\n'.repeat(50000) + '快照末尾完整保留' }],
      operationLogs: Array.from({ length: 35 }, (_, i) => ({ type: 'save', message: '第 ' + i + ' 条记录' })),
      agentEditHistory: [{ instruction: '把钟改成铃', patches: [{ chapter: 9, before: '钟', after: '铃' }] }],
    },
  };
  await clickSidebarEntry(page, 'link', '小说库');
  await page.locator('#project-file').setInputFiles({
    name: 'migration-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  const card = page
    .locator('.book')
    .filter({ has: page.getByRole('heading', { name: source.state.project.title, exact: true }) });
  await card.getByRole('button', { name: '进入创作', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: source.state.project.title }).waitFor();
  const bookId = await page.evaluate(
    async (title) =>
      (await (await import('/novel-assets/workspace.mjs')).makeWorkspaceClient().list()).find(
        (book) => book.title === title,
      ).id,
    source.state.project.title,
  );
  const archivePaths = await page.evaluate(async (id) => {
    const root = '/workspace/novels/' + id;
    const receipt = await (
      await fetch('/api/workspace/file?path=' + encodeURIComponent(root + '/book.json'))
    ).json();
    return receipt.archive.map((path) => root + '/' + path);
  }, bookId);
  assert.ok(archivePaths.length > 1, 'Exercise actual imported multipart history.');
  const before = await Promise.all(
    archivePaths.map(async (path) =>
      Buffer.from(
        await (
          await context.request.get(origin + '/api/workspace/file?path=' + encodeURIComponent(path))
        ).body(),
      ),
    ),
  );
  let reads = 0;
  const countRead = (request) => {
    if (request.method() === 'GET' && archivePaths.includes(new URL(request.url()).searchParams.get('path')))
      reads++;
  };
  page.on('request', countRead);
  await page.getByRole('button', { name: '设定', exact: true }).click();
  await page.getByRole('button', { name: '背景与人物', exact: true }).click();
  const settingURL = origin + '/api/novels/' + bookId + '/document?path=setting.md';
  const oldSetting = await (await context.request.get(settingURL)).json();
  const localSetting = oldSetting.text + '\n未提交的作者设定，阅读档案不能暗中保存。';
  await fillEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), localSetting);
  await page.locator('.novel-ms-status').filter({ hasText: '本机草稿已保留' }).waitFor();
  await page.getByRole('button', { name: '导入记录', exact: true }).click();
  const area = page.getByRole('region', { name: '导入记录', exact: true });
  const type = area.getByRole('combobox', { name: '记录类型', exact: true });
  await type.waitFor();
  await area.getByRole('searchbox', { name: '查找导入记录', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+s');
  assert.equal(
    (await (await context.request.get(settingURL)).json()).hash,
    oldSetting.hash,
    'Ctrl+S in read-only history cannot save the hidden previous editor.',
  );
  assert.equal(await area.getByRole('button', { name: '保存设定', exact: true }).count(), 0);
  assert.equal(reads, archivePaths.length);
  assert.deepEqual(await type.locator('option').allTextContents(), [
    '旧对话 · 1',
    '章节快照 · 1',
    '操作记录 · 35',
    'AI 修改记录 · 1',
  ]);
  await area.getByRole('button', { name: '最初的钟声讨论', exact: true }).click();
  const full = area.getByRole('textbox', { name: '导入记录全文', exact: true });
  assert.match(await readEditor(full), /历史猜想，不是当前设定。/);
  assert.equal(await full.getAttribute('contenteditable'), 'false');
  await area.getByRole('button', { name: '引用到对话', exact: true }).click();
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  await composer.waitFor({ state: 'visible' });
  assert.match(await composer.textContent(), /\/state\/chatWindows\/0/);
  assert.match(await composer.textContent(), /不自动恢复或覆盖书稿/);
  assert.equal(await page.locator('[data-composer-seat]').count(), 1);
  await composer.fill('不能覆盖的未发送作者问题');
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await area.getByRole('button', { name: '引用到对话', exact: true }).click();
  await area.getByRole('alert').filter({ hasText: '已保留' }).waitFor();
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  assert.equal(await composer.textContent(), '不能覆盖的未发送作者问题');
  await composer.fill('');
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await area.getByRole('button', { name: '返回记录列表', exact: true }).click();
  await type.selectOption('chapterSnapshots');
  await area.locator('.novel-import-list button').click();
  assert.match(await readEditor(full), /快照末尾完整保留/);
  const content = await readEditor(full);
  assert.ok(content.length > 250000);
  await area.getByRole('button', { name: '原始字段', exact: true }).click();
  assert.equal(JSON.parse(await readEditor(full)).content, source.state.chapterSnapshots[0].content);
  await area.getByRole('button', { name: '原始字段', exact: true }).click();
  for (const [width, height, name] of [
    [1280, 900, 'desktop'],
    [768, 900, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok((await readEditor(full)).endsWith('快照末尾完整保留'));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-import-records-' + name + '.png'),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await area.getByRole('button', { name: '返回记录列表', exact: true }).click();
  await type.selectOption('operationLogs');
  assert.equal(await area.locator('.novel-import-list button').count(), 30);
  await area.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await area.locator('.novel-import-list button').count(), 5);
  await area.getByRole('searchbox', { name: '查找导入记录', exact: true }).fill('第 34 条');
  await area.locator('.novel-import-list button').waitFor();
  assert.equal(await area.locator('.novel-import-list button').count(), 1);
  await area.locator('.novel-import-list button').click();
  assert.match(await readEditor(full), /第 34 条记录/);
  assert.equal(
    reads,
    archivePaths.length,
    'Searching, selecting and native document polling must not reload archives.',
  );
  page.off('request', countRead);
  const after = await Promise.all(
    archivePaths.map(async (path) =>
      Buffer.from(
        await (
          await context.request.get(origin + '/api/workspace/file?path=' + encodeURIComponent(path))
        ).body(),
      ),
    ),
  );
  assert.deepEqual(after, before, 'Reading and staging references cannot rewrite archive bytes.');
  await page.getByRole('button', { name: '背景与人物', exact: true }).click();
  assert.equal(await readEditor(page.getByRole('textbox', { name: '书稿正文', exact: true })), localSetting);
  assert.equal((await (await context.request.get(settingURL)).json()).hash, oldSetting.hash);
  // Explicit fixture corruption only; this does not touch any personal book.
  const partURL = origin + '/api/workspace/file?path=' + encodeURIComponent(archivePaths[0]);
  assert.equal((await context.request.put(partURL, { data: 'corrupt local fixture' })).status(), 200);
  await page.getByRole('button', { name: '导入记录', exact: true }).click();
  await area.getByRole('alert').filter({ hasText: '内容已变化' }).waitFor();
  assert.equal(await area.getByRole('combobox', { name: '记录类型', exact: true }).count(), 0);
  assert.equal((await context.request.put(partURL, { data: before[0] })).status(), 200);
  await area.getByRole('button', { name: '重新读取', exact: true }).click();
  await type.waitFor();
  assert.equal(await type.locator('option').first().textContent(), '旧对话 · 1');
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + restoreBookId + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  console.log(
    'Imported history passed: actual multi-part archive, all four collections, complete long text, read-only, native draft reference/no auto-send, occupied draft preserved, search/pagination, no polling reload or archive writes, desktop/tablet/mobile.',
  );
}
