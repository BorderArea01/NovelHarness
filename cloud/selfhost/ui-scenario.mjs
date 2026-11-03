import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import {
  openChapter,
  waitEditor,
  fillEditor,
  clickSidebarEntry,
  waitResponsiveLayout,
} from '../tests/editor-client.mjs';

export async function verifyWritingUi({ page, context, origin, book, prose }) {
  const shot = (name) => page.screenshot({ path: 'test-results/ui-' + name + '.png' });
  const overflow = async () =>
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const search = page.getByRole('searchbox', { name: '搜索小说', exact: true });
  await search.fill('雨港');
  await expect(search).toHaveValue('雨港');
  await expect(page.locator('.book:visible')).toHaveCount(1);
  await search.fill('没有这个书名');
  await page.getByRole('heading', { name: '没有匹配的小说', exact: true }).waitFor();
  await expect(page.locator('.book:visible')).toHaveCount(0);
  await search.fill('');
  await expect(page.locator('.book:visible')).toHaveCount(3);
  const card = page.locator('.book[data-book-id="' + book.id + '"]');
  assert.equal(await card.getByRole('button', { name: '删除整本书', exact: true }).isVisible(), false);
  const menu = card.locator('.book-tools > summary');
  await menu.focus();
  await page.keyboard.press('Enter');
  await card.getByRole('button', { name: '改名', exact: true }).click();
  await card.getByRole('textbox', { name: '小说新书名', exact: true }).fill('取消操作不改书名');
  await card.getByRole('button', { name: '取消改名', exact: true }).click();
  assert.equal(await card.locator('h3').textContent(), '雨港来信');
  await card.getByRole('button', { name: '删除整本书', exact: true }).click();
  await page
    .getByRole('region', { name: '管理小说', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.equal(await page.locator('.book').count(), 3);
  if ((await card.locator('.book-tools').getAttribute('open')) !== null) await menu.click();
  await page.locator('#new-book').click();
  await page.getByRole('textbox', { name: '书名', exact: true }).fill('取消的新作品');
  await page.getByRole('button', { name: '取消建书', exact: true }).click();
  assert.equal(await page.locator('.book').count(), 3);
  // Reproduce the reported mix: a long unbroken book name and one card with
  // conversation status. This DOM-only fixture never creates a paid session.
  const fixture = await page
    .locator('.book')
    .first()
    .evaluate((node) => {
      const title = node.querySelector('h3'),
        activity = node.querySelector('.book-activity');
      const previous = { title: title.textContent, html: activity.innerHTML, hidden: activity.hidden };
      title.textContent = 'b-88633d364b4cd7752937bab6040cc67e';
      activity.hidden = false;
      const row = document.createElement('div');
      row.className = 'book-session';
      const state = document.createElement('span');
      state.textContent = 'AI 已结束';
      const button = document.createElement('button');
      button.textContent = '查看对话';
      row.append(state, button);
      activity.replaceChildren(row);
      return previous;
    });
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await waitResponsiveLayout(page);
    await overflow();
    const boxes = await page.locator('.book:visible').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect(),
          actions = node.querySelector('.actions').getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          actions: actions.top,
          overflow: node.scrollWidth > node.clientWidth + 1,
        };
      }),
    );
    for (const box of boxes) {
      assert.equal(box.overflow, false, 'Book contents overflow the card.');
      for (const peer of boxes.filter((other) => Math.abs(other.top - box.top) < 1)) {
        assert(Math.abs(peer.bottom - box.bottom) < 1, 'Cards on the same row must have equal height.');
        assert(Math.abs(peer.actions - box.actions) < 1, 'Book actions must align on the same row.');
      }
    }
    await shot('library-' + width);
  }
  await page
    .locator('.book')
    .first()
    .evaluate((node, previous) => {
      node.querySelector('h3').textContent = previous.title;
      const activity = node.querySelector('.book-activity');
      activity.innerHTML = previous.html;
      activity.hidden = previous.hidden;
    }, fixture);
  await page.setViewportSize({ width: 1280, height: 900 });
  await waitResponsiveLayout(page);
  await card.getByRole('button', { name: '进入创作', exact: true }).click();
  await page.locator('.novel-manuscript').waitFor();
  assert.equal(
    await page.getByRole('button', { name: '当前作品', exact: true }).getAttribute('aria-current'),
    'page',
  );
  assert.equal(await page.getByTestId('dsh-purge-launch').isVisible(), false);
  await page.getByRole('button', { name: '收起导航', exact: true }).click();
  const centers = [];
  for (const name of ['展开导航', '当前作品']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert(box && box.width === 44 && box.height === 44);
    centers.push(box.x + box.width / 2);
  }
  assert(Math.abs(centers[0] - centers[1]) < 1);
  await shot('collapsed-desktop');
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await openChapter(page, 'chapters/00001.md');
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await waitEditor(editor, prose);
  const changed = prose + '\n\n她将回信收好，起身去开门。';
  await fillEditor(editor, changed);
  await editor.press('ControlOrMeta+s');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.novel-ms-status')].some((e) => e.textContent.includes('已保存')),
  );
  const saved = await context.request.get(
    origin + '/api/novels/' + book.id + '/document?path=chapters/00001.md',
  );
  assert.equal(saved.status(), 200);
  assert.equal((await saved.json()).text, changed);
  await saved.dispose();
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await waitResponsiveLayout(page);
    await overflow();
    const box = await editor.boundingBox();
    assert(box && box.width > Math.min(width - 60, 240), 'Writer became too narrow.');
    await shot('manuscript-' + width);
    for (const name of ['大纲', '设定', '提示词']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.locator('.novel-ms-tabs[aria-busy="false"]').waitFor();
      if (name === '设定')
        assert.equal(
          await page.getByLabel('提示词编辑器', { exact: true }).count(),
          0,
          'Switching back to reference must not retain the prompt document.',
        );
      await overflow();
      await shot((name === '大纲' ? 'outline' : name === '设定' ? 'reference' : 'prompts') + '-' + width);
    }
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await waitEditor(editor, changed);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await waitResponsiveLayout(page);
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll('[data-testid="dsh-purge-tab-chip"], [data-testid="dsh-purge-launch"]'),
    ].some((element) => element.getBoundingClientRect().width > 0),
  );
  await shot('assistant-desktop');
  await overflow();
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await clickSidebarEntry(page, 'button', '设置');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '通用设置', exact: true }).click();
  await settings.getByRole('button', { name: '浅色', exact: true }).click();
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  await shot('manuscript-light');
  await clickSidebarEntry(page, 'button', '设置');
  await settings.getByRole('button', { name: '通用设置', exact: true }).click();
  await settings.getByRole('button', { name: '深色', exact: true }).click();
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 600 });
  await waitResponsiveLayout(page);
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.getByRole('button', { name: '关闭导航', exact: true }).click({ position: { x: 10, y: 120 } });
  await editor.focus();
  await overflow();
  await shot('short-phone');
  return {
    searched: true,
    managementCancel: true,
    saveVerified: true,
    layouts: [1280, 768, 390, 320],
    lightAndDark: true,
  };
}
