import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { waitResponsiveLayout } from './editor-client.mjs';

// Exercise the original native settings controls inside our navigation slot.
// Geometry only: safe to reuse against the live UI without reading story text.
export async function collapsedSidebarGeometry(page) {
  return page.locator('.novel-studio-sidebar').evaluate((sidebar) => {
    const box = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      rail: box(sidebar),
      scrollWidth: sidebar.scrollWidth,
      clientWidth: sidebar.clientWidth,
      controls: [...sidebar.querySelectorAll('button, a')]
        .filter((node) => node.getClientRects().length)
        .map((node) => ({
          label: node.getAttribute('aria-label') || node.title || node.textContent.trim(),
          ...box(node),
        })),
    };
  });
}

export function assertCollapsedSidebar(geometry) {
  const { rail, controls } = geometry;
  assert.equal(controls.length, 7, 'Brand, toggle, library, manuscript, models, settings and account.');
  assert.ok(geometry.scrollWidth <= geometry.clientWidth, 'No horizontal rail overflow.');
  for (const control of controls) {
    assert.equal(control.width, 44, control.label + ': consistent 44px width.');
    assert.equal(control.height, 44, control.label + ': consistent 44px height.');
    assert.ok(Math.abs(control.x + 22 - (rail.x + rail.width / 2)) <= 1, control.label + ': centered.');
    assert.ok(control.x >= rail.x && control.x + 44 <= rail.x + rail.width, control.label + ': inside rail.');
    assert.ok(control.y >= rail.y && control.y + 44 <= rail.y + rail.height, control.label + ': visible.');
  }
  const ordered = [...controls].sort((a, b) => a.y - b.y);
  for (let i = 1; i < ordered.length; i++)
    assert.ok(ordered[i].y - ordered[i - 1].y >= 50, 'Controls have at least 6px clearance.');
}

export async function verifySidebarLayout(page) {
  const sidebar = page.locator('.novel-studio-sidebar');
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1024, height: 600 },
    { width: 1280, height: 480 },
  ]) {
    await page.setViewportSize(size);
    await waitResponsiveLayout(page);
    if ((await sidebar.getAttribute('data-wide')) === 'true')
      await sidebar.getByRole('button', { name: '收起导航', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.novel-studio-sidebar')?.dataset.wide === 'false');
    const geometry = await collapsedSidebarGeometry(page);
    if (size.width === 1440) {
      await page.screenshot({ path: resolve('test-results/sidebar-collapsed-desktop.png') });
      console.log('Collapsed sidebar geometry: ' + JSON.stringify(geometry));
    }
    assertCollapsedSidebar(geometry);
    await sidebar.getByRole('button', { name: '展开导航', exact: true }).click();
    await sidebar.getByRole('link', { name: '小说库', exact: true }).filter({ hasText: '我的书库' }).waitFor();
  }
  // Settings still use their native dialogs, not styled replacement controls.
  await sidebar.getByRole('button', { name: '收起导航', exact: true }).click();
  for (const name of ['模型设置', '设置']) {
    await sidebar.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await sidebar.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await waitResponsiveLayout(page);
  if (!(await sidebar.isVisible())) await page.getByRole('button', { name: '展开导航', exact: true }).click();
  assert.equal(await sidebar.getAttribute('data-wide'), 'true');
  const center = await page.locator('.novel-native-center-column').boundingBox();
  assert.equal(center.width, 390, 'Mobile navigation overlays the page without squeezing it.');
  await page.screenshot({ path: resolve('test-results/sidebar-mobile-drawer.png') });
  await page.locator('.novel-navigation-scrim').click({ position: { x: 10, y: 200 } });
  assert.equal(await sidebar.isVisible(), false, 'Tap outside dismisses the mobile drawer.');
  await page.setViewportSize({ width: 1280, height: 900 });
  await waitResponsiveLayout(page);
  if ((await sidebar.getAttribute('data-wide')) === 'false')
    await sidebar.getByRole('button', { name: '展开导航', exact: true }).click();
}
