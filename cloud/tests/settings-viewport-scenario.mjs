import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clickSidebarEntry } from './editor-client.mjs';
import { visibleViewportFixture } from './visible-viewport-fixture.mjs';

// Original body-portaled settings, isolated localhost account only. This does
// not submit a model request or change provider/PIN settings.
export async function verifySettingsViewport({ page, origin, root }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const { visibleViewport, restoreViewport } = visibleViewportFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // This assertion must observe an unwanted onboarding dialog, not let the
  // fixture's normal first-run dismissal handler conceal the wrong entry.
  const later = page.getByRole('button', { name: '稍后配置', exact: true });
  await page.removeLocatorHandler(later);
  await clickSidebarEntry(page, 'button', '模型设置');
  const opened = page.getByRole('dialog');
  await opened.waitFor();
  if ((await opened.getAttribute('data-shortcut-modal')) !== 'settings')
    await page.screenshot({ path: resolve(root, 'test-results/cloud-model-entry-before.png') });
  assert.equal(
    await opened.getAttribute('data-shortcut-modal'),
    'settings',
    'The model entry opens the existing settings, not a second API-key onboarding dialog.',
  );
  assert.equal(
    await opened.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
    'true',
  );
  await page.screenshot({ path: resolve(root, 'test-results/cloud-model-entry-after.png') });
  await opened.getByRole('button', { name: '关闭', exact: true }).click();
  await opened.waitFor({ state: 'hidden' });
  await page.addLocatorHandler(later, () => later.click());
  await clickSidebarEntry(page, 'button', '设置');
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: '通用设置', exact: true }).getAttribute('aria-current'),
    'true',
    'Closing model settings clears section selection in the ORIGINAL shell store.',
  );
  await dialog.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
  const geometry = (locator) =>
    locator.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
    });
  const settle = () =>
    page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const results = [];
  try {
    await visibleViewport(320, 18);
    await page.waitForFunction(
      () => document.documentElement.style.getPropertyValue('--novel-visible-height') === '320px',
    );
    await settle();
    const initial = await geometry(dialog);
    if (initial.y < 18 || initial.bottom > 338) {
      await writeFile(
        resolve(root, 'test-results/cloud-settings-viewport-before.json'),
        JSON.stringify({ visibleTop: 18, visibleHeight: 320, panel: initial }, null, 2),
      );
      await page.screenshot({ path: resolve(root, 'test-results/cloud-settings-viewport-before.png') });
    }
    assert.ok(
      initial.y >= 18 && initial.bottom <= 338,
      'Native body-portaled settings must fit the visual viewport: ' + JSON.stringify(initial),
    );
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    const options = dialog.locator(':scope > div > div:last-child');
    for (const width of [320, 390, 600, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const height of [320, 240]) {
        await visibleViewport(height, 18);
        await settle();
        const panel = await geometry(dialog),
          button = await geometry(close),
          body = await geometry(options);
        assert.ok(panel.y >= 18 && panel.bottom <= 18 + height);
        assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
        assert.ok(button.width >= 44 && button.height >= 44);
        assert.ok(button.y >= panel.y && button.bottom <= panel.bottom);
        assert.ok(body.height >= 80 && body.bottom <= panel.bottom);
        assert.equal(await dialog.getByRole('navigation').count(), 1);
        if (width <= 600) {
          const title = await geometry(dialog.locator(':scope > nav > div:first-child'));
          assert.ok(Math.abs(title.y + title.height / 2 - button.y - button.height / 2) <= 4);
          const tabs = dialog.locator(':scope > nav > div:last-child');
          await tabs.getByRole('button').last().focus();
          await settle();
          const tabBounds = await tabs
            .getByRole('button')
            .last()
            .evaluate((node) => {
              const rect = node.getBoundingClientRect(),
                bounds = node.parentElement.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                boundsLeft: bounds.left,
                boundsRight: bounds.right,
                scrollLeft: node.parentElement.scrollLeft,
                focused: node === document.activeElement,
              };
            });
          assert.ok(
            tabBounds.left >= tabBounds.boundsLeft - 1 && tabBounds.right <= tabBounds.boundsRight + 1,
            'Native section navigation remains horizontally reachable: ' + JSON.stringify(tabBounds),
          );
          await tabs.getByRole('button', { name: '模型', exact: true }).click();
        }
        results.push({ width, visibleHeight: height, visibleTop: 18, panel, close: button, body });
      }
    }
    await restoreViewport();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('button', { name: /^编辑 DeepSeek/ }).click();
    await dialog
      .locator('summary')
      .filter({ hasText: /^自定义设置$/ })
      .click();
    const field = dialog.getByRole('textbox', { name: 'API 地址', exact: true });
    const draft = 'https://example.invalid/mobile-unsaved';
    await field.fill(draft);
    const original = await field.elementHandle();
    await visibleViewport(320, 18);
    await settle();
    const bounds = await geometry(options),
      focused = await geometry(field);
    assert.ok(
      focused.y >= bounds.y && focused.bottom <= bounds.bottom,
      'Already focused native field must remain inside its own options scroller: ' +
        JSON.stringify({ field: focused, body: bounds }),
    );
    assert.equal(await field.evaluate((node, previous) => node === previous, original), true);
    assert.equal(await field.inputValue(), draft);
    await page.screenshot({ path: resolve(root, 'test-results/cloud-settings-viewport-after.png') });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await original.dispose();
    await restoreViewport();
    await settle();
    await page.screenshot({ path: resolve(root, 'test-results/cloud-settings-mobile-after.png') });
    await writeFile(
      resolve(root, 'test-results/cloud-settings-viewport-after.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(
      'Native settings viewport passed: original body portal and focus owner, visible title/44px close, reachable native section navigation, 320/390/600/768 widths and 240/320 visible heights; focused provider draft retained/cancelled, no save or model request. Visual metrics are simulated, not an OS keyboard.',
    );
  } finally {
    await restoreViewport();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
}
