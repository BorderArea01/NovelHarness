import { newFixtureApi } from './fixture-api.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fillEditor, readEditor, waitEditor, openChapter } from './editor-client.mjs';
import { visibleViewportFixture } from './visible-viewport-fixture.mjs';
// All writes are to this test's independent localhost native VFS, never public.
export async function verifyThreeWayMerge({ page, context, origin, api, bookId, restorePath, root }) {
  const apiClient = await newFixtureApi(context);
  try {
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    const path = 'chapters/merge-fixture.md';
    const read = async (target = path) => {
      const response = await apiClient.get(origin + api + 'document?path=' + encodeURIComponent(target));
      assert.equal(response.status(), 200);
      return response.json();
    };
    const put = async (text, hash, target = path) => {
      const response = await apiClient.put(origin + api + 'document', {
        data: { path: target, text, expectedHash: hash },
      });
      assert.equal(response.status(), 200);
      return response.json();
    };
    const baseText = '# 三方合并\n原第一段\n\n保持的中间段\n\n原末段\n';
    const initial = await put(baseText, null);
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await openChapter(page, path);
    const text = page.getByRole('textbox', { name: '书稿正文', exact: true });
    const region = page.getByRole('region', { name: '三方冲突处理', exact: true });
    const local = baseText.replace('原第一段', '本机独立修改'),
      remote = baseText.replace('原末段', '云端独立修改');
    await fillEditor(text, local);
    const latest = await put(remote, initial.hash);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await region.waitFor();
    await region.getByRole('button', { name: '对比并合并', exact: true }).click();
    const preview = region.getByRole('textbox', { name: '合并结果预览', exact: true });
    await preview.waitFor();
    const combined = baseText.replace('原第一段', '本机独立修改').replace('原末段', '云端独立修改');
    assert.equal(await preview.inputValue(), combined);
    assert.equal((await read()).text, remote, 'Preview must never auto-publish.');
    await region.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '三方合并结果已载入' }).waitFor();
    const cacheKey = 'novel-unsubmitted:' + bookId + ':' + path;
    const cached = await page.evaluate(
      async (key) => (await import('/novel-assets/draft-cache.mjs')).readDraft(key),
      cacheKey,
    );
    assert.equal(cached.hash, latest.hash);
    assert.equal(cached.baseText, remote);
    assert.equal(cached.text, combined);
    await page.reload();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await openChapter(page, path);
    await waitEditor(text, combined);
    assert.equal(await region.count(), 0, 'Reload uses the rebased local draft, not the obsolete base.');
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    const saved = await read();
    assert.equal(saved.text, combined);
    const versions = await (
      await apiClient.get(origin + api + 'history?path=' + encodeURIComponent(path))
    ).json();
    assert.ok(versions.versions.some((v) => v.hash === initial.hash));
    assert.ok(versions.versions.some((v) => v.hash === latest.hash));
    const local2 = combined.replace('本机独立修改', '本机重叠修改'),
      remote2 = combined.replace('本机独立修改', '云端重叠修改');
    await fillEditor(text, local2);
    const r2 = await put(remote2, saved.hash);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await region.getByRole('button', { name: '对比并合并', exact: true }).click();
    await region.getByRole('button', { name: '冲突 1 使用本机', exact: true }).click();
    await preview.waitFor();
    let entered = false,
      release,
      completeRead;
    const readCompleted = new Promise((resolve) => {
      completeRead = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const readRoute = new RegExp('/api/novels/' + bookId + '/document\\?path=chapters%2Fmerge-fixture\\.md$');
    await page.route(readRoute, async (route) => {
      entered = true;
      await gate;
      await route.continue();
      completeRead();
    });
    await region.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true }).click();
    await page.waitForFunction(() => true); // Keep browser responsive during the held network read.
    const until = Date.now() + 10000;
    while (!entered) {
      if (Date.now() > until) throw new Error('Merge apply did not reread the original VFS.');
      await new Promise((r) => setTimeout(r, 50));
    }
    const remote3 = remote2.replace('云端独立修改', '云端第二次更新');
    await put(remote3, r2.hash);
    release();
    await readCompleted;
    await page.unroute(readRoute);
    await region.getByText('原文或本机稿已有变化，旧比较已失效；请重新对比。', { exact: true }).waitFor();
    assert.equal(await readEditor(text), local2);
    assert.equal((await read()).text, remote3);
    assert.equal(
      await region.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true }).isDisabled(),
      true,
    );
    await region.getByRole('button', { name: '重新对比并合并', exact: true }).click();
    await region.getByRole('button', { name: '手动解决冲突 1', exact: true }).click();
    await region
      .getByRole('textbox', { name: '冲突 1 手动结果', exact: true })
      .fill('手动保留双方意图的新段落\n');
    await preview.waitFor();
    assert.match(await preview.inputValue(), /手动保留双方/);
    assert.match(await preview.inputValue(), /云端第二次更新/);
    const manual = region.getByRole('textbox', { name: '冲突 1 手动结果', exact: true });
    const { visibleViewport, restoreViewport } = visibleViewportFixture(page);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const field of [manual, preview]) {
        await field.focus();
        await visibleViewport(320, 18);
        await page.waitForFunction(
          (label) => {
            const el = [...document.querySelectorAll('textarea')].find(
              (e) => e.getAttribute('aria-label') === label,
            );
            const r = el.getBoundingClientRect(),
              b = el.closest('.novel-ms-body').getBoundingClientRect();
            return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.height >= 60;
          },
          await field.getAttribute('aria-label'),
        );
        assert.equal(await manual.inputValue(), '手动保留双方意图的新段落\n');
        assert.equal((await read()).text, remote3, 'Keyboard presentation cannot publish a merge.');
        await page.screenshot({
          path: resolve(
            root,
            'test-results/cloud-mobile-merge-keyboard-' +
              width +
              (field === manual ? '-manual' : '-preview') +
              '.png',
          ),
          fullPage: true,
        });
        await restoreViewport();
        await page.locator('.novel-author-dock').waitFor({ state: 'visible' });
      }
    }
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [768, 1024, 'tablet'],
      [390, 844, 'mobile'],
    ]) {
      await page.setViewportSize({ width, height });
      if (width === 768 && (await page.getByRole('button', { name: '展开书稿', exact: true }).isVisible()))
        await page.getByRole('button', { name: '展开书稿', exact: true }).click();
      await region.getByRole('heading', { name: '保存冲突', exact: true }).scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await region.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-native-merge-' + name + '.png'),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const loadMerged = region.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true });
    await loadMerged.focus();
    await page.locator('.novel-author-dock').waitFor({ state: 'visible' });
    await visibleViewport(320, 18);
    await page.waitForFunction(
      () => Math.abs(document.querySelector('.novel-native-frame').getBoundingClientRect().height - 320) < 1,
    );
    assert.ok(
      await page.locator('.novel-ms-body').evaluate((el) => el.clientHeight >= 60),
      'Moving focus to the apply button must not restore a dock that collapses the editor.',
    );
    await loadMerged.click();
    await page.locator('.novel-ms-status').filter({ hasText: '三方合并结果已载入' }).waitFor();
    assert.equal((await read()).text, remote3, 'Loading a merge still does not save it.');
    await restoreViewport();
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.match((await read()).text, /手动保留双方/);
    assert.match((await read()).text, /云端第二次更新/);
    // Applying a merge is not a lock: a later remote write must still win CAS.
    const beforeLate = await read();
    const localLate = beforeLate.text.replace('保持的中间段', '本机最后的中间段');
    const remoteLate = beforeLate.text.replace('云端第二次更新', '云端第三次更新');
    await fillEditor(text, localLate);
    const lateVersion = await put(remoteLate, beforeLate.hash);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await region.getByRole('button', { name: '对比并合并', exact: true }).click();
    await preview.waitFor();
    await region.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '三方合并结果已载入' }).waitFor();
    const appliedText = await readEditor(text);
    const finalRemote = remoteLate.replace('云端第三次更新', '云端载入后再次更新');
    await put(finalRemote, lateVersion.hash);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await region.waitFor();
    assert.equal((await read()).text, finalRemote);
    assert.equal(await readEditor(text), appliedText);
    // The actual authenticated module Worker verifies the SHA-256 common base.
    const badBase = await page.evaluate(
      async () =>
        new Promise((resolve, reject) => {
          const worker = new Worker('/novel-assets/merge-worker.mjs', { type: 'module' });
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('Worker did not respond.'));
          }, 5000);
          worker.onmessage = ({ data }) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(data);
          };
          worker.onerror = () => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error('Worker unavailable.'));
          };
          worker.postMessage({
            path: 'chapters/fixture.md',
            base: '',
            local: '本机',
            remote: '云端',
            baseHash: '0'.repeat(64),
            remoteHash: '0'.repeat(64),
          });
        }),
    );
    assert.match(badBase.error, /共同基线校验失败/);
    const deletedPath = 'chapters/merge-deleted-fixture.md';
    await put('云端原文', null, deletedPath);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openChapter(page, 'chapters/merge-deleted-fixture.md');
    await fillEditor(text, '文件被删前的本机修改');
    const absolute = '/workspace/novels/' + bookId + '/' + deletedPath;
    assert.ok(
      absolute.startsWith('/workspace/novels/b-') && absolute.endsWith('/chapters/merge-deleted-fixture.md'),
    );
    assert.ok(
      (await apiClient.delete(origin + '/api/workspace/file?path=' + encodeURIComponent(absolute))).ok(),
    );
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await region
      .getByText('云端文件已删除。本机稿仍保留，请另存或下载；不会自动重建旧文件。', { exact: true })
      .waitFor();
    assert.equal(await region.getByRole('button', { name: '对比并合并', exact: true }).isDisabled(), true);
    assert.equal(await readEditor(text), '文件被删前的本机修改');
    assert.equal(
      (await apiClient.get(origin + api + 'document?path=' + encodeURIComponent(deletedPath))).status(),
      404,
    );
    await openChapter(page, restorePath);
    console.log(
      'Native three-way merge passed: real Worker/SHA, separate changes, manual overlap, concurrent remote update refusal, restart-safe rebase, CAS/history, remote deletion and 1280/768/390 layouts.',
    );
  } finally {
    await apiClient.dispose();
  }
}
