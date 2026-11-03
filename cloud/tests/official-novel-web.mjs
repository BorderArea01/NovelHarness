// Real existing novel UI over official DSH + original full plugin. All writes
// target a private snapshot and a synthetic book; no real model credentials.
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { prepareOfficialNovel } from '../scripts/prepare-official-novel.mjs';
import { privateDirectory } from '../scripts/private-directory.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { startNovelWeb } from '../official/novel/web.mjs';
import { vfsFileFingerprint } from '../official/novel/storage.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { openChapter, waitEditor } from './editor-client.mjs';
import { request as httpRequest } from 'node:http';
import { verifyRulesEditor } from './rules-scenario.mjs';
import { verifyChapterNavigation } from './chapter-scenario.mjs';
import { verifyBookLifecycle } from './book-lifecycle-scenario.mjs';
import { verifyNativeEditContract } from './native-edit-scenario.mjs';

const root = resolve('data/official-validation/integration');
await privateDirectory(root);
const report = {
  passed: false,
  complete: false,
  status: 'running',
  productionSwitched: false,
  productionWrites: 0,
  realModelCalls: 0,
};
await writeFile(join(root, 'web-report.json'), JSON.stringify(report));
const activeBefore = await readFile('data/local-host/active.json');
let app, web, model, browser, page;
const diagnostics = {
  responses: [],
  failed: [],
  errors: [],
  console: [],
  socketsOpened: 0,
  socketsClosed: 0,
};
let stage = 'prepare';
const additionalSyntheticRoots = [];
let closing = false;
try {
  const { worker } =
    process.env.NOVEL_OFFICIAL_USE_PREPARED_BASELINE === '1'
      ? { worker: join(root, 'baseline/worker') }
      : await prepareOfficialNovel();
  const filename = join(root, 'web-main.sqlite'),
    home = join(root, 'web-home');
  await copyFile(join(root, '../source-main.sqlite'), filename);
  model = await startModelFixture();
  app = await startOfficialNovel({ sqlite: filename, home, fixtureEndpoint: model.url });
  const before = vfsFileFingerprint(app.storage);
  const { bootstrapBook } = await import(pathToFileURL(join(worker, 'book-catalog.mjs')));
  const { makeDocumentService } = await import(pathToFileURL(join(worker, 'novel-documents.mjs')));
  const bundle = await makeBookBundle(null, {
    title: '隔离网页整合测试',
    seed: '一把钥匙，一封雨中的来信。',
  });
  bootstrapBook(app.storage.fs, app.storage.db, bundle.manifest.id, bundle);
  const service = makeDocumentService(app.storage.fs, app.storage.db, bundle.manifest.id);
  const original = '# 雨夜\n\n她拾起了门口的钥匙。\n';
  service.run({ kind: 'save', path: 'chapters/1.md', text: original, expectedHash: null });
  const ownerKey = 'fixture-only-official-novel-web-owner-secret-0123456789';
  web = await startNovelWeb(app, { ownerKey, home });
  stage = 'authentication';
  const unauthorized = {};
  for (const path of [
    '/',
    '/api/novels',
    '/dsh-purge/status',
    '/dsh-purge/config',
    '/novel-assets/harness-bridge.mjs',
  ]) {
    const response = await fetch(web.origin + path, { redirect: 'manual' });
    unauthorized[path] = response.status;
    await response.arrayBuffer();
    assert.notEqual(response.status, 200, 'Unauthenticated route leaked: ' + path);
  }
  assert.equal((await fetch(web.origin + '/api/auth/session').then((r) => r.json())).authenticated, false);
  const cross = await fetch(web.origin + '/dsh-purge/config', {
    method: 'POST',
    headers: { origin: 'https://other.invalid' },
    body: '{}',
  });
  assert.equal(cross.status, 403);
  await cross.arrayBuffer();
  const socketStatus = await new Promise((resolveStatus, reject) => {
    const request = httpRequest(web.origin + '/api/remote.mux', {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        origin: web.origin,
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    request.on('response', (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Unauthenticated WebSocket admitted.'));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(socketStatus, 401);
  report.auth = {
    originalPinGatewayAndPinStateOwner: true,
    unauthenticatedStatus: unauthorized,
    crossOriginRejected: true,
    unauthenticatedWebSocketRejected: true,
  };
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-background-networking', '--disable-extensions', '--js-flags=--max-old-space-size=192'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const remote = [],
    errors = [],
    failed = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    remote.push(url.origin);
    return route.abort();
  });
  const login = await context.request.post(web.origin + '/api/auth/recover', {
    headers: { origin: web.origin },
    data: { accessKey: ownerKey, newPin: '4826', confirmPin: '4826' },
  });
  assert.equal(login.status(), 200, await login.text());
  await login.dispose();
  const session = await context.request.get(web.origin + '/api/auth/session');
  assert.equal((await session.json()).authenticated, true);
  await session.dispose();
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => {
    errors.push(error.message);
    diagnostics.errors.push(error.message);
  });
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()))
      diagnostics.console.push(message.text().slice(0, 1800));
  });
  page.on('websocket', (socket) => {
    diagnostics.socketsOpened++;
    socket.on('close', () => diagnostics.socketsClosed++);
  });
  page.on('response', (response) => {
    const row = { path: new URL(response.url()).pathname, status: response.status() };
    diagnostics.responses.push(row);
    if (response.status() >= 400) failed.push(row);
  });
  page.on('requestfailed', (request) =>
    diagnostics.failed.push({ path: new URL(request.url()).pathname, failure: request.failure()?.errorText }),
  );
  for (const label of ['继续', '稍后配置'])
    await page.addLocatorHandler(
      page.getByRole('button', { name: label, exact: true }),
      async () => {
        try {
          await page.getByRole('button', { name: label, exact: true }).click();
        } catch (error) {
          if (!closing) throw error;
        }
      },
      { noWaitAfter: true },
    );
  await page.addLocatorHandler(
    page.getByRole('button', { name: /我已知晓并继续|I understand/ }),
    async () => {
      try {
        await page.getByRole('checkbox').first().check();
        await page.getByRole('button', { name: /我已知晓并继续|I understand/ }).click();
      } catch (error) {
        if (!closing) throw error;
      }
    },
  );
  stage = 'novel-shell';
  await page.goto(web.origin + '/?novel=' + bundle.manifest.id, { waitUntil: 'commit' });
  await page.locator('.novel-manuscript').waitFor({ timeout: 30000 });
  assert.equal(await page.title(), '小说工作台');
  await openChapter(page, 'chapters/1.md');
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), original);
  stage = 'native-plugin';
  const status = await context.request.get(web.origin + '/dsh-purge/status');
  assert.equal(status.status(), 200);
  assert.equal((await status.json()).plugin_version, '1.1.82');
  await status.dispose();
  const launcher = page.getByRole('button', { name: /dsh-purge/i }).first();
  await launcher.click();
  await page
    .getByText(/清洗|Clean/, { exact: true })
    .first()
    .waitFor();
  await page.screenshot({ path: join(root, 'novel-plugin-desktop.png') });
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page
    .getByText(/清洗|Clean/, { exact: true })
    .first()
    .waitFor({ state: 'hidden' });
  stage = 'native-edit-contract';
  report.nativeEditContract = await verifyNativeEditContract({
    page,
    model,
    service,
    root: bundle.manifest.root,
  });
  stage = 'assistant-synchronization';
  // Deliberately varied paragraphs: the native stream/save/editor chain must
  // retain semantic paragraphs, not reformat a manuscript one sentence a line.
  // This is a hand-written fixture, not evidence of model literary quality.
  const text = [
    '# 雨夜',
    '她没有立刻拿起钥匙。楼道里的声控灯刚灭，门锁上那道新划痕却还留在眼前，细而亮，像有人方才用刀尖试过锁孔。她把手缩回袖口，侧过身，让自己的影子离开门缝，又听了一会儿。雨水正顺着外墙的水管往下走，断断续续的滴答声之间，屋里传来一声极轻的纸张摩擦。',
    '“里面有人吗？”她问。声音比预想中轻，她便没有再敲门，掌心隔着袖口压住了冰冷的把手。',
    '门里没有回答。一封湿透的信从门下滑出来，先露出发皱的角，随后整个信封都伏在了她鞋边；那只空白信封上留着一道泥水印，水印的方向却从门外指向屋内。她蹲下去，没有碰它，先用钥匙的齿轻轻拨开封口。纸页上的第一行字还没有晕开，是她自己的笔迹，连改掉日期时习惯留下的那一小笔都在。',
    '',
  ].join('\n\n');
  const task = model.register({
    finalText: '修改与续写已保存进本书。',
    steps: [
      {
        name: 'novel_proposal_prepare',
        input: { path: bundle.manifest.root + '/chapters/1.md', instruction: '改写并续写第一章。' },
      },
      {
        name: 'write',
        expected: 'characters (editor, excluding whitespace): ' + text.replace(/\s/g, '').length,
        input: ({ results, task }) => {
          const p = JSON.parse(results.get('fixture_' + task.id + '_0').text);
          assert(p.draft.startsWith(bundle.manifest.root + '/drafts/'));
          return { file_path: p.draft, content: text };
        },
      },
      {
        name: 'novel_proposal_inspect',
        input: ({ results, task }) => ({
          proposal_id: JSON.parse(results.get('fixture_' + task.id + '_0').text).proposalId,
        }),
        expected: '"characters":' + text.replace(/\s/g, '').length,
      },
      {
        name: 'novel_proposal_submit',
        input: ({ results, task }) => {
          const initial = JSON.parse(results.get('fixture_' + task.id + '_0').text);
          const current = JSON.parse(results.get('fixture_' + task.id + '_2').text);
          assert.equal(current.characters, text.replace(/\s/g, '').length);
          assert.notEqual(current.expectedHash, initial.expectedHash);
          return {
            proposal_id: current.proposalId,
            expected_hash: current.expectedHash,
            content: text,
            content_scope: 'document',
            complete: true,
          };
        },
        expected: '"published":true',
      },
    ],
  });
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const composer = page
    .locator('.novel-author-input [role="textbox"][contenteditable="true"]:visible')
    .first();
  await composer.fill(task.marker + ' 改写开头，并继续写下去，保存到第一章。');
  await composer.press('Enter');
  await page.getByText(task.finalText, { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(task.completedSteps, task.steps.length);
  assert(
    task.bodies.some((body) => JSON.stringify(body.messages).includes('按作者要求写小说正文')),
    'Editable prose template did not reach the actual model HTTP request after prepare.',
  );
  for (const text of [
    '彼此的回应推动事情发展',
    '段落随语意与说话人变化',
    '关系和性格从相处中显现，不宣读人设',
  ])
    assert(
      task.bodies.some((body) => JSON.stringify(body.messages).includes(text)),
      'Dialogue guidance did not reach the actual native provider request: ' + text,
    );
  assert(
    task.bodies.every((body) => JSON.stringify(body.tools).includes('读取并应用 task.template')),
    'Native tool schema lost its template-consumption contract.',
  );
  report.proseTemplateReachedActualProvider = true;
  assert(task.bodies.some((body) => JSON.stringify(body.messages).includes('字数只作下限')));
  report.minimumLengthTemplateReachedProvider = true;
  report.nativeDraftCharacterCountAndFreshHash = true;
  assert(
    task.bodies.every((body) =>
      body.tools.find((t) => t.name === 'bash')?.description.includes('SQLite 虚拟 Bash'),
    ),
  );
  report.virtualShellFactsReachedProvider = true;
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), text);
  await page.getByRole('textbox', { name: '书稿正文', exact: true }).click();
  assert.equal(service.run({ kind: 'read', path: 'chapters/1.md' }).text, text);
  report.manuscriptParagraphsPreservedExactly = true;
  await page.screenshot({ path: join(root, 'novel-web-desktop.png') });
  stage = 'mobile';
  await page.setViewportSize({ width: 390, height: 844 });
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), text);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: join(root, 'novel-web-mobile.png') });
  stage = 'original-chapter-and-rules-regression';
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = '/api/novels/' + bundle.manifest.id + '/';
  await verifyChapterNavigation({
    page,
    context,
    origin: web.origin,
    api,
    restorePath: 'chapters/1.md',
    root: resolve('.'),
  });
  await verifyRulesEditor({ page, context, origin: web.origin, api, root: resolve('.') });
  report.originalChapterNavigationAndRename = true;
  report.originalRulesPromptsPovAndCards = true;
  stage = 'backup-and-pin';
  const { makeWorkspaceClient } = await import('../pages/public/novel-assets/workspace.mjs');
  const fetcher = async (path, init = {}) => {
    const cookie = (await context.cookies(web.origin)).map((item) => item.name + '=' + item.value).join('; ');
    return fetch(web.origin + path, {
      ...init,
      headers: { ...init.headers, cookie, origin: web.origin },
      redirect: 'manual',
    });
  };
  const backup = await makeWorkspaceClient(fetcher).backup(bundle.manifest.id);
  assert(backup);
  report.backupViaOriginalClient = true;
  stage = 'book-lifecycle-and-context-isolation';
  const lifecycle = await verifyBookLifecycle({
    page,
    context,
    origin: web.origin,
    book: bundle.manifest,
    model,
    storage: app.storage,
    screenshots: root,
  });
  additionalSyntheticRoots.push(lifecycle.root);
  report.bookLifecycle = lifecycle;
  stage = 'backup-and-pin';
  const oldCookie = (await context.cookies(web.origin))
    .map((item) => item.name + '=' + item.value)
    .join('; ');
  const closedBeforePinChange = diagnostics.socketsClosed;
  const changed = await context.request.post(web.origin + '/api/auth/pin', {
    headers: { origin: web.origin },
    data: { currentPin: '4826', newPin: '7391', confirmPin: '7391' },
  });
  assert.equal(changed.status(), 200, await changed.text());
  await changed.dispose();
  const closeDeadline = Date.now() + 3000;
  while (diagnostics.socketsClosed === closedBeforePinChange && Date.now() < closeDeadline)
    await new Promise((resolve) => setTimeout(resolve, 30));
  assert(diagnostics.socketsClosed > closedBeforePinChange, 'Old native transport survived PIN change.');
  report.auth.pinChangeClosesOldTransport = true;
  const stale = await fetch(web.origin + '/api/novels', { headers: { cookie: oldCookie } });
  assert.equal(stale.status, 401);
  await stale.arrayBuffer();
  const logout = await context.request.post(web.origin + '/api/auth/logout', {
    headers: { origin: web.origin },
    maxRedirects: 0,
  });
  assert.equal(logout.status(), 303);
  await logout.dispose();
  await page.goto(web.origin + '/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('登录 PIN', { exact: true }).fill('7391');
  await page.getByRole('button', { name: '进入书库', exact: true }).click();
  await page.locator('.novel-library').waitFor();
  report.auth.changedPinAndOldCookieInvalidated = true;
  report.auth.originalLoginFormWorks = true;
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  assert.deepEqual(model.errors, []);
  assert.deepEqual(
    vfsFileFingerprint(app.storage).filter(
      (item) =>
        ![bundle.manifest.root, ...additionalSyntheticRoots].some((root) => item.path.startsWith(root + '/')),
    ),
    before,
  );
  assert.deepEqual(await readFile('data/local-host/active.json'), activeBefore);
  report.passed = true;
  report.novelShellReused = true;
  report.nativePluginClient = true;
  report.assistantPublishesAndLeftEditorRefreshes = true;
  report.mobileNoPageOverflow = true;
  report.remaining = [
    'complete original UI regression',
    'real historical sessions and attachments',
    'plugin lifecycle and uninstall',
    'full security/permission audit',
  ];
  report.requests = model.requests.length;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  closing = true;
  report.stage = stage;
  report.status = report.passed ? 'passed' : 'failed';
  report.network = diagnostics;
  report.trace = web?.trace;
  if (page)
    report.browserDiagnostics = await page
      .evaluate(() => ({
        bridgeLoaded: !!globalThis.__ModuleLoader__,
        bootEntries: globalThis.__DSH_BOOT__?.entries?.map((entry) => ({
          id: entry.id,
          inject: entry.inject,
          url: entry.url,
        })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
      }))
      .catch(() => null);
  await browser?.close();
  await web?.close();
  if (app) await app.shutdown.shutdown(process.exitCode ? 1 : 0);
  await model?.close();
  await writeFile(join(root, 'web-report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: report.passed,
      complete: false,
      stage,
      failure: report.failure?.split('\n')[0],
    }),
  );
}
