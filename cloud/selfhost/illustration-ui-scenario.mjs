import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { readEditor, selectEditor, waitEditor, waitResponsiveLayout } from '../tests/editor-client.mjs';

export async function verifyIllustrationUi({ page, context, origin, book, editor, prose }) {
  await selectEditor(editor, prose.indexOf('渡船靠岸时'), prose.indexOf('渡船靠岸时'));
  await page.getByRole('button', { name: '▧ 插图', exact: true }).click();
  await page.getByRole('textbox', { name: '新插图图注', exact: true }).fill('雨港插图');
  const landscape = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 360);
    sky.addColorStop(0, '#39486b');
    sky.addColorStop(0.58, '#d8b0a2');
    sky.addColorStop(1, '#4d718a');
    g.fillStyle = sky;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#f4d4a8';
    g.beginPath();
    g.arc(445, 130, 33, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#384957';
    g.beginPath();
    g.moveTo(0, 235);
    g.lineTo(100, 170);
    g.lineTo(235, 228);
    g.lineTo(330, 190);
    g.lineTo(640, 245);
    g.lineTo(640, 265);
    g.lineTo(0, 265);
    g.fill();
    g.fillStyle = '#334957';
    g.fillRect(0, 265, 640, 95);
    g.strokeStyle = '#9fabad';
    g.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      g.beginPath();
      g.moveTo(70 + i * 13, 270 + i * 7);
      g.lineTo(560 - i * 17, 270 + i * 7);
      g.stroke();
    }
    g.fillStyle = '#192a39';
    g.fillRect(110, 220, 9, 100);
    g.fillRect(200, 226, 8, 94);
    g.fillRect(70, 236, 200, 10);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('上传章节插图', { exact: true }).setInputFiles({
    name: 'harbor.png',
    mimeType: 'image/png',
    buffer: Buffer.from(landscape, 'base64'),
  });
  const image = page.locator('.novel-illustration img');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveJSProperty('naturalWidth', 640);
  const inserted = await readEditor(editor);
  assert(inserted.includes('![雨港插图](illustrations/'));
  assert.equal(inserted.replace(/\n\n!\[雨港插图\]\(illustrations\/[a-f0-9]{64}\.json\)/, ''), prose);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await waitResponsiveLayout(page);
    const box = await image.boundingBox();
    assert(box && box.height <= (width > 600 ? 140 : 104) + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'test-results/illustrations-' + width + '.png' });
  }
  await page.getByRole('button', { name: '放大插图：雨港插图', exact: true }).click();
  await expect(page.locator('dialog.novel-illustration-lightbox')).toBeVisible();
  await page.getByRole('button', { name: '关闭大图', exact: true }).click();
  await page.getByRole('button', { name: '收起插图', exact: true }).click();
  await expect(image).not.toBeVisible();
  await page.getByRole('button', { name: '展开插图', exact: true }).click();
  await expect(image).toBeVisible();
  await page.locator('.novel-illustration-actions > summary').click();
  await page.getByRole('button', { name: '图注', exact: true }).click();
  await page.getByRole('textbox', { name: '插图图注', exact: true }).fill('雨港新图注');
  await page.getByRole('button', { name: '完成图注', exact: true }).click();
  await expect(page.getByRole('button', { name: '放大插图：雨港新图注', exact: true })).toBeVisible();
  await page.locator('.novel-illustration-actions > summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '更换', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: Buffer.from(landscape, 'base64') });
  await expect
    .poll(() => readEditor(editor))
    .not.toContain(inserted.split('](illustrations/')[1].split(')')[0]);
  const replaced = await readEditor(editor);
  await expect(page.locator('.novel-illustration img')).toHaveJSProperty('naturalWidth', 640);
  await editor.press('ControlOrMeta+s');
  const api = origin + '/api/novels/' + book.id;
  await expect
    .poll(
      async () => (await (await context.request.get(api + '/document?path=chapters/00001.md')).json()).text,
    )
    .toContain('![雨港新图注]');
  await page.reload();
  await waitEditor(editor, replaced);
  await expect(page.locator('.novel-illustration img')).toHaveJSProperty('naturalWidth', 640);
  await page.locator('.novel-illustration-actions > summary').click();
  await page.getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.locator('.novel-illustration')).toHaveCount(0);
  const removed = await readEditor(editor);
  assert.equal(removed, replaced.replace(/!\[雨港新图注\]\(illustrations\/[a-f0-9]{64}\.json\)/, ''));
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  await expect(page.locator('.novel-illustration')).toHaveCount(1);
  // Restore the synthetic chapter so the rest of the writing regression uses
  // its original fixture. The enclosing browser harness deletes its whole store.
  const { fillEditor } = await import('../tests/editor-client.mjs');
  await fillEditor(editor, prose);
  await editor.press('ControlOrMeta+s');
  await expect
    .poll(
      async () => (await (await context.request.get(api + '/document?path=chapters/00001.md')).json()).text,
    )
    .toBe(prose);
  await page.setViewportSize({ width: 1280, height: 900 });
}
