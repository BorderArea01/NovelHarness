import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  fillEditor,
  openChapter,
  openChapterDirectory,
  openDocumentOptions,
  readEditor,
  waitEditor,
  waitResponsiveLayout,
} from './editor-client.mjs';

// Real native editor and synthetic localhost book. Geometry measures the
// visible editor, not just document height or the browser's outer viewport.
export async function verifyManuscriptSpace({ page, client, api, path, root, waitFor }) {
  assert.equal(new URL(api).hostname, '127.0.0.1', 'Layout writes are confined to the localhost fixture.');
  await page.setViewportSize({ width: 390, height: 844 });
  await waitResponsiveLayout(page);
  const nav = page.getByRole('navigation', { name: '章节导航', exact: true });
  const measure = () =>
    page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const body = box('.novel-ms-body'),
        editor = box('.novel-prose-editor'),
        nav = box('.novel-chapter-navigation');
      return {
        width: innerWidth,
        height: innerHeight,
        headerHeight: box('.novel-desk-bar').height,
        dockHeight: box('.novel-author-dock').height,
        navigationHeight: nav.height,
        bodyHeight: body.height,
        editorOffset: editor.top - body.top,
        visibleEditorHeight: Math.max(
          0,
          Math.min(editor.bottom, body.bottom, innerHeight) - Math.max(editor.top, body.top),
        ),
      };
    });
  const before = await measure();
  if (before.navigationHeight > 56) {
    await writeFile(
      resolve(root, 'test-results/cloud-manuscript-space-before.json'),
      JSON.stringify(before, null, 2),
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-manuscript-space-before.png'),
      fullPage: true,
    });
  }
  assert.ok(
    before.navigationHeight <= 56,
    'Closed chapter navigation should fit one 44px touch row, not consume two rows. ' +
      JSON.stringify(before),
  );
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  const read = async (target) => {
    const response = await client.get(api + 'document?path=' + encodeURIComponent(target));
    assert.equal(response.status(), 200);
    const value = await response.json();
    await response.dispose();
    return value;
  };
  const original = await read(path);
  const editorNode = await editor.elementHandle();
  const measurements = [];
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await waitResponsiveLayout(page);
    const picker = nav.getByRole('button', { name: '展开章节目录', exact: true });
    assert.equal(await picker.getAttribute('aria-expanded'), 'false');
    const targets = [
      picker,
      nav.getByRole('button', { name: '上一章', exact: true }),
      nav.getByRole('button', { name: '下一章', exact: true }),
      nav.getByRole('button', { name: '＋ 新章', exact: true }),
    ];
    const boxes = [];
    for (const target of targets) {
      const rect = await target.boundingBox();
      assert.ok(rect && rect.width >= 44 && rect.height >= 44, 'Touch targets retain 44px at ' + width);
      assert.ok(
        await target.evaluate((element) => {
          const r = element.getBoundingClientRect(),
            hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return hit === element || element.contains(hit);
        }),
        'Navigation center must not be covered at ' + width,
      );
      boxes.push(rect);
    }
    assert.ok(boxes.every((box) => Math.abs(box.y - boxes[0].y) < 2));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(
      await page.locator('.novel-ms-path').isVisible(),
      false,
      'Technical path is not a permanent row.',
    );
    const options = page.getByRole('button', { name: '文稿选项', exact: true });
    await options.click();
    const panel = page.getByRole('region', { name: '文稿选项', exact: true });
    await panel.waitFor();
    assert.match(await panel.innerText(), new RegExp(path.replaceAll('.', '\\.')));
    assert.equal(
      await editor.evaluate((node, original) => node === original, editorNode),
      true,
      'Options never recreate the original editor.',
    );
    const panelBox = await panel.boundingBox(),
      bar = await page.locator('.novel-workspace-status').boundingBox();
    assert.ok(panelBox.y >= bar.y + bar.height - 1, 'Options expand inline, not over the text.');
    assert.equal(await page.locator('.novel-ms-savebar').count(), 0, 'No dedicated save row.');
    assert.equal(
      await page.getByRole('button', { name: '保存正文', exact: true }).count(),
      0,
      'Clean reading has no disabled save action.',
    );
    await options.click();
    assert.equal(await panel.count(), 0);
    await picker.focus();
    await picker.press('Enter');
    const directory = nav.getByRole('region', { name: '章节目录', exact: true });
    await directory.waitFor();
    await nav.getByRole('searchbox', { name: '搜索章节', exact: true }).fill('navigation-fixture');
    assert.equal(await nav.locator('button[data-document-path=' + JSON.stringify(path) + ']').count(), 1);
    await picker.press('Space');
    assert.equal(await directory.count(), 0);
    await waitEditor(editor, original.text);
    const shortcuts = page.locator('.novel-author-shortcuts');
    if (
      (await shortcuts.locator(':scope > summary').isVisible()) &&
      (await shortcuts.evaluate((e) => e.open))
    )
      await shortcuts.locator(':scope > summary').click();
    await page.getByRole('button', { name: '正文', exact: true }).focus();
    const space = await measure();
    assert.ok(
      space.headerHeight <= 60,
      'Book title and assistant share one touch-safe header: ' + JSON.stringify(space),
    );
    assert.ok(
      space.bodyHeight >= space.height * 0.6,
      'Reading area gets at least 60% of the normal viewport: ' + JSON.stringify(space),
    );
    assert.ok(
      space.visibleEditorHeight >= space.height * 0.4,
      'Actual prose remains prominent: ' + JSON.stringify(space),
    );
    assert.equal(await page.locator('.novel-ms-heading').count(), 1, 'No duplicated title header.');
    assert.equal(await page.locator('.novel-desk-heading-host .novel-ms-heading').count(), 1);
    measurements.push(space);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-manuscript-space-' + width + '.png'),
      fullPage: true,
    });
  }
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  const composerNode = await composer.elementHandle();
  const draftBefore = await composer.textContent();
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [768, 1024],
    [1280, 720],
    [1440, 900],
    [960, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await waitResponsiveLayout(page);
    await page.getByRole('button', { name: '正文', exact: true }).focus();
    const space = await measure();
    assert.ok(
      space.bodyHeight >= height * 0.6,
      'Short/zoom-equivalent layout protects prose: ' + JSON.stringify(space),
    );
    assert.ok(
      await composer.isVisible(),
      'Original input remains directly available, not a hidden replacement.',
    );
    assert.equal(
      await page.locator('.novel-author-input [data-composer-card] > [data-input-scroll] + div').isVisible(),
      false,
      'Idle reading does not reserve the full native tool row.',
    );
    await composer.fill('布局测试：保留同一个未发送输入框。');
    assert.equal(
      await page.locator('.novel-author-input [data-composer-card] > [data-input-scroll] + div').isVisible(),
      true,
      'Focusing restores the actual native controls; an empty session may have no metrics.',
    );
    assert.equal(await composer.evaluate((node, original) => node === original, composerNode), true);
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
    assert.equal(
      await page.locator('.novel-author-input [data-composer-card] > [data-input-scroll] + div').isVisible(),
      true,
    );
    assert.equal(await composer.evaluate((node, original) => node === original, composerNode), true);
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
    assert.equal(await composer.textContent(), '布局测试：保留同一个未发送输入框。');
    assert.equal(await editor.evaluate((node, original) => node === original, editorNode), true);
    // Clear through the real Lexical key pipeline. Playwright fill('') may
    // clear only its DOM before the native draft owner commits an update.
    await composer.press('ControlOrMeta+A');
    await composer.press('Backspace');
    if (draftBefore) await composer.fill(draftBefore);
    await page.getByRole('button', { name: '正文', exact: true }).focus();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await composer.textContent(), draftBefore);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-prose-balance-' + width + 'x' + height + '.png'),
      fullPage: true,
    });
  }
  await composerNode.dispose();
  await editorNode.dispose();
  await page.setViewportSize({ width: 390, height: 844 });
  const longPath = 'chapters/long-heading-layout-fixture.md';
  const longTitle = '钟楼之外还有一封没有寄出的信，'.repeat(14);
  const created = await client.put(api + 'document', {
    data: { path: longPath, text: '# ' + longTitle + '\n\n长标题不应破坏导航。', expectedHash: null },
  });
  assert.equal(created.status(), 200);
  await created.dispose();
  await page.reload();
  await openChapter(page, longPath);
  await waitEditor(editor, '# ' + longTitle + '\n\n长标题不应破坏导航。');
  assert.equal(await nav.locator('.novel-chapter-current').textContent(), longTitle);
  assert.ok((await nav.boundingBox()).height <= 56);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await nav.getByRole('button', { name: '展开章节目录', exact: true }).click();
  const longEntry = nav.locator('button[data-document-path=' + JSON.stringify(longPath) + '] > span');
  assert.equal(await longEntry.textContent(), longTitle);
  assert.ok(
    await longEntry.evaluate(
      (element) =>
        getComputedStyle(element).whiteSpace !== 'nowrap' && element.scrollHeight <= element.clientHeight + 1,
    ),
    'The full long title wraps in the expanded directory.',
  );
  await openChapter(page, path);
  await waitEditor(editor, original.text);
  assert.equal(
    await page.getByRole('button', { name: '文稿选项', exact: true }).getAttribute('aria-expanded'),
    'false',
  );
  await page.getByRole('button', { name: '文稿选项', exact: true }).click();
  await page.getByRole('button', { name: '改标题', exact: true }).click();
  await page.getByRole('textbox', { name: '章节标题', exact: true }).fill('取消时不能保存这个标题');
  await page.locator('.novel-chapter-rename').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await read(path)).hash, original.hash);
  const draft = original.text + '\n不该因收起工具而丢失的未保存稿。';
  await fillEditor(editor, draft);
  await openDocumentOptions(page);
  assert.equal(await page.getByRole('button', { name: '下载本地稿', exact: true }).isVisible(), true);
  assert.equal(await readEditor(editor), draft);
  assert.equal((await read(path)).hash, original.hash);
  await fillEditor(editor, original.text);
  await waitFor(
    () =>
      page
        .getByRole('button', { name: '保存正文', exact: true })
        .count()
        .then((n) => n === 0),
    'clean draft after local undo',
  );
  const save = page.getByRole('button', { name: '保存正文', exact: true });
  const directory = page.getByRole('region', { name: '章节目录', exact: true });
  const options = page.getByRole('region', { name: '文稿选项', exact: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const next = (await read(path)).text + '\n保存后收起工具，宽度 ' + width + '。';
    await fillEditor(editor, next);
    await openChapterDirectory(page);
    await openDocumentOptions(page);
    assert.equal(await directory.isVisible(), true);
    assert.equal(await options.isVisible(), true);
    await save.click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    await waitFor(() => save.count().then((n) => n === 0), 'successful save retires save action');
    assert.equal(await directory.count(), 0, 'Successful save collapses the chapter directory.');
    assert.equal(await options.count(), 0, 'Successful save collapses document tools.');
    assert.equal(await readEditor(editor), next, 'The manuscript itself stays open.');
    assert.equal((await read(path)).text, next);
  }
  const base = await read(path),
    failed = base.text + '\n失败后继续保留本机稿。';
  await fillEditor(editor, failed);
  await openChapterDirectory(page);
  await openDocumentOptions(page);
  const route = '**/api/novels/*/document';
  const fail = async (request) =>
    request.request().method() === 'PUT'
      ? request.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '合成保存失败：' + '服务暂时不可用，原稿没有被覆盖，可重试或下载本机稿。'.repeat(4),
          }),
        })
      : request.continue();
  await page.route(route, fail);
  try {
    await save.click();
    await page.locator('.novel-ms-status').filter({ hasText: '合成保存失败' }).waitFor();
    assert.equal(await directory.isVisible(), true);
    assert.equal(await options.isVisible(), true);
    assert.equal(await save.isEnabled(), true, 'A failed save remains retryable.');
    assert.equal(await readEditor(editor), failed);
    assert.equal((await read(path)).hash, base.hash, 'Failure never changes formal prose.');
  } finally {
    await page.unroute(route, fail);
  }
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hold = async (request) => {
    if (request.request().method() !== 'PUT') return request.continue();
    entered();
    await gate;
    await request.continue();
  };
  await page.route(route, hold);
  const newer = failed + '\n请求期间输入的新句子。';
  try {
    await save.click();
    await started;
    await fillEditor(editor, newer);
    release();
    await page.locator('.novel-ms-status').filter({ hasText: '当前新修改尚未保存' }).waitFor();
    assert.equal(await readEditor(editor), newer);
    assert.equal((await read(path)).text, failed);
    assert.equal(await directory.isVisible(), true, 'Do not collapse while newer input is unsaved.');
    assert.equal(await options.isVisible(), true);
    await waitFor(() => save.isEnabled(), 'save cleanup leaves the newer draft retryable');
  } finally {
    release();
    await page.unroute(route, hold);
  }
  await save.click();
  await waitFor(() => save.count().then((n) => n === 0), 'latest draft saved');
  assert.equal((await read(path)).text, newer);
  assert.equal(await directory.count(), 0);
  assert.equal(await options.count(), 0);
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-save-compact-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-save-compact-mobile.png'),
    fullPage: true,
  });
  const outline = await read('outline.json');
  const outlineWrite = await client.put(api + 'document', {
    data: {
      path: 'outline.json',
      text: JSON.stringify([{ chapter: 1, title: '保存后阅读', summary: '原概要' }]),
      expectedHash: outline.hash,
    },
  });
  assert.equal(outlineWrite.status(), 200);
  await outlineWrite.dispose();
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  await page.getByRole('button', { name: '编辑章纲', exact: true }).click();
  const summary = page.getByRole('textbox', { name: '大纲概要', exact: true });
  await summary.fill('保存后自动切回完整阅读，不需再点阅读。');
  const saveOutline = page.getByRole('button', { name: '保存大纲', exact: true });
  await page.route(route, fail);
  try {
    await saveOutline.click();
    await page.locator('.novel-ms-status').filter({ hasText: '合成保存失败' }).waitFor();
    assert.equal(await summary.inputValue(), '保存后自动切回完整阅读，不需再点阅读。');
    assert.equal(await summary.isVisible(), true, 'A failed chapter-outline save stays editable.');
  } finally {
    await page.unroute(route, fail);
  }
  await saveOutline.click();
  await waitFor(() => saveOutline.count().then((n) => n === 0), 'chapter outline committed');
  assert.equal(await summary.count(), 0, 'Saved chapter outline retracts its editing form.');
  assert.equal(await page.getByRole('button', { name: '编辑章纲', exact: true }).isVisible(), true);
  assert.match(await page.locator('.novel-outline-chapter').innerText(), /保存后自动切回完整阅读/);
  assert.equal(
    JSON.parse((await read('outline.json')).text)[0].summary,
    '保存后自动切回完整阅读，不需再点阅读。',
  );
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await waitEditor(editor, newer);
  await writeFile(
    resolve(root, 'test-results/cloud-manuscript-space-after.json'),
    JSON.stringify(measurements, null, 2),
  );
  console.log(
    'Native manuscript space passed: one-row 44px chapter controls; no dedicated save row; contextual save, successful directory/options collapse at 390/1280, failed save and newer in-flight draft remain editable/retryable; chapter-outline save retracts editing only on commit; full title, local download, original editor/composer preserved; 320/390/768/1280. No provider or production writes.',
  );
}
