import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { openChapter, waitEditor, clickSidebarEntry } from './editor-client.mjs';

// Original Harness model HTTP/tool/session + VFS integration. Synthetic local
// provider only. Never reads production credentials or alters formal books.
export async function verifyAuthoringSystem({ page, context, origin, model, waitFor, root }) {
  await page.setViewportSize({ width: 1440, height: 960 });
  const id = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  const base = origin + '/api/novels/' + id + '/';
  const request = async (route, data) => {
    const response = data
      ? await context.request.put(base + route, { data, timeout: 20000 })
      : await context.request.get(base + route, { timeout: 20000 });
    assert.equal(response.status(), 200);
    const value = await response.json();
    await response.dispose();
    return value;
  };
  const path = 'chapters/authoring.md';
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  const prompts = page.getByLabel('提示词编辑器', { exact: true });
  for (const label of ['助手总规则', '风格与禁忌', '人称与角色视角', '参考风格与手法'])
    assert.equal(await prompts.getByText(label, { exact: true }).count(), 0);
  assert.equal(
    await prompts
      .locator('summary')
      .filter({ hasText: /写作卡片|插件附加提示词/ })
      .count(),
    0,
  );
  const taskTemplate = 'WRITE_ONLY_MARKER_9e71：按作者本次要求写作。章节：{chapterTitle}。';
  const templateEditor = prompts.getByRole('textbox', { name: '提示词 write', exact: true });
  await templateEditor.fill(taskTemplate);
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await waitFor(
    async () =>
      JSON.parse((await request('document?path=rules.json')).text).savedPrompts.write === taskTemplate,
    'task template persisted in the original rules owner',
  );
  const documents = (await request('documents')).documents;
  assert(!documents.some((file) => ['START.md', 'AGENTS.md'].includes(file.path)));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await templateEditor.isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const box = await templateEditor.boundingBox();
    assert.ok(box.width > 200 && box.x >= 0 && box.x + box.width <= width);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-prompt-sources-' + width + '.png'),
      fullPage: true,
    });
  }
  await prompts
    .locator('summary')
    .filter({ hasText: /^正文$/ })
    .click();
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-prompt-sources-overview-390.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  const original = '# 第三声钟\n\n她从衣袋里取出铜钥匙。';
  const revised = '# 第三声钟\n\n守钟人将铜钥匙递给她，她留下值夜资格牌作为交换。';
  await request('document', { path, text: original, expectedHash: null });
  const outline = await request('document?path=outline.json');
  await request('document', {
    path: 'outline.json',
    expectedHash: outline.hash,
    text: JSON.stringify([
      {
        chapter: 1,
        title: '第三声钟',
        chapterPath: path,
        summary: '以值夜资格交换铜钥匙。',
        plotPoints: ['交换钥匙', '留下代价'],
      },
    ]),
  });
  await page.reload();
  await openChapter(page, path);
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await waitEditor(editor, original);
  const previous = ({ task, results, step }) =>
    JSON.parse(results.get('fixture_' + task.id + '_' + (step - 1)).text);
  const oldContext = 'OLD_CHAT_ONLY_DO_NOT_REINJECT_947821';
  const rewrite = model.register({
    prepare(prompt) {
      assert.ok(
        !prompt.includes('你的交付是创作讨论与可读小说'),
        'No separate assistant workflow is injected.',
      );
    },
    argumentPreviewAtStep: 2,
    argumentPreviewText: '守钟人将铜钥匙递给她',
    steps: [
      {
        name: 'novel_proposal_prepare',
        input: { mode: 'rewrite', path, instruction: '改正钥匙的来源，写出交换动作和代价。' },
        expected: '"mode":"direct"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: revised.slice(0, -6),
            complete: false,
          };
        },
        expected: '"published":false',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: revised,
            complete: true,
          };
        },
        expected: '"published":true',
      },
    ],
    finalText: '已修改钥匙来源并保存，旧版本可从历史恢复。',
  });
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await composer.fill('请直接修改第一章。' + oldContext + rewrite.marker);
  await composer.press('Enter');
  await waitFor(
    () => rewrite.holds.some((h) => h.stage === 'tool-arguments'),
    'final rewrite argument stream held',
  );
  assert.equal(
    (await request('document?path=' + path)).text,
    original,
    'Partial content cannot replace formal prose.',
  );
  const showAssistant = page.getByRole('button', { name: '创作助手', exact: true });
  if (await showAssistant.isVisible()) await showAssistant.click();
  assert.equal(await page.getByRole('button', { name: '接受改稿', exact: true }).count(), 0);
  assert.equal(await page.getByText('已读取候选', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '查看候选', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('textbox', { name: '候选流式预览', exact: true }).count(),
    0,
    'Tool protocol does not automatically expand another full-text preview in chat.',
  );
  model.release(rewrite);
  await waitFor(() => rewrite.completedSteps === 3, 'requested old-prose edit committed directly');
  assert(
    rewrite.bodies.some((body) => JSON.stringify(body).includes('WRITE_ONLY_MARKER_9e71')),
    'Prepared tool result supplies the chosen task template to the real model HTTP.',
  );
  await page.locator('.novel-native-activity').filter({ hasText: 'AI 已结束' }).waitFor();
  if (await page.getByRole('button', { name: '返回书稿', exact: true }).isVisible())
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await waitEditor(editor, revised);
  assert.equal((await request('document?path=' + path)).text, revised);
  const history = await request('history?path=' + path);
  let oldVersion;
  for (const v of history.versions) {
    const record = await request('history?path=' + path + '&hash=' + v.hash);
    if (record.text === original) oldVersion = record;
  }
  assert.ok(oldVersion, 'Original prose survives in the existing version history.');
  // Keep ALL book document hashes, not merely its displayed title.
  const bookHashes = async () => {
    const hashes = [];
    for (const doc of (await request('documents')).documents) {
      const actual = await request('document?path=' + encodeURIComponent(doc.path));
      hashes.push([doc.path, actual.hash]);
    }
    return hashes;
  };
  const before = await bookHashes();
  const oldSession = await page.locator('.novel-manuscript').getAttribute('data-session-id');
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清空聊天', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.novel-manuscript').getAttribute('data-session-id')) !== oldSession,
    'fresh native session replaces only chat context',
  );
  const freshSession = await page.locator('.novel-manuscript').getAttribute('data-session-id');
  assert.deepEqual(await bookHashes(), before);
  assert.equal(await page.locator('.novel-archived-conversations summary').textContent(), '归档对话 · 1');
  assert.ok(!(await page.locator('.novel-desk-assistant').innerText()).includes(oldContext));
  const probe = model.register({
    steps: [
      {
        name: 'read',
        input: { file_path: '/workspace/novels/' + id + '/' + path },
        expected: '留下值夜资格牌作为交换',
      },
      {
        name: 'read',
        input: { file_path: '/workspace/novels/' + id + '/outline.json' },
        expected: '交换钥匙',
      },
      { name: 'read', input: { file_path: '/workspace/novels/' + id + '/rules.json' } },
    ],
    finalText: '已读取当前作品的正文、大纲与规则，不沿用旧聊天。',
  });
  await composer.fill('读取当前小说的正文、大纲和规则，不改稿。' + probe.marker);
  await composer.press('Enter');
  await waitFor(
    () => probe.completedSteps === 3,
    'fresh conversation can read same book through original tools',
  );
  await page.locator('.novel-native-activity').filter({ hasText: 'AI 已结束' }).waitFor();
  assert.ok(probe.bodies.length >= 4);
  assert.ok(
    probe.bodies.every((body) => !JSON.stringify(body).includes(oldContext)),
    'Actual model HTTP must not contain old transcript, tool history, compacted summary or old task marker.',
  );
  assert.ok(probe.bodies.every((body) => !JSON.stringify(body).includes(rewrite.marker)));
  await page.reload();
  await waitFor(
    async () => (await page.locator('.novel-manuscript').getAttribute('data-session-id')) === freshSession,
    'reload resumes new conversation rather than the archive',
  );
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  // Native appearance remains the owner across the app and the body portal.
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await clickSidebarEntry(page, 'button', '设置');
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '通用设置', exact: true }).click();
    const palette = settings.locator('.novel-theme-accents');
    await palette.getByRole('button', { name: '浅紫', exact: true }).click();
    for (const name of ['浅色', '深色', '跟随系统']) {
      await settings.getByRole('button', { name, exact: true }).click();
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-authoring-theme-' + width + '-' + name + '.png'),
        fullPage: true,
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await settings.getByRole('button', { name: '深色', exact: true }).click();
    await palette.getByRole('button', { name: '中性', exact: true }).click();
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'hidden' });
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
      ),
      '#151619',
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-authoring-assistant-' + width + '.png'),
      fullPage: true,
    });
    const reset = await page.getByRole('button', { name: '清空聊天', exact: true }).boundingBox();
    assert.ok(reset.width >= 44 && reset.x >= 0 && reset.x + reset.width <= width);
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
    await waitEditor(editor, revised);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-authoring-manuscript-' + width + '.png'),
      fullPage: true,
    });
    assert.equal(await page.getByRole('button', { name: /^改稿/ }).count(), 0);
    await page.getByRole('button', { name: '设定', exact: true }).click();
    await page.getByRole('button', { name: '人物与资料', exact: true }).click();
    assert.equal(await page.getByText('AI 整理建议', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
  }
  console.log(
    'Unified authoring passed: old prose final auto-save, partial protection and exact prior history; fresh native conversation archives old context, preserves all book document hashes and excludes old messages from actual model HTTP; native light/dark/system + neutral/accent settings at 320/390/1440, no routine review tab or dedicated extraction entrance. Local synthetic provider only.',
  );
}
