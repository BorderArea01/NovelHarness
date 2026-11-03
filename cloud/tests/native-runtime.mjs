// Real pinned DSH + local workerd + Pages + one browser. No production data,
// Cloudflare account mutation, user API key, or model prompt is used here.
import assert from 'node:assert/strict';
import { verifyRulesEditor } from './rules-scenario.mjs';
import { verifyThreeWayMerge } from './merge-scenario.mjs';
import { verifyLongDocuments } from './long-document-scenario.mjs';
import { verifyDraftRecovery } from './draft-scenario.mjs';
import { verifyChapterNavigation } from './chapter-scenario.mjs';
import { verifyChapterOrder } from './chapter-order-scenario.mjs';
import {
  fillEditor,
  readEditor,
  waitEditor,
  clickSidebarEntry,
  openGenerationRecords,
} from './editor-client.mjs';
import { retainBackupInput, verifyBackupSnapshot } from './backup-snapshot-client.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { stageRuntime } from '../scripts/stage-runtime.mjs';
import { createGuidedBook } from './novel-studio-scenario.mjs';
import { verifyImportRecords } from './import-records-scenario.mjs';
import { verifyHistoryBrowser, verifyHistoryPagination } from './history-scenario.mjs';
import { rotateFixtureContext } from './context-lifetime.mjs';
import { backupDownload } from './backup-download.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wrangler = resolve(root, 'cloud/tools/node_modules/wrangler/bin/wrangler.js');
const work = resolve(root, `test-results/cloud-native-${Date.now()}`);
const workerOrigin = 'http://127.0.0.1:8791';
const pagesOrigin = 'http://127.0.0.1:8792';
const fixtureKey = 'fixture-only-owner-key-not-for-production-0123456789abcdef';
const children = [];
let devRegistry = resolve(work, 'dev-registry');
let browser, browserServer;

function launch(args, cwd) {
  const child = spawn(process.execPath, ['--max-old-space-size=384', wrangler, ...args], {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_CF_FETCH_ENABLED: 'false',
      WRANGLER_REGISTRY_PATH: devRegistry,
      BROWSER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, output: '' };
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      record.output = (record.output + String(chunk)).slice(-12000);
    });
  child.on('error', (error) => {
    record.error = error;
  });
  children.push(record);
  return record;
}

async function ready(origin, path, record) {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (record.error || record.child.exitCode !== null)
      throw new Error(`Local runtime exited: ${record.error?.message ?? record.output}`);
    try {
      const result = await fetch(origin + path, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      if (result.status < 500) return;
    } catch {
      /* Wait for THIS owned runtime, never launch a replacement. */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Local runtime readiness timed out: ${record.output}`);
}

async function closeOwned(record) {
  if (record.child.exitCode !== null) return;
  if (process.platform === 'win32')
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(record.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  else record.child.kill('SIGTERM');
  if (record.child.exitCode === null) await new Promise((resolve) => record.child.once('exit', resolve));
}

try {
  await mkdir(work, { recursive: true });
  const runtimePackage = JSON.parse(
    await readFile(resolve(root, 'cloud/tools/node_modules/dsh-edge/package.json'), 'utf8'),
  );
  assert.equal(runtimePackage.version, '0.30.0');
  await stageRuntime(resolve(work, 'worker'));
  const fixtureConfig = (await readFile(resolve(root, 'cloud/tests/runtime/wrangler.toml'), 'utf8'))
    .replace(
      /^main = .*$/m,
      `main = ${JSON.stringify(resolve(work, 'worker/entry.mjs').replaceAll('\\', '/'))}`,
    )
    .replace(
      /^directory = .*$/m,
      `directory = ${JSON.stringify(resolve(root, 'cloud/tools/node_modules/dsh-edge/dist').replaceAll('\\', '/'))}`,
    );
  await writeFile(resolve(work, 'worker.toml'), fixtureConfig);
  const worker = launch(
    [
      'dev',
      '--local',
      '--config',
      resolve(work, 'worker.toml'),
      '--ip',
      '127.0.0.1',
      '--port',
      '8791',
      '--persist-to',
      resolve(work, 'worker-state'),
    ],
    root,
  );
  console.log('Waiting for the owned local DSH Worker (synthetic fixture credentials only).');
  await ready(workerOrigin, '/api/health', worker);
  const health = await (await fetch(workerOrigin + '/api/health')).json();
  console.log(
    `Native Worker answered health; release ${health.version ?? health.release ?? 'inspect runtime response'}.`,
  );
  const pages = launch(
    [
      'pages',
      'dev',
      'public',
      '--service',
      'HARNESS=novel-harness-local-verification',
      '--ip',
      '127.0.0.1',
      '--port',
      '8792',
      '--persist-to',
      resolve(work, 'pages-state'),
    ],
    resolve(root, 'cloud/pages'),
  );
  console.log('Waiting for the owned local Pages Functions runtime.');
  await ready(pagesOrigin, '/api/auth/session', pages);
  assert.equal((await (await fetch(pagesOrigin + '/api/auth/session')).json()).authenticated, false);
  const executablePath =
    process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browserServer = await chromium.launchServer({
    headless: true,
    executablePath,
    args: ['--js-flags=--max-old-space-size=192'],
  });
  browser = await chromium.connect(browserServer.wsEndpoint());
  let context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  let page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.addLocatorHandler(page.getByRole('button', { name: '继续', exact: true }), async () => {
    await page.getByRole('button', { name: '继续', exact: true }).click();
  });
  const errors = [];
  const modelPosts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/(?:session[./]prompt|sessions\/[^/]+\/turn)$/.test(new URL(request.url()).pathname)
    )
      modelPosts.push(request.url());
  });
  await page.goto(pagesOrigin + '/novels/');
  await page.locator('#bootstrap-form input[name="accessKey"]').fill(fixtureKey);
  await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
  await page.getByRole('heading', { name: '设置你的 PIN', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(await page.locator('#bootstrap-key').inputValue(), '');
  await page.reload();
  await page.getByRole('heading', { name: '设置你的 PIN', exact: true }).waitFor();
  await page.locator('#setup-pin').fill('561904');
  await page.locator('#setup-confirm').fill('561904');
  await page.getByRole('button', { name: '设置 PIN 并进入书库', exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'library');
  await page.getByRole('status').filter({ hasText: '还没有小说' }).waitFor();
  await page.evaluate(() => {
    window.novelFrameAudit = 'same-native-frame';
  });
  await createGuidedBook(page, {
    title: '修士在飞升钟声里听见前人的求救声',
    seed: '修士在飞升钟声里听见前人的求救声',
  });
  await page.waitForURL((url) => url.pathname === '/' && !url.searchParams.has('view'));
  const bookId = await page.evaluate(async () => {
    const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
    return (await makeWorkspaceClient().list())[0].id;
  });
  assert.equal(
    await page.evaluate(() => window.novelFrameAudit),
    'same-native-frame',
    'Library and book must not reload into separate applications.',
  );
  console.log('Book uploaded through real Pages binding; testing native client plugin activation.');
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  await page.waitForURL((url) => url.pathname === '/' && !url.searchParams.has('novel'));
  const previewContinue = page.getByRole('button', { name: '继续', exact: true });
  if (await previewContinue.isVisible()) {
    await previewContinue.click();
    await previewContinue.waitFor({ state: 'hidden' });
  }
  await page.waitForFunction(() => getComputedStyle(document.body).colorScheme.includes('dark'));
  const graphHasBridge = await page.evaluate(() =>
    globalThis.__DSH_BOOT__.entries.some((entry) => entry.id === 'novel-harness-bridge'),
  );
  assert.equal(graphHasBridge, true);
  assert.equal(modelPosts.length, 0, 'Preparing a draft must not submit a paid model prompt.');
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await page.getByRole('button', { name: '＋ 新章', exact: true }).click();
  await page.getByRole('textbox', { name: '新章节标题', exact: true }).fill('雨夜的钟声');
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/document'),
  );
  await page.getByRole('button', { name: '创建', exact: true }).click();
  assert.equal(
    (await createResponse).status(),
    200,
    'Native create must succeed, not only the memory fixture.',
  );
  await page.waitForFunction(
    () => !document.querySelector('.novel-ms-status')?.textContent.includes('正在读取'),
  );
  let editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await editor.waitFor();
  await waitEditor(editor, '# 雨夜的钟声\n\n');
  await fillEditor(editor, '# 雨夜的钟声\n\n雨水沿着剑刃往下淌。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
  const docApi = '/api/novels/' + bookId + '/';
  const documents = await (await context.request.get(pagesOrigin + docApi + 'documents')).json();
  assert.ok(Array.isArray(documents.documents), 'Native atomic adapter must be usable.');
  const docPath = documents.documents.find((item) => item.category === 'chapter').path;
  const concurrencyPath = 'chapters/concurrent-fixture.md';
  const initialConcurrent = await (
    await context.request.put(pagesOrigin + docApi + 'document', {
      data: { path: concurrencyPath, text: '原文', expectedHash: null },
    })
  ).json();
  const concurrent = await Promise.all(
    ['设备一', '设备二'].map((text) =>
      context.request.put(pagesOrigin + docApi + 'document', {
        data: { path: concurrencyPath, text, expectedHash: initialConcurrent.hash },
      }),
    ),
  );
  assert.deepEqual(concurrent.map((response) => response.status()).sort(), [200, 409]);
  const originalDocument = await (
    await context.request.get(pagesOrigin + docApi + 'document?path=' + encodeURIComponent(docPath))
  ).json();
  const proposal = await (
    await context.request.post(pagesOrigin + docApi + 'proposals', {
      data: { path: docPath, expectedHash: originalDocument.hash },
    })
  ).json();
  assert.ok(proposal.id, 'A proposal must be atomically captured in the native VFS.');
  await context.request.put(
    pagesOrigin +
      '/api/workspace/file?path=' +
      encodeURIComponent(`/workspace/novels/${bookId}/${proposal.draft}`),
    { data: '# 雨夜的钟声\n\n钟楼里有人敲了第三声。' },
  );
  await openGenerationRecords(page);
  await page
    .locator('.novel-proposals button')
    .filter({ hasText: docPath.split('/').pop() })
    .click();
  await page.getByRole('button', { name: '接受改稿', exact: true }).waitFor();
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-native-manuscript-review-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-native-manuscript-review-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '接受改稿', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
  assert.match(await readEditor(editor), /第三声/);
  const staleSave = await context.request.put(pagesOrigin + docApi + 'document', {
    data: { path: docPath, text: '不应覆盖', expectedHash: originalDocument.hash },
  });
  assert.equal(staleSave.status(), 409);
  const history = await (
    await context.request.get(pagesOrigin + docApi + 'history?path=' + encodeURIComponent(docPath))
  ).json();
  assert.ok(history.versions.some((version) => version.hash === originalDocument.hash));
  await page.setViewportSize({ width: 1280, height: 900 });
  // Human-facing canon edits use the SAME native files, CAS and history as prose.
  console.log(
    'Native editor scenarios begin; driver heap MiB=' + Math.round(process.memoryUsage().heapUsed / 1048576),
  );
  await verifyHistoryBrowser({ page, context, origin: pagesOrigin, api: docApi, restorePath: docPath, root });
  if (process.argv.includes('--history')) {
    assert.deepEqual(errors, []);
    console.log('Focused native history regression passed. No provider calls.');
  } else {
    await verifyHistoryPagination({
      page,
      context,
      origin: pagesOrigin,
      api: docApi,
      restorePath: docPath,
      root,
    });
    await verifyImportRecords({ page, context, origin: pagesOrigin, root, restoreBookId: bookId });
    const orderedBook = await verifyChapterOrder({
      page,
      context,
      origin: pagesOrigin,
      restoreBookId: bookId,
      root,
    });
    await verifyChapterNavigation({
      page,
      context,
      origin: pagesOrigin,
      api: docApi,
      restorePath: docPath,
      root,
    });
    await verifyRulesEditor({ page, context, origin: pagesOrigin, api: docApi, root });
    await verifyThreeWayMerge({
      page,
      context,
      origin: pagesOrigin,
      api: docApi,
      bookId,
      restorePath: docPath,
      root,
    });
    // Large protocol payloads have an independent lifetime; do not carry every
    // earlier browser/HTTP object into the long-document/draft pair.
    ({ context, page } = await rotateFixtureContext({ browser, context, page, origin: pagesOrigin }));
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/(?:session[./]prompt|sessions\/[^/]+\/turn)$/.test(new URL(request.url()).pathname)
      )
        modelPosts.push(request.url());
    });
    await page.addLocatorHandler(page.getByRole('button', { name: '继续', exact: true }), () =>
      page.getByRole('button', { name: '继续', exact: true }).click(),
    );
    await page.goto(pagesOrigin + '/?novel=' + bookId);
    await page.locator('.novel-manuscript[data-book-id=' + JSON.stringify(bookId) + ']').waitFor();
    editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    console.log(
      'Independent long-document/draft phase; driver heap MiB=' +
        Math.round(process.memoryUsage().heapUsed / 1048576),
    );
    await verifyLongDocuments({
      page,
      context,
      origin: pagesOrigin,
      api: docApi,
      restorePath: docPath,
      root,
    });
    await verifyDraftRecovery({
      page,
      context,
      origin: pagesOrigin,
      api: docApi,
      bookId,
      restorePath: docPath,
      root,
    });
    console.log(
      'Native editor scenarios released; driver heap MiB=' +
        Math.round(process.memoryUsage().heapUsed / 1048576),
    );
    // Synthetic evidence only; no AI extraction or provider request is made.
    const readCanon = async () =>
      (await context.request.get(pagesOrigin + docApi + 'document?path=canon.json')).json();
    const emptyCanon = await readCanon();
    const canonFixture = {
      ...JSON.parse(emptyCanon.text),
      extension: { preserved: ['unknown', 42] },
      characters: [
        {
          id: 'person-a',
          name: '沈澄',
          trust: 'confirmed',
          notes: '不能静默改写的旧笔记',
          tags: ['主角'],
          unknown: { preserved: true },
          customFields: { 旧字段: '保留原值', 复杂字段: { nested: [1] } },
        },
        { id: 'person-b', name: '祝余', trust: 'auto', notes: '来自 AI 的推测', evidence: '原文依据保留' },
      ],
    };
    assert.equal(
      (
        await context.request.put(pagesOrigin + docApi + 'document', {
          data: {
            path: 'canon.json',
            text: JSON.stringify(canonFixture, null, 2),
            expectedHash: emptyCanon.hash,
          },
        })
      ).status(),
      200,
    );
    await page.getByRole('button', { name: '设定', exact: true }).click();
    await page.getByRole('button', { name: '人物与资料', exact: true }).click();
    const canonRegion = page.getByLabel('人物与资料编辑器', { exact: true });
    await canonRegion.waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: '资料源文件', exact: true }).isVisible(),
      false,
      'Technical source stays collapsed.',
    );
    await page.locator('.novel-canon-card button').filter({ hasText: '沈澄' }).click();
    await page
      .getByRole('textbox', { name: '资料笔记', exact: true })
      .fill('对钟声敏感，但不会直接说出恐惧。');
    await page.getByRole('textbox', { name: '资料标签', exact: true }).fill('');
    await page.getByRole('textbox', { name: '资料标签', exact: true }).pressSequentially('主角，钟楼');
    await page.getByRole('button', { name: '＋ 字段', exact: true }).click();
    await page.getByRole('textbox', { name: '新字段名', exact: true }).fill('底线');
    await page.getByRole('textbox', { name: '新字段内容', exact: true }).fill('不牺牲无辜');
    await page.getByRole('button', { name: '添加字段', exact: true }).click();
    await page.getByRole('textbox', { name: '字段名：底线', exact: true }).fill('不可越过的底线');
    await page.getByRole('textbox', { name: '字段名：底线', exact: true }).press('Tab');
    await page.getByRole('textbox', { name: '字段内容：不可越过的底线', exact: true }).waitFor();
    await page.getByRole('checkbox', { name: '选择沈澄', exact: true }).check();
    await page.getByRole('checkbox', { name: '选择祝余', exact: true }).check();
    await page.getByRole('combobox', { name: '批量操作', exact: true }).selectOption('custom');
    await page.getByRole('textbox', { name: '批量字段名', exact: true }).fill('所属线');
    await page.getByRole('textbox', { name: '批量修改内容', exact: true }).fill('钟楼案');
    await page.getByRole('button', { name: '应用到所选', exact: true }).click();
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    let savedCanon = JSON.parse((await readCanon()).text);
    assert.deepEqual(savedCanon.extension, canonFixture.extension);
    assert.deepEqual(savedCanon.characters[0].unknown, { preserved: true });
    assert.deepEqual(
      savedCanon.characters[0].tags,
      ['主角', '钟楼'],
      'Typing separators must not concatenate tags.',
    );
    assert.equal(savedCanon.characters[0].customFields.不可越过的底线, '不牺牲无辜');
    assert.deepEqual(savedCanon.characters[0].customFields.复杂字段, { nested: [1] });
    assert.ok(savedCanon.characters.every((item) => item.customFields.所属线 === '钟楼案'));
    assert.equal(savedCanon.characters[1].trust, 'auto', 'Manual edits do not silently confirm AI guesses.');
    await page.getByRole('button', { name: '清空选择', exact: true }).click();
    await page.locator('.novel-canon-card button').filter({ hasText: '祝余' }).click();
    await page.getByRole('button', { name: '确认为设定', exact: true }).click();
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(JSON.parse((await readCanon()).text).characters[1].trust, 'confirmed');
    await page.getByRole('button', { name: '地点 0', exact: true }).click();
    await page.getByRole('button', { name: '＋ 地点', exact: true }).click();
    await page.getByRole('textbox', { name: '新地点名称', exact: true }).fill('旧钟楼');
    await page.locator('.novel-reference-new').getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('textbox', { name: '资料笔记', exact: true }).fill('第三声钟响之前，不要进入塔顶。');
    await page.getByRole('button', { name: '关系 0', exact: true }).click();
    await page.getByRole('button', { name: '＋ 关系', exact: true }).click();
    await page.getByRole('textbox', { name: '新关系名称', exact: true }).fill('调查');
    await page.getByRole('combobox', { name: '关系起点', exact: true }).selectOption('characters:0');
    await page.getByRole('combobox', { name: '关系终点', exact: true }).selectOption('locations:0');
    await page.locator('.novel-reference-new').getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('combobox', { name: '编辑关系起点', exact: true }).selectOption('characters:1');
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    savedCanon = JSON.parse((await readCanon()).text);
    assert.equal(savedCanon.relations[0].sourceId, 'person-b');
    assert.equal(savedCanon.relations[0].targetId, savedCanon.locations[0].id);
    await page.getByRole('button', { name: '地点 1', exact: true }).click();
    await page.locator('.novel-canon-card button').filter({ hasText: '旧钟楼' }).click();
    await page.locator('.novel-related button').filter({ hasText: '调查' }).waitFor();
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-reference-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await canonRegion.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(
      await page
        .getByRole('button', { name: '人物与资料', exact: true })
        .evaluate((el) => el.clientWidth >= 80),
      'Mobile reference names must scroll horizontally, not all shrink to ellipses.',
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-reference-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.novel-related button').filter({ hasText: '调查' }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.novel-canon-detail').getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(JSON.parse((await readCanon()).text).relations.length, 0);
    // Stale canon edits reject exactly like chapters, and UI preserves local text.
    await page.getByRole('button', { name: '人物 2', exact: true }).click();
    await page.locator('.novel-canon-card button').filter({ hasText: '沈澄' }).click();
    await page.getByRole('textbox', { name: '资料笔记', exact: true }).fill('本机未提交的笔记');
    const beforeExternal = await readCanon(),
      external = JSON.parse(beforeExternal.text);
    external.externalWriter = 'another-device';
    assert.equal(
      (
        await context.request.put(pagesOrigin + docApi + 'document', {
          data: { path: 'canon.json', text: JSON.stringify(external), expectedHash: beforeExternal.hash },
        })
      ).status(),
      200,
    );
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.getByRole('heading', { name: '保存冲突', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: '资料笔记', exact: true }).inputValue(),
      '本机未提交的笔记',
    );
    assert.equal(
      JSON.parse((await readCanon()).text).characters[0].notes,
      '对钟声敏感，但不会直接说出恐惧。',
    );
    await page.getByRole('button', { name: '以云端为基线，手工合并', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已采用云端作为新基线' }).waitFor();
    external.characters[0].notes = '本机未提交的笔记';
    await page.getByText('源文件 · 按需修改', { exact: true }).click();
    await page
      .getByRole('textbox', { name: '资料源文件', exact: true })
      .fill(JSON.stringify(external, null, 2));
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(JSON.parse((await readCanon()).text).externalWriter, 'another-device');
    // Structured JSON uses the same three-way UI as prose, without editing source.
    await page.getByRole('button', { name: '人物 2', exact: true }).click();
    await page.locator('.novel-canon-card button').filter({ hasText: '沈澄' }).click();
    await page.getByRole('textbox', { name: '资料笔记', exact: true }).fill('结构化三方合并的本机笔记');
    const jsonBase = await readCanon(),
      jsonRemote = JSON.parse(jsonBase.text);
    jsonRemote.extension.newRemoteField = { keep: true };
    assert.equal(
      (
        await context.request.put(pagesOrigin + docApi + 'document', {
          data: { path: 'canon.json', text: JSON.stringify(jsonRemote), expectedHash: jsonBase.hash },
        })
      ).status(),
      200,
    );
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    const jsonConflict = page.getByRole('region', { name: '三方冲突处理', exact: true });
    await jsonConflict.getByRole('button', { name: '对比并合并', exact: true }).click();
    const jsonPreview = jsonConflict.getByRole('textbox', { name: '合并结果预览', exact: true });
    await jsonPreview.waitFor();
    const mergedJson = JSON.parse(await jsonPreview.inputValue());
    assert.equal(mergedJson.characters[0].notes, '结构化三方合并的本机笔记');
    assert.deepEqual(mergedJson.extension.newRemoteField, { keep: true });
    assert.equal(JSON.parse((await readCanon()).text).characters[0].notes, '本机未提交的笔记');
    await jsonConflict.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '三方合并结果已载入' }).waitFor();
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.deepEqual(JSON.parse((await readCanon()).text), mergedJson);
    const beforeBom = await readCanon();
    assert.equal(
      (
        await context.request.put(pagesOrigin + docApi + 'document', {
          data: { path: 'canon.json', text: '\ufeff' + beforeBom.text, expectedHash: beforeBom.hash },
        })
      ).status(),
      200,
    );
    assert.equal(
      (await readCanon()).text,
      '\ufeff' + beforeBom.text,
      'Legacy UTF-8 BOM must be accepted and retained by the actual native save.',
    );
    await page.getByRole('button', { name: '创作规则', exact: true }).click();
    await page.getByLabel('创作规则编辑器', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '资料源文件', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await editor.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-mobile-start.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: resolve(root, 'test-results/cloud-native-desktop.png'), fullPage: true });
    const draft = await page
      .locator('textarea,[contenteditable="true"]')
      .evaluateAll((elements) =>
        elements
          .map((element) => element.value ?? element.textContent ?? '')
          .find((value) => value.includes('/workspace/novels/')),
      );
    assert.equal(
      draft,
      undefined,
      'Technical file instructions must not replace the author-facing conversation.',
    );
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
    const composer = page.locator('[contenteditable="true"]:not(.cm-content):visible').first();
    await composer.fill('作者未发送草稿：请保留这句话');
    await clickSidebarEntry(page, 'button', '模型设置');
    const modelSettings = page.getByRole('dialog', { name: '设置', exact: true });
    await modelSettings.waitFor();
    assert.equal(
      await modelSettings.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
      'true',
    );
    await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-models-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-models-mobile.png'),
      fullPage: true,
    });
    await modelSettings.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await page
        .locator('[contenteditable="true"]:not(.cm-content):visible')
        .first()
        .evaluate((element) => element.value ?? element.textContent),
      '作者未发送草稿：请保留这句话',
    );
    await clickSidebarEntry(page, 'button', '设置');
    await page
      .getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '模型', exact: true })
      .click();
    await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
    const providerBox = await page.getByRole('button', { name: '添加模型提供商', exact: true }).boundingBox();
    assert.ok(providerBox && providerBox.width > 240 && providerBox.x + providerBox.width <= 390);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-settings-mobile.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await clickSidebarEntry(page, 'link', '小说库');
    await page.goto(pagesOrigin + '/?settings=models');
    await modelSettings.waitFor();
    assert.equal(
      await modelSettings.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
      'true',
    );
    await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
    await page.waitForURL((url) => !url.searchParams.has('settings'));
    await modelSettings.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await clickSidebarEntry(page, 'link', '小说库');
    await page
      .locator('.book')
      .filter({ has: page.getByRole('heading', { name: '修士在飞升钟声里听见前人的求救声', exact: true }) })
      .getByRole('button', { name: '进入创作', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('textarea,[contenteditable="true"]')].some((element) =>
          (element.value ?? element.textContent ?? '').includes('作者未发送草稿：请保留这句话'),
        ),
      { timeout: 30000 },
    );
    await page.waitForURL((url) => !url.searchParams.has('novel'));
    assert.equal(modelPosts.length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(root, 'test-results/cloud-native-mobile.png'), fullPage: true });
    // Release the long editor/draft scenario's browser protocol/request objects
    // before the independent full-backup phase. Keep real auth/localStorage and
    // the SAME workerd/VFS/book. Do not lower fixture sizes or skip byte checks.
    const backupStorage = await context.storageState();
    await context.close();
    context = await browser.newContext({
      storageState: backupStorage,
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/(?:session[./]prompt|sessions\/[^/]+\/turn)$/.test(new URL(request.url()).pathname)
      )
        modelPosts.push(request.url());
    });
    await page.goto(pagesOrigin + '/novels/');
    await page.locator('#new-book').waitFor();
    console.log(
      'Independent backup phase after context release; driver heap MiB=' +
        Math.round(process.memoryUsage().heapUsed / 1048576),
    );
    // Authoring happens after the import receipt. Backup must discover current
    // files, not replay the original import's stale file list or source archive.
    const authoredPath = `/workspace/novels/${bookId}/chapters/新章 (二).md`;
    const authored = '\ufeff新写的雨夜。\r\n钟声停了，求救声还在。🌧️';
    assert.ok(
      (
        await context.request.put(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath),
          { data: Buffer.from('\ufeff' + authored) },
        )
      ).ok(),
    );
    assert.deepEqual(
      await (
        await context.request.get(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath),
        )
      ).body(),
      Buffer.from(authored),
    );
    await clickSidebarEntry(page, 'link', '小说库');
    const download = await backupDownload(page, () =>
      page
        .locator('.book')
        .filter({ has: page.getByRole('heading', { name: '修士在飞升钟声里听见前人的求救声', exact: true }) })
        .getByRole('button', { name: '备份', exact: true })
        .click(),
    );
    const downloadPath = resolve(work, 'book-backup.json');
    await download.saveAs(downloadPath);
    // BrowserServer uploads a path with Playwright's createReadStream pipeline.
    // A Buffer payload base64-copies the entire backup through the protocol and
    // defeats the 128 MiB test-driver bound; do not reduce backup contents instead.
    const backupInput = downloadPath;
    await retainBackupInput(page);
    await page.locator('#project-file').setInputFiles(backupInput);
    await page.getByRole('heading', { name: '恢复预览', exact: true }).waitFor();
    const downloaded = await verifyBackupSnapshot(page, { bookId, authored });
    console.log('Native backup downloaded; verifying ' + downloaded.files + ' complete files.');
    await page.getByRole('button', { name: '恢复为副本', exact: true }).click();
    // The pagination fixture adds 107 real history files. Original import does
    // serial per-file existence/CAS checks and writes; the 15-second UI default
    // is not a deadline for completing a verified 200-file restore.
    await page.getByRole('heading', { name: /恢复副本/ }).waitFor({ timeout: 60000 });
    console.log(
      'Native backup restored; driver heap MiB=' + Math.round(process.memoryUsage().heapUsed / 1048576),
    );
    const restored = await page.evaluate(async () => {
      const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
      return (await makeWorkspaceClient().list()).find((book) => book.restoredFrom);
    });
    assert.notEqual(restored.id, bookId);
    const verifiedBackup = await verifyBackupSnapshot(page, {
      bookId,
      authored,
      restoredRoot: restored.root,
    });
    assert.equal(verifiedBackup.files, downloaded.files);
    assert.equal(verifiedBackup.allBytesCompared, true);
    const restoredPath = restored.root + '/chapters/新章 (二).md';
    console.log(
      'Native backup byte comparisons passed; driver heap MiB=' +
        Math.round(process.memoryUsage().heapUsed / 1048576),
    );
    assert.deepEqual(
      await (
        await context.request.get(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(restoredPath),
        )
      ).body(),
      Buffer.from(authored),
    );
    assert.deepEqual(
      await (
        await context.request.get(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath),
        )
      ).body(),
      Buffer.from(authored),
    );
    assert.ok(
      (
        await context.request.put(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(restoredPath),
          { data: '副本后来的改动' },
        )
      ).ok(),
    );
    await page.locator('#project-file').setInputFiles(backupInput);
    await page.getByRole('button', { name: '恢复为副本', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '这份备份已恢复过' }).waitFor();
    assert.equal(
      await (
        await context.request.get(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(restoredPath),
        )
      ).text(),
      '副本后来的改动',
    );
    const linkPath = `/workspace/novels/${bookId}/test-link`;
    const linkResult = await (
      await context.request.post(pagesOrigin + '/api/workspace/exec', {
        data: { command: `ln -s /workspace/outside-backup-fixture.txt ${linkPath}`, cwd: '/workspace' },
      })
    ).json();
    assert.equal(linkResult.exitCode, 0);
    const linkRefused = await page.evaluate(async (id) => {
      const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
      try {
        await makeWorkspaceClient().backup(id);
        return false;
      } catch (error) {
        return error.message.includes('符号链接');
      }
    }, bookId);
    assert.equal(linkRefused, true, 'Native VFS symlinks must not be followed or silently omitted.');
    assert.ok(
      (
        await context.request.delete(pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(linkPath))
      ).ok(),
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-backup-mobile.png'),
      fullPage: true,
    });
    const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await other.newPage();
    otherPage.on('pageerror', (error) => errors.push(error.message));
    otherPage.on('pageerror', (error) => errors.push(error.message));
    await otherPage.goto(pagesOrigin + '/login');
    await otherPage.locator('#pin').fill('561904');
    await otherPage.getByRole('button', { name: '进入书库', exact: true }).click();
    await otherPage.waitForURL((url) => url.searchParams.get('view') === 'library');
    assert.deepEqual(
      await (
        await other.request.get(pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath))
      ).body(),
      Buffer.from(authored),
    );
    await clickSidebarEntry(page, 'link', '账号与 PIN');
    await page.locator('#current-pin').fill('000000');
    await page.locator('#new-pin').fill('815703');
    await page.locator('#confirm-pin').fill('815703');
    await page.getByRole('button', { name: '保存新 PIN', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '当前 PIN 不正确' }).waitFor();
    await page.locator('#current-pin').fill('561904');
    await page.getByRole('button', { name: '保存新 PIN', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'PIN 已保存' }).waitFor();
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-pin-account-mobile.png'),
      fullPage: true,
    });
    assert.equal(
      (
        await other.request.get(pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath))
      ).status(),
      401,
    );
    await otherPage.reload();
    await otherPage.waitForURL((url) => url.pathname === '/login');
    await otherPage.locator('#pin').fill('561904');
    await otherPage.getByRole('button', { name: '进入书库', exact: true }).click();
    await otherPage.getByRole('status').filter({ hasText: 'PIN 不正确' }).waitFor();
    await otherPage.locator('#pin').fill('815703');
    await otherPage.getByRole('button', { name: '进入书库', exact: true }).click();
    await otherPage.waitForURL((url) => url.searchParams.get('view') === 'library');
    await clickSidebarEntry(otherPage, 'link', '账号与 PIN');
    await otherPage.getByRole('button', { name: '退出登录', exact: true }).click();
    await otherPage.waitForURL((url) => url.pathname === '/login');
    await otherPage.getByText('忘记 PIN？', { exact: true }).click();
    await otherPage.locator('#recovery-key').fill(fixtureKey);
    await otherPage.locator('#reset-pin').fill('927461');
    await otherPage.locator('#reset-confirm').fill('927461');
    await otherPage.getByRole('button', { name: '重设 PIN 并登录', exact: true }).click();
    await otherPage.waitForURL((url) => url.searchParams.get('view') === 'library');
    assert.deepEqual(
      await (
        await other.request.get(pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath))
      ).body(),
      Buffer.from(authored),
    );
    assert.equal(
      (
        await context.request.get(
          pagesOrigin + '/api/workspace/file?path=' + encodeURIComponent(authoredPath),
        )
      ).status(),
      401,
    );
    // Exercise the real native input facade but intercept its prompt carrier
    // BEFORE the Worker. This proves action wiring without a provider/model call.
    await otherPage.setViewportSize({ width: 1280, height: 900 });
    await otherPage.addLocatorHandler(
      otherPage.getByRole('button', { name: '继续', exact: true }),
      async () => {
        await otherPage.getByRole('button', { name: '继续', exact: true }).click();
      },
    );
    await otherPage.goto(pagesOrigin + '/?novel=' + bookId);
    await otherPage.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '已读取' }).waitFor();
    const nativeComposer = otherPage.locator('[contenteditable="true"]:not(.cm-content):visible').first();
    await otherPage.getByRole('button', { name: '创作助手', exact: true }).click();
    await nativeComposer.fill('必须保留的对话草稿');
    // 1280px viewport minus the native sidebar now intentionally uses one pane.
    // Return via the real workspace control instead of clicking hidden paper tabs.
    await otherPage.getByRole('button', { name: '返回书稿', exact: true }).click();
    await otherPage.getByRole('button', { name: '设定', exact: true }).click();
    await otherPage.getByRole('button', { name: '正文', exact: true }).click();
    assert.equal(await nativeComposer.textContent(), '必须保留的对话草稿');
    assert.equal(await otherPage.getByRole('textbox', { name: '这次想怎么写', exact: true }).count(), 0);
    // Lexical owns input state; use actual editing keys rather than replacing
    // contenteditable.textContent and racing its input reconciliation.
    const clearNativeComposer = async () => {
      const assistant = otherPage.getByRole('button', { name: '创作助手', exact: true });
      if (await assistant.isVisible()) await assistant.click();
      // A failed task is restored as the complete native Lexical document, much
      // taller than its scroll viewport. Clicking that document's geometric
      // centre can hit the action bar below the clipped viewport. Focus the
      // actual input, then exercise real select-all/delete keys as before.
      await nativeComposer.focus();
      await nativeComposer.press('ControlOrMeta+A');
      await nativeComposer.press('Backspace');
      await nativeComposer.waitFor();
      await otherPage.waitForFunction(() =>
        Array.from(document.querySelectorAll('[contenteditable="true"]:not(.cm-content)'))
          .filter((el) => el.getBoundingClientRect().width > 0)
          .every((el) => !el.textContent?.trim()),
      );
      await otherPage.getByRole('button', { name: '返回书稿', exact: true }).click();
    };
    let interceptedPrompt,
      interceptedCount = 0;
    await otherPage.route(/\/api\/session[./]prompt$/, async (route) => {
      interceptedPrompt = route.request().postDataJSON();
      interceptedCount++;
      await route.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'Synthetic test blocked provider calls.',
      });
    });
    const submitted = otherPage.waitForResponse((response) =>
      /\/api\/session[./]prompt$/.test(new URL(response.url()).pathname),
    );
    await otherPage.getByRole('button', { name: /^(接着写|按纲续写)$/ }).click();
    await submitted;
    // This intentionally unlinked chapter must now prepare its missing outline
    // through the original Agent, not create an unplanned prose proposal in UI.
    // The actual frozen rules/templates are checked at prepare/model HTTP by the
    // engine pipeline fixture; this carrier is intercepted before tool execution.
    assert.match(JSON.stringify(interceptedPrompt), /novel_proposal_prepare/);
    assert.match(JSON.stringify(interceptedPrompt), new RegExp(bookId));
    assert.match(JSON.stringify(interceptedPrompt), /先补充对应章节规划/);
    assert.match(JSON.stringify(interceptedPrompt), /必须保留的对话草稿/);
    await otherPage.waitForFunction(() =>
      Array.from(document.querySelectorAll('[contenteditable="true"]')).some((el) =>
        /^\[novel-task:v[12]\]/.test(el.textContent ?? ''),
      ),
    );
    const failedAttemptDocuments = await (
      await other.request.get(pagesOrigin + '/api/novels/' + bookId + '/documents')
    ).json();
    await otherPage.getByRole('button', { name: '正文', exact: true }).click();
    await otherPage.getByRole('button', { name: /^(接着写|按纲续写)$/ }).click();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '未发送成功的完整任务' }).waitFor();
    assert.equal(
      interceptedCount,
      1,
      'Failed native request must be retried as itself, not wrapped into a second writing request.',
    );
    assert.equal(
      (await (await other.request.get(pagesOrigin + '/api/novels/' + bookId + '/documents')).json()).proposals
        .length,
      failedAttemptDocuments.proposals.length,
    );
    // Canon uses the SAME input facade. Intercept its carrier too; synthetic
    // candidate files exercise review/publication without a paid/provider call.
    const otherDoc = '/api/novels/' + bookId + '/';
    const evidencePath = 'notes/资料整理样本.md';
    const evidenceText = '守钟人许微将青铜钥匙递给沈澄。青铜钥匙上刻着失落的城徽。';
    assert.equal(
      (
        await other.request.put(pagesOrigin + otherDoc + 'document', {
          data: { path: evidencePath, text: evidenceText, expectedHash: null },
        })
      ).status(),
      200,
    );
    await clearNativeComposer();
    await otherPage.getByRole('button', { name: '设定', exact: true }).click();
    await otherPage.getByRole('button', { name: '人物与资料', exact: true }).click();
    assert.equal(
      await otherPage.getByText('AI 整理建议', { exact: true }).count(),
      0,
      'Dedicated extraction entrance is retired; canon editing and old suggestion recovery remain.',
    );
    // Seed a HISTORICAL suggestion through the same document/proposal API. This
    // verifies old data recovery, not the retired organizer. Real Agent prepare/
    // submit remains covered by the native tool-scope integration fixture.
    const baseCanon = await (
      await other.request.get(pagesOrigin + otherDoc + 'document?path=canon.json')
    ).json();
    const historic = await other.request.post(pagesOrigin + otherDoc + 'proposals', {
      data: {
        path: 'canon.json',
        expectedHash: baseCanon.hash,
        sources: [evidencePath],
        originSessionId: await otherPage.locator('.novel-manuscript').getAttribute('data-session-id'),
      },
    });
    assert.equal(historic.status(), 200);
    await openGenerationRecords(otherPage);
    await otherPage.getByRole('region', { name: '资料整理提案', exact: true }).waitFor();
    const currentDocs = await (await other.request.get(pagesOrigin + otherDoc + 'documents')).json();
    const canonProposal = currentDocs.proposals.find((proposal) => proposal.target === 'canon.json');
    assert.deepEqual(
      canonProposal.sources.map((source) => source.path),
      [evidencePath],
    );
    const canonicalBefore = await (
      await other.request.get(pagesOrigin + otherDoc + 'document?path=canon.json')
    ).json();
    const writeCandidate = (text) =>
      other.request.put(
        pagesOrigin +
          '/api/workspace/file?path=' +
          encodeURIComponent('/workspace/novels/' + bookId + '/' + canonProposal.draft),
        { data: text },
      );
    await writeCandidate('{"characters":[');
    await otherPage
      .getByText('候选 JSON 尚未完整；可以继续浏览，完成后会自动检查。', { exact: true })
      .waitFor();
    await otherPage.getByRole('button', { name: '正文', exact: true }).click();
    await otherPage.getByRole('textbox', { name: '书稿正文', exact: true }).waitFor();
    await openGenerationRecords(otherPage);
    await otherPage
      .locator('.novel-proposals > .novel-document-strip button')
      .filter({ hasText: '资料整理' })
      .click();
    const suggestion = JSON.parse(canonicalBefore.text.replace(/^\uFEFF/, ''));
    suggestion.characters[0].notes = 'AI 不能偷改作者已确认的笔记';
    suggestion.characters.push({
      id: 'keeper',
      name: '许微',
      trust: 'auto',
      role: '守钟人',
      evidenceSources: [{ path: evidencePath, quote: '守钟人许微将青铜钥匙递给沈澄。' }],
    });
    suggestion.items ??= [];
    const itemIndex = suggestion.items.length;
    suggestion.items.push({
      id: 'bronze-key',
      name: '青铜钥匙',
      trust: 'auto',
      notes: '钥匙上刻着失落的城徽。',
      evidenceSources: [{ path: evidencePath, quote: '青铜钥匙上刻着失落的城徽。' }],
    });
    suggestion.characters.push({
      id: 'unproven-name',
      name: '沈遥',
      trust: 'auto',
      notes: '引用未证实这个姓名。',
      evidenceSources: [{ path: evidencePath, quote: '守钟人许微将青铜钥匙递给沈澄。' }],
    });
    suggestion.relations ??= [];
    suggestion.relations.push({
      id: 'unproven-relation',
      label: '亲属',
      sourceType: 'character',
      sourceId: suggestion.characters[0].id,
      targetType: 'character',
      targetId: 'keeper',
      trust: 'auto',
      evidenceSources: [{ path: evidencePath, quote: '守钟人许微将青铜钥匙递给沈澄。' }],
    });
    await writeCandidate(JSON.stringify(suggestion, null, 2));
    await otherPage.getByRole('checkbox', { name: '收录青铜钥匙', exact: true }).waitFor();
    assert.equal(await otherPage.getByRole('checkbox', { name: '收录沈澄', exact: true }).isDisabled(), true);
    const canonReview = await (
      await other.request.get(pagesOrigin + otherDoc + 'review?id=' + canonProposal.id)
    ).json();
    assert.equal(canonReview.canon.validCount, 4);
    assert.equal(
      canonReview.canon.changes.find((change) => change.after.id === 'unproven-name')
        .requiresIndividualReview,
      true,
    );
    await otherPage.getByRole('button', { name: '编辑候选稿', exact: true }).click();
    await otherPage.getByText('资料候选 · 尚未收录', { exact: true }).waitFor();
    await otherPage.getByRole('button', { name: /^物品 \d+$/ }).click();
    await otherPage.locator('.novel-canon-card button').filter({ hasText: '青铜钥匙' }).click();
    const candidateDetail = otherPage.getByRole('region', { name: '编辑青铜钥匙', exact: true });
    await candidateDetail
      .getByRole('textbox', { name: '资料笔记', exact: true })
      .fill('作者修正的候选笔记；尚未收录。');
    assert.equal(await otherPage.getByRole('button', { name: '返回核对', exact: true }).isDisabled(), true);
    await candidateDetail.locator('.novel-custom-fields > summary').click();
    await candidateDetail.getByRole('button', { name: '＋ 字段', exact: true }).click();
    await candidateDetail.getByRole('textbox', { name: '新字段名', exact: true }).fill('保管位置');
    await candidateDetail
      .getByRole('textbox', { name: '新字段内容', exact: true })
      .fill('沈澄手中，需核对后收录');
    await candidateDetail.getByRole('button', { name: '添加字段', exact: true }).click();
    const proofDetails = candidateDetail.locator('.novel-candidate-evidence');
    await proofDetails.locator('summary').click();
    await candidateDetail
      .getByRole('textbox', { name: '原文引句 1', exact: true })
      .fill('青铜钥匙上刻着失落的城徽。');
    await candidateDetail.getByRole('button', { name: '查看第 1 段来源', exact: true }).click();
    await candidateDetail.locator('.novel-canon-source pre').filter({ hasText: evidenceText }).waitFor();
    assert.equal(await candidateDetail.getByRole('button', { name: '确认为设定', exact: true }).count(), 0);
    for (const width of [1280, 768, 390]) {
      await otherPage.setViewportSize({ width, height: 900 });
      assert.ok(await otherPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await candidateDetail.scrollIntoViewIfNeeded();
      await otherPage.screenshot({
        path: resolve(root, 'test-results/cloud-native-canon-candidate-' + width + '.png'),
        fullPage: true,
      });
    }
    await otherPage.getByRole('button', { name: /^人物 \d+$/ }).click();
    await otherPage.locator('.novel-canon-card button').filter({ hasText: '沈澄' }).click();
    assert.equal(
      await otherPage
        .getByRole('region', { name: '编辑沈澄', exact: true })
        .getByRole('textbox', { name: '资料名称', exact: true })
        .isDisabled(),
      true,
    );
    const remoteCandidate = structuredClone(suggestion);
    remoteCandidate.characters.find((item) => item.id === 'keeper').notes = '另一设备修改的候选笔记';
    const remoteSave = await other.request.put(pagesOrigin + otherDoc + 'document', {
      data: {
        path: canonProposal.draft,
        text: JSON.stringify(remoteCandidate),
        expectedHash: canonReview.draft.hash,
      },
    });
    assert.equal(remoteSave.status(), 200);
    const remoteSaved = await remoteSave.json();
    await otherPage.getByRole('button', { name: '保存候选', exact: true }).click();
    const candidateConflict = otherPage.getByRole('region', { name: '三方冲突处理', exact: true });
    await candidateConflict.getByRole('button', { name: '对比并合并', exact: true }).click();
    const candidateMerge = candidateConflict.getByRole('textbox', { name: '合并结果预览', exact: true });
    await candidateMerge.waitFor();
    const mergedCandidate = JSON.parse(await candidateMerge.inputValue());
    assert.equal(
      mergedCandidate.characters.find((item) => item.id === 'keeper').notes,
      '另一设备修改的候选笔记',
    );
    assert.equal(mergedCandidate.items[itemIndex].notes, '作者修正的候选笔记；尚未收录。');
    await candidateConflict.getByRole('button', { name: '载入合并结果（尚未保存）', exact: true }).click();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '三方合并结果已载入' }).waitFor();
    await otherPage.getByRole('button', { name: '保存候选', exact: true }).click();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    const correctedDraft = await (
      await other.request.get(
        pagesOrigin + otherDoc + 'document?path=' + encodeURIComponent(canonProposal.draft),
      )
    ).json();
    const correctedValue = JSON.parse(correctedDraft.text);
    assert.equal(correctedValue.items[itemIndex].notes, '作者修正的候选笔记；尚未收录。');
    assert.equal(correctedValue.items[itemIndex].customFields.保管位置, '沈澄手中，需核对后收录');
    assert.equal(correctedValue.items[itemIndex].trust, 'auto');
    assert.equal(
      (await (await other.request.get(pagesOrigin + otherDoc + 'document?path=canon.json')).json()).text,
      canonicalBefore.text,
    );
    const draftHistory = await (
      await other.request.get(
        pagesOrigin + otherDoc + 'history?path=' + encodeURIComponent(canonProposal.draft),
      )
    ).json();
    assert.ok(draftHistory.versions.some((version) => version.hash === canonReview.draft.hash));
    assert.ok(draftHistory.versions.some((version) => version.hash === remoteSaved.hash));
    await otherPage.getByRole('button', { name: '返回核对', exact: true }).click();
    await otherPage.setViewportSize({ width: 1280, height: 900 });
    console.log(
      'Canon candidate correction passed: original editor, source quote and custom fields, locked author records, draft CAS/history, explicit re-review and 1280/768/390 layouts.',
    );
    await otherPage.getByRole('button', { name: '选择可收录资料', exact: true }).click();
    assert.equal(await otherPage.getByRole('checkbox', { name: '收录许微', exact: true }).isChecked(), true);
    assert.equal(
      await otherPage.getByRole('checkbox', { name: '收录青铜钥匙', exact: true }).isChecked(),
      true,
    );
    const riskyName = otherPage.getByRole('checkbox', { name: '收录沈遥', exact: true });
    assert.equal(await riskyName.isChecked(), false);
    assert.equal(await otherPage.getByRole('checkbox', { name: '收录亲属', exact: true }).isChecked(), false);
    await riskyName
      .locator('xpath=ancestor::article')
      .getByText(/名称或别名未出现在/)
      .waitFor();
    await riskyName.check();
    assert.equal(
      await riskyName.isChecked(),
      true,
      'Individual author judgement remains available; no new blanket rejection.',
    );
    await otherPage.getByRole('button', { name: '清空选择', exact: true }).click();
    assert.equal(
      (await (await other.request.get(pagesOrigin + otherDoc + 'document?path=canon.json')).json()).text,
      canonicalBefore.text,
    );
    await otherPage.getByRole('checkbox', { name: '收录青铜钥匙', exact: true }).check();
    const itemCard = otherPage
      .getByRole('checkbox', { name: '收录青铜钥匙', exact: true })
      .locator('xpath=ancestor::article');
    const itemDetails = itemCard.locator('details').first();
    if (!(await itemDetails.getAttribute('open'))) {
      if (!(await itemDetails.evaluate((el) => el.open)))
        await itemDetails.locator('summary').first().click();
    }
    await itemCard.getByRole('button', { name: '查看原文', exact: true }).click();
    await otherPage.locator('.novel-canon-source pre').filter({ hasText: evidenceText }).waitFor();
    await otherPage.getByRole('button', { name: '收起原文', exact: true }).click();
    await itemCard.scrollIntoViewIfNeeded();
    await otherPage.screenshot({
      path: resolve(root, 'test-results/cloud-native-canon-proposal-desktop.png'),
      fullPage: true,
    });
    await otherPage.setViewportSize({ width: 390, height: 844 });
    assert.ok(await otherPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await otherPage.screenshot({
      path: resolve(root, 'test-results/cloud-native-canon-proposal-mobile.png'),
      fullPage: true,
    });
    await otherPage.getByRole('button', { name: '收录所选 · 1', exact: true }).click();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '已收录 1 条待确认资料' }).waitFor();
    const acceptedCanon = await (
      await other.request.get(pagesOrigin + otherDoc + 'document?path=canon.json')
    ).json();
    const originalCanon = JSON.parse(canonicalBefore.text.replace(/^\uFEFF/, '')),
      publishedCanon = JSON.parse(acceptedCanon.text.replace(/^\uFEFF/, ''));
    assert.deepEqual(
      publishedCanon.characters,
      originalCanon.characters,
      'Unselected author edits and AI people must not enter canon.',
    );
    assert.equal(publishedCanon.items[itemIndex].name, '青铜钥匙');
    assert.equal(publishedCanon.items[itemIndex].trust, 'auto', 'Collection is not author confirmation.');
    assert.equal(publishedCanon.items[itemIndex].notes, '作者修正的候选笔记；尚未收录。');
    const canonHistory = await (
      await other.request.get(pagesOrigin + otherDoc + 'history?path=canon.json')
    ).json();
    assert.ok(canonHistory.versions.some((version) => version.hash === canonicalBefore.hash));
    // One outline area, full previews, real pointer sorting, linked prose and the
    // same proposal/history transaction. All candidate content is synthetic.
    await otherPage.setViewportSize({ width: 1280, height: 900 });
    const readOutline = async () =>
      (await other.request.get(pagesOrigin + otherDoc + 'document?path=outline.json')).json();
    const emptyOutline = await readOutline();
    const synopsisTail = '【完整概要结尾：证据必须由港民保存】';
    const longSynopsis =
      Array.from(
        { length: 16 },
        (_, n) =>
          `第 ${n + 1} 次核验，沈澄以值夜资格换取查阅原件的许可，让港民各留一份记录；闻砚必须解释姐姐来信上不一致的日期。`,
      ).join('\n\n') +
      '\n\n' +
      synopsisTail;
    const originalPlan = {
      worldArc: { unknown: '保留世界线' },
      chapters: [
        {
          chapter: 1,
          title: '钟楼前夜',
          summary: longSynopsis,
          note: '本章不揭开姐姐的全部去向',
          extension: { keep: true },
          plotPoints: [
            { id: 'stable-beat-a', desc: '拆开来信', done: false, custom: '保留' },
            { id: 'stable-beat-b', desc: '留下两份记录', done: false },
          ],
        },
      ],
    };
    assert.equal(
      (
        await other.request.put(pagesOrigin + otherDoc + 'document', {
          data: { path: 'outline.json', text: JSON.stringify(originalPlan), expectedHash: emptyOutline.hash },
        })
      ).status(),
      200,
    );
    let releaseOutlineRead, observedOutlineRead;
    const delayedRead = new Promise((resolve) => {
      observedOutlineRead = resolve;
    });
    const outlineReadRoute = new RegExp('/api/novels/' + bookId + '/document\\?path=outline\\.json$');
    await otherPage.route(outlineReadRoute, async (route) => {
      const release = new Promise((resolve) => {
        releaseOutlineRead = resolve;
      });
      observedOutlineRead();
      await release;
      await route.continue();
    });
    await otherPage.getByRole('button', { name: '大纲', exact: true }).click();
    await delayedRead;
    await otherPage.getByRole('status').filter({ hasText: '正在打开文稿…' }).waitFor();
    assert.equal(
      await otherPage.getByRole('textbox', { name: '资料源文件', exact: true }).count(),
      0,
      'Never render the previous file under a newly selected section during loading.',
    );
    releaseOutlineRead();
    await otherPage.getByRole('region', { name: '章节大纲', exact: true }).waitFor();
    await otherPage.unroute(outlineReadRoute);
    assert.equal(await otherPage.locator('.novel-outline-summary').first().textContent(), longSynopsis);
    const previewGeometry = await otherPage
      .locator('.novel-outline-summary')
      .first()
      .evaluate((el) => ({ height: el.clientHeight, scrollHeight: el.scrollHeight }));
    assert.ok(
      previewGeometry.height > 500 && previewGeometry.scrollHeight <= previewGeometry.height + 1,
      'Outline preview flows in full, not a clipped text box.',
    );
    await otherPage.getByRole('button', { name: '编辑章纲', exact: true }).click();
    await otherPage.getByRole('textbox', { name: '大纲标题', exact: true }).fill('钟楼前夜 · 作者修订');
    await otherPage.getByRole('textbox', { name: '剧情点 2', exact: true }).scrollIntoViewIfNeeded();
    const grip = await otherPage.getByRole('button', { name: '拖动剧情点 1', exact: true }).boundingBox();
    const drop = await otherPage.getByRole('textbox', { name: '剧情点 2', exact: true }).boundingBox();
    assert.ok(grip && drop && grip.y > 0 && drop.y > 0);
    await otherPage.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await otherPage.mouse.down();
    await otherPage.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 8 });
    await otherPage.mouse.up();
    assert.equal(
      await otherPage.getByRole('textbox', { name: '剧情点 1', exact: true }).inputValue(),
      '留下两份记录',
    );
    await otherPage.getByRole('button', { name: '上移剧情点 2', exact: true }).click();
    await otherPage.getByRole('button', { name: '保存大纲', exact: true }).click();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    const authorOutline = await readOutline(),
      authorRows = JSON.parse(authorOutline.text).chapters;
    assert.deepEqual(authorRows[0].plotPoints, originalPlan.chapters[0].plotPoints);
    assert.equal(authorRows[0].note, originalPlan.chapters[0].note);
    await otherPage.getByRole('button', { name: '起草本章', exact: true }).click();
    await otherPage.getByRole('button', { name: '按纲生成本章', exact: true }).waitFor();
    const linkedOutline = await readOutline(),
      linkedRow = JSON.parse(linkedOutline.text).chapters[0];
    assert.match(linkedRow.chapterPath, /^chapters\//);
    await clearNativeComposer();
    const linkedWrite = otherPage.waitForResponse((response) =>
      /\/api\/session[./]prompt$/.test(new URL(response.url()).pathname),
    );
    await otherPage.getByRole('button', { name: '按纲生成本章', exact: true }).click();
    await linkedWrite;
    assert.match(JSON.stringify(interceptedPrompt), /proposal_id/);
    assert.match(JSON.stringify(interceptedPrompt), /chapters\//);
    assert.doesNotMatch(JSON.stringify(interceptedPrompt), /executionPrompt/);
    assert.doesNotMatch(JSON.stringify(interceptedPrompt), /试写本章开场场景/);
    await openGenerationRecords(otherPage); // Interrupted/unsent task is recoverable, not an approval step.
    const writingBasis = otherPage.locator('.novel-writing-basis');
    await writingBasis.locator(':scope > summary').click();
    const basisPlan = writingBasis.getByRole('region', { name: '本次关联章纲', exact: true });
    await basisPlan.waitFor();
    assert.equal(await basisPlan.locator('p').first().textContent(), linkedRow.summary);
    assert.ok((await basisPlan.textContent()).includes(linkedRow.note));
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [768, 1024, 'tablet'],
      [390, 844, 'mobile'],
    ]) {
      await otherPage.setViewportSize({ width, height });
      await writingBasis.scrollIntoViewIfNeeded();
      assert.ok(await otherPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await writingBasis.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
      await otherPage.screenshot({
        path: resolve(root, 'test-results/cloud-native-writing-basis-' + name + '.png'),
        fullPage: true,
      });
    }
    await otherPage.setViewportSize({ width: 1280, height: 900 });
    await writingBasis.locator(':scope > summary').click();
    const linkedDoc = await (
      await other.request.get(
        pagesOrigin + otherDoc + 'document?path=' + encodeURIComponent(linkedRow.chapterPath),
      )
    ).json();
    const writtenText = '# 钟楼前夜\n\n沈澄将姐姐的来信藏进值夜簿，另抄一份交给港民。';
    assert.equal(
      (
        await other.request.put(pagesOrigin + otherDoc + 'document', {
          data: { path: linkedRow.chapterPath, text: writtenText, expectedHash: linkedDoc.hash },
        })
      ).status(),
      200,
    );
    await clearNativeComposer();
    await otherPage.getByRole('button', { name: '大纲', exact: true }).click();
    await otherPage.getByText('AI 续规划 / 调整', { exact: true }).click();
    await otherPage.getByRole('spinbutton', { name: '规划起始章', exact: true }).fill('1');
    await otherPage.getByRole('spinbutton', { name: '本批规划章数', exact: true }).fill('2');
    const outlineSubmit = otherPage.waitForResponse((response) =>
      /\/api\/session[./]prompt$/.test(new URL(response.url()).pathname),
    );
    await otherPage.getByRole('button', { name: '生成规划候选', exact: true }).click();
    await outlineSubmit;
    assert.match(JSON.stringify(interceptedPrompt), /贯穿全篇/);
    await openGenerationRecords(otherPage);
    await otherPage
      .locator('.novel-proposals > .novel-document-strip button')
      .filter({ hasText: '大纲规划' })
      .click();
    await otherPage.getByRole('region', { name: '大纲规划提案', exact: true }).waitFor();
    const pendingOutlineList = await (await other.request.get(pagesOrigin + otherDoc + 'documents')).json();
    const outlineProposal = pendingOutlineList.proposals.find((p) => p.target === 'outline.json');
    assert.equal(
      outlineProposal.plan.sources.find((source) => source.path === linkedRow.chapterPath).written,
      true,
    );
    const putOutlineCandidate = (text) =>
      other.request.put(
        pagesOrigin +
          '/api/workspace/file?path=' +
          encodeURIComponent('/workspace/novels/' + bookId + '/' + outlineProposal.draft),
        { data: text },
      );
    const globalDirection =
      '沈澄试图让港民拥有独立记录，姐姐的失踪牵动钟楼禁令；每次选择都有代价，最终兑现分散保存证据的承诺，而非依靠突然恢复的记忆。';
    const existingProjection = {
      chapter: 1,
      title: linkedRow.title,
      summary: linkedRow.summary,
      plotPoints: linkedRow.plotPoints.map((point) => point.desc),
    };
    await putOutlineCandidate(JSON.stringify({ storyPlan: globalDirection, chapters: [existingProjection] }));
    await otherPage.getByText('缺少第 2 章，请补齐候选；不必重生成已完成内容。', { exact: true }).waitFor();
    assert.equal(
      await otherPage.getByRole('button', { name: '接受本批规划', exact: true }).isDisabled(),
      true,
    );
    // Retry resumes the same candidate/proposal rather than paying to restart it.
    await clearNativeComposer();
    const resumeResponse = otherPage.waitForResponse((response) =>
      /\/api\/session[./]prompt$/.test(new URL(response.url()).pathname),
    );
    await otherPage.getByRole('button', { name: '补全 / 修正规划', exact: true }).click();
    await resumeResponse;
    assert.match(JSON.stringify(interceptedPrompt), /保留已完成且有效的章节/);
    const completedPlan = {
      storyPlan: globalDirection,
      chapters: [
        existingProjection,
        {
          chapter: 2,
          title: '失去资格',
          summary:
            '沈澄公开两份值夜记录，失去守夜资格；她必须追查是谁修改了潮汐刻度，港民第一次拥有可核验的原件。',
          plotPoints: ['公开记录并失去资格', '把调查转向刻度修改者'],
        },
      ],
    };
    await putOutlineCandidate(JSON.stringify(completedPlan, null, 2));
    await otherPage.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((el) => el.textContent === '接受本批规划');
      return button && !button.disabled;
    });
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [768, 1024, 'tablet'],
      [390, 844, 'mobile'],
    ]) {
      await otherPage.setViewportSize({ width, height });
      if (width === 768) {
        await otherPage.waitForFunction(
          () => document.querySelector('.novel-manuscript')?.getBoundingClientRect().width >= 600,
        );
        assert.ok(await otherPage.getByRole('button', { name: '创作助手', exact: true }).isVisible());
      }
      assert.ok(await otherPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(
        await otherPage
          .locator('.novel-outline-review')
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      await otherPage.screenshot({
        path: resolve(root, 'test-results/cloud-native-outline-' + name + '.png'),
        fullPage: true,
      });
    }
    await otherPage.getByRole('button', { name: '接受本批规划', exact: true }).click();
    await otherPage.locator('.novel-ms-status').filter({ hasText: '本批规划已接受' }).waitFor();
    const finalOutline = JSON.parse((await readOutline()).text);
    assert.deepEqual(finalOutline.worldArc, originalPlan.worldArc);
    assert.deepEqual(finalOutline.chapters[0], linkedRow);
    assert.equal(finalOutline.chapters[1].chapter, 2);
    assert.equal(
      (
        await (
          await other.request.get(
            pagesOrigin + otherDoc + 'document?path=' + encodeURIComponent(linkedRow.chapterPath),
          )
        ).json()
      ).text,
      writtenText,
    );
    assert.equal(
      (await (await other.request.get(pagesOrigin + otherDoc + 'document?path=notes%2Fstory-plan.md')).json())
        .text,
      globalDirection,
    );
    await otherPage.getByRole('button', { name: '设定', exact: true }).click();
    await otherPage.getByLabel('人物与资料编辑器', { exact: true }).waitFor();
    assert.equal(
      await otherPage.getByRole('region', { name: '章节大纲', exact: true }).count(),
      0,
      'Outline must not leak back into the settings view.',
    );
    await otherPage.getByRole('button', { name: '正文', exact: true }).click();
    await waitEditor(otherPage.getByRole('textbox', { name: '书稿正文', exact: true }), writtenText);
    assert.equal(
      await readEditor(otherPage.getByRole('textbox', { name: '书稿正文', exact: true })),
      writtenText,
      'Return from outline/settings keeps the same chapter, not the first filename.',
    );
    // A real workerd storage transaction must roll back the direction when the
    // merged outline exceeds the existing single-file limit after a prior write.
    const atomicBook = await otherPage.evaluate(async () => {
      const { makeBookBundle } = await import('/novel-assets/bundle.mjs'),
        { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
      const bundle = await makeBookBundle(null, { seed: '仅用于验证规划事务回滚的独立样本' });
      return (await makeWorkspaceClient().import(bundle)).book;
    });
    const atomicApi = '/api/novels/' + atomicBook.id + '/';
    const atomicOriginal = await (
      await other.request.get(pagesOrigin + atomicApi + 'document?path=outline.json')
    ).json();
    const largeBase = JSON.stringify({
      extension: '字'.repeat(Math.floor((2 * 1024 * 1024 - 10000) / 3)),
      chapters: [],
    });
    const largeSaved = await (
      await other.request.put(pagesOrigin + atomicApi + 'document', {
        data: { path: 'outline.json', text: largeBase, expectedHash: atomicOriginal.hash },
      })
    ).json();
    assert.ok(largeSaved.hash);
    const atomicProposal = await (
      await other.request.post(pagesOrigin + atomicApi + 'proposals', {
        data: { path: 'outline.json', expectedHash: largeSaved.hash, range: { start: 1, end: 1 } },
      })
    ).json();
    const largeCandidate = JSON.stringify({
      storyPlan: '不应留下半份方向',
      chapters: [{ chapter: 1, title: '超限样本', summary: '文'.repeat(6000), plotPoints: ['触发上限'] }],
    });
    assert.equal(
      (
        await other.request.put(
          pagesOrigin +
            '/api/workspace/file?path=' +
            encodeURIComponent(atomicBook.root + '/' + atomicProposal.draft),
          { data: largeCandidate },
        )
      ).status(),
      200,
    );
    const atomicReview = await (
      await other.request.get(pagesOrigin + atomicApi + 'review?id=' + atomicProposal.id)
    ).json();
    assert.equal(atomicReview.outline.valid, true);
    const refused = await other.request.post(pagesOrigin + atomicApi + 'accept', {
      data: { id: atomicProposal.id, draftHash: atomicReview.draft.hash },
    });
    assert.equal(refused.status(), 413);
    assert.equal(
      (await other.request.get(pagesOrigin + atomicApi + 'document?path=notes%2Fstory-plan.md')).status(),
      404,
    );
    assert.equal(
      (await (await other.request.get(pagesOrigin + atomicApi + 'document?path=outline.json')).json()).text,
      largeBase,
    );
    // Restart the complete OWNED localhost service stack against the SAME data.
    // Wrangler's Pages proxy retains an ephemeral dev Service Binding socket;
    // recreating both runtimes tests a full restart, not dev hot-rebind behavior.
    const longReadURL = pagesOrigin + '/api/novels/' + bookId + '/document?path=chapters%2Flong-fixture.md';
    const beforeRestartResponse = await other.request.get(longReadURL);
    assert.equal(beforeRestartResponse.status(), 200);
    const beforeRestart = await beforeRestartResponse.json();
    const revisionURL = pagesOrigin + '/api/novels/' + bookId + '/changes';
    const beforeRevisionResponse = await other.request.get(revisionURL);
    const beforeRevision = await beforeRevisionResponse.json();
    await beforeRevisionResponse.dispose();
    await closeOwned(pages);
    await closeOwned(worker);
    // Registry is ephemeral transport state, NOT the persisted Worker/Pages data.
    // Reusing dead Miniflare RPC registration files can leave local bindings 503.
    devRegistry = resolve(work, 'dev-registry-after-restart');
    const resumedWorker = launch(
      [
        'dev',
        '--local',
        '--config',
        resolve(work, 'worker.toml'),
        '--ip',
        '127.0.0.1',
        '--port',
        '8791',
        '--persist-to',
        resolve(work, 'worker-state'),
      ],
      root,
    );
    await ready(workerOrigin, '/api/health', resumedWorker);
    const resumedPages = launch(
      [
        'pages',
        'dev',
        'public',
        '--service',
        'HARNESS=novel-harness-local-verification',
        '--ip',
        '127.0.0.1',
        '--port',
        '8792',
        '--persist-to',
        resolve(work, 'pages-state'),
      ],
      resolve(root, 'cloud/pages'),
    );
    await ready(pagesOrigin, '/api/auth/session', resumedPages);
    const afterRestartResponse = await other.request.get(longReadURL);
    assert.equal(afterRestartResponse.status(), 200);
    const afterRestart = await afterRestartResponse.json();
    const afterRevisionResponse = await other.request.get(revisionURL);
    const afterRevision = await afterRevisionResponse.json();
    await afterRevisionResponse.dispose();
    assert.equal(
      afterRevision.revision,
      beforeRevision.revision,
      'Restarting an unchanged VFS must not force every browser to scan chapters again.',
    );
    assert.equal(afterRestart.hash, beforeRestart.hash);
    const orderAfterRestartResponse = await other.request.get(
      pagesOrigin + '/api/novels/' + orderedBook.id + '/chapter-order',
    );
    assert.equal(orderAfterRestartResponse.status(), 200);
    const orderAfterRestart = await orderAfterRestartResponse.json();
    await orderAfterRestartResponse.dispose();
    assert.equal(orderAfterRestart.version, orderedBook.version);
    assert.deepEqual(
      orderAfterRestart.entries.map((entry) => entry.key),
      orderedBook.keys,
    );
    assert.equal(afterRestart.text.length, beforeRestart.text.length);
    assert.deepEqual(afterRestart.parts, beforeRestart.parts);
    console.log(
      'Native multipart body/layout/PIN session survived an owned full Worker + Pages service restart.',
    );
    await other.close();
    assert.equal(modelPosts.length, 0);
    assert.deepEqual(errors, []);
    console.log(
      'Native integration passed: unified frame/manuscripts/canon; full outline preview, editing, pointer/keyboard beat order, atomic chapter binding and scoped prose task, bounded planning/resume/protected written chapters/direction, real multi-file transaction rollback, 1280/768/390 layouts; PIN/backup/native regression. Model carriers intercepted; no real provider request.',
    );
  }
} catch (error) {
  console.error('Native fixture failed:', error.message.slice(0, 700));
  for (const record of children)
    console.log(record.output.replaceAll(fixtureKey, '[synthetic-owner-fixture]').slice(-3500));
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        if (!new URL(page.url()).protocol.startsWith('http')) continue;
        try {
          await Promise.race([
            page.screenshot({ path: resolve(work, 'failure.png'), fullPage: true, timeout: 5000 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Diagnostic deadline')), 5500)),
          ]);
        } catch {
          /* best effort, no user data */
        }
      }
  throw new Error(
    error.message.slice(0, 700) +
      '\n' +
      (error.stack
        ?.match(/^\s+at .+$/gm)
        ?.slice(-4)
        .join('\n') ?? ''),
  );
} finally {
  await browserServer?.kill();
  for (const record of children.reverse()) await closeOwned(record);
}
