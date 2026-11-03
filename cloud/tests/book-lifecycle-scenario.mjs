import assert from 'node:assert/strict';
import { join } from 'node:path';
import { newFixtureApi } from './fixture-api.mjs';
import { waitEditor, openChapter } from './editor-client.mjs';

export async function verifyBookLifecycle({ page, context, origin, book, model, storage, screenshots }) {
  const http = await newFixtureApi(context);
  const marker = 'OLD_BOOK_CONTEXT_SENTINEL_732';
  const api = origin + '/api/novels/' + book.id + '/';
  async function json(response) {
    const data = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(data));
    return data;
  }
  try {
    for (const [path, text] of [
      ['memory.json', JSON.stringify({ memory: { old: marker } })],
      ['setting.md', marker],
      ['seed.md', marker],
      ['notes/story-plan.md', marker],
      ['drafts/old.md', marker],
    ]) {
      const current = await http.get(api + 'document?' + new URLSearchParams({ path }));
      const old = current.status() === 200 ? await current.json() : null;
      await json(await http.put(api + 'document', { data: { path, text, expectedHash: old?.hash ?? null } }));
    }
    await page.getByRole('link', { name: '小说库', exact: true }).click();
    const card = () => page.locator('.book[data-book-id="' + book.id + '"]');
    async function tools() {
      const details = card().locator('.book-tools');
      if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
    }
    await card().waitFor();
    // Cancelling must not move the book or leave a modal over the library.
    await tools();
    await card().getByRole('button', { name: '删除整本书', exact: true }).click();
    const panel = page.getByRole('region', { name: '管理小说', exact: true });
    await panel.getByRole('button', { name: '确认删除整本书', exact: true }).waitFor();
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    assert(storage.fs.existsSync(book.root + '/book.json'));
    await card().getByRole('button', { name: '删除整本书', exact: true }).click();
    await panel.getByRole('button', { name: '确认删除整本书', exact: true }).click();
    await card().waitFor({ state: 'detached' });
    assert(!storage.fs.existsSync(book.root + '/book.json'));
    assert.equal(
      storage.fs.readFileSync('/workspace/.novel-trash/books/' + book.id + '/memory.json', 'utf8'),
      JSON.stringify({ memory: { old: marker } }),
    );
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    await card().getByRole('button', { name: '恢复小说', exact: true }).click();
    await panel.getByRole('button', { name: '确认恢复小说', exact: true }).click();
    await card().waitFor({ state: 'detached' });
    assert.equal(storage.fs.readFileSync(book.root + '/setting.md', 'utf8'), marker);
    await page.getByRole('button', { name: '返回书库', exact: true }).click();
    await tools();
    await card().getByRole('button', { name: '重新开始', exact: true }).click();
    await panel.getByRole('button', { name: '确认重新开始', exact: true }).waitFor();
    assert.equal(await panel.getByLabel('重新开始的新灵感', { exact: true }).inputValue(), '');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: join(screenshots, 'book-restart-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.getByRole('button', { name: '确认重新开始', exact: true }).click();
    await page.locator('.novel-manuscript').waitFor({ timeout: 30000 });
    const books = await json(await http.get(origin + '/api/novels'));
    const fresh = books.books.find((b) => b.title === book.title && b.id !== book.id);
    assert(fresh && fresh.root !== book.root);
    assert.equal(storage.fs.readFileSync(fresh.root + '/seed.md', 'utf8'), '');
    for (const path of ['setting.md', 'memory.json', 'canon.json', 'rules.json', 'archive/source.json'])
      assert(!storage.fs.readFileSync(fresh.root + '/' + path, 'utf8').includes(marker), path);
    assert(!storage.fs.existsSync(fresh.root + '/notes/story-plan.md'));
    assert(!storage.fs.existsSync(fresh.root + '/drafts/old.md'));
    const prose =
      '# 错拿的箱子\n\n末班车进站时，她发现行李牌上的名字不是自己的。她把箱子放回长椅，叫住了刚才与她擦肩而过的乘客。\n';
    let chapterPath;
    const task = model.register({
      finalText: '独立新书已保存，没有沿用旧故事。',
      observe(body) {
        const wire = JSON.stringify(body);
        assert(!wire.includes(marker), 'Old story content leaked into the new native model request.');
        assert(!wire.includes(book.root), 'Old book path leaked into the new native model request.');
      },
      steps: [
        {
          name: 'novel_proposal_prepare',
          input: {
            instruction: '不要大纲，直接写错拿行李的新故事。',
            chapter: 1,
            without_outline: true,
          },
        },
        {
          name: 'novel_proposal_submit',
          input: ({ results, task }) => {
            const p = JSON.parse(results.get('fixture_' + task.id + '_0').text);
            chapterPath = p.target.slice(fresh.root.length + 1);
            return {
              proposal_id: p.proposalId,
              expected_hash: p.expectedHash,
              content: prose,
              complete: true,
            };
          },
          expected: '"published":true',
        },
      ],
    });
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
    const composer = page
      .locator('.novel-author-input [role="textbox"][contenteditable="true"]:visible')
      .first();
    await composer.fill(task.marker + ' 不要大纲，直接写错拿行李的新故事。');
    await composer.press('Enter');
    await page.getByText(task.finalText, { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(task.completedSteps, 2);
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
    assert(chapterPath?.startsWith('chapters/'));
    await openChapter(page, chapterPath);
    await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), prose);
    assert.equal(storage.fs.readFileSync(fresh.root + '/' + chapterPath, 'utf8'), prose);
    return { root: fresh.root, deleteRestoreAndRestart: true, oldMaterialsAbsentAtActualModelBoundary: true };
  } finally {
    await http.dispose();
  }
}
