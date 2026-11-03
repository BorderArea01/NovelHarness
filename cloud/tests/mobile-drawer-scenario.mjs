import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clickSidebarEntry } from './editor-client.mjs';
import { verifySettingsViewport } from './settings-viewport-scenario.mjs';

// Layout/focus evidence over the actual native frame and a localhost fixture.
// No model submission, account change, or formal document mutation.
export async function verifyMobileDrawer({ page, context, origin, root, waitFor }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const bookId = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.novel-native-frame[data-novel-narrow][data-sidebar-collapsed]').waitFor();
  const geometry = () =>
    page.evaluate(() => {
      const center = document.querySelector('.novel-native-center-column').getBoundingClientRect();
      return { viewport: innerWidth, centerWidth: center.width, centerLeft: center.left };
    });
  const baseline = await geometry();
  if (baseline.centerWidth < baseline.viewport - 1) {
    await writeFile(
      resolve(root, 'test-results/cloud-mobile-shell-before.json'),
      JSON.stringify(baseline, null, 2),
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-shell-before.png'),
      fullPage: true,
    });
  }
  assert.ok(
    baseline.centerWidth >= baseline.viewport - 1,
    'Collapsed phone navigation must release its rail: ' + JSON.stringify(baseline),
  );
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  const unsent = '菜单验证：这是尚未发送的灵感。';
  await composer.fill(unsent);
  const inputNode = await composer.elementHandle();
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  const editorNode = await editor.elementHandle();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.novel-native-frame:not([data-novel-narrow])').waitFor();
  const desktopWidth = (await page.locator('.novel-native-sidebar-column').boundingBox()).width;
  const results = [];
  for (const width of [320, 390, 600, 601, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.novel-native-frame[data-novel-narrow][data-sidebar-collapsed]').waitFor();
    const compact = width <= 600;
    await page
      .locator(
        compact ? '.novel-native-frame[data-novel-compact]' : '.novel-native-frame:not([data-novel-compact])',
      )
      .waitFor();
    const before = await geometry();
    if (compact) {
      assert.ok(Math.abs(before.centerLeft) < 1 && Math.abs(before.centerWidth - width) < 1);
      const tabs = await page
        .locator('.novel-ms-tabs button')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
      assert.ok(
        tabs.every((right) => right <= width + 1),
        'Every writing tab is reachable without a clipped last label.',
      );
    }
    const launcher = page.getByRole('button', { name: '展开导航', exact: true });
    const launchBox = await launcher.boundingBox();
    assert.ok(launchBox.width >= 44 && launchBox.height >= 44);
    const add = await page.getByRole('button', { name: '＋ 新章', exact: true }).boundingBox();
    await launcher.click();
    const dialog = page.getByRole('dialog', { name: '导航菜单', exact: true });
    await dialog.waitFor();
    const after = await geometry();
    assert.ok(
      Math.abs(before.centerWidth - after.centerWidth) < 1 &&
        Math.abs(before.centerLeft - after.centerLeft) < 1,
    );
    assert.equal(await page.locator('.novel-native-center-column').evaluate((node) => node.inert), true);
    assert.ok(await dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement)));
    if (width === 390)
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-mobile-shell-drawer.png'),
        fullPage: true,
      });
    const count = await dialog.locator('button,a[href]').count();
    for (let i = 0; i < count + 2; i++) {
      await page.keyboard.press('Tab');
      assert.ok(
        await dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement)),
        'Tab must not escape the open drawer.',
      );
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.novel-native-center-column').evaluate((node) => node.inert), false);
    assert.equal(await launcher.evaluate((node) => node === node.ownerDocument.activeElement), true);
    assert.equal(await editor.evaluate((node, original) => node === original, editorNode), true);
    assert.equal(await composer.evaluate((node, original) => node === original, inputNode), true);
    assert.equal(await composer.textContent(), unsent);
    await launcher.click();
    const scrim = page.getByRole('button', { name: '关闭导航', exact: true });
    await scrim.waitFor();
    const box = await scrim.boundingBox();
    const x = add.x + add.width / 2 >= box.x ? add.x + add.width / 2 : box.x + box.width / 2;
    const touch = await context.newCDPSession(page);
    try {
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: add.y + add.height / 2 }],
      });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await touch.detach();
    }
    await scrim.waitFor({ state: 'hidden' });
    await page.waitForTimeout(350); // Allow the browser's touch-to-click sequence to settle.
    assert.equal(
      await page.locator('.novel-ms-new').count(),
      0,
      'Outside tap closes the drawer without activating the new-chapter button underneath.',
    );
    results.push({ ...before, compact, overlayDidNotSqueeze: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitFor(
    () =>
      page
        .locator('.novel-native-frame[data-novel-narrow]')
        .count()
        .then((n) => !n),
    'desktop native layout restored',
  );
  assert.equal((await page.locator('.novel-native-sidebar-column').boundingBox()).width, desktopWidth);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await page.getByRole('dialog', { name: '导航菜单', exact: true }).waitFor({ state: 'hidden' });
  // A keyboard/landscape-sized viewport must not reopen a scrolled drawer
  // with its close control above the visible frame.
  await page.setViewportSize({ width: 390, height: 240 });
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.getByRole('dialog', { name: '导航菜单', exact: true }).waitFor();
  await page.locator('.novel-studio-sidebar').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  const closeBox = await page.getByRole('button', { name: '收起导航', exact: true }).boundingBox();
  assert.ok(
    closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= 240,
    'Reopened short drawer must show its close control: ' + JSON.stringify(closeBox),
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await clickSidebarEntry(page, 'button', '设置');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.waitFor();
  assert.equal(await page.getByRole('dialog', { name: '导航菜单', exact: true }).count(), 0);
  assert.ok(
    await settings.evaluate((node) => node.contains(node.ownerDocument.activeElement)),
    'Native settings keep their own focus.',
  );
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  await clickSidebarEntry(page, 'link', '账号与 PIN');
  await page.getByRole('heading', { name: '登录 PIN', exact: true }).waitFor();
  const h1 = await page.locator('.novel-account h1').boundingBox();
  const menu = await page.getByRole('button', { name: '展开导航', exact: true }).boundingBox();
  assert.ok(h1.x >= menu.x + menu.width, 'Account heading is not covered by the global launcher.');
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.locator('.novel-studio-brand').click();
  await page.getByRole('dialog', { name: '导航菜单', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('#new-book').waitFor();
  assert.ok((await page.locator('.novel-library h1').boundingBox()).x >= menu.x + menu.width);
  await page
    .locator('.book[data-book-id=' + JSON.stringify(bookId) + ']')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id=' + JSON.stringify(bookId) + ']').waitFor();
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.textContent(), unsent);
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await editor.waitFor();
  await page.locator('.novel-ms-tabs[aria-busy="false"]').waitFor();
  await page.screenshot({ path: resolve(root, 'test-results/cloud-mobile-shell-after.png'), fullPage: true });
  await writeFile(
    resolve(root, 'test-results/cloud-mobile-shell-after.json'),
    JSON.stringify(results, null, 2),
  );
  const settingsEditor = await editor.elementHandle(),
    settingsComposer = await composer.elementHandle();
  await verifySettingsViewport({ page, origin, root });
  assert.equal(await editor.evaluate((node, previous) => node === previous, settingsEditor), true);
  assert.equal(await composer.evaluate((node, previous) => node === previous, settingsComposer), true);
  assert.equal(await composer.textContent(), unsent);
  await settingsEditor.dispose();
  await settingsComposer.dispose();
  await inputNode.dispose();
  await editorNode.dispose();
  // A real navigation, not a click followed by an assertion on an absent
  // query string. The original session must recover its unsent input too.
  await page.goto(origin + '/?settings=models');
  const linkedModels = page.getByRole('dialog', { name: '设置', exact: true });
  await linkedModels.waitFor();
  assert.equal(
    await linkedModels.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
    'true',
  );
  await page.waitForURL((url) => !url.searchParams.has('settings'));
  await linkedModels.getByRole('button', { name: '关闭', exact: true }).click();
  await linkedModels.waitFor({ state: 'hidden' });
  await composer.waitFor();
  assert.equal(await composer.textContent(), unsent);
  await clickSidebarEntry(page, 'link', '小说库');
  await page.locator('#new-book').waitFor();
  await page.goto(origin + '/?settings=models');
  await linkedModels.waitFor();
  assert.equal(
    await linkedModels.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
    'true',
  );
  await linkedModels.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('#new-book').waitFor();
  await page
    .locator('.book[data-book-id=' + JSON.stringify(bookId) + ']')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.textContent(), unsent);
  console.log(
    'Native mobile shell passed: full phone width, all writing tabs, original overlay owner, real browser touch outside dismissal, inert background/Tab containment/Escape focus return, unchanged editor/composer DOM and draft, desktop preference restored; model entry and real deep-link reload use the same native section with unsent input retained. No model or production writes; not a physical phone.',
  );
}
