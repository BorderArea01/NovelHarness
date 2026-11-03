import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newFixtureApi } from './fixture-api.mjs';
import { fillEditor, readEditor, waitEditor, openChapter, openHistory } from './editor-client.mjs';
// Independent localhost manuscript; never a personal book or paid provider.
export async function verifyHistoryBrowser({ page, context, origin, api, restorePath, root }) {
  const client = await newFixtureApi(context);
  try {
    const path = 'chapters/history-fixture.md';
    const get = async (target = path) => {
      const response = await client.get(origin + api + 'document?path=' + encodeURIComponent(target));
      assert.equal(response.status(), 200);
      const value = await response.json();
      await response.dispose();
      return value;
    };
    const put = async (text, expectedHash, target = path) => {
      const response = await client.put(origin + api + 'document', {
        data: { path: target, text, expectedHash },
      });
      assert.equal(response.status(), 200);
      const value = await response.json();
      await response.dispose();
      return value;
    };
    const a = await put('# 历史初稿\n\n姐姐没有回信。\n', null);
    const b = await put('# 历史初稿\n\n姐姐寄回了钥匙。\n', a.hash);
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await openChapter(page, path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true, includeHidden: true });
    await waitEditor(editor, b.text);
    const local = b.text + '\n本机尚未保存的第三段，不能因查看历史而丢失。';
    await fillEditor(editor, local);
    await editor.evaluate((el) => {
      window.__historyAuthorEditor = el;
    });
    let listFail = true;
    const historyRoute = '**' + api + 'history?*';
    await page.route(historyRoute, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') === path && !url.searchParams.has('hash') && listFail) {
        listFail = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '独立历史读取失败测试' }),
        });
      } else await route.continue();
    });
    await openHistory(page);
    const history = page.getByRole('region', { name: '历史版本', exact: true });
    await history.getByRole('alert').filter({ hasText: '独立历史读取失败测试' }).waitFor();
    assert.equal(await readEditor(editor), local);
    await history.getByRole('button', { name: '重试读取历史', exact: true }).click();
    const picker = history.getByRole('combobox', { name: '选择历史版本', exact: true });
    await picker.waitFor();
    await page.unroute(historyRoute);
    const preview = history.getByRole('textbox', { name: '历史版本预览', exact: true });
    await picker.selectOption(a.hash);
    await waitEditor(preview, a.text);
    assert.equal(await readEditor(editor), local, 'Selecting history must not edit the current draft.');
    assert.equal((await get()).hash, b.hash);
    await page.keyboard.press('ControlOrMeta+s');
    assert.equal((await get()).hash, b.hash, 'History cannot save the hidden draft through a shortcut.');
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (width <= 768) {
        await history.getByRole('button', { name: '当前稿', exact: true }).click();
        await history.getByRole('textbox', { name: '当前稿比较', exact: true }).waitFor({ state: 'visible' });
        await history.getByRole('button', { name: '历史稿', exact: true }).click();
      }
      await preview.waitFor({ state: 'visible' });
      assert.ok(await history.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-history-' + width + '.png'),
        fullPage: true,
      });
    }
    await fillEditor(preview, '不可写入的预览修改');
    assert.equal(await readEditor(preview), a.text);
    const downloadEvent = page.waitForEvent('download');
    await history.getByRole('button', { name: '下载当前稿', exact: true }).click();
    const savedDownload = resolve(root, 'test-results/cloud-history-current-draft.txt');
    await (await downloadEvent).saveAs(savedDownload);
    assert.equal(await readFile(savedDownload, 'utf8'), local);
    // Edge may create its internal Downloads bubble as another page. Keep the
    // application as the active test page rather than leaving its rendering
    // scheduler background-throttled after the real download assertion.
    await page.bringToFront();
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    const load = () => history.getByRole('button', { name: '载入此版本（尚未保存）', exact: true }).click();
    await load();
    await history.getByRole('button', { name: '取消替换', exact: true }).click();
    assert.equal(await readEditor(editor), local);
    await history.getByRole('button', { name: '返回编辑', exact: true }).click();
    await waitEditor(editor, local);
    assert.ok(
      await editor.evaluate((el) => window.__historyAuthorEditor === el),
      'Keep the original writable editor.',
    );
    // Explicit restore still only loads a draft, then original save/CAS commits.
    await openHistory(page);
    await picker.selectOption(a.hash);
    await waitEditor(preview, a.text);
    await load();
    await history.getByRole('button', { name: '确认替换未保存稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '历史版本已载入编辑区' }).waitFor();
    await waitEditor(editor, a.text);
    assert.equal((await get()).hash, b.hash);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal((await get()).hash, a.hash);
    await fillEditor(editor, local);
    // Out-of-order read delivery and leaving while a read is held.
    await openHistory(page);
    await picker.waitFor();
    let entered, release;
    const ready = new Promise((r) => {
      entered = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    await page.route(historyRoute, async (route) => {
      if (new URL(route.request().url()).searchParams.get('hash') === a.hash) {
        entered();
        await gate;
      }
      await route.continue();
    });
    await picker.selectOption(a.hash);
    await ready;
    await picker.selectOption(b.hash);
    await waitEditor(preview, b.text);
    assert.equal(await readEditor(editor), local);
    const third = await put(b.text + '\n云端第三版。', a.hash);
    await history.getByRole('button', { name: '返回编辑', exact: true }).click();
    const lateResponse = page.waitForResponse((r) => r.url().includes('hash=' + a.hash));
    release();
    await lateResponse;
    await page.unroute(historyRoute);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await history.count(), 0);
    assert.equal(await readEditor(editor), local);
    await openHistory(page);
    await picker.selectOption(a.hash);
    await waitEditor(preview, a.text);
    await load();
    await history.getByRole('button', { name: '确认替换未保存稿', exact: true }).click();
    await history.getByRole('alert').filter({ hasText: '云端版本已更新，当前稿未修改' }).waitFor();
    assert.equal(await readEditor(editor), local);
    assert.equal((await get()).hash, third.hash);
    await history.getByRole('button', { name: '返回编辑', exact: true }).click();
    const conflict = page.getByRole('region', { name: '三方冲突处理', exact: true });
    assert.equal(
      await conflict.count(),
      1,
      'Repeated history/compare navigation keeps exactly one original conflict editor.',
    );
    await conflict.getByRole('button', { name: '以云端为基线，手工合并', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已采用云端作为新基线' }).waitFor();
    assert.equal(await readEditor(editor), local);
    await openHistory(page);
    await picker.selectOption(a.hash);
    await waitEditor(preview, a.text);
    await load();
    await history.getByRole('button', { name: '确认替换未保存稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '历史版本已载入编辑区' }).waitFor();
    await waitEditor(editor, a.text);
    const fourth = await put(third.text + '\n载入后的云端第四版。', third.hash);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await conflict.waitFor();
    assert.equal(
      (await get()).hash,
      fourth.hash,
      'History never silently overwrites a newer formal revision.',
    );
    assert.equal(await readEditor(editor), a.text);
    await openChapter(page, restorePath);
    await page.setViewportSize({ width: 1280, height: 900 });
    const longPath = 'chapters/history-long-fixture.md';
    const longText =
      '\ufeff# 长篇历史\r\n' + '钟声从纸背传来，姐姐仍站在门外。\r\n'.repeat(24000) + '历史尾标\r\n';
    assert.ok(Buffer.byteLength(longText) > 1024 * 1024);
    const longA = await put(longText, null, longPath);
    const longB = await put(longText.replace('历史尾标', '当前尾标'), longA.hash, longPath);
    await openChapter(page, longPath);
    await waitEditor(editor, longB.text.replaceAll('\r\n', '\n'));
    await openHistory(page);
    await picker.selectOption(longA.hash);
    await waitEditor(preview, longText.replaceAll('\r\n', '\n'));
    await history.getByRole('button', { name: '定位首处变化', exact: true }).click();
    await page.waitForFunction(async () => {
      const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
      const el = document.querySelector('[aria-label="历史版本预览"]');
      const view = EditorView.findFromDOM(el);
      return view.viewport.to >= view.state.doc.length - 100;
    });
    assert.ok(
      (await preview.locator('.cm-line').count()) < 500,
      'Large snapshots must use original editor virtualization.',
    );
    assert.equal((await get(longPath)).hash, longB.hash);
    await page.bringToFront();
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    await load(); // A clean document needs no dirty-draft replacement question.
    await history.waitFor({ state: 'hidden', timeout: 30000 });
    await waitEditor(editor, longText.replaceAll('\r\n', '\n'));
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(
      (await get(longPath)).hash,
      longA.hash,
      'Restoring preserves original BOM/CRLF and all multipart bytes.',
    );
    await openChapter(page, restorePath);
    console.log(
      'Native history passed: read-only snapshots, full-page navigation, original editor/draft, 1440/768/390/320, safe download, read failure/retry, latest-only/cancelled read delivery, explicit dirty replacement, successful save and original CAS conflict. No provider or production writes.',
    );
  } catch (error) {
    console.error(
      'History diagnostic:',
      await page.evaluate(() => ({
        url: location.href,
        visible: document.visibilityState,
        focused: document.hasFocus(),
        histories: document.querySelectorAll('.novel-history').length,
        historyOpen: document.querySelector('.novel-ms-body')?.dataset.historyOpen,
      })),
      await page.locator('.novel-ms-status').allTextContents(),
      'author text:',
      await readEditor(page.locator('.cm-content[aria-label="书稿正文"]').first())
        .then((value) => ({ characters: value.length, head: value.slice(0, 100) }))
        .catch(() => 'unavailable'),
    );
    await page
      .screenshot({ path: resolve(root, 'test-results/cloud-history-failure.png'), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await client.dispose();
  }
}

export async function verifyHistoryPagination({ page, context, origin, api, restorePath, root }) {
  const client = await newFixtureApi(context);
  const path = 'chapters/paged-history-fixture.md';
  try {
    const snapshots = [];
    let current;
    for (let i = 0; i <= 107; i++) {
      const response = await client.put(origin + api + 'document', {
        data: { path, text: '# 分页历史\n版本 ' + i, expectedHash: current?.hash ?? null },
      });
      assert.equal(response.status(), 200);
      if (current) snapshots.push(current);
      current = await response.json();
      await response.dispose();
    }
    const originalHashes = new Set(snapshots.map((s) => s.hash));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await openChapter(page, path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true, includeHidden: true });
    await waitEditor(editor, current.text);
    const local = current.text + '\n未保存的分页测试稿';
    await fillEditor(editor, local);
    await openHistory(page);
    const history = page.getByRole('region', { name: '历史版本', exact: true });
    const picker = history.getByRole('combobox', { name: '选择历史版本', exact: true });
    await picker.waitFor();
    const options = () => picker.evaluate((el) => [...el.options].map((o) => o.value).filter(Boolean));
    assert.equal((await options()).length, 50);
    await picker.selectOption(snapshots.at(-1).hash);
    const preview = history.getByRole('textbox', { name: '历史版本预览', exact: true });
    await waitEditor(preview, snapshots.at(-1).text);
    const routePattern = '**' + api + 'history?*';
    let failMore = true;
    await page.route(routePattern, async (route) => {
      if (new URL(route.request().url()).searchParams.has('after') && failMore) {
        failMore = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '更早历史读取失败测试' }),
        });
      } else await route.continue();
    });
    await history.getByRole('button', { name: '读取更早版本', exact: true }).click();
    await history.getByRole('alert').filter({ hasText: '更早历史读取失败测试' }).waitFor();
    assert.equal((await options()).length, 50);
    assert.equal(await readEditor(preview), snapshots.at(-1).text);
    assert.equal(await readEditor(editor), local);
    await history.getByRole('button', { name: '重试读取更早版本', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('select[aria-label="选择历史版本"]')?.options.length === 101,
    );
    await page.unroute(routePattern);
    // A newer formal save must not shift the older-record continuation window.
    const update = await client.put(origin + api + 'document', {
      data: { path, text: '# 分页历史\n分页期间的云端新稿', expectedHash: current.hash },
    });
    assert.equal(update.status(), 200);
    const latest = await update.json();
    await update.dispose();
    await history.getByRole('button', { name: '读取更早版本', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('select[aria-label="选择历史版本"]')?.options.length === 108,
    );
    const all = await options();
    assert.equal(new Set(all).size, 107);
    assert.deepEqual(new Set(all), originalHashes);
    assert.equal(await history.getByRole('button', { name: '读取更早版本', exact: true }).count(), 0);
    await picker.selectOption(snapshots[0].hash);
    await waitEditor(preview, snapshots[0].text);
    assert.equal(await readEditor(editor), local);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-history-older-mobile.png'),
      fullPage: true,
    });
    await history.getByRole('button', { name: '返回编辑', exact: true }).click();
    // Closing an in-flight older-page request is immediate and drops its result.
    await openHistory(page);
    await picker.waitFor();
    let entered, release;
    const ready = new Promise((r) => {
      entered = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    await page.route(routePattern, async (route) => {
      if (new URL(route.request().url()).searchParams.has('after')) {
        entered();
        await gate;
      }
      await route.continue();
    });
    await history.getByRole('button', { name: '读取更早版本', exact: true }).click();
    await ready;
    await history.getByRole('button', { name: '返回编辑', exact: true }).click();
    const pendingResponse = page.waitForResponse((r) => new URL(r.url()).searchParams.has('after'));
    release();
    await (await pendingResponse).finished();
    await page.unroute(routePattern);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await history.count(), 0);
    assert.equal(await readEditor(editor), local);
    const unchanged = await client.get(origin + api + 'document?path=' + encodeURIComponent(path));
    assert.equal((await unchanged.json()).hash, latest.hash);
    await unchanged.dispose();
    const invalid = await client.get(
      origin + api + 'history?path=' + encodeURIComponent(path) + '&after=invalid',
    );
    assert.equal(invalid.status(), 400);
    await invalid.dispose();
    await openChapter(page, restorePath);
    await page.setViewportSize({ width: 1280, height: 900 });
    console.log(
      'Native history pagination passed: 107 real immutable revisions over three HTTP pages, oldest full snapshot, concurrent newer save without lost/duplicate original rows, inline older-page error/retry with preview/draft intact, cancelled read cannot reopen the page, malformed cursor rejected, no provider or production writes.',
    );
  } finally {
    await client.dispose();
  }
}
