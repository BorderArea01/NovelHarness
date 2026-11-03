import { newFixtureApi } from './fixture-api.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  fillEditor,
  openChapter,
  openChapterDirectory,
  waitEditor,
  readEditor,
  openGenerationRecords,
} from './editor-client.mjs';
// Independent localhost book; no public data, provider settings or paid model.
export async function verifyChapterOrder({ page, context, origin, restoreBookId, root }) {
  const apiClient = await newFixtureApi(context);
  try {
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    const book = await page.evaluate(async () => {
      const { makeBookBundle } = await import('/novel-assets/bundle.mjs');
      const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
      const bundle = await makeBookBundle({
        state: {
          project: { title: '独立章节重排验收', setting: '', characters: '' },
          chapters: [
            { chapter: 1, content: '\ufeff# 甲章\r\n正文甲🌧️\r\n' },
            { chapter: 2, content: '# 乙章\n正文乙' },
          ],
          outline: [
            { chapter: 1, title: '甲章', summary: '甲的原概要', unknown: { chapter: 1 } },
            { chapter: 2, title: '乙章', summary: '乙的原概要' },
            { chapter: 3, title: '未来章', summary: '尚未起草' },
          ],
          creativeRules: { chapterPOVOverrides: { 1: ['甲角色'], 2: ['乙角色'] }, toneAtmosphere: '原基调' },
          memory: { chapterCards: [{ chapter: 1, summary: '原有摘要' }] },
          chapterMemories: {
            2: {
              chapter: 2,
              sourceChapters: [1],
              sourceHash: '旧编号与正文的摘要校验',
              content: '原有前文接力',
            },
          },
        },
        characters: [
          { id: 'a', name: '人物甲', trust: 'manual', sourceChapter: 1, customFields: { chapter: 1 } },
        ],
      });
      return (await makeWorkspaceClient().import(bundle)).book;
    });
    const api = '/api/novels/' + book.id + '/';
    async function json(route, data, expected = 200) {
      const url = origin + api + route;
      const response = data
        ? await apiClient[route === 'document' ? 'put' : 'post'](url, { data })
        : await apiClient.get(url);
      try {
        assert.equal(response.status(), expected);
        return await response.json();
      } finally {
        await response.dispose();
      }
    }
    const read = (path) => json('document?path=' + encodeURIComponent(path));
    const a = await read('chapters/00001.md'),
      b = await read('chapters/00002.md');
    const c = await json('document', {
      path: 'chapters/free-c.md',
      text: '# 自由丙\n未编号的正文',
      expectedHash: null,
    });
    const originalOutline = await read('outline.json');
    const originalRules = await read('rules.json');
    const originalMemory = await read('memory.json');
    const originalCanon = await read('canon.json');
    const provenance = async () => {
      const response = await apiClient.get(
        origin + '/api/workspace/file?path=' + encodeURIComponent(book.root + '/chapter-index.json'),
      );
      try {
        assert.equal(response.status(), 200);
        return (await response.body()).toString('hex');
      } finally {
        await response.dispose();
      }
    };
    const indexBytes = await provenance();
    const readGuide = async () => {
      const response = await apiClient.get(
        origin + '/api/workspace/file?path=' + encodeURIComponent(book.root + '/START.md'),
      );
      try {
        assert.equal(response.status(), 200);
        return await response.text();
      } finally {
        await response.dispose();
      }
    };
    const originalGuide = await readGuide();
    const proposal = await json('proposals', { path: a.path, expectedHash: a.hash });
    const emptyDraft = await read(proposal.draft);
    await json('document', {
      path: proposal.draft,
      text: '旧顺序的候选，必须保留且不能静默接受',
      expectedHash: emptyDraft.hash,
    });
    await page.goto(origin + '/?novel=' + book.id);
    await page.locator('.novel-manuscript[data-book-id=' + JSON.stringify(book.id) + ']').waitFor();
    await page.locator('.novel-ms-heading > strong').filter({ hasText: book.title }).waitFor();
    await openChapter(page, a.path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    const local = a.text + '本机还没有提交的新段落';
    await fillEditor(editor, local);
    async function begin() {
      const nav = page.getByRole('navigation', { name: '章节导航', exact: true });
      await openChapterDirectory(page);
      await nav.getByRole('button', { name: '调整顺序', exact: true }).click();
      await page.getByRole('region', { name: '调整章节顺序', exact: true }).waitFor();
    }
    await begin();
    let order = page.getByRole('region', { name: '调整章节顺序', exact: true });
    const listKeys = () =>
      order.locator('[data-order-key]').evaluateAll((nodes) => nodes.map((node) => node.dataset.orderKey));
    assert.deepEqual(await listKeys(), [a.path, b.path, 'outline:3', c.path]);
    await order.getByRole('button', { name: '上移章节：自由丙', exact: true }).click();
    await order.getByRole('button', { name: '拖动章节：自由丙', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    assert.deepEqual(await listKeys(), [a.path, c.path, b.path, 'outline:3']);
    await order.getByRole('button', { name: '取消排序', exact: true }).click();
    await waitEditor(editor, local.replaceAll('\r\n', '\n'));
    assert.equal((await read('outline.json')).hash, originalOutline.hash);
    assert.equal((await read('rules.json')).hash, originalRules.hash);
    await begin();
    // Genuine touchscreen events exercise pointer capture and touch-action, not
    // a synthetic JS call to the reorder reducer.
    await page.setViewportSize({ width: 390, height: 900 });
    const grip = order.getByRole('button', { name: '拖动章节：自由丙', exact: true });
    assert.equal(
      await grip.evaluate((element) => getComputedStyle(element).touchAction),
      'none',
      'Chapter drag handle must retain touch-action:none, not generic tap gestures.',
    );
    const firstRow = order.locator('[data-order-key=' + JSON.stringify(a.path) + ']');
    // Native sidebar layout animates after changing the viewport. A raw CDP
    // touch has no Playwright actionability/stability wait of its own.
    await grip.click({ trial: true });
    await firstRow.scrollIntoViewIfNeeded();
    await grip.click({ trial: true });
    const from = await grip.boundingBox(),
      to = await firstRow.boundingBox();
    assert.ok(from && to);
    const touch = await context.newCDPSession(page);
    const x = from.x + from.width / 2,
      startY = from.y + from.height / 2,
      endY = to.y + 4;
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY, id: 1 }],
    });
    for (let step = 1; step <= 6; step++)
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY + ((endY - startY) * step) / 6, id: 1 }],
      });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
    await page.waitForFunction(
      (key) => document.querySelector('.novel-order-list > li')?.dataset.orderKey === key,
      c.path,
    );
    assert.deepEqual(await listKeys(), [c.path, a.path, b.path, 'outline:3']);
    // Browsing another part of the SAME workbench retains the staged ordering.
    await page.getByRole('button', { name: '设定', exact: true }).click();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    assert.deepEqual(await listKeys(), [c.path, a.path, b.path, 'outline:3']);
    await order.getByRole('button', { name: '预览重排', exact: true }).click();
    await order.getByRole('button', { name: '确认重排', exact: true }).waitFor();
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-native-chapter-order-' + width + '.png'),
        fullPage: true,
      });
    }
    // A real other-device edit invalidates the preview without losing the draft.
    const changedRules = await json('document', {
      path: 'rules.json',
      expectedHash: originalRules.hash,
      text: originalRules.text + '\n',
    });
    await order.getByRole('button', { name: '确认重排', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '关联资料已更新' }).waitFor();
    assert.equal((await read('outline.json')).hash, originalOutline.hash);
    assert.deepEqual(await listKeys(), [c.path, a.path, b.path, 'outline:3']);
    await order.getByRole('button', { name: '重新读取（放弃本次排序）', exact: true }).click();
    await order.getByRole('combobox', { name: '要移动的章节', exact: true }).selectOption(c.path);
    await order.getByRole('spinbutton', { name: '章节目标位置', exact: true }).fill('1');
    await order.getByRole('button', { name: '移动', exact: true }).click();
    await order.getByRole('button', { name: '预览重排', exact: true }).click();
    await order.getByRole('button', { name: '确认重排', exact: true }).waitFor();
    // Corrupt ONLY a fixture's second-file history. The first outline save must
    // roll back when the rules snapshot refuses to overwrite this bad history.
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const badHistory = book.root + '/.novel-history/' + hash('rules.json') + '/' + changedRules.hash + '.md';
    const badURL = origin + '/api/workspace/file?path=' + encodeURIComponent(badHistory);
    const placed = await apiClient.put(badURL, { data: '仅用于本地验证的损坏历史' });
    assert.equal(placed.status(), 200);
    await placed.dispose();
    const beforeHistory = await json('history?path=outline.json');
    await order.getByRole('button', { name: '确认重排', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '历史校验失败' }).waitFor();
    assert.equal((await read('outline.json')).hash, originalOutline.hash);
    assert.equal((await read('rules.json')).hash, changedRules.hash);
    assert.equal((await read('memory.json')).hash, originalMemory.hash);
    assert.equal((await read('canon.json')).hash, originalCanon.hash);
    assert.deepEqual(await json('history?path=outline.json'), beforeHistory);
    assert.equal((await json('review?id=' + proposal.id)).orderWarning, undefined);
    const removed = await apiClient.delete(badURL);
    assert.equal(removed.status(), 200);
    await removed.dispose();
    await order.getByRole('button', { name: '确认重排', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '顺序已保存' }).waitFor();
    await waitEditor(editor, local.replaceAll('\r\n', '\n'));
    for (const file of [a, b, c]) assert.equal((await read(file.path)).hash, file.hash);
    assert.equal(await provenance(), indexBytes);
    const guide = await readGuide();
    assert.ok(guide.startsWith(originalGuide));
    assert.match(guide, /当前章号、顺序及正文绑定以 outline.json/);
    assert.equal(guide.split('<!-- novel:chapter-order:v1:start -->').length, 2);
    const rows = JSON.parse((await read('outline.json')).text);
    assert.deepEqual(
      rows.map((row) => [row.chapter, row.chapterPath]),
      [
        [1, c.path],
        [2, a.path],
        [3, b.path],
        [4, null],
      ],
    );
    assert.deepEqual(rows[1].unknown, { chapter: 1 });
    const currentOutline = await read('outline.json');
    rows[1].summary = '另一设备只修改了章纲，正文与本机稿均未改变';
    const remoteOutline = await json('document', {
      path: 'outline.json',
      expectedHash: currentOutline.hash,
      text: JSON.stringify(rows),
    });
    await page
      .locator('.novel-manuscript[data-outline-hash=' + JSON.stringify(remoteOutline.hash) + ']')
      .waitFor();
    assert.equal(await readEditor(editor), local.replaceAll('\r\n', '\n'));
    assert.equal((await read(a.path)).hash, a.hash);
    const rules = JSON.parse((await read('rules.json')).text);
    assert.deepEqual(rules.creativeRules.chapterPOVOverrides, { 2: ['甲角色'], 3: ['乙角色'] });
    const memory = JSON.parse((await read('memory.json')).text);
    assert.equal(memory.memory.chapterCards[0].chapter, 2);
    assert.deepEqual(memory.chapterMemories[3].sourceChapters, [2]);
    assert.equal(memory.chapterMemories[3].sourceHash, '旧编号与正文的摘要校验');
    assert.equal(memory.chapterOrderReview.required, true);
    const canon = JSON.parse((await read('canon.json')).text);
    assert.equal(canon.characters[0].sourceChapter, 2);
    assert.equal(canon.characters[0].trust, 'manual');
    assert.deepEqual(canon.characters[0].customFields, { chapter: 1 });
    const stale = await json('review?id=' + proposal.id);
    assert.equal(stale.current.hash, proposal.baseHash);
    assert.ok(stale.orderWarning);
    await json('accept', { id: proposal.id, draftHash: stale.draft.hash }, 409);
    await openGenerationRecords(page);
    await page.locator('.novel-proposals button').filter({ hasText: '00001.md' }).click();
    assert.equal(await page.getByRole('button', { name: '接受改稿', exact: true }).isDisabled(), true);
    await page.getByText(stale.orderWarning, { exact: true }).waitFor();
    await page.getByRole('button', { name: '放弃', exact: true }).click();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await waitEditor(editor, local.replaceAll('\r\n', '\n'));
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    // The real UI refreshes current planning, and a second device changing it
    // between that read and proposal creation must stop BEFORE any model submit.
    let releasePreparation, preparationEntered;
    const ready = new Promise((resolve) => {
      preparationEntered = resolve;
    });
    const gate = new Promise((resolve) => {
      releasePreparation = resolve;
    });
    const route = '**' + api + 'proposals';
    let captured;
    await page.route(route, async (request) => {
      captured = request.request().postDataJSON();
      preparationEntered();
      await gate;
      await request.continue();
    });
    try {
      const shortcuts = page.locator('.novel-author-shortcuts');
      if (!(await shortcuts.evaluate((node) => node.open)))
        await shortcuts.locator(':scope > summary').click();
      await page.getByRole('button', { name: '写作', exact: true }).click();
      let deadline;
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Prose preparation never reached the guarded candidate API.')),
            15000,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
      assert.equal(captured.outlineHash, remoteOutline.hash);
      const latest = await read('outline.json');
      rows[1].summary = '准备过程中再次改变的规划';
      await json('document', { path: 'outline.json', expectedHash: latest.hash, text: JSON.stringify(rows) });
      releasePreparation();
      await page.locator('.novel-ms-status').filter({ hasText: '未基于旧规划创建 AI 任务' }).waitFor();
      assert.equal((await json('documents')).proposals.length, 0);
      assert.equal((await read(a.path)).text, local);
    } finally {
      releasePreparation();
      await page.unroute(route);
    }
    await page.getByRole('button', { name: '设定', exact: true }).click();
    await page.getByRole('button', { name: 'AI 记忆', exact: true }).click();
    await page.locator('.novel-order-review > summary').click();
    await page.getByRole('button', { name: '标记已核对（尚未保存）', exact: true }).click();
    assert.equal(JSON.parse((await read('memory.json')).text).chapterOrderReview.required, true);
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(JSON.parse((await read('memory.json')).text).chapterOrderReview.required, false);
    await page.reload();
    assert.equal((await read(a.path)).text, local);
    assert.equal((await read(a.path)).outline.chapter, 2);
    assert.equal(JSON.parse((await read('memory.json')).text).chapterOrderReview.required, false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(origin + '/?novel=' + restoreBookId);
    await page.locator('.novel-manuscript[data-book-id=' + JSON.stringify(restoreBookId) + ']').waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    const persisted = await json('chapter-order');
    console.log(
      'Native chapter order passed: genuine touch drag, buttons/Alt-key/jump, browsing/cancel, server preview/CAS, second-file-history failure atomic rollback, stable prose/provenance, POV/memory/canon references, stale-proposal refusal, unsaved body retained, explicit review/save/reload and 1280/768/390 layouts.',
    );
    return { id: book.id, version: persisted.version, keys: persisted.entries.map((entry) => entry.key) };
  } finally {
    await apiClient.dispose();
  }
}
