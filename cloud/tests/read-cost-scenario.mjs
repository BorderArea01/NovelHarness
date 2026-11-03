import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readEditor, waitEditor } from './editor-client.mjs';

export async function verifyReadCosts({ page, context, origin, workerOrigin, model, root, waitFor }) {
  const booksResponse = await context.request.get(origin + '/api/novels');
  const book = (await booksResponse.json()).books[0];
  await booksResponse.dispose();
  assert.ok(book?.id);
  const api = origin + '/api/novels/' + book.id + '/';
  const write = async (path, text, expectedHash = null) => {
    const response = await context.request.put(api + 'document', { data: { path, text, expectedHash } });
    assert.equal(response.status(), 200);
    const value = await response.json();
    await response.dispose();
    return value;
  };
  const measure = async (route) => {
    const target = '/__novel_editor/' + book.id + '/' + route;
    const response = await context.request.get(
      workerOrigin + '/api/__local_read_cost?target=' + encodeURIComponent(target),
    );
    assert.equal(response.status(), 200);
    const value = await response.json();
    await response.dispose();
    assert.equal(value.status, 200);
    return value;
  };
  for (let i = 1; i <= 60; i++)
    await write('chapters/cost-' + i + '.md', '# 第 ' + i + ' 章\n\n测试正文不涉及正式作品。');
  const cold = await measure('documents');
  assert.equal(cold.value.documents.filter((d) => d.category === 'chapter').length, 60);
  const warm = await measure('documents');
  assert.ok(warm.rowsRead <= 2, JSON.stringify({ warm: warm.rowsRead, queries: warm.queries }));
  assert.equal(warm.rowsWritten, 0);
  assert.deepEqual(warm.value, cold.value);
  const docCold = await measure('document?path=chapters/cost-1.md');
  const docWarm = await measure('document?path=chapters/cost-1.md');
  assert.ok(docWarm.rowsRead <= 2);
  const version = await measure('changes');
  assert.ok(version.rowsRead <= 2);
  assert.equal(version.rowsWritten, 0);
  console.log(
    'Measured native SQL rows (60 chapters):',
    JSON.stringify({
      cold: cold.rowsRead,
      warm: warm.rowsRead,
      documentCold: docCold.rowsRead,
      documentWarm: docWarm.rowsRead,
      revision: version.rowsRead,
    }),
  );
  let repeatedRows = 0;
  for (let i = 0; i < 40; i++) repeatedRows += (await measure('changes')).rowsRead;
  assert.ok(repeatedRows <= 80);
  // Original native file API, not our editor, must invalidate the snapshot.
  const nativeWrite = await context.request.put(
    origin + '/api/workspace/file?path=' + encodeURIComponent(book.root + '/chapters/cost-1.md'),
    {
      data: '# 原生工具修改\n\n其他设备已修改的正文。',
      headers: { 'content-type': 'text/plain' },
    },
  );
  assert.equal(nativeWrite.status(), 200);
  await nativeWrite.dispose();
  const changed = await measure('changes');
  assert.notEqual(changed.value.revision, version.value.revision);
  const updated = await measure('document?path=chapters/cost-1.md');
  assert.match(updated.value.text, /其他设备已修改/);
  assert.notEqual(updated.value.hash, docCold.value.hash);
  const conflict = await context.request.put(api + 'document', {
    data: {
      path: 'chapters/cost-1.md',
      text: '过期设备不能覆盖',
      expectedHash: docCold.value.hash,
    },
  });
  assert.equal(conflict.status(), 409);
  await conflict.dispose();
  const nativeDelete = await context.request.delete(
    origin + '/api/workspace/file?path=' + encodeURIComponent(book.root + '/chapters/cost-60.md'),
  );
  assert.equal(nativeDelete.status(), 200);
  await nativeDelete.dispose();
  const afterDelete = await measure('documents');
  assert.equal(afterDelete.value.documents.filter((d) => d.category === 'chapter').length, 59);
  const missing = await context.request.get(api + 'document?path=chapters/cost-60.md');
  assert.equal(missing.status(), 404);
  await missing.dispose();
  const traffic = [];
  const track = (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/novels/' + book.id + '/'))
      traffic.push(new URL(request.url()).pathname.split('/').at(-1));
  };
  page.on('request', track);
  await page.reload();
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await waitEditor(editor, '# 原生工具修改\n\n其他设备已修改的正文。');
  await waitFor(() => traffic.includes('changes'), 'revision monitor starts');
  // Initial editor navigation can legitimately make the first revision refresh
  // yield. Establish the baseline after it is ready, before measuring idle.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // Exercise the actual browser scheduler, not a source-string assertion.
  await page.waitForTimeout(1200);
  traffic.length = 0;
  await page.waitForTimeout(23000);
  const idleChecks = traffic.filter((r) => r === 'changes').length;
  assert.ok(idleChecks >= 2, 'Exercise at least two actual idle timer checks.');
  assert.equal(
    traffic.filter((r) => ['documents', 'document', 'writing-run', 'review'].includes(r)).length,
    0,
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => traffic.includes('changes'), 'lightweight focus check');
  assert.equal(traffic.filter((r) => ['documents', 'document'].includes(r)).length, 0);
  const before = await readEditor(editor);
  const current = await measure('document?path=chapters/cost-1.md');
  await write('chapters/cost-1.md', current.value.text + '\n跨设备同步检查。', current.value.hash);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitEditor(editor, before + '\n跨设备同步检查。');
  assert.equal(model.requests.length, 0);
  page.off('request', track);
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-read-cost-browser.png'),
    fullPage: true,
  });
  const report = {
    fixtureChapters: 60,
    coldDirectoryRows: cold.rowsRead,
    cachedDirectoryRows: warm.rowsRead,
    coldDocumentRows: docCold.rowsRead,
    cachedDocumentRows: docWarm.rowsRead,
    revisionCheckRows: version.rowsRead,
    fortyRevisionCheckRows: repeatedRows,
    cacheReductionPercent: (1 - warm.rowsRead / cold.rowsRead) * 100,
    idleFullReads: 0,
    idleObservationMs: 23000,
    actualBrowserIdleRevisionChecks: idleChecks,
    nativeWritesAndDeletesInvalidate: true,
    staleSaveRejected: true,
    paidModelCalls: 0,
    productionDataAccessed: false,
  };
  await writeFile(resolve(root, 'test-results/cloud-read-cost.json'), JSON.stringify(report, null, 2));
  console.log('Native SQLite read-cost regression:', JSON.stringify(report));
}
