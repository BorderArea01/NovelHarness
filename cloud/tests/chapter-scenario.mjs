import { newFixtureApi } from './fixture-api.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fillEditor, openChapter, openDocumentOptions, readEditor, waitEditor } from './editor-client.mjs';
// All mutation is confined to the independent localhost fixture, never a book online.
// Dispose responses after parsing: Playwright otherwise retains each full body
// until context close (https://playwright.dev/docs/api/class-apiresponse#api-response-dispose).
export async function verifyChapterNavigation({ page, context, origin, api, restorePath, root }) {
  const apiClient = await newFixtureApi(context);
  try {
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    const read = async (path) => {
      const r = await apiClient.get(origin + api + 'document?path=' + encodeURIComponent(path));
      try {
        assert.equal(r.status(), 200);
        return await r.json();
      } finally {
        await r.dispose();
      }
    };
    const put = async (path, text, expectedHash) => {
      const r = await apiClient.put(origin + api + 'document', { data: { path, text, expectedHash } });
      try {
        assert.equal(r.status(), 200);
        return await r.json();
      } finally {
        await r.dispose();
      }
    };
    const oldOutline = await read('outline.json');
    const path = 'chapters/title-stable-fixture.md',
      next = 'chapters/a-next-fixture.md';
    const source = '\ufeff# 改名前的正文标题\r\n\r\n正文中的沈澄🌧️不应改变。\r\n';
    const first = await put(path, source, null);
    await put(next, '# 下一章\n正文', null);
    await put(
      'outline.json',
      JSON.stringify({
        extension: { keep: true },
        chapters: [
          { chapter: 2, title: '第二章章纲', chapterPath: next },
          { chapter: 1, title: '第一章章纲', chapterPath: path, summary: '原概要', unknown: ['保留'] },
        ],
      }),
      oldOutline.hash,
    );
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await openChapter(page, path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(editor, source.replaceAll('\r\n', '\n'));
    const nav = page.getByRole('navigation', { name: '章节导航', exact: true });
    assert.match(await nav.locator('.novel-chapter-current').innerText(), /第1章.*第一章章纲/);
    await nav.getByRole('button', { name: '下一章', exact: true }).click();
    await waitEditor(editor, '# 下一章\n正文');
    await nav.getByRole('button', { name: '上一章', exact: true }).click();
    await waitEditor(editor, source.replaceAll('\r\n', '\n'));
    await openDocumentOptions(page);
    await page.getByRole('button', { name: '改标题', exact: true }).click();
    await page.getByRole('textbox', { name: '章节标题', exact: true }).fill('取消后不应出现');
    await page.locator('.novel-chapter-rename').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await read(path)).hash, first.hash);
    await openDocumentOptions(page);
    await page.getByRole('button', { name: '改标题', exact: true }).click();
    await page.getByRole('textbox', { name: '章节标题', exact: true }).fill('新章标题🌧️');
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-native-chapter-' + width + '.png'),
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: '保存标题', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '标题已保存' }).waitFor();
    const saved = await read(path);
    assert.equal(saved.text, source.replace('改名前的正文标题', '新章标题🌧️'));
    assert.equal(saved.path, path);
    assert.equal(saved.outline.title, '新章标题🌧️');
    const updatedOutline = await read('outline.json');
    const shape = JSON.parse(updatedOutline.text);
    assert.deepEqual(shape.chapters[1].unknown, ['保留']);
    assert.deepEqual(shape.extension, { keep: true });
    await page.reload();
    await openChapter(page, path);
    await waitEditor(editor, saved.text.replaceAll('\r\n', '\n'));
    assert.equal(await page.getByRole('region', { name: '三方冲突处理', exact: true }).count(), 0);
    // A different device changes the outline after the title form opened.
    await openDocumentOptions(page);
    await page.getByRole('button', { name: '改标题', exact: true }).click();
    await page.getByRole('textbox', { name: '章节标题', exact: true }).fill('旧大纲不准覆盖');
    shape.chapters[1].summary = '来自其他设备的新概要';
    const remoteOutline = await put('outline.json', JSON.stringify(shape), updatedOutline.hash);
    await page.getByRole('button', { name: '保存标题', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '大纲已更新' }).waitFor();
    assert.equal((await read(path)).hash, saved.hash);
    assert.equal((await read('outline.json')).hash, remoteOutline.hash);
    await page
      .locator('.novel-chapter-rename')
      .getByRole('button', { name: '重新读取', exact: true })
      .click();
    await openDocumentOptions(page);
    await page.getByRole('button', { name: '改标题', exact: true }).click();
    await page.getByRole('textbox', { name: '章节标题', exact: true }).fill('等待中的新标题');
    let release, entered;
    const gate = new Promise((r) => {
      release = r;
    });
    const started = new Promise((r) => {
      entered = r;
    });
    const route = '**' + api + 'chapter-title';
    await page.route(route, async (request) => {
      entered();
      await gate;
      await request.continue();
    });
    try {
      await page.getByRole('button', { name: '保存标题', exact: true }).click();
      await started;
      const local = saved.text.replace('正文中的沈澄', '等待期间继续编辑的沈澄');
      await fillEditor(editor, local);
      release();
      await page.locator('.novel-ms-status').filter({ hasText: '等待期间的新修改仍保留' }).waitFor();
      assert.equal(await readEditor(editor), local.replaceAll('\r\n', '\n'));
      assert.equal((await read(path)).text, saved.text.replace('新章标题🌧️', '等待中的新标题'));
      await page.reload();
      await openChapter(page, path);
      await waitEditor(editor, local.replaceAll('\r\n', '\n'));
      await page.getByRole('region', { name: '三方冲突处理', exact: true }).waitFor();
    } finally {
      release();
      await page.unroute(route);
    }
    // Make the SECOND save exceed the real logical-file cap AFTER the manuscript
    // was updated. This proves the native transaction rolls back both versions
    // and histories, rather than merely rejecting a request before any writes.
    const rollbackBody = await read(path);
    const rollbackOutline = await read('outline.json');
    const hugeOutline = await put(
      'outline.json',
      JSON.stringify({
        extension: 'x'.repeat(2 * 1024 * 1024 - 256),
        chapters: [{ chapter: 1, chapterPath: path, title: 'old' }],
      }),
      rollbackOutline.hash,
    );
    const histories = async (target) => {
      const response = await apiClient.get(origin + api + 'history?path=' + encodeURIComponent(target));
      try {
        assert.equal(response.status(), 200);
        return await response.json();
      } finally {
        await response.dispose();
      }
    };
    const beforeHistory = await histories(path),
      beforeOutlineHistory = await histories('outline.json');
    const failedTitle = await apiClient.post(origin + api + 'chapter-title', {
      data: {
        path,
        title: '长'.repeat(120),
        expectedHash: rollbackBody.hash,
        outlineHash: hugeOutline.hash,
      },
    });
    assert.equal(failedTitle.status(), 413);
    await failedTitle.dispose();
    assert.equal((await read(path)).hash, rollbackBody.hash);
    assert.equal((await read('outline.json')).hash, hugeOutline.hash);
    assert.deepEqual(await histories(path), beforeHistory);
    assert.deepEqual(await histories('outline.json'), beforeOutlineHistory);
    // Leave the original fixture outline and selection intact for existing suites.
    const currentOutline = await read('outline.json');
    await put('outline.json', oldOutline.text, currentOutline.hash);
    await openChapter(page, restorePath);
    await page.setViewportSize({ width: 1280, height: 900 });
    console.log(
      'Native chapter navigation passed: derived labels/order, prev-next, title cancel/save, unchanged path/body, atomic outline sync with second-file-limit rollback and unchanged histories, stale-outline refusal, in-flight typing/reload conflict recovery, 1280/768/390 layout.',
    );
  } finally {
    await apiClient.dispose();
  }
}
