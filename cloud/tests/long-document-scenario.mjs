import { newFixtureApi } from './fixture-api.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fillEditor, readEditor, waitEditor, openChapter, openGenerationRecords } from './editor-client.mjs';
// Independent localhost VFS only. No deployment credentials or paid provider.
export async function verifyLongDocuments({ page, context, origin, api, restorePath, root }) {
  const apiClient = await newFixtureApi(context);
  try {
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    const original =
      '\ufeff首段\r\n' +
      Array.from({ length: 18000 }, (_, i) => '第' + i + '段，钟声仍在远处，人物走过长街。\r\n').join('') +
      '尾段🌧️\r\n';
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    const domHash = (text) => sha(text.replaceAll('\r\n', '\n'));
    assert.ok(Buffer.byteLength(original) > 512 * 1024);
    const path = 'chapters/long-fixture.md';
    const read = async (route = 'document?path=' + encodeURIComponent(path), prefix = api) => {
      const r = await apiClient.get(origin + prefix + route);
      try {
        assert.equal(r.status(), 200);
        return await r.json();
      } finally {
        await r.dispose();
      }
    };
    const put = async (text, expectedHash) => {
      const r = await apiClient.put(origin + api + 'document', { data: { path, text, expectedHash } });
      try {
        assert.equal(r.status(), 200);
        return await r.json();
      } finally {
        await r.dispose();
      }
    };
    const first = await put(original, null);
    console.log('Long document native API created; opening the original editor.');
    assert.equal(first.hash, sha(original));
    assert.ok(first.parts.length > 1);
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await openChapter(page, path);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(editor, original.replaceAll('\r\n', '\n'));
    assert.equal(sha(await readEditor(editor)), domHash(original));
    const viewStats = await editor.evaluate(async (el) => {
      const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
      const view = EditorView.findFromDOM(el);
      return {
        renderedLines: el.querySelectorAll('.cm-line').length,
        visible: view.viewport.to - view.viewport.from,
        total: view.state.doc.length,
        height: view.scrollDOM.clientHeight,
      };
    });
    console.log('Long editor viewport:', JSON.stringify(viewStats));
    assert.ok(
      viewStats.renderedLines < 200 && viewStats.visible < viewStats.total && viewStats.height < 1000,
    );
    console.log('Long document complete in virtual editor; testing paste input.');
    const local = original.replace('首段', '作者完整长章开场');
    await fillEditor(editor, local);
    await editor.press('ControlOrMeta+z');
    await waitEditor(editor, original.replaceAll('\r\n', '\n'));
    await editor.press('Control+y');
    await waitEditor(editor, local.replaceAll('\r\n', '\n'));
    console.log('Long document browser input returned; saving.');
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    const saved = await read();
    assert.equal(saved.hash, sha(local));
    const history = await read('history?path=' + encodeURIComponent(path) + '&hash=' + first.hash);
    assert.equal(sha(history.text), first.hash);
    await page.reload();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await openChapter(page, path);
    await waitEditor(editor, local.replaceAll('\r\n', '\n'));
    assert.equal(sha(await readEditor(editor)), domHash(local));
    // Actual UI comparison/acceptance of a selected-range candidate preserves the
    // entire unselected prefix/tail, not just the currently visible textarea area.
    const start = local.indexOf('尾段'),
      end = start + '尾段🌧️'.length;
    const proposed = await apiClient.post(origin + api + 'proposals', {
      data: { path, expectedHash: saved.hash, edit: { start, end } },
    });
    assert.equal(proposed.status(), 200);
    const proposal = await proposed.json();
    const bookId = api.split('/')[3];
    assert.ok(
      (
        await apiClient.put(
          origin +
            '/api/workspace/file?path=' +
            encodeURIComponent('/workspace/novels/' + bookId + '/' + proposal.draft),
          { data: '经过修改的尾段🌧️' },
        )
      ).ok(),
    );
    await openGenerationRecords(page);
    await page.locator('.novel-proposals button').filter({ hasText: 'long-fixture.md' }).click();
    await page.getByText('本次仅替换选中段落，其余全文保持不变。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '接受改稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
    const expected = local.slice(0, start) + '经过修改的尾段🌧️' + local.slice(end);
    assert.equal((await read()).hash, sha(expected));
    assert.equal(sha(await readEditor(editor)), domHash(expected));
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [768, 1024, 'tablet'],
      [390, 844, 'mobile'],
    ]) {
      await page.setViewportSize({ width, height });
      if (width === 768 && (await page.getByRole('button', { name: '展开书稿', exact: true }).isVisible()))
        await page.getByRole('button', { name: '展开书稿', exact: true }).click();
      await editor.evaluate(async (el) => {
        const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
        const view = EditorView.findFromDOM(el);
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length) });
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal((await readEditor(editor)).endsWith('经过修改的尾段🌧️\n'), true);
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-native-long-' + name + '.png'),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // Importer's historic fragments have no runtime layout receipt yet. Read the
    // complete existing chapter/outline without modifying or converting either.
    const legacy = await page.evaluate(async () => {
      const { makeBookBundle } = await import('/novel-assets/bundle.mjs');
      const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
      const body = '\ufeff' + '旧版长章正文🌧️。\r\n'.repeat(30000);
      const outline = [
        {
          chapter: 7,
          title: '原版长大纲',
          summary: '选择引出代价，代价迫使下一步行动。'.repeat(16000),
          plotPoints: [],
        },
      ];
      const bundle = await makeBookBundle({
        state: { project: { title: '仅本地分片验收' }, chapters: [{ chapter: 7, content: body }], outline },
      });
      const book = (await makeWorkspaceClient().import(bundle)).book;
      const { digest } = await import('/novel-assets/bundle.mjs');
      return {
        id: book.id,
        bodyHash: await digest(body),
        outlineHash: await digest(JSON.stringify(outline, null, 2)),
        tail: bundle.files.filter((f) => f.path.startsWith('chapters/')).at(-1),
      };
    });
    const legacyApi = '/api/novels/' + legacy.id + '/';
    const chapter = await read('document?path=chapters%2F00001.md', legacyApi);
    const outline = await read('document?path=outline.json', legacyApi);
    assert.equal(chapter.hash, legacy.bodyHash);
    assert.equal(outline.hash, legacy.outlineHash);
    assert.ok(chapter.parts.length > 1 && outline.parts.length > 1);
    const linked = await apiClient.post(origin + legacyApi + 'outline-chapter', {
      data: { chapter: 7, expectedHash: outline.hash },
    });
    assert.equal(linked.status(), 200);
    assert.equal((await linked.json()).path, 'chapters/00001.md');
    await linked.dispose();
    const markerURL =
      origin +
      '/api/workspace/file?path=' +
      encodeURIComponent('/workspace/novels/' + legacy.id + '/chapters/00001.md.parts.json');
    assert.equal((await apiClient.get(markerURL)).status(), 404, 'Reading migrated text does not mutate it.');
    const tailURL =
      origin +
      '/api/workspace/file?path=' +
      encodeURIComponent('/workspace/novels/' + legacy.id + '/' + legacy.tail.path);
    assert.ok((await apiClient.delete(tailURL)).ok());
    assert.equal(
      (await apiClient.get(origin + legacyApi + 'document?path=chapters%2F00001.md')).status(),
      409,
      'Missing legacy tail cannot masquerade as complete prose.',
    );
    assert.ok((await apiClient.put(tailURL, { data: legacy.tail.content })).ok());
    assert.equal((await read('document?path=chapters%2F00001.md', legacyApi)).hash, legacy.bodyHash);
    const nativePath = 'chapters/native-direct.md',
      nativeText = '原生单文件。\r\n'.repeat(30000);
    const nativeURL =
      origin +
      '/api/workspace/file?path=' +
      encodeURIComponent('/workspace/novels/' + legacy.id + '/' + nativePath);
    assert.ok((await apiClient.put(nativeURL, { data: nativeText })).ok());
    const nativeDoc = await read('document?path=' + encodeURIComponent(nativePath), legacyApi);
    assert.equal(nativeDoc.hash, sha(nativeText));
    assert.equal(nativeDoc.parts, undefined);
    const updatedNative = await apiClient.put(origin + legacyApi + 'document', {
      data: { path: nativePath, text: nativeText + '作者补充', expectedHash: nativeDoc.hash },
    });
    assert.equal(updatedNative.status(), 200);
    const migratedNative = await updatedNative.json();
    await updatedNative.dispose();
    assert.ok(migratedNative.parts.length > 1);
    assert.equal(migratedNative.hash, sha(nativeText + '作者补充'));
    assert.equal(
      (await read('history?path=' + encodeURIComponent(nativePath) + '&hash=' + nativeDoc.hash, legacyApi))
        .hash,
      nativeDoc.hash,
    );
    await openChapter(page, restorePath);
    console.log(
      'Native long documents passed: complete >512KiB editor/save/reload/scoped acceptance/history, 1280/768/390, real legacy chapter and outline aggregation, non-mutating reads and missing-tail refusal.',
    );
  } finally {
    await apiClient.dispose();
  }
}
