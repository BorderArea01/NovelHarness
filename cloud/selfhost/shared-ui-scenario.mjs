import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { startSelfHostedServer } from './server.mjs';
import { waitResponsiveLayout } from '../tests/editor-client.mjs';

export async function verifySharedUi(browser) {
  const root = await mkdtemp(join(tmpdir(), 'novel-shared-ui-'));
  let app, context, page;
  let modelRequests = 0;
  try {
    app = await startSelfHostedServer({ mode: 'shared', port: 0, dataDirectory: root, initialPin: '864209' });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (/\/api\/session\/prompt$/.test(url.pathname)) {
        modelRequests++;
        return route.abort();
      }
      if (url.origin !== app.origin) return route.abort();
      return route.continue();
    });
    page = await context.newPage();
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
    await page.goto(app.origin + '/login');
    await page.getByLabel('登录 PIN', { exact: true }).fill('864209');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('.novel-native-frame').waitFor({ timeout: 45000 });
    // Initial native notices can defer sidebar mounting. Wait for the actual
    // desktop entry instead of deciding that a not-yet-mounted sidebar is folded.
    await page.getByRole('link', { name: '数据与访问', exact: true }).click({ timeout: 45000 });
    await page.getByRole('heading', { name: '私人共享空间', exact: true }).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-novel-mode'), 'shared');
    assert.equal(await page.getByLabel('当前 PIN', { exact: true }).isVisible(), false);
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await waitResponsiveLayout(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `test-results/mode-shared-${width}.png` });
    }
    await page.getByText('修改登录 PIN', { exact: true }).click();
    await page.getByLabel('当前 PIN', { exact: true }).fill('864209');
    await page.getByLabel('新 PIN', { exact: true }).fill('209468');
    await page.getByLabel('再次输入新 PIN', { exact: true }).fill('209468');
    await page.getByRole('button', { name: '保存新 PIN', exact: true }).click();
    await expect(page.locator('#message')).toContainText('PIN 已保存');
    await expect(page.locator('.novel-access-details')).not.toHaveAttribute('open');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('登录 PIN', { exact: true }).fill('209468');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('.novel-native-frame').waitFor({ timeout: 45000 });
    assert.equal(modelRequests, 0);
    return { pinLoginAndChange: true, commonAccountUi: true, modelRequests, layouts: [1280, 768, 390, 320] };
  } catch (error) {
    if (page) await page.screenshot({ path: 'test-results/mode-shared-failure.png' }).catch(() => {});
    throw error;
  } finally {
    await context?.close();
    await app?.close();
    assert(root.startsWith(join(tmpdir(), 'novel-shared-ui-')));
    await rm(root, { recursive: true, force: true });
  }
}
