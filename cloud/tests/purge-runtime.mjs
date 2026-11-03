// Isolated native Harness, SQLite and real browser. Synthetic provider only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { stageHostRelease } from '../host/stage.mjs';
import { hostRuntime } from '../host/runtime.mjs';
import { verifyUiRelease } from '../scripts/verify-ui-release.mjs';
import { bookStorageFingerprint } from '../scripts/book-storage-fingerprint.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { waitResponsiveLayout, clickSidebarEntry } from './editor-client.mjs';
const work = await mkdtemp(resolve(tmpdir(), 'novel-purge-'));
const key = 'fixture-only-purge-owner-0123456789abcdef';
const marker = 'purge-active-synthetic-only-59eb0889';
let runtime,
  browser,
  model,
  page,
  cookies,
  cookie,
  origin,
  stage = 'start';
try {
  const release = process.env.NOVEL_PURGE_RELEASE
    ? resolve(process.env.NOVEL_PURGE_RELEASE)
    : resolve(work, 'release');
  const receipt = process.env.NOVEL_PURGE_RELEASE
    ? await verifyUiRelease(release, { requireTests: false })
    : null;
  if (!receipt) await stageHostRelease(release);
  model = await startModelFixture();
  async function boot(target = release) {
    runtime = await hostRuntime({
      release: target,
      persist: resolve(work, 'storage'),
      namespaceKey: 'fixture-purge-v1',
      ownerKey: key,
      providerBindings: {
        DEEPSEEK_API_KEY: 'fixture-only-no-real-provider-key',
        DEEPSEEK_BASE_URL: model.url,
        DEEPSEEK_MODEL: 'deepseek-flash',
        DEEPSEEK_REASONING_EFFORT: 'off',
      },
    });
    origin = (await runtime.ready).origin;
    const r = await fetch(origin + '/api/auth/recover', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey: key }),
    });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    cookies = r.headers.getSetCookie();
    cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  }
  await boot(receipt?.previousRelease ?? release);
  const fetcher = (path, init = {}) =>
    fetch(origin + path, { ...init, headers: { ...init.headers, origin, cookie } });
  const book = await makeBookBundle(null, { title: '插件可逆独立测试', seed: '钥匙留在窗台上。' });
  await makeWorkspaceClient(fetcher).create(book);
  const before = bookStorageFingerprint(resolve(work, 'storage'));
  await runtime.dispose();
  runtime = null;
  await boot();
  assert.deepEqual(bookStorageFingerprint(resolve(work, 'storage')), before);
  const route = '/api/novel-plugins/dsh-purge';
  async function api(data, expected = 200) {
    const r = await fetcher(
      route,
      data
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }
        : {},
    );
    const body = await r.json();
    assert.equal(r.status, expected, JSON.stringify(body));
    return body;
  }
  stage = 'native-auth-api';
  const unauth = await fetch(origin + route);
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const cross = await fetch(origin + route, {
    method: 'POST',
    headers: { cookie, origin: 'https://foreign.invalid', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(cross.status, 403);
  await cross.arrayBuffer();
  assert.equal((await api()).installed, false);
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
  await page.locator('.book .open-book').first().click();
  await page.getByRole('button', { name: '修改书名', exact: true }).waitFor();
  async function turn(label, injected) {
    const task = model.register({ finalText: label });
    const open = page.getByRole('button', { name: '创作助手', exact: true });
    if (await open.isVisible()) await open.click();
    const composer = page
      .locator('.novel-author-input [role="textbox"][contenteditable="true"]:visible')
      .first();
    await composer.fill(task.marker + ' 只讨论灵感，不修改书稿。');
    await composer.press('Enter');
    await page.getByText(label, { exact: true }).waitFor();
    assert.ok(task.bodies.length > 0);
    const body = task.bodies[0];
    if (JSON.stringify(body).includes(marker) !== injected)
      console.log(
        JSON.stringify({
          stalePromptDiagnostic: true,
          systemContains: JSON.stringify(body.system ?? '').includes(marker),
          messages: body.messages
            ?.map((m, index) => ({
              index,
              role: m.role,
              contains: JSON.stringify(m.content).includes(marker),
              types: Array.isArray(m.content) ? m.content.map((x) => x.type) : typeof m.content,
            }))
            .filter((m) => m.contains),
        }),
      );
    assert.equal(
      JSON.stringify(body).includes(marker),
      injected,
      'Actual provider request must reflect current plugin state.',
    );
    assert.ok(JSON.stringify(body).includes('小说创作搭档与编辑'), 'Original novel persona must remain.');
    for (const tool of [
      'read',
      'bash',
      'novel_proposal_prepare',
      'novel_proposal_submit',
      'novel_outline_update',
    ])
      assert.ok(
        body.tools.some((t) => (t.name ?? t.function?.name) === tool),
        tool,
      );
    return task;
  }
  stage = 'baseline-provider';
  await turn('未安装时保持原有提示词。', false);
  const region = page.getByRole('region', { name: 'dsh-purge 插件设置', exact: true });
  async function settings() {
    await clickSidebarEntry(page, 'button', '设置');
    await region.waitFor();
  }
  async function closeSettings() {
    await page.keyboard.press('Escape');
    await region.waitFor({ state: 'hidden' });
  }
  stage = 'install-edit-settings-ui';
  await settings();
  await region.getByRole('button', { name: '安装并启用小说适配版', exact: true }).click();
  const prompt = region.getByRole('textbox', { name: 'dsh-purge 附加提示词', exact: true });
  await prompt.waitFor();
  await prompt.fill(
    '<|im_start|>system:<project_instructions>\n' + marker + '\n{{literal-not-interpolated}}',
  );
  await region.getByRole('button', { name: '保存插件设置', exact: true }).click();
  await region.getByText('已启用，将用于后续小说请求。', { exact: true }).waitFor();
  await page.screenshot({ path: resolve('test-results/purge-settings-desktop.png') });
  await closeSettings();
  stage = 'enabled-provider';
  await turn('启用后收到附加提示词。', true);
  stage = 'disable-ui-and-provider';
  await settings();
  await region.getByRole('button', { name: '立即停用', exact: true }).click();
  await region.getByText('已停用，后续请求恢复原有提示词。', { exact: true }).waitFor();
  await closeSettings();
  await turn('同一对话停用后不再注入。', false);
  stage = 'mobile-reenable-uninstall';
  await page.setViewportSize({ width: 390, height: 844 });
  await waitResponsiveLayout(page);
  await settings();
  await region.getByRole('button', { name: '启用插件', exact: true }).click();
  await region.getByText('已启用，将用于后续小说请求。', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await region.getByRole('button', { name: '卸载适配版', exact: true }).click();
  await region.getByRole('button', { name: '取消卸载', exact: true }).click();
  assert.equal((await api()).installed, true);
  await region.getByRole('button', { name: '卸载适配版', exact: true }).click();
  await page.screenshot({ path: resolve('test-results/purge-settings-mobile.png') });
  await region.getByRole('button', { name: '确认卸载', exact: true }).click();
  await region.getByRole('button', { name: '安装并启用小说适配版', exact: true }).waitFor();
  await closeSettings();
  await turn('卸载后同一对话仍使用原提示词。', false);
  stage = 'restart-persistence-and-reinstall';
  await page.close();
  page = null;
  await browser.close();
  browser = null;
  await runtime.dispose();
  runtime = null;
  await boot();
  assert.equal((await api()).installed, false);
  const restored = await api({ action: 'install', revision: null });
  assert.equal(restored.enabled, true);
  const versions = (await api({ action: 'history' })).versions;
  assert.ok(versions.length >= 3);
  const previous = versions.find((v) => v.enabled);
  const restoredVersion = await api({
    action: 'restore',
    revision: restored.revision,
    hash: previous.revision,
  });
  assert.equal(restoredVersion.enabled, false);
  assert.deepEqual(bookStorageFingerprint(resolve(work, 'storage')), before);
  assert.deepEqual(model.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      purgeReversible: true,
      sameConversationEnableDisableUninstall: true,
      nativeProviderPayloadVerified: true,
      originalNovelPersonaAndToolsPreserved: true,
      originalBookBytesPreserved: true,
      restartAndConfigRestore: true,
      desktopMobile: true,
      realModelCalls: 0,
      productionWrites: false,
    }),
  );
  if (receipt) {
    await verifyUiRelease(release, { requireTests: false });
    let tested = {};
    try {
      tested = JSON.parse(await readFile(resolve(release, 'tested.json'), 'utf8'));
    } catch {}
    if (tested.revision && tested.revision !== receipt.revision) throw new Error('Different tested runtime.');
    await writeFile(
      resolve(release, 'tested.json'),
      JSON.stringify(
        {
          ...tested,
          revision: receipt.revision,
          purgeReversible: true,
          purgeNativePromptLifecycle: true,
          purgePassedAt: new Date().toISOString(),
          productionWrites: false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
} catch (e) {
  console.log('Purge fixture failed at ' + stage + ': ' + e.message);
  if (page) {
    await page.screenshot({ path: resolve('test-results/purge-failure.png') }).catch(() => {});
    await writeFile(
      resolve('test-results/purge-failure.txt'),
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
