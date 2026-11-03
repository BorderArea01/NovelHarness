// Actual pinned Harness/Worker/Pages/model HTTP/tool loop with synthetic data.
// Does not read deployment.json, owner-key.txt, real provider keys or production.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { selectEditor, readEditor, waitEditor, openChapter, clickSidebarEntry } from './editor-client.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { stageRuntime } from '../scripts/stage-runtime.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { NOVEL_IDENTITY } from '../worker/novel-role.mjs';
import { proposalSteps } from './proposal-tool-fixture.mjs';
import { verifyWritingRun } from './writing-run-scenario.mjs';
import { verifyBorrowedWorkflow } from './borrowed-workflow-scenario.mjs';
import { verifyNovelStudio, createGuidedBook, verifyStudioEngine } from './novel-studio-scenario.mjs';
import { verifyNovelPipeline } from './novel-pipeline-scenario.mjs';
import { verifyCreativeQuestions } from './creative-questions-scenario.mjs';
import { verifySelectionNavigation } from './selection-navigation-scenario.mjs';
import { rotateFixtureContext } from './context-lifetime.mjs';
import { verifyAuthoringSystem } from './authoring-system-scenario.mjs';
import { verifyPerformance } from './performance-scenario.mjs';
import { verifyControlAffordance } from './control-affordance-scenario.mjs';
import { verifyReadCosts } from './read-cost-scenario.mjs';
const systemText = (body) =>
  typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((block) => block.text ?? '').join('\n')
      : (body.messages ?? [])
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
const root = fileURLToPath(new URL('../../', import.meta.url)),
  work = resolve(root, 'test-results/cloud-engine-' + Date.now());
const workerOrigin = 'http://127.0.0.1:8793',
  origin = 'http://127.0.0.1:8794';
const children = [],
  key = 'fixture-only-owner-key-not-for-production-0123456789abcdef';
let browser, model;
let devRegistry = resolve(work, 'dev-registry');
function launch(args, cwd) {
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=384', resolve(root, 'cloud/tools/node_modules/wrangler/bin/wrangler.js'), ...args],
    {
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
    },
  );
  const record = { child, output: '', args: [...args], cwd };
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      record.output = (record.output + chunk).slice(-6000);
    });
  child.on('error', (error) => {
    record.error = error;
  });
  children.push(record);
  return record;
}
async function waitFor(predicate, label, limit = 30000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > limit) throw new Error('Timed out: ' + label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function ready(url, record) {
  await waitFor(
    async () => {
      if (record.error || record.child.exitCode !== null)
        throw new Error('Owned runtime exited: ' + (record.error?.message ?? record.output));
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(1000) })).status < 500;
      } catch {
        return false;
      }
    },
    'owned runtime readiness',
    45000,
  );
}
async function closeOwned(record) {
  if (record.child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    record.child.kill('SIGTERM');
    return;
  }
  await new Promise((resolve) => {
    const p = spawn('taskkill.exe', ['/PID', String(record.child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    p.on('exit', resolve);
    p.on('error', resolve);
  });
}
try {
  await mkdir(work, { recursive: true });
  model = await startModelFixture();
  assert.equal(new URL(model.url).hostname, '127.0.0.1');
  await stageRuntime(resolve(work, 'worker'));
  if (process.argv.includes('--read-cost')) {
    const { cp } = await import('node:fs/promises');
    await cp(
      resolve(root, 'cloud/tests/fixtures/read-cost-entry.mjs'),
      resolve(work, 'worker/read-cost-entry.mjs'),
    );
  }
  const config =
    (await readFile(resolve(root, 'cloud/tests/runtime/wrangler.toml'), 'utf8'))
      .replaceAll('novel-harness-local-verification', 'novel-harness-engine-verification')
      .replace(
        /^main = .*$/m,
        'main = ' +
          JSON.stringify(
            resolve(
              work,
              'worker',
              process.argv.includes('--read-cost') ? 'read-cost-entry.mjs' : 'entry.mjs',
            ).replaceAll('\\', '/'),
          ),
      )
      .replace(
        /^directory = .*$/m,
        'directory = ' +
          JSON.stringify(resolve(root, 'cloud/tools/node_modules/dsh-edge/dist').replaceAll('\\', '/')),
      ) +
    '\nDEEPSEEK_BASE_URL = ' +
    JSON.stringify(model.url) +
    '\n';
  // The endpoint is explicit before starting a Worker; no fallback key/source is used.
  assert.ok(config.includes('DEEPSEEK_BASE_URL = "http://127.0.0.1:'));
  await writeFile(resolve(work, 'worker.toml'), config);
  const worker = launch(
    [
      'dev',
      '--local',
      '--config',
      resolve(work, 'worker.toml'),
      '--ip',
      '127.0.0.1',
      '--port',
      '8793',
      '--persist-to',
      resolve(work, 'worker-state'),
    ],
    root,
  );
  await ready(workerOrigin + '/api/health', worker);
  const pages = launch(
    [
      'pages',
      'dev',
      'public',
      '--service',
      'HARNESS=novel-harness-engine-verification',
      '--ip',
      '127.0.0.1',
      '--port',
      '8794',
      '--binding',
      'PLATFORM_REVISION=engine-fixture-' + Date.now(),
      '--persist-to',
      resolve(work, 'pages-state'),
    ],
    resolve(root, 'cloud/pages'),
  );
  await ready(origin + '/api/auth/session', pages);
  browser = await chromium.launch({
    headless: true,
    args: ['--js-flags=--max-old-space-size=192'],
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  let context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const auth = await context.request.post(origin + '/api/auth/login', {
    form: { accessKey: key },
    maxRedirects: 0,
  });
  assert.equal(auth.status(), 303);
  await auth.dispose();
  let page = await context.newPage();
  const errors = [];
  async function observePage(page) {
    await page.addInitScript(() => {
      globalThis.__privacyTitleViolations = 0;
      new MutationObserver(() => {
        if (document.title && document.title !== '小说工作台') globalThis.__privacyTitleViolations++;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /TypeError|ReferenceError|React error/.test(message.text())) {
        errors.push(message.text().slice(0, 1800));
        console.error(
          'Local renderer diagnostic:',
          message.text().replaceAll(key, '[synthetic-owner]').slice(0, 1800),
        );
      }
    });
    await page.addLocatorHandler(page.getByRole('button', { name: '继续', exact: true }), () =>
      page.getByRole('button', { name: '继续', exact: true }).click(),
    );
    await page.addLocatorHandler(page.getByRole('button', { name: '稍后配置', exact: true }), () =>
      page.getByRole('button', { name: '稍后配置', exact: true }).click(),
    );
  }
  await observePage(page);
  async function independentBrowserPhase() {
    console.log(
      'Independent engine phase, before releasing protocol owners; driver heap MiB=' +
        Math.round(process.memoryUsage().heapUsed / 1048576),
    );
    ({ context, page } = await rotateFixtureContext({ browser, context, page, origin }));
    await observePage(page);
    await page.goto(origin + '/novels/');
    console.log(
      'Independent engine phase restored all browser data; same Worker, VFS and provider history; driver heap MiB=' +
        Math.round(process.memoryUsage().heapUsed / 1048576),
    );
  }
  await page.goto(origin + '/novels/');
  const seed = '沈澄收到姐姐寄来的铜钥匙，钟楼在没有守钟人的夜里响了第三声。';
  await createGuidedBook(page, { title: '铜钥匙与第三声钟', seed });
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  if (!process.argv.includes('--legacy-layout-regression')) {
    if (process.argv.includes('--read-cost'))
      await verifyReadCosts({ page, context, origin, workerOrigin, model, root, waitFor });
    else if (process.argv.includes('--controls'))
      await verifyControlAffordance({ page, context, origin, model, root });
    else if (process.argv.includes('--performance'))
      await verifyPerformance({ page, context, origin, model, root });
    else if (process.argv.includes('--authoring'))
      await verifyAuthoringSystem({ page, context, origin, root, model, waitFor });
    else if (process.argv.includes('--navigation'))
      await verifySelectionNavigation({ page, context, origin, root, waitFor });
    else if (process.argv.includes('--questions'))
      await verifyCreativeQuestions({ page, context, origin, model, waitFor, root });
    else if (process.argv.includes('--pipeline'))
      await verifyNovelPipeline({ page, context, origin, model, waitFor, root });
    else await verifyNovelStudio({ page, context, origin, model, root, waitFor });
    if (
      !process.argv.includes('--studio') &&
      !process.argv.includes('--performance') &&
      !process.argv.includes('--controls') &&
      !process.argv.includes('--authoring') &&
      !process.argv.includes('--pipeline') &&
      !process.argv.includes('--questions') &&
      !process.argv.includes('--navigation') &&
      !process.argv.includes('--read-cost')
    ) {
      const book = await verifyStudioEngine({ page, context, origin, model, waitFor, root });
      await verifyWritingRun({ page, context, origin, book, model, waitFor, root });
      await verifyBorrowedWorkflow({ page, context, origin, book, model, waitFor, root });
      await verifyNovelPipeline({ page, context, origin, model, waitFor, root });
      await clickSidebarEntry(page, 'link', '小说库');
      await independentBrowserPhase();
      await createGuidedBook(page, { title: '灵感选择独立测试', seed });
      await page.locator('.novel-ms-heading > strong').filter({ hasText: '灵感选择独立测试' }).waitFor();
      await verifyCreativeQuestions({ page, context, origin, model, waitFor, root });
      await clickSidebarEntry(page, 'link', '小说库');
      await independentBrowserPhase();
      await createGuidedBook(page, { title: '导航独立测试', seed });
      await page.locator('.novel-ms-heading > strong').filter({ hasText: '导航独立测试' }).waitFor();
      await verifySelectionNavigation({ page, context, origin, root, waitFor });
      await clickSidebarEntry(page, 'link', '小说库');
      await independentBrowserPhase();
      await createGuidedBook(page, { title: '直接创作上下文独立测试', seed });
      await page
        .locator('.novel-ms-heading > strong')
        .filter({ hasText: '直接创作上下文独立测试' })
        .waitFor();
      await verifyAuthoringSystem({ page, context, origin, root, model, waitFor });
    }
    assert.deepEqual(model.errors, []);
    assert.deepEqual(errors, []);
    assert.ok(model.requests.every((request) => request.keysSynthetic));
  } else {
    await page.getByRole('button', { name: '提示词', exact: true }).click();
    const writingRule = '用动作与停顿表现情绪，不用旁白替读者总结。';
    await page.getByRole('textbox', { name: '提示词 write', exact: true }).fill(writingRule);
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    const book = await page.evaluate(
      async () => (await (await import('/novel-assets/workspace.mjs')).makeWorkspaceClient().list())[0],
    );
    const api = '/api/novels/' + book.id + '/';
    const get = async (route) => {
      const response = await context.request.get(origin + api + route);
      assert.equal(response.status(), 200);
      return response.json();
    };
    const candidateText =
      '# 无人敲响的钟\n\n沈澄把铜钥匙扣在桌沿，没让它碰响。第三声钟停下时，她才发现门缝下压着姐姐的回信。';
    const task = model.register({
      holdBeforeStep: 0,
      holdFinish: true,
      prepare(prompt, self) {
        const draft = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
        assert.ok(draft?.startsWith(book.root + '/drafts/'));
        self.draft = draft;
        self.steps = [
          { name: 'read', input: { file_path: book.root + '/seed.md' }, expected: seed },
          { name: 'read', input: { file_path: book.root + '/rules.json' }, expected: writingRule },
          { name: 'read', input: { file_path: draft } },
          { name: 'write', input: { file_path: draft, content: candidateText } },
        ];
      },
    });
    const authorComposer = page.locator('[contenteditable="true"][role="textbox"]:visible').first();
    assert.equal(
      await page.getByRole('textbox', { name: '这次想怎么写', exact: true }).count(),
      0,
      'There is no second writing-instruction editor.',
    );
    await page.getByRole('button', { name: '编辑要求', exact: true }).click();
    await waitFor(
      () => authorComposer.evaluate((element) => document.activeElement === element),
      'original composer focused without replacing it',
    );
    await authorComposer.fill(task.marker);
    await page.reload();
    await page.getByRole('button', { name: '从灵感试写', exact: true }).waitFor();
    assert.equal(
      await authorComposer.textContent(),
      task.marker,
      'The native draft, not another instruction cache, survives refresh.',
    );
    await page.getByRole('button', { name: '从灵感试写', exact: true }).click();
    await waitFor(() => task.holds.length > 0, 'mock provider receiving genuine native request');
    assert.ok(
      systemText(task.bodies[0]).includes(NOVEL_IDENTITY),
      'The provider must actually receive the novelist system identity, not only a user task.',
    );
    assert.ok(!systemText(task.bodies[0]).includes('You are dsh-edge, a coding agent powered by'));
    assert.ok(
      systemText(task.bodies[0]).includes('The shell is just-bash'),
      'Original runtime limitations remain.',
    );
    const activity = page.getByLabel('当前对话执行状态', { exact: true });
    await activity.filter({ hasText: 'AI 执行中' }).waitFor();
    const initialBasis = page.locator('.novel-writing-basis');
    await initialBasis.locator(':scope > summary').click();
    await initialBasis.getByText(task.marker, { exact: true }).waitFor();
    await initialBasis.locator(':scope > summary').click();
    const taskCard = page.locator('.novel-task-card').first();
    await taskCard.waitFor();
    assert.equal(await taskCard.locator('strong').textContent(), '试写开场');
    assert.equal(await taskCard.locator('.novel-task-intent').textContent(), task.marker);
    assert.equal(await taskCard.locator('.novel-task-source').count(), 0);
    await taskCard.getByRole('button', { name: '展开执行指令', exact: true }).click();
    const fullNativeText = await taskCard.locator('.novel-task-source').textContent();
    assert.ok(fullNativeText.startsWith('[novel-task:v2]\n'));
    assert.ok(fullNativeText.includes(task.draft));
    assert.ok(fullNativeText.includes('V4.4.3 默认'));
    assert.ok(fullNativeText.includes('小说标题: ' + book.title));
    assert.ok(!fullNativeText.includes('小说标题: {title}'));
    assert.ok(
      task.bodies[0].messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.some?.((block) => block.type === 'text' && block.text === fullNativeText),
      ),
    );
    await taskCard.getByRole('button', { name: '收起执行指令', exact: true }).click();
    const linkedProposal = (await get('documents')).proposals[0];
    assert.ok(linkedProposal.originSessionId);
    const callsBeforeLinks = task.bodies.length;
    for (const [width, height] of [
      [1280, 900],
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: '查看发起对话', exact: true }).click();
      await taskCard.getByRole('button', { name: '查看候选', exact: true }).click();
      await page.getByRole('button', { name: '编辑候选稿', exact: true }).waitFor();
      await waitFor(
        () =>
          page.getByRole('region', { name: '小说书稿', exact: true }).evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.left >= -1 && rect.right <= innerWidth + 1;
          }),
        'candidate panel actually in the viewport after native animation',
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: resolve(work, 'proposal-conversation-' + width + '.png'),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      task.bodies.length,
      callsBeforeLinks,
      'Viewing the source and candidate never resubmits a model task.',
    );
    await page.screenshot({ path: resolve(work, 'compact-task-desktop.png'), fullPage: true });
    console.log(
      'Native model request reached localhost; wire/tool names:',
      JSON.stringify(
        model.requests.map((item) => ({
          task: item.task !== null,
          wire: item.url,
          tools: item.tools.filter((name) => ['read', 'write'].includes(name)),
          keysSynthetic: item.keysSynthetic,
        })),
      ),
    );
    await page.getByText('正在核对本书资料，步骤 1。', { exact: false }).waitFor();
    // Leave the manuscript without stopping its genuine native stream. The book
    // card projects the same Session, not a new job or a second model request.
    const modelCallsBeforeLibrary = task.bodies.length;
    const unsentWhileStreaming = '等这一段完成后，再讨论姐姐的动机。';
    await authorComposer.fill(unsentWhileStreaming);
    await clickSidebarEntry(page, 'link', '小说库');
    const bookCard = page.locator('.book[data-book-id="' + book.id + '"]');
    const bookRun = bookCard.locator('.book-session[data-state="running"]');
    await bookRun.waitFor();
    assert.equal(
      await bookCard.locator('.open-book').isVisible(),
      false,
      'Do not duplicate the same book/session entry.',
    );
    const runningSessionId = await bookRun.getAttribute('data-session-id');
    assert.ok(runningSessionId);
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [768, 1024, 'tablet'],
      [390, 844, 'mobile'],
    ]) {
      await page.setViewportSize({ width, height });
      await bookRun.scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await bookRun.evaluate((node) => node.scrollWidth <= node.clientWidth));
      await page.screenshot({ path: resolve(work, 'book-activity-' + name + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await bookRun.waitFor();
    assert.equal(await bookRun.getAttribute('data-session-id'), runningSessionId);
    await bookRun.getByRole('button', { name: /^查看对话：/ }).click();
    await activity.filter({ hasText: 'AI 执行中' }).waitFor();
    assert.equal(
      task.bodies.length,
      modelCallsBeforeLibrary,
      'Library navigation never resubmits a model task.',
    );
    assert.equal(await page.locator('.novel-task-card').count(), 1);
    assert.equal(
      await authorComposer.textContent(),
      unsentWhileStreaming,
      'Library navigation preserves the sole original unsent draft.',
    );
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await page.getByRole('textbox', { name: '书稿正文', exact: true }).waitFor();
    const listing = await get('documents'),
      proposal = listing.proposals[0];
    assert.ok(proposal?.draft && task.draft.endsWith(proposal.draft));
    assert.equal(proposal.writing.instruction, task.marker);
    assert.equal(proposal.writing.mode, 'begin');
    assert.equal(
      (await get('document?path=' + encodeURIComponent(proposal.target))).text.includes('铜钥匙扣在桌沿'),
      false,
    );
    task.holdBeforeStep = undefined;
    model.release(task);
    await waitFor(
      () => task.completedSteps === 4 && task.holds.some((hold) => hold.step === 4),
      'native read/write/tool-result loop',
    );
    assert.equal((await get('review?id=' + proposal.id)).draft.text, candidateText);
    const premature = await context.request.post(origin + api + 'accept', {
      data: { id: proposal.id, draftHash: (await get('review?id=' + proposal.id)).draft.hash },
    });
    assert.equal(
      premature.status(),
      409,
      'A valid file while the model is still running is not a finished proposal.',
    );
    await clickSidebarEntry(page, 'link', '小说库');
    task.holdFinish = false;
    model.release(task);
    const rpc = async (method, request) =>
      (
        await context.request.post(origin + '/api/' + method.replace('.', '/'), {
          data: { type: 'client-request', rpcId: crypto.randomUUID(), payload: { args: { request } } },
        })
      ).json();
    const sessions = await rpc('session.list', {});
    const sessionId = sessions.result?.value?.items?.find((item) => item.cwd === book.root)?.sessionId;
    assert.ok(sessionId, 'Native session identity must be found from native metadata.');
    assert.equal(sessionId, runningSessionId, 'The book card returns to the exact running conversation.');
    assert.equal(linkedProposal.originSessionId, sessionId);
    await waitFor(async () => {
      const result = await rpc('session.history', { sessionId });
      return result.result?.value?.events?.some((entry) => entry.event.type === 'turn/end');
    }, 'canonical native turn/end');
    const finishedBookRun = bookCard.locator('.book-session[data-session-id="' + sessionId + '"]');
    await finishedBookRun.filter({ hasText: 'AI 已结束' }).waitFor();
    await finishedBookRun.getByRole('button', { name: /^查看对话：/ }).click();
    const history = await rpc('session.history', { sessionId });
    assert.ok(
      history.result.value.events.some(
        (entry) =>
          entry.event.type === 'user/message' &&
          entry.event.data.content.some((block) => block.type === 'text' && block.text === fullNativeText),
      ),
      'Native durable history must retain exactly what the model received.',
    );
    console.log(
      'Synthetic canonical terminal:',
      JSON.stringify(
        history.result.value.events
          .filter((entry) => entry.event.type === 'turn/end')
          .map((entry) => entry.event),
      ),
    );
    await taskCard.getByRole('button', { name: '查看候选', exact: true }).click();
    await page.getByRole('button', { name: '接受改稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '接受改稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
    assert.equal((await get('document?path=' + encodeURIComponent(proposal.target))).text, candidateText);
    await taskCard.getByRole('button', { name: '查看候选', exact: true }).click();
    await page.getByText('已接受 · 只读回看处理时的候选，不会再次收录。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '接受改稿', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '放弃', exact: true }).count(), 0);
    await page.getByRole('button', { name: '查看候选稿', exact: true }).click();
    assert.equal(
      await page.locator('.novel-prose-editor .cm-content').getAttribute('contenteditable'),
      'false',
    );
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await activity.filter({ hasText: 'AI 已结束' }).waitFor();
    // Provider failure must be the SAME native failure in chat and manuscript,
    // not an optimistic success inferred from a created proposal.
    const failed = model.register({ httpStatus: 402, errorMessage: 'Synthetic balance failure.' });
    await authorComposer.fill(failed.marker);
    await page.getByRole('button', { name: /^(接着写|按纲续写)$/ }).click();
    await waitFor(() => failed.observed, 'native provider failure');
    await activity.filter({ hasText: 'AI 执行失败' }).waitFor();
    await clickSidebarEntry(page, 'link', '小说库');
    await bookCard.locator('.book-session[data-state="error"]').waitFor();
    await bookCard
      .locator('.book-session[data-session-id="' + sessionId + '"]')
      .getByRole('button', { name: /^查看对话：/ })
      .click();
    await activity.filter({ hasText: 'AI 执行失败' }).waitFor();
    assert.equal((await get('document?path=' + encodeURIComponent(proposal.target))).text, candidateText);
    const failedHistory = await rpc('session.history', { sessionId });
    assert.equal(
      failedHistory.result.value.events.filter((entry) => entry.event.type === 'turn/end').at(-1).event.data
        .reason.kind,
      'error',
    );
    // Reconnect while the provider is still streaming. Native session state owns
    // recovery; neither opening the book nor reloading submits another prompt.
    await page.getByRole('button', { name: '正文', exact: true }).click();
    const cancelled = model.register({
      holdBeforeStep: 0,
      prepare(prompt, self) {
        const path = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
        assert.ok(path?.startsWith(book.root + '/drafts/'));
        self.draft = path;
        self.steps = [
          { name: 'read', input: { file_path: path } },
          { name: 'write', input: { file_path: path, content: 'This late write must never happen.' } },
        ];
      },
    });
    await authorComposer.fill(cancelled.marker);
    await page.getByRole('button', { name: /^(接着写|按纲续写)$/ }).click();
    await waitFor(() => cancelled.holds.length > 0, 'cancellable native stream');
    const activeDraftPath = cancelled.draft.slice(book.root.length + 1);
    const activeCandidate = await get('document?path=' + encodeURIComponent(activeDraftPath));
    assert.equal(activeCandidate.candidate.running, true);
    const busyCandidate = await context.request.put(origin + api + 'document', {
      data: { path: activeDraftPath, text: '不能覆盖正在生成的候选', expectedHash: activeCandidate.hash },
    });
    assert.equal(busyCandidate.status(), 409);
    assert.match((await busyCandidate.json()).error, /仍有 AI 在运行/);
    await busyCandidate.dispose();
    assert.equal(
      (await get('document?path=' + encodeURIComponent(activeDraftPath))).text,
      activeCandidate.text,
    );
    // Read-only reorder preview may run while this real native turn streams,
    // but publication must not change the sequence underneath its frozen task.
    const guardFile = await context.request.put(origin + api + 'document', {
      data: {
        path: proposal.target + '-order-guard.md',
        text: '# 重排并发验证\n正文不应被修改',
        expectedHash: null,
      },
    });
    assert.equal(guardFile.status(), 200);
    await guardFile.dispose();
    const orderSnapshot = await get('chapter-order');
    const orderKeys = orderSnapshot.entries.map((entry) => entry.key).reverse();
    const orderResponse = await context.request.post(origin + api + 'chapter-order', {
      data: {
        action: 'preview',
        version: orderSnapshot.version,
        keys: orderKeys,
      },
    });
    assert.equal(orderResponse.status(), 200);
    const orderPreview = await orderResponse.json();
    await orderResponse.dispose();
    assert.equal(orderPreview.valid, true);
    const oldSequence = await get('document?path=outline.json');
    const busyOrder = await context.request.post(origin + api + 'chapter-order', {
      data: {
        action: 'apply',
        version: orderSnapshot.version,
        keys: orderKeys,
        fingerprint: orderPreview.fingerprint,
      },
    });
    assert.equal(busyOrder.status(), 409);
    assert.match((await busyOrder.json()).error, /结束或停止后再确认重排/);
    await busyOrder.dispose();
    assert.equal((await get('document?path=outline.json')).hash, oldSequence.hash);
    console.log(
      'Native active-turn chapter order guard passed: preview remains readable; publication refused without changing the outline.',
    );
    const callsBeforeReload = cancelled.bodies.length;
    await page.reload();
    await activity.filter({ hasText: 'AI 执行中' }).waitFor();
    await page.locator('.novel-task-card').last().waitFor();
    assert.equal(
      await page.locator('.novel-task-source').count(),
      0,
      'Reload reconstructs compact task rendering from native history, not a second cache.',
    );
    assert.equal(cancelled.bodies.length, callsBeforeReload, 'Reconnect must not resubmit a prompt.');
    await clickSidebarEntry(page, 'link', '小说库');
    const backgroundRun = bookCard.locator('.book-session[data-session-id="' + sessionId + '"]');
    const stopRoute = /\/api\/session[./]cancel$/;
    await page.route(stopRoute, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic stop transport failure.' }),
      }),
    );
    await backgroundRun.getByRole('button', { name: '停止 AI', exact: true }).click();
    await bookCard.getByRole('alert').filter({ hasText: /停止/ }).waitFor();
    assert.equal(cancelled.holds[0].closed, false, 'A failed stop request must not masquerade as cancelled.');
    await page.unroute(stopRoute);
    await backgroundRun.getByRole('button', { name: '停止 AI', exact: true }).click();
    await backgroundRun.filter({ hasText: 'AI 已停止' }).waitFor();
    await backgroundRun.getByRole('button', { name: /^查看对话：/ }).click();
    await activity.filter({ hasText: 'AI 已停止' }).waitFor();
    await waitFor(() => cancelled.holds[0].closed, 'upstream stream closed by native cancellation');
    model.release(cancelled);
    assert.equal(cancelled.issuedSteps.length, 0, 'Stopped stream must not execute a late tool.');
    assert.equal((await get('document?path=' + encodeURIComponent(proposal.target))).text, candidateText);
    await page.screenshot({ path: resolve(work, 'unified-execution.png'), fullPage: true });
    console.log(
      'Native book activity passed: same original running/error/stopped Session across library/manuscript/reload, exact conversation navigation, native cancellation and 1280/768/390 layouts without task resubmission.',
    );
    // Ordinary native chat still sends and displays the author's literal words.
    const freeChat = '普通聊天：先讨论姐姐为什么没有亲自送信，不要写文件。';
    const composer = page.locator('[contenteditable="true"][role="textbox"]:visible').first();
    await composer.fill(freeChat);
    await composer.press('Enter');
    await page.getByText(freeChat, { exact: true }).waitFor();
    assert.equal(await page.locator('.novel-task-card').count(), 3);
    await waitFor(async () => {
      const latest = await rpc('session.history', { sessionId });
      return latest.result.value.events.filter((entry) => entry.event.type === 'turn/end').length === 4;
    }, 'ordinary native conversation after task submission');
    // Preparation is async: editing the ORIGINAL draft while a proposal request
    // is pending must reject the stale action, not overwrite or send the new text.
    await authorComposer.fill('任务准备前的要求');
    let preparationEntered = false,
      releasePreparation;
    const preparationGate = new Promise((resolve) => {
      releasePreparation = resolve;
    });
    const proposalRoute = origin + api + 'proposals';
    await page.route(proposalRoute, async (route) => {
      preparationEntered = true;
      await preparationGate;
      await route.continue();
    });
    const requestsBeforeRace = model.requests.length;
    await page.getByRole('button', { name: /^(接着写|按纲续写)$/ }).click();
    await waitFor(() => preparationEntered, 'async manuscript proposal preparation');
    await authorComposer.fill('作者在准备期间写下的新要求，不能丢失。');
    releasePreparation();
    await page.locator('.novel-ms-status').filter({ hasText: '草稿刚发生变化' }).waitFor();
    assert.equal(await authorComposer.textContent(), '作者在准备期间写下的新要求，不能丢失。');
    assert.equal(
      model.requests.length,
      requestsBeforeRace,
      'No model prompt may be sent from a stale input snapshot.',
    );
    await page.unroute(proposalRoute);
    // Desktop uses the original dock toolbar, not the tablet-only focus button.
    await page.locator('[data-sidebar-right-toggle]:visible').click();
    for (const [width, height, name] of [
      [768, 1024, 'tablet'],
      [390, 844, 'mobile'],
    ]) {
      await page.setViewportSize({ width, height });
      const card = page.locator('.novel-task-card').last();
      await card.scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      let box = await card.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
      await card.getByRole('button', { name: '展开执行指令', exact: true }).click();
      assert.ok(
        await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        'Expanded task source must wrap on narrow screens.',
      );
      await card.getByRole('button', { name: '收起执行指令', exact: true }).click();
      await page.screenshot({ path: resolve(work, 'compact-task-' + name + '.png'), fullPage: true });
    }
    // A narrow-screen author moves to the SAME composer, then back to the same
    // manuscript. The navigation itself neither submits nor destroys their text.
    await page.getByRole('button', { name: '书稿', exact: true }).click();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await page.screenshot({ path: resolve(work, 'single-input-manuscript-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '编辑要求', exact: true }).click();
    await authorComposer.waitFor();
    assert.equal(await authorComposer.textContent(), '作者在准备期间写下的新要求，不能丢失。');
    await authorComposer.fill('手机上尚未发送的要求，切换书稿后仍需保留。');
    await page.getByRole('button', { name: '书稿', exact: true }).click();
    await page.getByRole('button', { name: '编辑要求', exact: true }).click();
    await authorComposer.waitFor();
    assert.equal(await authorComposer.textContent(), '手机上尚未发送的要求，切换书稿后仍需保留。');
    assert.equal(model.requests.length, requestsBeforeRace);
    // Real native model/tools exercise the SAME selected-range and append actions
    // on multipart prose. No direct model call or alternate writing controller.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '书稿', exact: true }).click();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    const partLimit = 512 * 1024,
      row = 'Earlier paragraphs must remain unchanged. '.repeat(4) + '\r\n';
    const prefixBytes = partLimit - 3;
    const prefix =
      '\ufeff' + row.repeat(Math.floor(prefixBytes / row.length)) + 'x'.repeat(prefixBytes % row.length);
    const selectedText = '需要改写的关键句🌧️';
    const longOriginal = prefix + '\r\n' + selectedText + '\r\n现存尾段保持不变。\r\n';
    const longPath = 'chapters/engine-long.md';
    assert.equal(Buffer.byteLength(prefix), partLimit);
    const longSave = await context.request.put(origin + api + 'document', {
      data: { path: longPath, text: longOriginal, expectedHash: null },
    });
    assert.equal(longSave.status(), 200);
    const longDocument = await longSave.json();
    assert.equal(longDocument.parts.length, 2);
    await openChapter(page, 'chapters/engine-long.md');
    const longEditor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(longEditor, longOriginal.replaceAll('\r\n', '\n'));
    const visibleLong = await readEditor(longEditor),
      selectionStart = visibleLong.indexOf(selectedText);
    await selectEditor(longEditor, selectionStart, selectionStart + selectedText.length);
    await page.getByRole('button', { name: '改写选中段落', exact: true }).waitFor();
    const replacement = '改写后的关键句🌧️';
    const selectedTask = model.register({
      prepare(prompt, self) {
        assert.ok(prompt.includes(selectedText) && prompt.includes('本次仅替换选段'));
        assert.ok(longDocument.parts.every((p) => prompt.includes(book.root + '/' + p)));
        const draft = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
        assert.ok(draft);
        self.steps = [
          {
            name: 'read',
            input: { file_path: book.root + '/' + longDocument.parts[0] },
            expected: 'Earlier paragraphs',
          },
          {
            name: 'read',
            input: { file_path: book.root + '/' + longDocument.parts[1] },
            expected: selectedText,
          },
          { name: 'read', input: { file_path: draft } },
          { name: 'write', input: { file_path: draft, content: replacement } },
        ];
      },
    });
    await authorComposer.fill(selectedTask.marker);
    await page.getByRole('button', { name: '改写选中段落', exact: true }).click();
    await waitFor(() => selectedTask.completedSteps === 4, 'native scoped long-document tool loop');
    await activity.filter({ hasText: 'AI 已结束' }).waitFor();
    await page.getByText('本次仅替换选中段落，其余全文保持不变。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '接受改稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
    const expectedLong = longOriginal.replace(selectedText, replacement);
    const fullHash = (s) => createHash('sha256').update(s).digest('hex');
    assert.equal((await get('document?path=' + encodeURIComponent(longPath))).hash, fullHash(expectedLong));
    const appendText = '新增的场景，旧正文不重复。\r\n';
    const appendTask = model.register({
      prepare(prompt, self) {
        assert.ok(prompt.includes('本次仅追加'));
        const draft = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
        assert.ok(draft);
        self.steps = [
          {
            name: 'read',
            input: { file_path: book.root + '/' + longDocument.parts[1] },
            expected: replacement,
          },
          { name: 'read', input: { file_path: draft } },
          { name: 'write', input: { file_path: draft, content: appendText } },
        ];
      },
    });
    await authorComposer.fill(appendTask.marker);
    await page.getByRole('button', { name: /^(接着写|按纲续写)$/ }).click();
    await waitFor(() => appendTask.completedSteps === 3, 'native long-document append tool loop');
    await activity.filter({ hasText: 'AI 已结束' }).waitFor();
    await page.getByText('本次仅追加候选内容，已有全文保持不变。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '接受改稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
    assert.equal(
      (await get('document?path=' + encodeURIComponent(longPath))).hash,
      fullHash(expectedLong + appendText),
    );
    // Publish an actual new order, then use the SAME original conversation and
    // real native tool loop to read its updated entry guide, bindings and rules.
    const readyOrder = await get('chapter-order');
    const reorderedKeys = readyOrder.entries.map((entry) => entry.key).reverse();
    const reviewedResponse = await context.request.post(origin + api + 'chapter-order', {
      data: {
        action: 'preview',
        version: readyOrder.version,
        keys: reorderedKeys,
      },
    });
    assert.equal(reviewedResponse.status(), 200);
    const reviewedOrder = await reviewedResponse.json();
    await reviewedResponse.dispose();
    const publishedOrder = await context.request.post(origin + api + 'chapter-order', {
      data: {
        action: 'apply',
        version: readyOrder.version,
        keys: reorderedKeys,
        fingerprint: reviewedOrder.fingerprint,
      },
    });
    assert.equal(publishedOrder.status(), 200);
    await publishedOrder.dispose();
    const reorderedOutline = await get('document?path=outline.json');
    const linkedLong = JSON.parse(reorderedOutline.text).find((row) => row.chapterPath === longPath);
    assert.ok(linkedLong);
    assert.equal(
      (await get('document?path=' + encodeURIComponent(longPath))).outline.chapter,
      linkedLong.chapter,
    );
    assert.equal(
      (await get('document?path=' + encodeURIComponent(longPath))).hash,
      fullHash(expectedLong + appendText),
    );
    const orderReader = model.register({
      prepare(prompt, self) {
        self.steps = [
          {
            name: 'read',
            input: { file_path: book.root + '/START.md' },
            expected: '本书已调整章序。当前章号、顺序及正文绑定以 outline.json',
          },
          { name: 'read', input: { file_path: book.root + '/outline.json' }, expected: longPath },
          { name: 'read', input: { file_path: book.root + '/rules.json' }, expected: 'chapterOrderReview' },
          {
            name: 'read',
            input: { file_path: book.root + '/' + longDocument.parts[0] },
            expected: 'Earlier paragraphs',
          },
        ];
      },
    });
    await authorComposer.fill(orderReader.marker);
    await authorComposer.press('Enter');
    await waitFor(
      () => orderReader.completedSteps === 4,
      'native model reads the reordered book guide and current bindings',
    );
    assert.ok(
      JSON.stringify(orderReader.bodies[0]).includes(
        '本书已调整章序。当前章号、顺序及正文绑定以 outline.json',
      ),
      'The first post-reorder native model request must already include refreshed workspace instructions, before any tool reads.',
    );
    await activity.filter({ hasText: 'AI 已结束' }).waitFor();
    console.log(
      'Native post-reorder context passed: original conversation/tool loop read current START, outline, rules and unchanged physical prose.',
    );
    const sourceDraft = '源对话中还没发送的下一段想法。';
    await authorComposer.fill(sourceDraft);
    const tasksBeforeSourceReturn = model.requests.filter((request) => request.task !== null).length;
    await page.getByRole('button', { name: '新建会话', exact: true }).last().click();
    await waitFor(
      () => authorComposer.textContent().then((value) => !value?.trim()),
      'a distinct native conversation with its own draft',
    );
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    await page.getByRole('button', { name: /^改稿/ }).click();
    await page.locator('.novel-proposals > .novel-document-strip button').first().click();
    await page.getByRole('button', { name: '查看发起对话', exact: true }).click();
    await waitFor(
      () => authorComposer.textContent().then((value) => value === sourceDraft),
      'return from another conversation to the exact original source and unsent draft',
    );
    assert.equal(model.requests.filter((request) => request.task !== null).length, tasksBeforeSourceReturn);
    console.log(
      'Native candidate/source navigation passed: exact proposal from task, same original tab, read-only resolved results, genuine second-session return, native unsent draft and no task resubmission.',
    );
    const ordinaryTask = model.register({ finalText: 'Ordinary workspace synthetic reply.' });
    const createOrdinary = await context.request.post(origin + '/api/sessions', {
      data: { title: 'Ordinary role verification' },
    });
    assert.equal(createOrdinary.status(), 201);
    const ordinarySession = (await createOrdinary.json()).session;
    const ordinaryId = ordinarySession.id ?? ordinarySession.sessionId;
    assert.ok(ordinaryId);
    const ordinaryTurn = await context.request.post(origin + '/api/sessions/' + ordinaryId + '/turn', {
      data: { message: ordinaryTask.marker },
      timeout: 45000,
    });
    assert.equal(ordinaryTurn.status(), 200);
    await ordinaryTurn.text();
    await ordinaryTurn.dispose();
    assert.ok(ordinaryTask.bodies.length);
    assert.ok(systemText(ordinaryTask.bodies[0]).includes('You are dsh-edge, a coding agent powered by'));
    assert.ok(!systemText(ordinaryTask.bodies[0]).includes(NOVEL_IDENTITY));
    const toolsOf = (body) => body.tools.map((tool) => tool.name ?? tool.function?.name).sort();
    const runTools = ['novel_run_next', 'novel_run_submit'];
    for (const name of runTools) {
      assert.ok(toolsOf(task.bodies[0]).includes(name));
      assert.ok(!toolsOf(ordinaryTask.bodies[0]).includes(name));
    }
    assert.deepEqual(
      toolsOf(ordinaryTask.bodies[0]),
      toolsOf(task.bodies[0]).filter((name) => !runTools.includes(name)),
      'Novel role must not remove native capabilities.',
    );
    // Keep original VFS, conversations, metadata and browser draft while replacing
    // ONLY owned processes. A cold resume must install the same original-context hook.
    await closeOwned(pages);
    await closeOwned(worker);
    // Local RPC registrations are ephemeral, not persisted session/VFS state.
    // A full restart must not bind Pages to the former Miniflare socket.
    devRegistry = resolve(work, 'dev-registry-after-restart');
    const coldWorker = launch(worker.args, worker.cwd);
    await ready(workerOrigin + '/api/health', coldWorker);
    const coldPages = launch(pages.args, pages.cwd);
    await ready(origin + '/api/auth/session', coldPages);
    const resumedRoleTask = model.register({ finalText: 'Cold-resumed novel synthetic reply.' });
    const resumedTurn = await context.request.post(origin + '/api/sessions/' + sessionId + '/turn', {
      data: { message: resumedRoleTask.marker },
      timeout: 45000,
    });
    assert.equal(resumedTurn.status(), 200);
    await resumedTurn.text();
    await resumedTurn.dispose();
    assert.ok(resumedRoleTask.bodies.length);
    assert.ok(systemText(resumedRoleTask.bodies[0]).includes(NOVEL_IDENTITY));
    assert.ok(!systemText(resumedRoleTask.bodies[0]).includes('You are dsh-edge, a coding agent powered by'));
    assert.deepEqual(toolsOf(resumedRoleTask.bodies[0]), toolsOf(task.bodies[0]));
    await page.reload();
    await waitFor(
      () => authorComposer.textContent().then((value) => value === sourceDraft),
      'original unsent native draft after service restart',
    );
    await writeFile(
      resolve(work, 'native-role-verification.json'),
      JSON.stringify(
        {
          novelSystem: systemText(task.bodies[0]),
          ordinarySystem: systemText(ordinaryTask.bodies[0]),
          coldResumedNovelSystem: systemText(resumedRoleTask.bodies[0]),
          tools: toolsOf(task.bodies[0]),
          sameNativeHistory: true,
          unsentDraftPreserved: true,
          realProviderRequests: 0,
        },
        null,
        2,
      ),
    );
    console.log(
      'Native novelist role passed: actual model HTTP system identity, ordinary workspace unchanged, full native tool catalog retained and same-book cold resume/draft preservation. Synthetic provider only; not literary-quality proof.',
    );
    assert.ok(model.requests.every((request) => request.keysSynthetic));
    for (const [key, button, mode, text] of [
      ['deai', '润色本章', 'rewrite', '润色后的独立合成候选。'],
      ['ending', '写章节收尾', 'continue', '窗外最后一声钟沉进雨里。'],
    ]) {
      await page.getByRole('button', { name: '正文', exact: true }).click();
      await openChapter(page, proposal.target);
      const beforeSpecial = await get('document?path=' + encodeURIComponent(proposal.target));
      const specialTask = model.register({
        prepare(prompt, self) {
          self.draft = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
          assert.ok(self.draft);
          self.steps = proposalSteps(prompt, text);
        },
      });
      await authorComposer.fill(specialTask.marker);
      await page.getByText('更多写作', { exact: true }).click();
      await page.getByRole('button', { name: button, exact: true }).click();
      await waitFor(() => specialTask.completedSteps === 2, 'native ' + key + ' template tool loop');
      await activity.filter({ hasText: 'AI 已结束' }).waitFor();
      const specialId = specialTask.draft.match(/([a-f0-9-]{36})\.md$/)[1];
      const specialReview = await get('review?id=' + specialId);
      assert.equal(specialReview.proposal.promptTemplate.key, key);
      assert.equal(specialReview.proposal.writing.mode, mode);
      assert.equal(specialReview.draft.text, text);
      const receivedText = specialTask.bodies[0].messages
        .flatMap((message) =>
          typeof message.content === 'string'
            ? [message.content]
            : (message.content ?? []).map((block) => block.text ?? ''),
        )
        .join('\n');
      assert.ok(receivedText.includes(specialReview.proposal.promptTemplate.body));
      assert.equal(
        (await get('document?path=' + encodeURIComponent(proposal.target))).hash,
        beforeSpecial.hash,
      );
      if (mode === 'continue')
        assert.deepEqual(specialReview.proposal.edit, {
          start: beforeSpecial.text.length,
          end: beforeSpecial.text.length,
        });
    }
    await authorComposer.fill(sourceDraft);
    // Exercise first-use outline creation, then append using the distinct legacy
    // outlineContinue template, entirely through the real page and native tools.
    await clickSidebarEntry(page, 'link', '小说库');
    let releaseSeed,
      seedReadObserved = false;
    const seedGate = new Promise((resolve) => {
      releaseSeed = resolve;
    });
    const seedRoute = '**/api/novels/*/document?*';
    const holdSeed = async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') === 'seed.md' && !url.pathname.includes(book.id)) {
        seedReadObserved = true;
        await seedGate;
      }
      await route.continue();
    };
    await page.route(seedRoute, holdSeed);
    await page.getByLabel('零碎的灵感').fill('只用于验证默认大纲入口的合成新书：一口井每天退回昨日的信。');
    await page.getByRole('button', { name: '准备创作', exact: true }).click();
    await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
    const planBook = await page.evaluate(
      async (oldId) =>
        (await (await import('/novel-assets/workspace.mjs')).makeWorkspaceClient().list()).find(
          (item) => item.id !== oldId,
        ),
      book.id,
    );
    assert.ok(planBook);
    await waitFor(() => seedReadObserved, 'owned slow first-document read');
    assert.equal(
      await page.getByRole('region', { name: '小说书稿', exact: true }).getAttribute('data-book-id'),
      planBook.id,
    );
    assert.equal(await page.getByRole('button', { name: '大纲', exact: true }).isDisabled(), true);
    releaseSeed();
    await page.getByRole('button', { name: '大纲', exact: true }).click();
    await page.unroute(seedRoute, holdSeed);
    assert.equal(await page.locator('.novel-outline-planner').evaluate((element) => element.open), true);
    for (const [number, key] of [
      [1, 'outline'],
      [2, 'outlineContinue'],
    ]) {
      if (number === 2) await page.getByText('AI 续规划 / 调整', { exact: true }).click();
      const planTask = model.register({
        prepare(prompt, self) {
          self.draft = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
          assert.ok(self.draft?.startsWith(planBook.root));
          self.steps = [
            { name: 'read', input: { file_path: self.draft } },
            {
              name: 'write',
              input: {
                file_path: self.draft,
                content: JSON.stringify({
                  ...(number === 1
                    ? { storyPlan: '信件退回的代价迫使邮差调查井底记录，并决定保留无法撤回的证据。' }
                    : {}),
                  chapters: [
                    {
                      chapter: number,
                      title: '井边的信 ' + number,
                      summary: '邮差比对退回的信件并决定保存原件，因此失去重写昨日的机会。',
                      plotPoints: ['核对信封日期', '保存无法撤回的原件'],
                    },
                  ],
                }),
              },
            },
          ];
        },
      });
      await page.getByLabel('规划起始章', { exact: true }).fill(String(number));
      await page.getByLabel('本批规划章数', { exact: true }).fill('1');
      await page.getByLabel('本次规划要求', { exact: true }).fill(planTask.marker);
      await page.getByRole('button', { name: '生成规划候选', exact: true }).click();
      await waitFor(() => planTask.completedSteps === 2, 'native ' + key + ' candidate generation');
      await activity.filter({ hasText: 'AI 已结束' }).waitFor();
      const planId = planTask.draft.match(/([a-f0-9-]{36})\.md$/)[1];
      const planResponse = await context.request.get(
        origin + '/api/novels/' + planBook.id + '/review?id=' + planId,
      );
      const planReview = await planResponse.json();
      await planResponse.dispose();
      assert.equal(planReview.proposal.promptTemplate.key, key);
      assert.deepEqual(planReview.proposal.promptTemplate.unknownFields, []);
      const actual = planTask.bodies[0].messages
        .flatMap((m) =>
          typeof m.content === 'string' ? [m.content] : (m.content ?? []).map((b) => b.text ?? ''),
        )
        .join('\n');
      assert.ok(actual.includes(planReview.proposal.promptTemplate.body));
      await page.getByRole('button', { name: '接受本批规划', exact: true }).click();
      await page.locator('.novel-ms-status').filter({ hasText: '本批规划已接受' }).waitFor();
    }
    const planListingResponse = await context.request.get(
      origin + '/api/novels/' + planBook.id + '/documents',
    );
    const planListing = await planListingResponse.json();
    await planListingResponse.dispose();
    assert.equal(planListing.outlineChapterCount, 2);
    assert.equal(planListing.documents.filter((item) => item.category === 'chapter').length, 0);
    await page.getByRole('button', { name: '起草本章', exact: true }).first().click();
    await page.getByRole('button', { name: '按纲生成本章', exact: true }).waitFor();
    const chapterListResponse = await context.request.get(
      origin + '/api/novels/' + planBook.id + '/documents',
    );
    const chapterPath = (await chapterListResponse.json()).documents.find(
      (item) => item.category === 'chapter',
    ).path;
    await chapterListResponse.dispose();
    const chapterURL =
      origin + '/api/novels/' + planBook.id + '/document?path=' + encodeURIComponent(chapterPath);
    const beforeChapterResponse = await context.request.get(chapterURL);
    const beforeChapter = await beforeChapterResponse.json();
    await beforeChapterResponse.dispose();
    const chapterText =
      '邮差把今日退回的信封贴在登记簿旁，两个日期并排，墨色一深一浅。井口又传来纸张摩擦的声音，他没有伸手。\n\n他把原件锁进铁匣，收走了井边的绳子。从这一刻起，昨日不能再被改写；他得带着这封信去问寄信人。';
    const chapterTask = model.register({
      prepare(prompt, self) {
        assert.ok(prompt.includes('"proposal_id"'));
        assert.ok(!prompt.includes('试写本章开场场景'));
        self.draft = prompt.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
        assert.ok(self.draft);
        self.steps = proposalSteps(prompt, chapterText);
      },
    });
    await authorComposer.fill(chapterTask.marker);
    await page.getByRole('button', { name: '按纲生成本章', exact: true }).click();
    await waitFor(() => chapterTask.completedSteps === 2, 'explicit full-chapter native task');
    await activity.filter({ hasText: 'AI 已结束' }).waitFor();
    const chapterId = chapterTask.draft.match(/([a-f0-9-]{36})\.md$/)[1];
    const chapterReviewResponse = await context.request.get(
      origin + '/api/novels/' + planBook.id + '/review?id=' + chapterId,
    );
    const chapterReview = await chapterReviewResponse.json();
    await chapterReviewResponse.dispose();
    assert.equal(chapterReview.proposal.writing.purpose, 'chapter');
    assert.equal(chapterReview.proposal.promptTemplate.key, 'write');
    assert.equal(chapterReview.writingContext.outline.chapter, 1);
    const unchangedResponse = await context.request.get(chapterURL);
    assert.equal((await unchangedResponse.json()).hash, beforeChapter.hash);
    await unchangedResponse.dispose();
    await page.getByRole('button', { name: '接受改稿', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
    const writtenResponse = await context.request.get(chapterURL);
    assert.equal((await writtenResponse.json()).text, beforeChapter.text + chapterText);
    await writtenResponse.dispose();
    console.log(
      'Explicit by-outline chapter runtime passed: frozen full-chapter purpose, associated chapter facts, original native model/tools, no premature publication and explicit accepted prose; not an opening-only relabel.',
    );
    await verifyWritingRun({ page, context, origin, book: planBook, model, waitFor, root });
    await verifyBorrowedWorkflow({ page, context, origin, book: planBook, model, waitFor, root });
    assert.ok(model.requests.every((request) => request.keysSynthetic));
    console.log(
      'First-use outline runtime passed: visible initial planner, original outline and outlineContinue default templates reach model HTTP, full preview/explicit acceptance and no automatic prose publication.',
    );
    console.log(
      'Restored template runtime passed: default expansion reaches actual native model HTTP; explicit polish and chapter-ending actions write candidates only, with frozen selected template and append scope.',
    );
    assert.deepEqual(model.errors, []);
    assert.deepEqual(errors, []);
    console.log(
      'Engine integration passed: genuine localhost model stream → native read/write tools → native VFS candidate → protected acceptance; native 402 failure, reload recovery and cancellation; compact task cards preserve full model/history text, ordinary native chat and 1280/768/390 layouts. No paid API or production data.',
    );
  }
} catch (error) {
  console.error(
    'Engine fixture:',
    error.message,
    'model requests:',
    model?.requests.length ?? 0,
    'protocol errors:',
    model?.errors ?? [],
  );
  for (const record of children)
    console.error(record.output.replaceAll(key, '[synthetic-owner]').slice(-3500));
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        console.error(
          'UI diagnostic:',
          await page.locator('[role="alert"],.novel-ms-status').allTextContents(),
        );
        if (new URL(page.url()).protocol.startsWith('http'))
          await page.screenshot({ path: resolve(work, 'failure.png'), fullPage: true }).catch(() => {});
      }
  throw error;
} finally {
  await browser?.close();
  for (const record of children.reverse()) await closeOwned(record);
  await model?.close();
}
