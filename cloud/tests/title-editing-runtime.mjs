// Same native Harness/Pages/SQL owners. Synthetic stories/model only; no production writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stageHostRelease } from '../host/stage.mjs';
import { hostRuntime } from '../host/runtime.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { chromium } from '@playwright/test';
import { verifyUiRelease } from '../scripts/verify-ui-release.mjs';
import { verifySidebarLayout } from './sidebar-layout-scenario.mjs';
import {
  openChapter,
  clickSidebarEntry,
  waitResponsiveLayout,
  fillEditor,
  readEditor,
} from './editor-client.mjs';
const work = await mkdtemp(resolve(tmpdir(), 'novel-title-edit-'));
let runtime, browser, model, page;
const ownerKey = 'fixture-only-title-owner-key-0123456789abcdef';
let stage = 'start';
try {
  const release = process.env.NOVEL_TITLE_RELEASE
    ? resolve(process.env.NOVEL_TITLE_RELEASE)
    : resolve(work, 'release');
  if (!process.env.NOVEL_TITLE_RELEASE) await stageHostRelease(release);
  model = await startModelFixture();
  const task = model.register({ finalText: '标题编辑测试已就绪。' });
  runtime = await hostRuntime({
    release,
    persist: resolve(work, 'storage'),
    namespaceKey: 'fixture-title-edit-v1',
    ownerKey,
    providerBindings: {
      DEEPSEEK_API_KEY: 'fixture-only-no-real-provider-key',
      DEEPSEEK_BASE_URL: model.url,
      DEEPSEEK_MODEL: 'deepseek-flash',
      DEEPSEEK_REASONING_EFFORT: 'off',
    },
  });
  const origin = (await runtime.ready).origin;
  const login = await fetch(origin + '/api/auth/recover', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: ownerKey }),
  });
  assert.equal(login.status, 200);
  await login.arrayBuffer();
  const cookies = login.headers.getSetCookie(),
    cookie = cookies.map((v) => v.split(';')[0]).join('; ');
  const fetcher = (path, init = {}) =>
    fetch(origin + path, { ...init, headers: { ...init.headers, cookie, origin } });
  const bundle = await makeBookBundle(null, { title: '手动标题测试', seed: '不修改正式作品。' });
  await makeWorkspaceClient(fetcher).create(bundle);
  const base = '/api/novels/' + bundle.manifest.id + '/';
  const get = async (path) => {
    const r = await fetcher(base + 'document?path=' + encodeURIComponent(path));
    assert.equal(r.status, 200);
    return r.json();
  };
  const put = async (path, text) => {
    const before = await fetcher(base + 'document?path=' + encodeURIComponent(path));
    const hash = before.ok ? (await before.json()).hash : null;
    const r = await fetcher(base + 'document', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, text, expectedHash: hash }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  await put('chapters/1.md', '# 原章节\n\n雨停了，她留下钥匙。\n');
  await put(
    'outline.json',
    JSON.stringify([
      {
        chapter: 1,
        title: '原章节',
        chapterPath: 'chapters/1.md',
        summary: '留下钥匙。',
        plotPoints: ['离开'],
      },
      { chapter: 2, title: '尚未成文', summary: '隔天回来。', plotPoints: ['返回'] },
    ]),
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--js-flags=--max-old-space-size=192'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.addCookies(
    cookies.map((header) => {
      const pair = header.split(';')[0],
        i = pair.indexOf('=');
      return {
        name: pair.slice(0, i),
        value: pair.slice(i + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Strict',
      };
    }),
  );
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('Synthetic title browser error: ' + e.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('Synthetic title console: ' + message.text().slice(0, 900));
  });
  for (const label of ['继续', '稍后配置'])
    await page.addLocatorHandler(page.getByRole('button', { name: label, exact: true }), () =>
      page.getByRole('button', { name: label, exact: true }).click(),
    );
  await page.goto(origin + '/?view=library');
  await page.locator('.book .open-book').first().click();
  const manuscript = page.getByRole('region', { name: '小说书稿', exact: true });
  await manuscript.waitFor();
  stage = 'sidebar-layout';
  await verifySidebarLayout(page);
  stage = 'desktop-book-title';
  await page.getByRole('button', { name: '修改书名', exact: true }).click();
  await page.getByRole('textbox', { name: '书名', exact: true }).fill('作者改的书名 🌙');
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: '作者改的书名 🌙' }).waitFor();
  await page.reload();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: '作者改的书名 🌙' }).waitFor();
  stage = 'chapter-title-sync';
  await openChapter(page, 'chapters/1.md');
  await page.getByRole('button', { name: '改标题', exact: true }).click();
  await page.getByRole('textbox', { name: '章节标题', exact: true }).fill('夜雨之后');
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '标题已保存' }).waitFor();
  assert.equal((await get('chapters/1.md')).text, '# 夜雨之后\n\n雨停了，她留下钥匙。\n');
  assert.equal(JSON.parse((await get('outline.json')).text)[0].title, '夜雨之后');
  stage = 'outline-title-sync';
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  const row = page.locator('[data-outline-index="0"]');
  await row.getByRole('button', { name: '修改章纲标题', exact: true }).click();
  await row.getByRole('textbox', { name: '章纲标题', exact: true }).fill('钥匙与雨');
  await row.getByRole('button', { name: '保存标题', exact: true }).click();
  await row.locator('h3').filter({ hasText: '钥匙与雨' }).waitFor();
  assert.equal((await get('chapters/1.md')).text, '# 钥匙与雨\n\n雨停了，她留下钥匙。\n');
  assert.equal(JSON.parse((await get('outline.json')).text)[0].chapterPath, 'chapters/1.md');
  const unbound = page.locator('[data-outline-index="1"]');
  await unbound.getByRole('button', { name: '修改章纲标题', exact: true }).click();
  await unbound.getByRole('textbox', { name: '章纲标题', exact: true }).fill('尚未成文也能改');
  await unbound.getByRole('button', { name: '保存标题', exact: true }).click();
  await unbound.locator('h3').filter({ hasText: '尚未成文也能改' }).waitFor();
  stage = 'original-native-conversation';
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const composer = page.locator('[role="textbox"][contenteditable="true"]:visible').first();
  await composer.fill(task.marker);
  await composer.press('Enter');
  await page.getByText('标题编辑测试已就绪。', { exact: true }).waitFor();
  const existingCalls = model.requests.length;
  await page.setViewportSize({ width: 390, height: 844 });
  await waitResponsiveLayout(page);
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  const nav = page.getByRole('complementary', { name: '创作导航', exact: true });
  const sessionRow = nav.locator('.novel-session-row').filter({ has: page.locator('[aria-current="true"]') });
  stage = 'mobile-conversation-title';
  await sessionRow.getByRole('button', { name: '修改对话标题', exact: true }).click();
  const field = sessionRow.getByRole('textbox', { name: '对话标题', exact: true });
  await field.fill('手动对话名称');
  assert.equal(await nav.isVisible(), true, 'Editing does not close the mobile drawer.');
  await page.screenshot({ path: resolve('test-results/title-editing-mobile-form.png') });
  const box = await field.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await sessionRow.getByRole('button', { name: '保存标题', exact: true }).click();
  await sessionRow.getByRole('button', { name: '手动对话名称', exact: true }).waitFor();
  assert.equal(await nav.isVisible(), true);
  assert.equal(model.requests.length, existingCalls, 'Renaming never asks a model.');
  await sessionRow.getByRole('button', { name: '修改对话标题', exact: true }).click();
  await field.fill('取消不会保存');
  await field.press('Escape');
  assert.equal(await field.count(), 0);
  await sessionRow.getByRole('button', { name: '手动对话名称', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.getByRole('button', { name: '手动对话名称', exact: true }).waitFor();
  await clickSidebarEntry(page, 'button', '当前作品');
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await openChapter(page, 'chapters/1.md');
  stage = 'mobile-book-title';
  await page.getByRole('button', { name: '修改书名', exact: true }).click();
  await page.getByRole('textbox', { name: '书名', exact: true }).fill('手机改书名');
  await page.screenshot({ path: resolve('test-results/title-editing-mobile-book.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: '手机改书名' }).waitFor();
  stage = 'draft-retention';
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  const draft = '# 钥匙与雨\n\n这段尚未保存的正文需要保留。';
  await fillEditor(editor, draft);
  await page.getByRole('button', { name: '修改书名', exact: true }).click();
  await page.getByRole('textbox', { name: '书名', exact: true }).fill('正文草稿不受影响');
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: '正文草稿不受影响' }).waitFor();
  assert.equal(await readEditor(editor), draft);
  assert.equal(model.requests.length, existingCalls);
  assert.deepEqual(errors, []);
  assert.deepEqual(model.errors, []);
  await page.setViewportSize({ width: 768, height: 1024 });
  await waitResponsiveLayout(page);
  await page.screenshot({ path: resolve('test-results/title-editing-tablet.png') });
  console.log(
    JSON.stringify({
      manualBookAndConversationTitles: true,
      chapterAndOutlineTitlesSynchronized: true,
      pathsAndSessionIdsPreserved: true,
      cancelAndReloadVerified: true,
      mobile390AndTablet768: true,
      proseDraftPreserved: true,
      renameModelCalls: 0,
      realModelCalls: 0,
      productionWrites: false,
      collapsedSidebarAndMobileDrawer: true,
    }),
  );
  if (process.env.NOVEL_TITLE_RELEASE) {
    const receipt = JSON.parse(await readFile(resolve(release, 'ui-release.json'), 'utf8'));
    await verifyUiRelease(release, { requireTests: false });
    await writeFile(
      resolve(release, 'tested.json'),
      JSON.stringify(
        {
          revision: receipt.revision,
          passedAt: new Date().toISOString(),
          originalNativeHarness: true,
          desktopMobileTablet: true,
          titleSynchronization: true,
          cancelReloadAndDraftRetention: true,
          renameModelCalls: 0,
          productionWrites: false,
          collapsedSidebarAndMobileDrawer: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
} catch (error) {
  console.log('Title editing fixture failed at ' + stage + ': ' + error.message);
  if (page) {
    await page.screenshot({ path: resolve('test-results/title-editing-failure.png') }).catch(() => {});
    await writeFile(
      resolve('test-results/title-editing-failure.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await runtime?.dispose();
  await model?.close();
  await rm(work, { recursive: true, force: true });
}
