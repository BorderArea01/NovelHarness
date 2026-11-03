// Behavior-inspired, independently implemented. Real native runtime, synthetic model only.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { openChapter, fillEditor, waitEditor } from './editor-client.mjs';
import { parseTaskMessage } from '../pages/public/novel-assets/task-message.mjs';
export async function verifyBorrowedWorkflow({ page, context, origin, book, model, waitFor, root }) {
  const base = origin + '/api/novels/' + book.id + '/';
  const get = async (route) => {
    const response = await context.request.get(base + route);
    assert.equal(response.status(), 200);
    const data = await response.json();
    await response.dispose();
    return data;
  };
  const put = async (path, text, expectedHash) => {
    const response = await context.request.put(base + 'document', { data: { path, text, expectedHash } });
    assert.equal(response.status(), 200);
    const data = await response.json();
    await response.dispose();
    return data;
  };
  const catalog = await get('documents'),
    chapters = catalog.documents.filter((c) => c.category === 'chapter');
  assert.ok(chapters.length >= 2);
  const first = await get('document?path=' + encodeURIComponent(chapters[0].path)),
    second = await get('document?path=' + encodeURIComponent(chapters[1].path));
  const protectedFiles = await Promise.all(
    ['outline.json', 'memory.json', 'canon.json'].map((path) => get('document?path=' + path)),
  );
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await openChapter(page, first.path);
  const guide = page.locator('.novel-chapter-focus');
  assert.equal(await guide.evaluate((node) => node.open), false);
  await guide.locator(':scope > summary').click();
  await page.getByRole('region', { name: '本章目标对照', exact: true }).waitFor();
  assert.ok((await guide.textContent()).includes(first.outline.summary));
  const composer = page.locator('[contenteditable="true"]:not(.cm-content):visible').first(),
    activity = page.getByLabel('当前对话执行状态', { exact: true });
  const coverage = model.register({
    holdFinish: true,
    finalText: '合成剧情覆盖审阅：已核对原文；未读取的范围保持待确认。',
    prepare(prompt, self) {
      assert.equal(parseTaskMessage(prompt).kind, 'review');
      assert.ok(prompt.includes('专项审读：剧情覆盖'));
      assert.ok(prompt.includes(first.hash));
      assert.ok(prompt.includes('关键词重合'));
      self.steps = [
        { name: 'read', input: { file_path: book.root + '/' + first.path }, expected: '邮差' },
        { name: 'read', input: { file_path: book.root + '/outline.json' }, expected: 'plotPoints' },
        { name: 'read', input: { file_path: book.root + '/memory.json' }, expected: 'chapterMemories' },
      ];
    },
  });
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await composer.fill(coverage.marker);
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await guide.getByRole('button', { name: '核对剧情覆盖', exact: true }).click();
  await waitFor(
    () => coverage.completedSteps === 3 && coverage.holds.length > 0,
    'native evidence-based coverage review',
  );
  await activity.filter({ hasText: 'AI 执行中' }).waitFor();
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  assert.equal(coverage.holds[0].closed, false, 'Browsing must not interrupt the native review stream.');
  model.release(coverage);
  await activity.filter({ hasText: 'AI 已结束' }).waitFor();
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await openChapter(page, second.path);
  const continuity = model.register({
    finalText: '合成前后矛盾审阅：对照已读正文，不以记忆或评分代替证据。',
    prepare(prompt, self) {
      assert.ok(prompt.includes('专项审读：前后矛盾'));
      assert.ok(prompt.includes(second.hash));
      assert.ok(prompt.includes('待确认'));
      self.steps = [
        { name: 'read', input: { file_path: book.root + '/' + first.path }, expected: '邮差' },
        { name: 'read', input: { file_path: book.root + '/' + second.path }, expected: '登记簿' },
      ];
    },
  });
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await composer.fill(continuity.marker);
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await page.getByText('更多写作', { exact: true }).click();
  await page.getByRole('button', { name: '检查前后矛盾', exact: true }).click();
  await waitFor(() => continuity.completedSteps === 2, 'native continuity review reads both formal sources');
  await activity.filter({ hasText: 'AI 已结束' }).waitFor();
  for (const doc of [first, second, ...protectedFiles])
    assert.equal((await get('document?path=' + encodeURIComponent(doc.path))).hash, doc.hash);
  assert.equal(
    (await get('documents')).proposals.length,
    catalog.proposals.length,
    'Read-only reviews create no shadow proposals or automatic memory writes.',
  );
  // An unaccepted candidate is intentionally NOT part of the reading edition.
  const proposed = await context.request.post(base + 'proposals', {
    data: { path: first.path, expectedHash: first.hash },
  });
  assert.equal(proposed.status(), 200);
  const proposal = await proposed.json();
  await proposed.dispose();
  const draft = await get('document?path=' + encodeURIComponent(proposal.draft));
  const excluded = '未接受候选绝对不应出现在成稿里。';
  await put(draft.path, excluded, draft.hash);
  const literal =
    '\n<script>globalThis.__readingXss=true</script>\n<img src="https://example.invalid/x" onerror="globalThis.__readingXss=true">\n【PP1】是作者原文。';
  const withLiteral = await put(first.path, first.text + literal, first.hash);
  await openChapter(page, first.path);
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), withLiteral.text);
  const exporter = page.locator('.novel-reading-export');
  await exporter.locator(':scope > summary').click();
  const downloads = [];
  page.on('download', (file) => downloads.push(file));
  let html = '';
  for (const format of ['txt', 'markdown', 'html']) {
    await exporter.getByLabel('成稿格式', { exact: true }).selectOption(format);
    const waiting = page.waitForEvent('download');
    await exporter.getByRole('button', { name: '下载成稿', exact: true }).click();
    const file = await waiting;
    const stream = await file.createReadStream(),
      chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    assert.ok(text.includes('【PP1】是作者原文。'));
    assert.ok(!text.includes(excluded));
    assert.ok(text.includes('邮差'));
    assert.ok(text.includes('登记簿'));
    assert.ok(text.includes('第四章'));
    if (format === 'html') {
      html = text;
      assert.ok(text.includes('&lt;script&gt;'));
      assert.ok(!text.includes('<script>'));
    }
    await exporter.getByRole('status').filter({ hasText: '已导出' }).waitFor();
  }
  assert.equal(downloads.length, 3);
  const reading = await context.newPage(),
    external = [];
  reading.on('request', (r) => {
    if (r.url().startsWith('http')) external.push(r.url());
  });
  await reading.setViewportSize({ width: 390, height: 844 });
  await reading.setContent(html);
  assert.equal(await reading.evaluate(() => globalThis.__readingXss), undefined);
  assert.deepEqual(external, []);
  assert.ok(await reading.getByRole('navigation', { name: '目录', exact: true }).isVisible());
  await reading.getByRole('navigation', { name: '目录', exact: true }).getByRole('link').last().click();
  assert.ok(await reading.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await reading.screenshot({
    path: resolve(root, 'test-results/cloud-reading-edition-mobile.png'),
    fullPage: true,
  });
  await reading.close();
  // The export stays inside the same manuscript header and never blocks browsing.
  for (const [width, height, name] of [
    [1280, 900, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await exporter.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await exporter.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-chapter-focus-export-' + name + '.png'),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await fillEditor(editor, withLiteral.text + '\n尚未保存的想法。');
  await waitFor(
    () => exporter.getByRole('button', { name: '下载成稿', exact: true }).isDisabled(),
    'unsaved draft blocks omission-prone export',
  );
  await fillEditor(editor, withLiteral.text);
  let release,
    observed = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const routePattern = '**/api/workspace/file?*';
  const handler = async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path?.startsWith(book.root + '/chapters/')) {
      observed = true;
      await gate;
    }
    await route.continue().catch((error) => {
      if (!observed) throw error;
    });
  };
  await page.route(routePattern, handler);
  try {
    await exporter.getByRole('button', { name: '下载成稿', exact: true }).click();
    await waitFor(() => observed, 'owned delayed export file read');
    await page.getByRole('button', { name: '大纲', exact: true }).click();
    await exporter.getByRole('button', { name: '取消导出', exact: true }).click();
    await exporter.getByRole('status').filter({ hasText: '已取消' }).waitFor();
  } finally {
    release();
    await page.unroute(routePattern, handler);
  }
  assert.equal(downloads.length, 3, 'Cancelling must not download a stale file.');
  assert.equal((await get('document?path=' + encodeURIComponent(first.path))).hash, withLiteral.hash);
  console.log(
    'Behavior-inspired workflow passed: real native read-only coverage/continuity tool streams, full chapter guide, no automatic progress/memory writes, TXT/Markdown/HTML reading downloads, formal-only sources, literal text preservation, safe standalone HTML/toc/mobile, dirty-draft refusal, cancellation and browsing, 1280/768/390 layouts. No paid model calls.',
  );
}
