import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clickSidebarEntry, openChapter, fillEditor, waitEditor } from './editor-client.mjs';
import { newFixtureApi } from './fixture-api.mjs';
import { contrast } from './control-contrast.mjs';

// Actual original UI/VFS, only localhost fixture books; no provider request.
export async function verifyControlAffordance({ page, context, origin, model, root }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const client = await newFixtureApi(context);
  const id = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  const path = 'chapters/controls-layout.md',
    api = origin + '/api/novels/' + id + '/';
  const text = '# 钟楼来信\n\n她推开门，雨水沿着信封的边缘落下。';
  const rows = [];
  async function measure(locator, { touch = true, enabled = true } = {}) {
    await locator.scrollIntoViewIfNeeded();
    const value = await locator.evaluate((element) => {
      const style = getComputedStyle(element),
        box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        label: element.getAttribute('aria-label') || element.textContent.trim(),
        width: box.width,
        height: box.height,
        background: style.backgroundColor,
        color: style.color,
        border: style.borderTopColor,
        borderWidth: parseFloat(style.borderTopWidth),
        hit: hit === element || element.contains(hit),
        x: box.x,
        right: box.right,
      };
    });
    assert.ok(value.hit, value.label + ': touch center is covered');
    if (touch) assert.ok(value.width >= 44 && value.height >= 44, value.label + ': minimum touch size');
    assert.ok(
      value.x >= -1 && value.right <= (await page.evaluate(() => innerWidth)) + 1,
      value.label + ': viewport bounds',
    );
    assert.ok(value.borderWidth >= 1, value.label + ': visible boundary without hover');
    if (enabled)
      assert.ok(contrast(value.background, value.color) >= 4.5, value.label + ': rendered text contrast');
    return value;
  }
  try {
    const response = await client.put(api + 'document', { data: { path, text, expectedHash: null } });
    assert.equal(response.status(), 200);
    await response.dispose();
    await page.reload();
    await openChapter(page, path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(editor, text);
    for (const theme of ['浅色', '深色']) {
      await clickSidebarEntry(page, 'button', '设置');
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.getByRole('button', { name: '通用设置', exact: true }).click();
      await settings.getByRole('button', { name: theme, exact: true }).click();
      await settings.getByRole('button', { name: '关闭', exact: true }).click();
      await page.waitForFunction(
        (color) => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim() === color,
        theme === '浅色' ? '#f5f5f7' : '#151619',
      );
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await waitEditor(editor, text);
        const touch = width <= 600;
        const controls = [];
        if (touch) controls.push(await measure(page.getByRole('button', { name: '展开导航', exact: true })));
        for (const label of ['正文', '大纲', '连写', '设定', '提示词', '文稿选项', '＋ 新章'])
          controls.push(await measure(page.getByRole('button', { name: label, exact: true }), { touch }));
        assert.ok(await page.locator('.novel-chapter-add-label').isVisible(), 'Keep 新章 text on phones.');
        await page.getByRole('button', { name: '文稿选项', exact: true }).click();
        await measure(page.getByRole('button', { name: '历史', exact: true }), { touch });
        await measure(page.getByRole('button', { name: '生成记录', exact: true }), { touch });
        await page.getByRole('button', { name: '文稿选项', exact: true }).click();
        await page.getByRole('button', { name: '大纲', exact: true }).click();
        await page.getByRole('region', { name: '章节大纲', exact: true }).waitFor();
        await page.locator('.novel-ms-tabs[aria-busy="false"]').waitFor();
        const plan = page.getByRole('button', { name: '生成规划候选', exact: true });
        if (!(await plan.isVisible())) await page.locator('.novel-outline-planner > summary').click();
        assert.equal(await plan.getAttribute('data-variant'), 'primary');
        await measure(plan, { touch });
        await page.getByRole('button', { name: '正文', exact: true }).click();
        await waitEditor(editor, text);
        await page.getByRole('button', { name: '创作助手', exact: true }).click();
        const shortcuts = page.locator('.novel-author-shortcuts');
        if (!(await shortcuts.evaluate((e) => e.open))) await shortcuts.locator(':scope > summary').click();
        const actions = page.getByRole('group', { name: 'AI 写作操作', exact: true });
        await measure(actions.getByRole('button', { name: '写作', exact: true }), { touch });
        await measure(actions.getByRole('button', { name: '审稿', exact: true }), { touch });
        await measure(actions.locator('.novel-more-writing > summary'), { touch });
        await page.screenshot({
          path: resolve(root, 'test-results/cloud-controls-assistant-' + width + '-' + theme + '.png'),
          fullPage: true,
        });
        await page.getByRole('button', { name: '返回书稿', exact: true }).click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({
          path: resolve(root, 'test-results/cloud-controls-' + width + '-' + theme + '.png'),
          fullPage: true,
        });
        rows.push({ theme, width, controls });
      }
    }
    await fillEditor(editor, text + '\n风掀起窗帘。');
    const save = page.getByRole('button', { name: '保存正文', exact: true });
    assert.equal(await save.getAttribute('data-variant'), 'primary');
    await measure(save, { touch: false });
    await save.click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    const saved = await client.get(api + 'document?path=' + encodeURIComponent(path));
    assert.equal((await saved.json()).text, text + '\n风掀起窗帘。');
    await saved.dispose();
    assert.equal(model.requests.length, 0);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await clickSidebarEntry(page, 'link', '小说库');
      const card = page.locator('.book[data-book-id="' + id + '"]');
      await card.waitFor();
      await measure(page.getByRole('button', { name: '＋ 新建小说', exact: true }), { touch: width <= 600 });
      for (const label of ['进入创作', '备份', '改名'])
        await measure(card.getByRole('button', { name: label, exact: true }), { touch: width <= 600 });
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-controls-library-' + width + '.png'),
        fullPage: true,
      });
      await card.getByRole('button', { name: '进入创作', exact: true }).click();
      await page.locator('.novel-manuscript[data-book-id="' + id + '"]').waitFor();
    }
    await writeFile(
      resolve(root, 'test-results/cloud-controls.json'),
      JSON.stringify({ rows, providerCalls: 0, originalSaveVerified: true }, null, 2),
    );
    console.log(
      'Control affordances passed: real UI at 320/390/768/1440, original light/dark owner, rendered contrast, non-hover outlines, touch hit targets, visible 新章, grouped AI actions and original save. Local fixture only.',
    );
  } finally {
    await client.dispose();
  }
}
