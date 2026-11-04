import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startAnonymousServer } from './server.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { verifyWritingUi } from './ui-scenario.mjs';
import { verifySharedUi } from './shared-ui-scenario.mjs';
import { clickSidebarEntry } from '../tests/editor-client.mjs';

await mkdir('test-results', { recursive: true });
let app, browser, failure;
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
  const a = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const b = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
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
    const key = await context.request.post(app.origin + '/api/credentials/set', {
      headers: { origin: app.origin },
      data: {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'credentials/set',
        payload: { args: { ref: 'DEEPSEEK_API_KEY', value: 'fixture-only-no-model-requests' } },
      },
    });
    assert.equal((await key.json()).result.ok, true);
    await key.dispose();
    identities.push(
      ...(await context.cookies())
        .filter((c) => c.name.startsWith('novelharness_'))
        .map((c) => c.value.split('.')[0]),
    );
    await writeFile(
      'test-results/public-browser-owners.json',
      JSON.stringify({ synthetic: true, identities }),
    );
  }
  const prose =
    '# 第一章 雨港\n\n' +
    Array(9)
      .fill(
        '渡船靠岸时，雨刚停。林遥在码头等到了那位邮差。他把信交给她，又指了指街对面的茶馆，说有人在那里等她。林遥问了姓名，邮差摇头，只说是一位从北方来的客人。',
      )
      .join('\n\n');
  const bundle = await makeBookBundle(null, {
    title: '雨港来信',
    seed: '沿海小城的书店主人收到故人的来信。',
  });
  const created = await a.request.post(app.origin + '/api/novels/' + bundle.manifest.id + '/bootstrap', {
    headers: { origin: app.origin },
    data: bundle,
  });
  assert.equal(created.status(), 200);
  await created.dispose();
  for (const [path, text] of [
    ['chapters/00001.md', prose],
    [
      'setting.md',
      '# 背景设定\n\n沿海小城，渡口与旧邮局。\n\n# 人物\n\n林遥经营书店，收到多年未见的朋友的来信。',
    ],
    [
      'outline.json',
      JSON.stringify([
        {
          chapter: 1,
          title: '雨港',
          summary: '林遥在渡口收到一封来信，去茶馆见到故人。',
          beats: ['渡船靠岸，信被送到。', '茶馆中谈起旧事。'],
        },
      ]),
    ],
  ]) {
    const api = app.origin + '/api/novels/' + bundle.manifest.id + '/document';
    const before = await a.request.get(api + '?path=' + encodeURIComponent(path));
    const expectedHash = before.status() === 200 ? (await before.json()).hash : null;
    await before.dispose();
    const saved = await a.request.put(api, {
      headers: { origin: app.origin },
      data: { path, text, expectedHash },
    });
    assert.equal(saved.status(), 200, await saved.text());
    await saved.dispose();
  }
  for (const title of ['无声轨道', '当钟声穿过长街与无人回答的旧信箱']) {
    const extra = await makeBookBundle(null, { title, seed: '独立界面验收：' + title });
    const r = await a.request.post(app.origin + '/api/novels/' + extra.manifest.id + '/bootstrap', {
      headers: { origin: app.origin },
      data: extra,
    });
    assert.equal(r.status(), 200);
    await r.dispose();
  }
  assert.equal((await (await b.request.get(app.origin + '/api/novels')).json()).books.length, 0);
  for (const [i, context] of [a, b].entries()) {
    const page = await context.newPage();
    const moduleMedia = [];
    let compressedModules = 0;
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/plugins/')
        moduleMedia.push(
          response
            .text()
            .then((text) => ({
              paths: [
                ...text.matchAll(/\/__host-assets\/client-media\/[a-f0-9]{64}\.(?:webp|png|jpeg)/g),
              ].map((m) => m[0]),
            }))
            .catch(() => ({ failed: true })),
        );
      if (
        new URL(response.url()).pathname === '/plugins/' &&
        response.headers()['content-encoding'] === 'gzip'
      )
        compressedModules++;
    });
    page.setDefaultTimeout(30000);
    for (const name of ['继续', 'Continue', '稍后配置', 'Configure later'])
      await page.addLocatorHandler(
        page.getByRole('button', { name, exact: true }),
        async () => page.getByRole('button', { name, exact: true }).click(),
        { times: 1 },
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
    await page.getByRole('searchbox', { name: '搜索小说', exact: true }).fill('');
    assert.equal(await page.title(), '小说工作台');
    assert.equal(await page.locator('body').getAttribute('data-novel-auth'), 'anonymous');
    assert.equal(await page.getByRole('link', { name: '账号与 PIN', exact: true }).count(), 0);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'test-results/public-' + (i ? 'mobile' : 'desktop') + '.png' });
    assert(frames > 0, 'Native streaming WebSocket did not receive frames.');
    if (i === 0) {
      try {
        report.ui = await verifyWritingUi({
          page,
          context,
          origin: app.origin,
          book: bundle.manifest,
          prose,
        });
      } catch (error) {
        // This browser contains synthetic fixtures only. Keep UI state, never
        // cookies, credentials, network headers or conversation contents.
        console.error(
          'Synthetic UI failure:',
          JSON.stringify(
            await page.evaluate(() => ({
              search: document.querySelector('#book-search')?.value,
              searchCount: document.querySelectorAll('#book-search').length,
              cards: [...document.querySelectorAll('.book')].map((e) => ({
                title: e.querySelector('h3')?.textContent,
                hidden: e.hidden,
                display: getComputedStyle(e).display,
              })),
              status: document.querySelector('#status')?.textContent,
            })),
          ),
        );
        await page.screenshot({ path: 'test-results/ui-failure.png' });
        throw error;
      }
    }
    assert(compressedModules > 0, 'Native modules must use compressed delivery in the real browser.');
    const inspections = await Promise.all(moduleMedia);
    assert(
      inspections.every((item) => !item.failed),
      'Native startup module bodies must remain readable.',
    );
    const mediaPaths = inspections.flatMap((item) => item.paths);
    assert(mediaPaths.length > 0, 'Large built-in UI illustrations must be external to the startup scripts.');
    const media = await context.request.get(app.origin + mediaPaths[0]);
    assert.equal(media.status(), 200);
    assert.equal(
      createHash('sha256')
        .update(await media.body())
        .digest('hex'),
      mediaPaths[0].split('/').pop().split('.')[0],
    );
    await media.dispose();
    report.clientMediaVerified = true;
    report.compressedModules = (report.compressedModules ?? 0) + compressedModules;
    await clickSidebarEntry(page, 'link', '数据与访问');
    await page.getByRole('heading', { name: '访客独立空间', exact: true }).waitFor();
    assert.equal(await page.getByText('修改登录 PIN', { exact: true }).count(), 0);
    await page.screenshot({ path: 'test-results/mode-isolated-' + (i ? 'mobile' : 'desktop') + '.png' });
  }
  await a.close();
  await b.close();
  await app.close();
  app = null;
  report.sharedUi = await verifySharedUi(browser);
  report.layouts = [1280, 390];
  report.webSocket = true;
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  try {
    await browser?.close();
    await app?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupPending = identities;
  }
  if (!report.cleanupPending)
    for (const id of identities) {
      assert(/^[a-f0-9]{64}$/.test(id));
      await rm(
        resolve(
          process.env.NOVEL_RUNTIME_DIR ?? 'data/anonymous-runtime',
          'data/official-validation/integration/visitors',
          id,
        ),
        {
          recursive: true,
          force: true,
        },
      );
    }
  if (failure) report.passed = false;
  await writeFile('test-results/public-browser.json', JSON.stringify(report));
}
console.log(JSON.stringify(report));
if (failure) throw failure;
