// Real page/native Agent/tool loop. Local synthetic model ONLY; not a prose-quality test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseTaskMessage } from '../pages/public/novel-assets/task-message.mjs';
import { clickSidebarEntry } from './editor-client.mjs';
const hash = (text) => createHash('sha256').update(text).digest('hex');
export async function verifyWritingRun({ page, context, origin, book, model, waitFor, root }) {
  const liveTitle = '原件与登记簿 · 连写使用当前书名';
  await clickSidebarEntry(page, 'link', '小说库');
  const bookCard = page.locator('.book[data-book-id="' + book.id + '"]');
  await bookCard.getByRole('button', { name: '改名', exact: true }).click();
  await bookCard.getByRole('textbox', { name: '小说新书名', exact: true }).fill(liveTitle);
  await bookCard.getByRole('button', { name: '保存书名', exact: true }).click();
  await bookCard.getByRole('heading', { name: liveTitle, exact: true }).waitFor();
  await bookCard.getByRole('button', { name: '进入创作', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: liveTitle }).waitFor();
  const api = origin + '/api/novels/' + book.id + '/';
  const get = async (route) => {
    const response = await context.request.get(api + route);
    assert.equal(response.status(), 200);
    const data = await response.json();
    await response.dispose();
    return data;
  };
  const post = async (route, data) => {
    const response = await context.request.post(api + route, { data });
    assert.equal(response.status(), 200);
    const result = await response.json();
    await response.dispose();
    return result;
  };
  const extend = async (number) => {
    const outline = await get('document?path=outline.json');
    const value = JSON.parse(outline.text),
      rows = Array.isArray(value) ? value : value.chapters;
    rows.push({
      chapter: number,
      title: '连写验证 ' + number,
      summary: '邮差保留原件，承担不能撤回的后果。',
      plotPoints: ['具体行动', '后果与衔接'],
    });
    const response = await context.request.put(api + 'document', {
      data: { path: 'outline.json', expectedHash: outline.hash, text: JSON.stringify(value) },
    });
    assert.equal(response.status(), 200);
    await response.dispose();
  };
  await extend(3);
  const originalOutline = JSON.parse((await get('document?path=outline.json')).text),
    firstPath = (Array.isArray(originalOutline) ? originalOutline : originalOutline.chapters)[0].chapterPath;
  const existing = await get('document?path=' + encodeURIComponent(firstPath));
  const rulesFile = await get('document?path=rules.json');
  const rules = JSON.parse(rulesFile.text.replace(/^\uFEFF/, ''));
  rules.savedPrompts ??= {};
  rules.savedPrompts.write = '当前作品：{title}\n' + (rules.savedPrompts.write ?? '按本章章纲写完整正文。');
  const savedRules = await context.request.put(origin + '/api/novels/' + book.id + '/document', {
    data: { path: 'rules.json', text: JSON.stringify(rules), expectedHash: rulesFile.hash },
  });
  assert.equal(savedRules.status(), 200);
  await savedRules.dispose();
  const partial = '部分正文：邮差打开登记簿，留下未决的日期。';
  const full2 = partial + '\n他将两封信并排保存，拒绝再把其中一封丢回井中。';
  const full3 = '第三章合成正文：他带着原件走向寄信人的门，准备承担选择的后果。';
  const marker = '执行作者已授权的按纲连写';
  let runId;
  const interrupted = model.register({
    marker,
    holdFinish: true,
    prepare(prompt, self) {
      const meta = parseTaskMessage(prompt);
      assert.equal(meta.kind, 'writing-run');
      runId = meta.runId;
      self.steps = [
        { name: 'novel_run_next', input: { run_id: runId }, expected: liveTitle },
        {
          name: 'novel_run_submit',
          input: { run_id: runId, chapter: 2, expected_hash: hash(''), content: partial, complete: false },
          expected: '"kind":"partial"',
        },
      ];
    },
  });
  const composer = page.locator('[contenteditable="true"]:not(.cm-content):visible').first();
  const assistant = page.getByRole('button', { name: '创作助手', exact: true });
  if (await assistant.isVisible()) await assistant.click();
  await composer.fill('连写合成样本：保留日期、原件与行动后果。');
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await page.getByRole('button', { name: '连写', exact: true }).click();
  const panel = page.getByRole('region', { name: '按纲连写', exact: true });
  await page.getByLabel('连写起始章', { exact: true }).fill('1');
  await page.getByLabel('连写结束章', { exact: true }).fill('3');
  assert.equal(
    await page.getByLabel('连写保存方式', { exact: true }).count(),
    0,
    'New batches use direct saving without another approval mode selector.',
  );
  await page.getByRole('button', { name: '开始按纲连写', exact: true }).click();
  await waitFor(
    () => interrupted.completedSteps === 2 && interrupted.holds.length > 0,
    'partial continuous run saved by native tools',
  );
  await panel.getByText('第 2 章 · 部分草稿 · 可继续', { exact: true }).waitFor();
  const before = await get('writing-run?id=' + runId),
    p2 = before.items.find((m) => m.chapter === 2).proposalId;
  assert.ok((await get('review?id=' + p2)).proposal.promptTemplate.body.includes(liveTitle));
  assert.equal(before.skipped, 1);
  assert.equal(before.generated, 0);
  // Browsing other book views must not cancel native execution or discard progress.
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  await page.getByRole('button', { name: '连写', exact: true }).click();
  await panel.getByRole('button', { name: '停止连写', exact: true }).click();
  await page.getByLabel('当前对话执行状态', { exact: true }).filter({ hasText: 'AI 已停止' }).waitFor();
  model.release(interrupted);
  const requestCount = model.requests.length;
  await page.reload();
  await page.getByRole('button', { name: '连写', exact: true }).click();
  await panel.getByRole('button', { name: /第 1–3 章 · 0\/2/ }).click();
  await panel.getByText('第 2 章 · 部分草稿 · 可继续', { exact: true }).waitFor();
  assert.equal(
    model.requests.length,
    requestCount,
    'Refreshing/reopening checkpoints must not call a model.',
  );
  const resumed = model.register({
    marker,
    prepare(prompt, self) {
      assert.equal(parseTaskMessage(prompt).runId, runId);
      self.steps = [
        { name: 'novel_run_next', input: { run_id: runId }, expected: '"hasText":true' },
        { name: 'read', input: { file_path: book.root + '/drafts/' + p2 + '.md' }, expected: partial },
        {
          name: 'novel_run_submit',
          input: { run_id: runId, chapter: 2, expected_hash: hash(partial), content: full2, complete: true },
        },
        { name: 'novel_run_next', input: { run_id: runId }, expected: '"chapter":3' },
        {
          name: 'read',
          input: { file_path: book.root + '/drafts/' + p2 + '.md' },
          expected: '他将两封信并排保存，拒绝再把其中一封丢回井中。',
        },
        {
          name: 'novel_run_submit',
          input: { run_id: runId, chapter: 3, expected_hash: hash(''), content: full3, complete: true },
        },
        { name: 'novel_run_next', input: { run_id: runId }, expected: '"kind":"completed"' },
      ];
    },
  });
  await panel.getByRole('button', { name: '从检查点继续', exact: true }).click();
  await waitFor(() => resumed.completedSteps === 7, 'same candidate resume and chapter carry');
  await page.getByLabel('当前对话执行状态', { exact: true }).filter({ hasText: 'AI 已结束' }).waitFor();
  await panel.getByText(/本批写作已完成 · 2\/2/).waitFor();
  const completed = await get('writing-run?id=' + runId);
  assert.equal(completed.items[1].proposalId, p2);
  for (const member of completed.items.filter((m) => !m.skipped)) {
    assert.equal(member.published, true);
    assert.equal(
      (await get('document?path=' + encodeURIComponent(member.path))).text,
      '# ' +
        (Array.isArray(originalOutline) ? originalOutline : originalOutline.chapters).find(
          (row) => Number(row.chapter) === member.chapter,
        ).title +
        '\n\n' +
        (member.chapter === 2 ? full2 : full3),
    );
  }
  for (const [width, height, name] of [
    [1280, 900, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await panel.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-native-writing-run-' + name + '.png'),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const member of completed.items.filter((m) => !m.skipped)) {
    await panel.getByText('第 ' + member.chapter + ' 章 · 已保存正文', { exact: true }).waitFor();
  }
  assert.equal((await get('document?path=' + encodeURIComponent(firstPath))).hash, existing.hash);
  await extend(4);
  await panel.getByText('新建连写', { exact: true }).click();
  await page.getByLabel('连写起始章', { exact: true }).fill('3');
  await page.getByLabel('连写结束章', { exact: true }).fill('4');
  assert.equal(await page.getByRole('button', { name: '开始按纲连写', exact: true }).isDisabled(), false);
  const auto = model.register({
    marker,
    prepare(prompt, self) {
      const meta = parseTaskMessage(prompt);
      assert.notEqual(meta.runId, runId);
      self.runId = meta.runId;
      self.steps = [
        { name: 'novel_run_next', input: { run_id: meta.runId }, expected: '"chapter":4' },
        {
          name: 'novel_run_submit',
          input: {
            run_id: meta.runId,
            chapter: 4,
            expected_hash: hash(''),
            content: '第四章：合成模型验证新章保存，不代表文学质量。',
            complete: true,
          },
          expected: '"kind":"committed"',
        },
        { name: 'novel_run_next', input: { run_id: meta.runId }, expected: '"kind":"completed"' },
      ];
    },
  });
  await page.getByRole('button', { name: '开始按纲连写', exact: true }).click();
  await waitFor(() => auto.completedSteps === 3, 'author-selected new-chapter publication');
  await page.getByLabel('当前对话执行状态', { exact: true }).filter({ hasText: 'AI 已结束' }).waitFor();
  await panel.getByText('第 4 章 · 已保存正文', { exact: true }).waitFor();
  const saved = await get('writing-run?id=' + auto.runId);
  assert.equal(saved.skipped, 1);
  assert.equal(saved.publication, 'new-chapters');
  assert.equal((await get('document?path=' + encodeURIComponent(firstPath))).hash, existing.hash);
  await panel.getByText('关闭授权', { exact: true }).click();
  await panel.getByRole('button', { name: '确认关闭连写授权', exact: true }).click();
  await panel.getByText(/授权已关闭/).waitFor();
  const cards = page.locator('.novel-task-card[data-task-kind="writing-run"]');
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  assert.equal(await cards.count(), 3);
  await cards.last().getByRole('button', { name: '执行详情', exact: true }).click();
  await cards.last().getByRole('button', { name: '查看连写进度', exact: true }).click();
  await panel.getByText(/授权已关闭/).waitFor();
  assert.equal((await get('writing-run?id=' + auto.runId)).phase, 'closed');
  console.log(
    'Continuous writing UI/native runtime passed: same conversation, partial stop, refresh without re-send, same-draft resume, causal predecessor, final direct saving without approval, existing prose unchanged, checkpoint navigation, 1280/768/390 layouts. Local synthetic model only.',
  );
}
