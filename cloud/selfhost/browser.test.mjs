import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { startAnonymousServer } from './server.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';

await mkdir('test-results', { recursive: true });
let app, browser;
const identities = [],
  report = { passed: false, modelRequests: 0 };
try {
  app = await startAnonymousServer({ port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--disable-background-networking', '--disable-extensions', '--js-flags=--max-old-space-size=192'],
  });
  const a = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  for (const context of [a, b]) {
    await context.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (/\/api\/session\/prompt$/.test(path)) {
        report.modelRequests++;
        return route.abort();
      }
      return route.continue();
    });
    const r = await context.request.get(app.origin + '/api/novels');
    assert.equal(r.status(), 200);
    await r.dispose();
    identities.push(
      ...(await context.cookies())
        .filter((c) => c.name.startsWith('novelharness_'))
        .map((c) => c.value.split('.')[0]),
    );
  }
  const bundle = await makeBookBundle(null, { title: '独立浏览器验收', seed: '合成测试灵感。' });
  const created = await a.request.post(app.origin + '/api/novels/' + bundle.manifest.id + '/bootstrap', {
    headers: { origin: app.origin },
    data: bundle,
  });
  assert.equal(created.status(), 200);
  await created.dispose();
  assert.equal((await (await b.request.get(app.origin + '/api/novels')).json()).books.length, 0);
  for (const [i, context] of [a, b].entries()) {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    for (const name of ['继续', '稍后配置'])
      await page.addLocatorHandler(
        page.getByRole('button', { name, exact: true }),
        async () => page.getByRole('button', { name, exact: true }).click(),
        { noWaitAfter: true },
      );
    await page.addLocatorHandler(
      page.getByRole('button', { name: /我已知晓并继续|I understand/ }),
      async () => {
        await page.getByRole('checkbox').first().check();
        await page.getByRole('button', { name: /我已知晓并继续|I understand/ }).click();
      },
    );
    let frames = 0;
    page.on('websocket', (ws) => ws.on('framereceived', () => frames++));
    await page.goto(app.origin + '/?view=library', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '刷新', exact: true }).waitFor({ timeout: 45000 });
    assert.equal(await page.title(), '小说工作台');
    assert.equal(await page.locator('body').getAttribute('data-novel-auth'), 'anonymous');
    assert.equal(await page.getByRole('link', { name: '账号与 PIN', exact: true }).count(), 0);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'test-results/public-' + (i ? 'mobile' : 'desktop') + '.png' });
    assert(frames > 0, 'Native streaming WebSocket did not receive frames.');
  }
  report.layouts = [1280, 390];
  report.webSocket = true;
  report.passed = true;
} finally {
  await browser?.close();
  await app?.close();
  for (const id of identities) {
    assert(/^[a-f0-9]{64}$/.test(id));
    await rm(resolve('data/anonymous-runtime/data/official-validation/integration/visitors', id), {
      recursive: true,
      force: true,
    });
  }
  await writeFile('test-results/public-browser.json', JSON.stringify(report));
}
console.log(JSON.stringify(report));
