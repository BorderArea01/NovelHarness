import { newFixtureApi } from './fixture-api.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fillEditor, readEditor, waitEditor, openChapter } from './editor-client.mjs';
// Real browser IndexedDB and original localhost VFS. No personal cloud writes.
export async function verifyDraftRecovery({ page, context, origin, api, bookId, restorePath, root }) {
  const apiClient = await newFixtureApi(context);
  try {
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    const path = 'chapters/cache-fixture.md',
      key = 'novel-unsubmitted:' + bookId + ':' + path;
    const get = async () => {
      const r = await apiClient.get(origin + api + 'document?path=' + encodeURIComponent(path));
      try {
        assert.equal(r.status(), 200);
        return await r.json();
      } finally {
        await r.dispose();
      }
    };
    const created = await apiClient.put(origin + api + 'document', {
      data: { path, text: '云端基线', expectedHash: null },
    });
    assert.equal(created.status(), 200);
    const original = await created.json();
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key,
      value: { hash: original.hash, baseText: original.text, text: '旧版未提交稿' },
    });
    await openChapter(page, path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(editor, '旧版未提交稿');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
    assert.equal((await get()).text, original.text, 'Cache migration does not publish a manuscript.');
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key,
      value: { hash: original.hash, baseText: original.text, text: '旧页面的另一份未保存稿' },
    });
    await page.reload();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await openChapter(page, path);
    await waitEditor(editor, '旧版未提交稿');
    await page.getByText('发现旧页面的另一份本机草稿', { exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载旧页面草稿', exact: true }).click();
    const download = await downloading,
      downloadPath = resolve(root, 'test-results/legacy-draft-fixture.txt');
    await download.saveAs(downloadPath);
    assert.equal(await readFile(downloadPath, 'utf8'), '旧页面的另一份未保存稿');
    await page.evaluate((key) => localStorage.removeItem(key), key); // only our fixture
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    // Much larger than a safe localStorage base+text pair, without changing OS
    // clipboard, creating cloud files or printing the synthetic large payload.
    const largeKey = 'novel-unsubmitted:' + bookId + ':notes/large-cache-only.txt';
    await page.evaluate(async (key) => {
      const { writeDraft } = await import('/novel-assets/draft-cache.mjs');
      const baseText = 'a'.repeat(1700000);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(baseText));
      const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
      await writeDraft(key, { hash, baseText, text: baseText.slice(0, -1) + 'b' });
    }, largeKey);
    await page.reload();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    const large = await page.evaluate(async (key) => {
      const cache = await import('/novel-assets/draft-cache.mjs');
      const before = await cache.readDraft(key);
      await cache.settleDraft(key, {
        previousHash: before.hash,
        hash: 'e'.repeat(64),
        text: '另一页面保存的内容',
      });
      const foreign = await cache.readDraft(key);
      if (foreign.hash !== before.hash) throw new Error('Another page cache was silently rebased.');
      await cache.writeDraft(key, {
        hash: before.hash,
        baseText: before.baseText,
        text: '保存期间新增的本机稿',
      });
      await cache.settleDraft(key, {
        previousHash: before.hash,
        hash: 'e'.repeat(64),
        text: '本页刚保存的旧稿',
      });
      const own = await cache.readDraft(key);
      await cache.settleDraft(key, { previousHash: own.hash, hash: own.hash, text: own.text });
      return {
        length: before.baseText.length,
        tail: before.text.at(-1),
        rebased:
          own.hash === 'e'.repeat(64) &&
          own.baseText === '本页刚保存的旧稿' &&
          own.text === '保存期间新增的本机稿',
        removed: (await cache.readDraft(key)) === null,
      };
    }, largeKey);
    assert.deepEqual(large, { length: 1700000, tail: 'b', rebased: true, removed: true });
    await openChapter(page, path);
    await waitEditor(editor, '旧版未提交稿');
    await fillEditor(editor, '准备提交的 A 稿');
    let release,
      continued,
      entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const forwarded = new Promise((resolve) => {
      continued = resolve;
    });
    const routeURL = origin + api + 'document';
    await page.route(routeURL, async (route) => {
      entered = true;
      await gate;
      await route.continue();
      continued();
    });
    const response = page.waitForResponse((r) => r.url() === routeURL && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    const deadline = Date.now() + 10000;
    while (!entered) {
      if (Date.now() > deadline) throw new Error('Fixture save was not intercepted.');
      await new Promise((r) => setTimeout(r, 50));
    }
    await fillEditor(editor, 'A 保存期间继续输入的 B 稿');
    assert.equal(
      await page.evaluate(
        async (key) => (await (await import('/novel-assets/draft-cache.mjs')).readDraft(key)).text,
        key,
      ),
      'A 保存期间继续输入的 B 稿',
    );
    release();
    await forwarded;
    await page.unroute(routeURL);
    assert.equal((await response).status(), 200);
    await page.locator('.novel-ms-status').filter({ hasText: '当前新修改尚未保存' }).waitFor();
    assert.equal((await get()).text, '准备提交的 A 稿');
    await page.reload();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await openChapter(page, path);
    await waitEditor(editor, 'A 保存期间继续输入的 B 稿');
    assert.equal(await page.getByRole('region', { name: '三方冲突处理', exact: true }).count(), 0);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    // Inject only this cache database's write denial, not native session storage.
    await page.evaluate(() => {
      globalThis.__fixtureDraftTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === 'novel-unsubmitted-v1' && args[1] === 'readwrite')
          throw new DOMException('Fixture quota denial', 'QuotaExceededError');
        return globalThis.__fixtureDraftTransaction.apply(this, args);
      };
    });
    try {
      await fillEditor(editor, '缓存失败时必须仍可取回的稿');
      await page.locator('.novel-ms-status').filter({ hasText: '存储失败' }).waitFor();
      await openChapter(page, restorePath);
      await page.locator('.novel-ms-status').filter({ hasText: '未切换文件' }).waitFor();
      assert.equal(await readEditor(editor), '缓存失败时必须仍可取回的稿');
      assert.equal((await get()).text, 'A 保存期间继续输入的 B 稿');
    } finally {
      await page.evaluate(() => {
        IDBDatabase.prototype.transaction = globalThis.__fixtureDraftTransaction;
        delete globalThis.__fixtureDraftTransaction;
      });
    }
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    await openChapter(page, restorePath);
    console.log(
      'Native draft cache passed: verified legacy migration/alternative download, 1.7M-character base+draft reload, per-page rebase ownership, real pending-save newer-input recovery and write-denial navigation refusal.',
    );
  } finally {
    await apiClient.dispose();
  }
}
