import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGuidedBook } from './novel-studio-scenario.mjs';
import { clickSidebarEntry } from './editor-client.mjs';

// Real original runtime, no request routing/interception (that disables Chromium
// HTTP caching). Only localhost synthetic books. No model calls or production data.
export async function verifyPerformance({ page, context, origin, model, root }) {
  const requests = [];
  const observe = (req) => {
    const url = new URL(req.url());
    if (url.origin === origin) requests.push({ path: url.pathname, method: req.method() });
  };
  page.on('request', observe);
  const title = '一次创建性能测试';
  await clickSidebarEntry(page, 'link', '小说库');
  await page.locator('.book').first().waitFor();
  requests.length = 0;
  const started = Date.now();
  await createGuidedBook(page, { title, seed: '凌晨，电梯停在不存在的楼层。' });
  await page.locator('.novel-ms-heading > strong').filter({ hasText: title }).waitFor();
  await page.getByRole('region', { name: '章节大纲', exact: true }).waitFor();
  const createMs = Date.now() - started;
  const creation = [...requests];
  const newBookId = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  assert.ok(
    creation
      .filter((r) => /\/api\/novels\/b-[a-f0-9]+\/documents?$/.test(r.path))
      .every((r) => r.path.startsWith('/api/novels/' + newBookId + '/')),
    'Opening a new book must not mount/read the previous book first.',
  );
  assert.equal(creation.filter((r) => /\/bootstrap$/.test(r.path)).length, 1);
  assert.equal(
    creation.filter((r) => r.path === '/api/workspace/file').length,
    0,
    'New book is not a file-by-file migration.',
  );
  assert.equal(creation.filter((r) => r.path === '/api/workspace/exec').length, 0);
  assert.equal(
    creation.filter((r) => r.path === '/api/novels').length,
    0,
    'Opening the created book must not wait for another whole-library scan.',
  );
  requests.length = 0;
  const libraryStart = Date.now();
  await clickSidebarEntry(page, 'link', '小说库');
  const card = page.locator('.book').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await card.waitFor();
  const libraryMs = Date.now() - libraryStart;
  assert.equal(requests.filter((r) => r.path === '/api/novels').length, 1);
  const openingStart = Date.now();
  requests.length = 0;
  await card.getByRole('button', { name: '进入创作', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: title }).waitFor();
  const openMs = Date.now() - openingStart;
  assert.equal(
    requests.filter((r) => r.path === '/api/workspace/file').length,
    0,
    'Validated library identity need not be downloaded again.',
  );

  const cdp = await context.newCDPSession(page);
  const cached = new Set();
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response.url.includes('/studio/') && (response.fromDiskCache || response.fromPrefetchCache))
      cached.add(response.url);
  });
  const reloadStart = Date.now();
  await page.reload();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: title }).waitFor();
  await page.getByRole('region', { name: '章节大纲', exact: true }).waitFor();
  const reloadMs = Date.now() - reloadStart;
  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((r) => r.name.includes('/studio/'))
      .map((r) => ({
        path: new URL(r.name).pathname,
        transfer: r.transferSize,
        bytes: r.decodedBodySize,
        duration: Math.round(r.duration),
      })),
  );
  const hits = resources.filter((r) => r.transfer === 0 && r.bytes > 0);
  assert.ok(resources.length >= 30, 'Exercise the full real module graph, not a small placeholder shell.');
  assert.equal(
    hits.length,
    resources.length,
    'Every release-owned module/stylesheet should reuse the warm browser cache.',
  );
  assert.equal(model.requests.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(root, 'test-results/cloud-performance-mobile.png'), fullPage: true });
  const report = {
    format: 'novel-performance-v1',
    environment: 'localhost, real pinned runtime; warm HTTP cache; no provider calls',
    createMs,
    libraryMs,
    openMs,
    reloadMs,
    createRequests: creation,
    releaseResources: resources.length,
    cacheHits: hits.length,
    diskCacheEvents: cached.size,
    resources,
  };
  await writeFile(resolve(root, 'test-results/cloud-performance.json'), JSON.stringify(report, null, 2));
  console.log(
    'Performance proof: ' +
      JSON.stringify({
        createMs,
        libraryMs,
        openMs,
        reloadMs,
        releaseResources: resources.length,
        cacheHits: hits.length,
      }),
  );
  page.off('request', observe);
  await cdp.detach();
}
