import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Original native message chrome, not an alternative toolbar or transcript.
// Intercept only the LOCAL fixture's clipboard transport: never overwrite the
// user's real system clipboard. All buttons and copy callbacks stay native.
export async function verifyMessageActions({ page, root, finalText, authorText, waitFor, cdp }) {
  const samples = [];
  const native = page.locator('.novel-desk-assistant');
  for (const [width, height] of [
    [320, 844],
    [390, 844],
    [768, 844],
    [1280, 844],
    [320, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await native.locator('[data-conversation-scroll]').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    for (const [kind, owner] of [
      ['assistant', native.locator('[data-turn-tail]').last()],
      ['author', native.locator('[data-chat-flow-kind="user"]').last()],
    ]) {
      const copy = owner.getByRole('button', { name: '复制', exact: true });
      await copy.waitFor();
      await copy.scrollIntoViewIfNeeded();
      const sample = await owner.locator('[data-clock]').evaluate((el) => {
        const host = el.closest('.novel-desk-assistant').getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')].map((button) => {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            label: button.getAttribute('aria-label'),
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
            hit: !!hit && (hit === button || button.contains(hit)),
          };
        });
        return {
          width: innerWidth,
          height: innerHeight,
          host: { left: host.left, right: host.right },
          buttons,
        };
      });
      samples.push({ kind, ...sample });
      await page.screenshot({
        path: resolve(root, `test-results/cloud-message-actions-${width}-${height}-${kind}.png`),
      });
    }
  }
  await writeFile(resolve(root, 'test-results/cloud-message-actions.json'), JSON.stringify(samples, null, 2));
  for (const sample of samples) {
    assert.ok(sample.buttons.length > 0, 'The original message actions really mounted');
    for (const button of sample.buttons) {
      const label = `${sample.width}x${sample.height} ${sample.kind} ${button.label}`;
      assert.ok(
        button.left >= sample.host.left && button.right <= sample.host.right,
        label + ' is outside the assistant',
      );
      assert.ok(button.hit, label + ' is obscured');
      if (sample.width < 1024)
        assert.ok(
          button.width >= 44 && button.height >= 44,
          label + ` has a small ${button.width}x${button.height} touch target`,
        );
      else assert.equal(button.height, 28, 'Desktop message controls retain their original size');
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  const draft = '复制前的未发送灵感，不能因为复制而丢失或发送。';
  await input.fill(draft);
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    window.__fixtureClipboard = {
      previous: Object.getOwnPropertyDescriptor(clipboard, 'writeText'),
      values: [],
    };
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value: async (text) => {
        window.__fixtureClipboard.values.push(text);
      },
    });
  });
  try {
    for (const [index, owner, text] of [
      [0, native.locator('[data-turn-tail]').last(), finalText],
      [1, native.locator('[data-chat-flow-kind="user"]').last(), authorText],
    ]) {
      const copy = owner.getByRole('button', { name: '复制', exact: true });
      await copy.scrollIntoViewIfNeeded();
      const r = await copy.boundingBox();
      const touchPoints = [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor(
        () => page.evaluate((count) => window.__fixtureClipboard.values.length === count, index + 1),
        'original copy callback after a touch tap',
      );
      assert.equal(await page.evaluate((index) => window.__fixtureClipboard.values[index], index), text);
      await owner.getByRole('button', { name: '复制成功', exact: true }).waitFor();
      assert.equal(
        await input.textContent(),
        draft,
        'Copy neither submits nor replaces the native author draft',
      );
    }
  } finally {
    await page.evaluate(() => {
      const { previous } = window.__fixtureClipboard;
      if (previous) Object.defineProperty(navigator.clipboard, 'writeText', previous);
      else delete navigator.clipboard.writeText;
      delete window.__fixtureClipboard;
    });
  }
  console.log(
    'Native message actions passed: assistant and author controls at 320/390/768 and 320px short height, 44px targets with hit tests, unchanged 1280px controls; CDP touch copies exact complete Markdown and author text, native acknowledgement and unsent draft preserved. Clipboard transport intercepted, no OS clipboard/paid provider/production writes; not a physical phone.',
  );
}
