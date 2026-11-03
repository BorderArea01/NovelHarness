import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyMessageActions } from './message-actions-scenario.mjs';

// Exercise the original native Markdown renderer through the real local Agent.
// Synthetic content only; no alternative transcript, provider or production data.
export async function verifyConversationReading({ page, model, waitFor, root }) {
  if (await page.getByRole('button', { name: '创作助手', exact: true }).isVisible())
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const identifier = '钟楼线索_' + 'FutureLetter'.repeat(14);
  const finalText = [
    '## 钟楼来信的三个方向',
    '沈澄把铜钥匙放在掌心。'.repeat(40),
    `线索代号：\`${identifier}\`。这一段的末尾仍然可以读到。`,
    `[完整线索链接${'LongReference'.repeat(16)}](https://example.com/story)`,
    '| 人物 | 想要什么 | 隐瞒什么 | 转折 | 结局 |',
    '| --- | --- | --- | --- | --- |',
    `| 沈澄 | 找回姐姐 | ${identifier} | 拒绝来信 | 守住钟楼 |`,
    `| 姐姐 | ${'不让过去重演'.repeat(12)} | 铜钥匙 | 交还选择 | 重新相见 |`,
    '```text',
    '完整长行_' + 'ClockTower'.repeat(35) + '_行尾可达',
    '```',
    '阅读检查结束，原始回复完整保留。',
  ]
    .join('\n\n')
    .replaceAll('\n\n|', '\n|');
  const task = model.register({ finalText });
  const input = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  await input.fill(task.marker);
  await input.press('Enter');
  await page.getByText('阅读检查结束，原始回复完整保留。', { exact: true }).waitFor();
  await waitFor(() => task.bodies.length > 0, 'original Agent rendered synthetic reading sample');
  const metrics = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    for (const width of [320, 390, 768, 1280, 1600]) {
      await page.setViewportSize({ width, height: 844 });
      await page.mouse.move(0, 0);
      const assistant = page.locator('.novel-desk-assistant');
      const table = assistant.locator('table').last();
      await table.waitFor();
      await table.scrollIntoViewIfNeeded();
      const measurement = await table.evaluate((table) => {
        const host = table.closest('.novel-desk-assistant');
        const bounds = host.getBoundingClientRect();
        const ancestors = [];
        for (let node = table; node && node !== host; node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const css = getComputedStyle(node);
          const previous = node.scrollLeft;
          node.scrollLeft = node.scrollWidth;
          const end = node.scrollLeft;
          node.scrollLeft = previous;
          ancestors.push({
            tag: node.tagName,
            class: node.className,
            left: r.left,
            right: r.right,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            end,
            overflowX: css.overflowX,
          });
        }
        const rows = [table, ...host.querySelectorAll('pre, p, h2')].map((node) => {
          const r = node.getBoundingClientRect();
          return {
            tag: node.tagName,
            left: r.left,
            right: r.right,
            width: r.width,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            overflowX: getComputedStyle(node).overflowX,
          };
        });
        return {
          width: innerWidth,
          host: { left: bounds.left, right: bounds.right },
          rootWidth: document.documentElement.scrollWidth,
          rows,
          ancestors,
        };
      });
      metrics.push(measurement);
      if (width === 390) {
        const wrapper = table.locator('..');
        await wrapper.evaluate((el) => {
          el.scrollLeft = 0;
        });
        await wrapper.focus();
        await page.keyboard.press('ArrowRight');
        await waitFor(() => wrapper.evaluate((el) => el.scrollLeft > 0), 'original table keyboard scrolling');
      }
      if (width === 320) {
        const wrapper = table.locator('..');
        const bounds = await wrapper.boundingBox();
        const scroll = await page.locator('[data-conversation-scroll]').boundingBox();
        const dock = await page.locator('.novel-author-dock').boundingBox();
        const start = Math.max(bounds.y, scroll.y);
        const end = Math.min(bounds.y + bounds.height, scroll.y + scroll.height, dock.y);
        assert.ok(end - start >= 44, 'A real visible table area is available for the swipe');
        const y = (start + end) / 2;
        const x = bounds.x + bounds.width - 24;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let distance = 20; distance <= 160; distance += 20) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x - distance, y }],
          });
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        measurement.touchScrollLeft = await wrapper.evaluate((el) => el.scrollLeft);
        await wrapper.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        await table.locator('th').last().scrollIntoViewIfNeeded();
        measurement.lastColumn = await table
          .locator('th')
          .last()
          .evaluate((el) => {
            const r = el.getBoundingClientRect(),
              p = el.closest('.md-table-wide').getBoundingClientRect();
            return {
              text: el.textContent,
              left: r.left,
              right: r.right,
              ownerLeft: p.left,
              ownerRight: p.right,
            };
          });
      }
      await page.screenshot({ path: resolve(root, `test-results/cloud-reply-reading-${width}.png`) });
    }
    await writeFile(resolve(root, 'test-results/cloud-reply-reading.json'), JSON.stringify(metrics, null, 2));
    assert.ok(
      metrics[0].touchScrollLeft > 40,
      'A touch swipe, not hover or a script, must scroll the wide table',
    );
    assert.equal(metrics[0].lastColumn.text, '结局');
    assert.ok(
      metrics[0].lastColumn.left >= metrics[0].lastColumn.ownerLeft - 1 &&
        metrics[0].lastColumn.right <= metrics[0].lastColumn.ownerRight + 1,
      'The final column is actually readable',
    );
    assert.equal(
      await page
        .locator('.novel-desk-assistant p')
        .filter({ hasText: '沈澄把铜钥匙放在掌心。' })
        .last()
        .textContent(),
      '沈澄把铜钥匙放在掌心。'.repeat(40),
      'Resizing and scrolling never replace or truncate the original prose',
    );
    const reply = page.locator('.novel-desk-assistant');
    assert.ok(
      (await reply.locator('pre').last().textContent()).includes(
        '完整长行_' + 'ClockTower'.repeat(35) + '_行尾可达',
      ),
    );
    assert.equal(
      await reply.locator('a[href="https://example.com/story"]').last().textContent(),
      '完整线索链接' + 'LongReference'.repeat(16),
    );
    assert.equal(await reply.locator('p code').last().textContent(), identifier);
    for (const m of metrics) {
      assert.ok(m.rootWidth <= m.width + 1, 'Reply must not widen the page');
      for (const row of m.rows.filter((r) => r.tag !== 'TABLE' && r.width > 0))
        assert.ok(
          row.left >= m.host.left - 1 && row.right <= m.host.right + 1,
          `${m.width}px: ${row.tag} extends beyond the assistant (${row.width}px)`,
        );
      assert.ok(
        m.ancestors.some(
          (a) =>
            a.end > 0 && a.left >= m.host.left && a.right <= m.host.right && /auto|scroll/.test(a.overflowX),
        ),
        `${m.width}px: wide table must have a reachable horizontal scroll owner inside the assistant`,
      );
    }
    await verifyMessageActions({ page, root, finalText, authorText: task.marker, waitFor, cdp });
    console.log(
      'Native reply reading passed: 320/390/768/1280/1600px, original Markdown prose/links/code retained; wide-table CDP touch swipe reaches the last column and original keyboard scrolling works. Browser simulation only, no physical phone or paid model call.',
    );
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
    await page.setViewportSize({ width: 1280, height: 844 });
  }
}
