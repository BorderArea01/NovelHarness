// Actual native SQLite/VFS + browser, on isolated synthetic books only.
// No production credentials/storage and no real model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { hostRuntime } from '../host/runtime.mjs';
import { stageHostRelease } from '../host/stage.mjs';
import { verifyUiRelease } from '../scripts/verify-ui-release.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import {
  openChapter,
  openChapterDirectory,
  openDocumentOptions,
  waitEditor,
  fillEditor,
  waitResponsiveLayout,
} from './editor-client.mjs';

const work = await mkdtemp(resolve(tmpdir(), 'novel-content-management-'));
const ownerKey = 'fixture-only-manual-content-owner-key-0123456789abcdef';
const path = 'chapters/1.md',
  original = '# 雨夜\n\n她在门前捡到钥匙。\n',
  direction = '钥匙贯穿全篇。\n';
let runtime,
  browser,
  page,
  origin,
  cookies,
  cookie,
  stage = 'start';
try {
  const release = process.env.NOVEL_CONTENT_RELEASE
    ? resolve(process.env.NOVEL_CONTENT_RELEASE)
    : resolve(work, 'release');
  const receipt = process.env.NOVEL_CONTENT_RELEASE
    ? await verifyUiRelease(release, { requireTests: false })
    : null;
  if (!receipt) await stageHostRelease(release);
  const start = (target = release) =>
    hostRuntime({
      release: target,
      persist: resolve(work, 'storage'),
      ownerKey,
      namespaceKey: 'fixture-manual-content-v1',
    });
  async function boot(target) {
    runtime = await start(target);
    origin = (await runtime.ready).origin;
    const r = await fetch(origin + '/api/auth/recover', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey: ownerKey }),
    });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    cookies = r.headers.getSetCookie();
    cookie = cookies.map((x) => x.split(';')[0]).join('; ');
  }
  await boot(receipt?.previousRelease ?? release);
  const fetcher = (path, init = {}) =>
    fetch(origin + path, { ...init, headers: { ...init.headers, cookie, origin } });
  const bundle = await makeBookBundle(null, { title: '手动操作独立测试', seed: '雨夜与钥匙' });
  await makeWorkspaceClient(fetcher).create(bundle);
  const other = await makeBookBundle(null, { title: '另一部独立测试书', seed: '不能串书' });
  await makeWorkspaceClient(fetcher).create(other);
  const base = '/api/novels/' + bundle.manifest.id + '/';
  const api = async (route, data, status = 200) => {
    const r = await fetcher(
      base + route,
      data
        ? {
            method: route === 'document' ? 'PUT' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          }
        : {},
    );
    assert.equal(r.status, status, 'Synthetic API ' + route + ': ' + (await r.clone().text()));
    return r.json();
  };
  const get = (path) => api('document?path=' + encodeURIComponent(path));
  const put = async (path, text) => {
    const r = await fetcher(base + 'document?path=' + encodeURIComponent(path));
    return api('document', { path, text, expectedHash: r.ok ? (await r.json()).hash : null });
  };
  const outlineText = JSON.stringify([
    { chapter: 1, title: '雨夜', summary: '发现钥匙', plotPoints: ['发现'], chapterPath: path },
    { chapter: 2, title: '门后', summary: '寻找房间', plotPoints: ['寻找'] },
  ]);
  await put(path, original);
  await put('outline.json', outlineText);
  await put('notes/story-plan.md', direction);
  stage = 'same-database-upgrade';
  await runtime.dispose();
  runtime = null;
  await boot(release);
  assert.equal((await get(path)).text, original);
  assert.equal((await get('outline.json')).text, outlineText);
  assert.equal((await get('notes/story-plan.md')).text, direction);
  stage = 'native-api-and-auth';
  stage = 'unauthenticated-content';
  const unauthenticated = await fetch(origin + base + 'content');
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.arrayBuffer();
  stage = 'cross-origin-content';
  const forbidden = await fetch(origin + base + 'content', {
    method: 'POST',
    headers: { cookie, origin: 'https://foreign.invalid', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);
  await forbidden.arrayBuffer();
  async function manual(action, extra = {}) {
    const preview = await api('content', { action: 'inspect', targetAction: action, ...extra });
    return api('content', { action, ...extra, expected: preview.expected });
  }
  stage = 'native-clear-planning';
  const first = await manual('clearPlanning');
  assert.equal(JSON.parse((await get('outline.json')).text).length, 0);
  assert.equal((await get('notes/story-plan.md')).text, '');
  assert.equal((await get(path)).text, original);
  // A real process disposal/reopen, not just reusing a JS service instance.
  stage = 'recovery-after-native-restart';
  await runtime.dispose();
  runtime = null;
  await boot(release);
  await api('content', { action: 'restore', id: first.recoveryId });
  assert.equal((await get('outline.json')).text, outlineText);
  assert.equal((await get('notes/story-plan.md')).text, direction);
  const otherRecovery = await fetcher('/api/novels/' + other.manifest.id + '/content', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', id: first.recoveryId }),
  });
  assert.equal(otherRecovery.status, 404);
  await otherRecovery.arrayBuffer();
  stage = 'multipart-native-delete-recover';
  const longPath = 'chapters/long.md',
    longText = '# 长篇\n\n' + '雨夜🌧️与门。\n'.repeat(40000);
  const long = await put(longPath, longText);
  assert.ok(long.parts.length > 1);
  const deleted = await manual('deleteChapter', { path: longPath });
  await api('document?path=' + encodeURIComponent(longPath), null, 404);
  await api('content', { action: 'restore', id: deleted.recoveryId });
  assert.equal((await get(longPath)).text, longText);
  // Delete again so the browser only presents the two small test chapters.
  await manual('deleteChapter', { path: longPath });
  stage = 'desktop-browser';
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
        index = pair.indexOf('=');
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Strict',
      };
    }),
  );
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const label of ['继续', '稍后配置'])
    await page.addLocatorHandler(page.getByRole('button', { name: label, exact: true }), () =>
      page.getByRole('button', { name: label, exact: true }).click(),
    );
  await page.goto(origin + '/?view=library');
  await page.locator('.book').filter({ hasText: '手动操作独立测试' }).locator('.open-book').click();
  await page.getByRole('button', { name: '修改书名', exact: true }).waitFor();
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await openChapter(page, path);
  await openDocumentOptions(page);
  await page.getByRole('button', { name: '清空正文', exact: true }).click();
  const confirm = page.getByRole('region', { name: '确认手动操作', exact: true });
  await confirm.getByRole('button', { name: '确认清空本章正文', exact: true }).waitFor();
  await page.screenshot({ path: resolve('test-results/content-management-desktop.png') });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await get(path)).text, original);
  await openDocumentOptions(page);
  await page.getByRole('button', { name: '清空正文', exact: true }).click();
  await confirm.getByRole('button', { name: '确认清空本章正文', exact: true }).click();
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), '# 雨夜\n\n');
  async function recoverLatest(fromOutline = false) {
    if (!fromOutline) await openChapterDirectory(page);
    await page.getByRole('button', { name: '回收与恢复', exact: true }).click();
    const region = page.getByRole('region', { name: '回收与恢复', exact: true });
    const row = region
      .locator('.novel-content-recovery-row')
      .filter({ has: page.getByRole('button', { name: '恢复', exact: true }) })
      .first();
    await row.getByRole('button', { name: '恢复', exact: true }).click();
    await row.getByRole('button', { name: '确认恢复', exact: true }).click();
  }
  await recoverLatest();
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), original);
  stage = 'mobile-outline-delete-clear-recover';
  await page.setViewportSize({ width: 390, height: 844 });
  await waitResponsiveLayout(page);
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  await page.locator('[data-outline-index="0"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve('test-results/content-management-mobile-outline.png') });
  await page.locator('.novel-outline-direction > summary').click();
  await page.getByRole('button', { name: '清空全篇方向', exact: true }).click();
  await confirm.getByRole('button', { name: '确认清空全篇方向', exact: true }).click();
  assert.equal((await get('notes/story-plan.md')).text, '');
  assert.equal((await get('outline.json')).text, outlineText);
  await recoverLatest(true);
  await page.getByRole('button', { name: '清空章节大纲', exact: true }).waitFor();
  assert.equal((await get('notes/story-plan.md')).text, direction);
  await page
    .locator('[data-outline-index="0"]')
    .getByRole('button', { name: '删除章纲', exact: true })
    .click();
  await confirm.getByRole('button', { name: '确认删除这条章纲', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-outline-index]').length === 1);
  assert.equal((await get(path)).text, original);
  await page.getByRole('button', { name: '清空章节大纲', exact: true }).click();
  await confirm.getByRole('button', { name: '确认清空章节大纲', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const buttonBox = await confirm
    .getByRole('button', { name: '确认清空章节大纲', exact: true })
    .boundingBox();
  assert.ok(buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= 390 && buttonBox.height >= 44);
  await page.screenshot({ path: resolve('test-results/content-management-mobile.png') });
  await confirm.getByRole('button', { name: '确认清空章节大纲', exact: true }).click();
  assert.equal(JSON.parse((await get('outline.json')).text).length, 0);
  assert.equal((await get('notes/story-plan.md')).text, direction);
  await page.getByRole('button', { name: '回收与恢复', exact: true }).click();
  const recovery = page.getByRole('region', { name: '回收与恢复', exact: true });
  const latest = recovery
    .locator('.novel-content-recovery-row')
    .filter({ has: page.getByRole('button', { name: '恢复', exact: true }) })
    .first();
  await latest.getByRole('button', { name: '恢复', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve('test-results/content-management-mobile-recovery.png') });
  await latest.getByRole('button', { name: '确认恢复', exact: true }).click();
  stage = 'mobile-delete-chapter';
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await openChapter(page, path);
  await openDocumentOptions(page);
  await page.getByRole('button', { name: '删除本章', exact: true }).click();
  await confirm.getByRole('button', { name: '确认删除本章', exact: true }).click();
  await page.getByRole('button', { name: '展开章节目录', exact: true }).waitFor();
  await api('document?path=' + encodeURIComponent(path), null, 404);
  await recoverLatest();
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), original);
  stage = 'unsaved-draft-protection';
  await fillEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), '# 雨夜\n\n尚未保存的修改');
  await openDocumentOptions(page);
  assert.equal(await page.getByRole('button', { name: '删除本章', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '清空正文', exact: true }).isDisabled(), true);
  assert.equal((await get(path)).text, original);
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 768, height: 1024 });
  await waitResponsiveLayout(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(
    JSON.stringify({
      manualContentManagement: true,
      recoveryAfterNativeRestart: true,
      sameStorageUpgrade: true,
      multipartDeleteAndRecovery: true,
      desktop1280Mobile390Tablet768: true,
      cancelAndUnsavedDraftProtection: true,
      crossBookRecoveryRejected: true,
      authAndSameOriginPreserved: true,
      modelCalls: 0,
      productionWrites: false,
    }),
  );
  if (receipt) {
    await verifyUiRelease(release, { requireTests: false });
    let tested = {};
    try {
      tested = JSON.parse(await readFile(resolve(release, 'tested.json'), 'utf8'));
    } catch {}
    if (tested.revision && tested.revision !== receipt.revision) throw new Error('Different tested release.');
    await writeFile(
      resolve(release, 'tested.json'),
      JSON.stringify(
        {
          ...tested,
          revision: receipt.revision,
          manualContentManagement: true,
          manualRecoveryAfterRestart: true,
          manualContentMobile: true,
          manualContentPassedAt: new Date().toISOString(),
          productionWrites: false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
} catch (error) {
  console.log(
    'Manual content fixture failed at ' +
      stage +
      ': ' +
      error.message +
      (error.cause ? ' (' + error.cause.message + ')' : ''),
  );
  if (page) {
    await page.screenshot({ path: resolve('test-results/content-management-failure.png') }).catch(() => {});
    await writeFile(
      resolve('test-results/content-management-failure.txt'),
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
  await rm(work, { recursive: true, force: true });
}
