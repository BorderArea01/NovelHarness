// Original native Harness/tool loop + actual browser, synthetic data/provider.
// Never reads production credentials/storage, never requests a paid model.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { verifyUiRelease } from '../scripts/verify-ui-release.mjs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stageHostRelease } from '../host/stage.mjs';
import { hostRuntime } from '../host/runtime.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { chromium } from '@playwright/test';
import { waitEditor, openChapter, waitResponsiveLayout, readEditor } from './editor-client.mjs';

const work = await mkdtemp(resolve(tmpdir(), 'novel-unified-writing-'));
const ownerKey = 'fixture-only-unified-writing-owner-key-0123456789abcdef';
const path = 'chapters/1.md';
const original = '# 钟楼\n\n她推开门。\n\n她把信放进抽屉。';
const mixed = '# 钟楼\n\n她没有推门，而是敲了三下。\n\n她把信放进抽屉。\n\n门后终于传来了脚步声。';
let runtime,
  model,
  browser,
  page,
  stage = 'start';
try {
  const release = process.env.NOVEL_UNIFIED_RELEASE ? resolve(process.env.NOVEL_UNIFIED_RELEASE) : resolve(work, 'release');
  const receipt = process.env.NOVEL_UNIFIED_RELEASE ? await verifyUiRelease(release, { requireTests: false }) : null;
  if (!receipt) await stageHostRelease(release);
  model = await startModelFixture();
  const start = (runtimeRelease) => hostRuntime({
    release: runtimeRelease,
    persist: resolve(work, 'storage'),
    namespaceKey: 'fixture-unified-writing-v1',
    ownerKey,
    providerBindings: {
      DEEPSEEK_API_KEY: 'fixture-only-no-real-provider-key',
      DEEPSEEK_BASE_URL: model.url,
      DEEPSEEK_MODEL: 'deepseek-flash',
      DEEPSEEK_REASONING_EFFORT: 'off',
    },
  });
  runtime = await start(receipt?.previousRelease ?? release);
  let origin = (await runtime.ready).origin;
  let cookies, cookie;
  const authenticate = async () => {
    const login = await fetch(origin + '/api/auth/recover', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: ownerKey }),
  });
  assert.equal(login.status, 200);
  await login.arrayBuffer();
    cookies = login.headers.getSetCookie();
    cookie = cookies.map((h) => h.split(';')[0]).join('; ');
  };
  await authenticate();
  const fetcher = (path, init = {}) =>
    fetch(origin + path, { ...init, headers: { ...init.headers, origin, cookie } });
  const bundle = await makeBookBundle(null, { title: '混合创作独立测试', seed: '门后传来三下敲击。' });
  await makeWorkspaceClient(fetcher).create(bundle);
  const base = '/api/novels/' + bundle.manifest.id + '/';
  const get = async (route) => {
    const r = await fetcher(base + route);
    assert.equal(r.status, 200);
    return r.json();
  };
  const put = await fetcher(base + 'document', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, text: original, expectedHash: null }),
  });
  assert.equal(put.status, 200);
  const before = await put.json();
  if (receipt) {
    stage = 'in-place-native-upgrade';
    const pendingResponse = await fetcher(base + 'proposals', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ originSessionId: 'fixture-legacy-author', path, expectedHash: before.hash,
        edit: { start: original.length, end: original.length }, writing: { version: 1, mode: 'continue', instruction: '旧任务仍待完成' } }) });
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    const sessionIds = async () => {
      const r = await fetcher('/api/sessions?limit=100'); assert.equal(r.status, 200);
      const rows = await r.json(); assert.equal(rows.hasMore, false);
      return rows.sessions.map(row => row.id ?? row.sessionId).sort();
    };
    const beforeIds = await sessionIds();
    await runtime.dispose(); runtime = null;
    runtime = await start(release); origin = (await runtime.ready).origin;
    await authenticate();
    assert.deepEqual(await sessionIds(), beforeIds);
    assert.equal((await get('document?path=' + encodeURIComponent(path))).text, original);
    const preserved = await get('review?id=' + pending.id);
    assert.equal(preserved.proposal.status, 'pending');
    assert.equal(preserved.proposal.writing.flexible, undefined);
    assert.deepEqual(preserved.proposal.edit, { start: original.length, end: original.length });
    assert.equal(preserved.draft.text, '');
    assert.equal(preserved.base, '');
  }
  const previous = ({ results, task, step }) =>
    JSON.parse(results.get('fixture_' + task.id + '_' + (step - 1)).text);
  const task = model.register({
    finalText: '前文与后文已一起保存。',
    steps: [
      {
        name: 'novel_proposal_prepare',
        input: {
          mode: 'rewrite',
          chapter: 1,
          path: bundle.manifest.root + '/' + path,
          instruction: '改第一段，同时续写后文。',
        },
        expected: '"contentScope":"document"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: mixed.slice(0, -5),
            complete: false,
          };
        },
        expected: '"published":false',
      },
      {
        name: 'novel_proposal_inspect',
        input: (scope) => ({ proposal_id: previous(scope).proposalId }),
        expected: '"contentScope":"document"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: mixed,
            complete: true,
          };
        },
        expected: '"published":true',
      },
    ],
  });
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
  page.on('pageerror', (error) => errors.push(error.message));
  for (const label of ['继续', '稍后配置'])
    await page.addLocatorHandler(page.getByRole('button', { name: label, exact: true }), () =>
      page.getByRole('button', { name: label, exact: true }).click(),
    );
  await page.goto(origin + '/?view=library');
  await page.locator('.book .open-book').first().click();
  await openChapter(page, path);
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await waitEditor(editor, original);
  stage = 'desktop-unified-entry';
  assert.equal(await page.getByRole('button', { name: '按想法改写', exact: true }).count(), 0);
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const composer = page
    .locator('.novel-author-input [role="textbox"][contenteditable="true"]:visible')
    .first();
  await composer.fill(task.marker + ' 改第一段，同时续写后文。');
  await composer.press('Enter');
  await page.getByText('前文与后文已一起保存。', { exact: true }).waitFor();
  const after = await get('document?path=' + encodeURIComponent(path));
  assert.equal(after.text, mixed);
  const history = await get('history?path=' + encodeURIComponent(path) + '&hash=' + before.hash);
  assert.equal(history.text, original);
  assert.equal(task.completedSteps, task.steps.length);
  for (const body of task.bodies) {
    const tools = body.tools.map((tool) => tool.name ?? tool.function?.name);
    for (const name of [
      'read',
      'bash',
      'novel_proposal_prepare',
      'novel_proposal_submit',
      'novel_outline_update',
    ])
      assert.ok(tools.includes(name), name + ' remains available throughout the task.');
  }
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await waitEditor(editor, mixed);
  await page.screenshot({ path: resolve('test-results/unified-writing-desktop.png') });
  stage = 'mobile-shortcut-uses-same-contract';
  await page.setViewportSize({ width: 390, height: 844 });
  await waitResponsiveLayout(page);
  const uiTask = model.register({
    finalText: '同一写作入口已保存修改与新增。',
    prepare(prompt, t) {
      t.proposalId = prompt.match(/本次 proposal_id=([a-f0-9-]{36})/)?.[1];
      assert.ok(t.proposalId);
      assert.match(prompt, /同一任务中修改前文、续写后文/);
      assert.match(prompt, /原子替换而非拼接/);
    },
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: ({ task }) => ({ proposal_id: task.proposalId }),
        expected: '"contentScope":"document"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: mixed.replace('三下', '两下') + '\n\n她退后半步。',
            complete: true,
          };
        },
        expected: '"published":true',
      },
    ],
  });
  // Fill the existing native composer without a duplicate writing form.
  const shortcutToggle = page.getByRole('button', { name: '写作', exact: true });
  await composer.fill(uiTask.marker + ' 把三下改成两下，再往后写。');
  const shortcuts = page.locator('.novel-author-shortcuts');
  if (!(await shortcuts.evaluate((node) => node.open))) await shortcuts.locator(':scope > summary').click();
  await shortcutToggle.click();
  await page.getByText('同一写作入口已保存修改与新增。', { exact: true }).waitFor({ state: 'attached' });
  const finalText = mixed.replace('三下', '两下') + '\n\n她退后半步。';
  assert.equal((await get('document?path=' + encodeURIComponent(path))).text, finalText);
  assert.equal(uiTask.completedSteps, uiTask.steps.length);
  for (const body of uiTask.bodies) {
    const tools = body.tools.map((tool) => tool.name ?? tool.function?.name);
    for (const name of [
      'read',
      'bash',
      'novel_proposal_prepare',
      'novel_proposal_submit',
      'novel_outline_update',
    ])
      assert.ok(tools.includes(name), name + ' also remains available from the writing shortcut.');
  }
  await waitEditor(editor, finalText);
  await page.screenshot({ path: resolve('test-results/unified-writing-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.reload();
  await waitEditor(editor, finalText);
  assert.equal(await readEditor(editor), finalText);
  assert.deepEqual(errors, []);
  assert.deepEqual(model.errors, []);
  if (receipt) {
    const testedPath = resolve(release, 'tested.json');
    const tested = JSON.parse(await readFile(testedPath, 'utf8'));
    assert.equal(tested.revision, receipt.revision);
    await writeFile(testedPath, JSON.stringify({ ...tested, unifiedWriting: true, inPlaceNativeUpgrade: true,
      unifiedWritingPassedAt: new Date().toISOString(), allNativeToolsAvailable: true, realModelCalls: 0,
      productionWrites: false }, null, 2), { mode: 0o600 });
  }
  console.log(
    JSON.stringify({
      nativeMixedRewriteAndContinue: true,
      allNativeToolsAvailable: true,
      originalFailureParametersAccepted: true,
      oneMobileWritingEntry: true,
      partialAndFinalStream: true,
      leftManuscriptSynchronized: true,
      noImplicitAppend: true,
      oldVersionVerified: true,
      reloadPreserved: true,
      browserErrors: 0,
      realModelCalls: 0,
      productionWrites: false,
      inPlaceNativeUpgrade: !!receipt,
    }),
  );
} catch (error) {
  console.log('Synthetic unified writing failed at ' + stage + ': ' + error.message);
  if (page) {
    await page.screenshot({ path: resolve('test-results/unified-writing-failure.png') }).catch(() => {});
    await writeFile(
      resolve('test-results/unified-writing-failure.txt'),
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
