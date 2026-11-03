import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createGuidedBook } from './novel-studio-scenario.mjs';
import { waitEditor, openChapterDirectory, clickSidebarEntry } from './editor-client.mjs';

// Actual original conversation -> scoped native tools -> the SAME formal VFS
// and left manuscript. Local synthetic provider only; no paid quality claim.
export async function verifyNovelPipeline({ page, context, origin, model, waitFor, root }) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await clickSidebarEntry(page, 'link', '小说库');
  await createGuidedBook(page, { title: '先纲后文独立测试', seed: '钟楼每天多出一封明天的信。' });
  await page.locator('.novel-ms-heading > strong').filter({ hasText: '先纲后文独立测试' }).waitFor();
  const bookId = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  const base = origin + '/api/novels/' + bookId + '/';
  // A normal native preference may unmount detailed tool rows. The manuscript
  // must still follow the ORIGINAL conversation model, not a row's render.
  await clickSidebarEntry(page, 'button', '设置');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '通用设置', exact: true }).click();
  const detailsRow = settings.getByText('工作步骤展示', { exact: true }).locator('xpath=../..');
  await detailsRow.getByRole('button', { name: '详细', exact: true }).click();
  await page.getByText('简洁', { exact: true }).last().click();
  await detailsRow.getByRole('button', { name: '简洁', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  const get = async (route) => {
    const response = await context.request.get(base + route);
    assert.equal(response.status(), 200);
    const value = await response.json();
    await response.dispose();
    return value;
  };
  const plan = {
    storyPlan: '沈澄为了姐姐留下的真相，以明日的记忆为代价进入钟楼。',
    chapters: [
      {
        chapter: 1,
        title: '明日来信',
        summary: '沈澄用铜钥匙取出明日来信，失去登楼前的一段记忆。',
        plotPoints: ['用铜钥匙开登记匣', '付出失忆代价'],
      },
    ],
  };
  const prose =
    '# 明日来信\n\n铜钥匙抵住锁孔时，沈澄听见钟楼里传来自己的声音。\n\n她取走姐姐的来信，却想不起刚才是谁领她进的门。';
  const previous = ({ task, results, step }) =>
    JSON.parse(results.get('fixture_' + task.id + '_' + (step - 1)).text);
  const task = model.register({
    argumentPreviewAtStep: 5,
    argumentPreviewText: '沈澄听见钟楼里',
    steps: [
      {
        name: 'novel_proposal_prepare',
        input: { mode: 'new-chapter', chapter: 1, instruction: '先大纲后正文，写完第一章。' },
        expected: '"prerequisite":"outline"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          assert.ok(p.authorRequest.includes('先大纲后正文'));
          assert.equal(p.task.kind, 'outline');
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: JSON.stringify(plan),
            complete: true,
          };
        },
        expected: '"published":true',
      },
      {
        name: 'novel_proposal_prepare',
        input: { mode: 'new-chapter', chapter: 1, instruction: '按已收录章纲写完第一章。' },
        expected: '"purpose":"chapter"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          assert.equal(p.prerequisite, null);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: '# 明日来信\n\n铜钥匙抵住锁孔时，沈澄屏住了呼吸。',
            complete: false,
          };
        },
        expected: '"published":false',
      },
      {
        name: 'novel_proposal_inspect',
        input: (scope) => ({ proposal_id: previous(scope).proposalId }),
        expected: '"editable":true',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return { proposal_id: p.proposalId, expected_hash: p.expectedHash, content: prose, complete: true };
        },
        expected: '"published":true',
      },
    ],
    finalText: '新大纲与第一章已入书。',
  });
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  await composer.fill('请根据这点灵感写第一章。' + task.marker);
  await composer.press('Enter');
  await waitFor(
    () => task.holds.some((h) => h.stage === 'tool-arguments'),
    'native ordinary dialogue prepares outline then starts prose',
  );
  const listing = await get('documents');
  assert.equal(JSON.parse((await get('document?path=outline.json')).text).length, 1);
  const chapter = listing.documents.find((d) => d.category === 'chapter');
  assert.ok(chapter);
  assert.ok(
    !(await get('document?path=' + encodeURIComponent(chapter.path))).text.includes('铜钥匙抵住锁孔'),
  );
  const live = page.getByRole('textbox', { name: '书稿流式预览', exact: true });
  await live.waitFor({ state: 'visible' });
  assert.equal(await live.getAttribute('contenteditable'), 'false');
  assert.ok((await live.textContent()).includes(task.argumentPreviewText));
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-pipeline-live-manuscript.png'),
    fullPage: true,
  });
  const callsBeforeReload = model.requests.length;
  await page.reload();
  await live.waitFor({ state: 'visible' });
  assert.ok((await live.textContent()).includes(task.argumentPreviewText));
  assert.equal(
    model.requests.length,
    callsBeforeReload,
    'Reload observes the existing native turn; it must not resend writing.',
  );
  assert.equal(task.holds.at(-1).closed, false);
  const observer = await context.newPage();
  const observerErrors = [];
  observer.on('pageerror', (error) => observerErrors.push(error.message));
  observer.setDefaultTimeout(20000);
  try {
    await observer.addLocatorHandler(observer.getByRole('button', { name: '继续', exact: true }), () =>
      observer.getByRole('button', { name: '继续', exact: true }).click(),
    );
    await observer.goto(origin + '/?novel=' + bookId);
    const remoteLive = observer.getByRole('textbox', { name: '书稿流式预览', exact: true });
    await remoteLive.waitFor({ state: 'visible' });
    assert.ok((await remoteLive.textContent()).includes(task.argumentPreviewText));
    assert.equal(await observer.locator('[data-composer-seat]').count(), 1);
    assert.equal(
      model.requests.length,
      callsBeforeReload,
      'A second browser tab borrows the same native execution; no new model turn.',
    );
    await observer.screenshot({
      path: resolve(root, 'test-results/cloud-pipeline-observer-live.png'),
      fullPage: true,
    });
    assert.deepEqual(observerErrors, []);
  } finally {
    await observer.close();
  }
  assert.equal(task.holds.at(-1).closed, false, 'Closing a viewing tab must not cancel the writing turn.');
  await clickSidebarEntry(page, 'link', '小说库');
  const foreignCard = page.locator('.book:not([data-book-id="' + bookId + '"])').first();
  const foreignId = await foreignCard.getAttribute('data-book-id');
  await foreignCard.getByRole('button', { name: '进入创作', exact: true }).click();
  await page.locator('.novel-manuscript[data-book-id="' + foreignId + '"]').waitFor();
  assert.equal(await page.getByRole('textbox', { name: '书稿流式预览', exact: true }).count(), 0);
  assert.equal(task.holds.at(-1).closed, false);
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + bookId + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await live.waitFor({ state: 'visible' });
  assert.ok((await live.textContent()).includes(task.argumentPreviewText));
  assert.equal(
    model.requests.length,
    callsBeforeReload,
    'Reopening the book observes the original held call.',
  );
  // Browsing and resizing cannot stop the original stream or fork its composer.
  await page.getByRole('button', { name: '设定', exact: true }).click();
  assert.equal(task.holds.at(-1).closed, false);
  await page.getByRole('button', { name: '正文', exact: true }).click();
  model.release(task);
  try {
    await waitFor(() => task.completedSteps === 6, 'partial save then final native prose auto-publication');
  } catch (error) {
    console.error(
      'Isolated pipeline terminal evidence:',
      JSON.stringify({
        completedSteps: task.completedSteps,
        issuedSteps: task.issuedSteps.map(({ step, name }) => ({ step, name })),
        holds: task.holds.map(({ stage, closed }) => ({ stage, closed })),
        modelRequests: task.bodies.length,
        lastNativeCalls: model.requests.slice(-3).map(({ task, tools }) => ({ task, tools })),
        formalMatches: (await get('document?path=' + encodeURIComponent(chapter.path))).text === prose,
        nativeActivity: await page.locator('.novel-native-activity').allTextContents(),
      }),
    );
    throw error;
  }
  await page.locator('.novel-native-activity').filter({ hasText: 'AI 已结束' }).waitFor();
  // Author browsed away: no forced navigation. The ordinary chapter selection
  // still refreshes from the sole native store without a manual accept click.
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), prose);
  assert.equal((await get('document?path=' + encodeURIComponent(chapter.path))).text, prose);
  for (const width of [1440, 1280, 1100, 900, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    const writing = page.locator('.novel-desk-writing');
    assert.equal(await writing.isVisible(), true);
    // Viewport/sidebar layout can commit between two protocol round-trips.
    // Compare both boxes in one browser frame and wait for the real layout,
    // instead of mixing a previous viewport measurement with the next one.
    await waitFor(
      () =>
        page.evaluate(() => {
          const paper = document.querySelector('.novel-desk-writing').getBoundingClientRect();
          const desk = document.querySelector('.novel-desk').getBoundingClientRect();
          return paper.width > 0 && paper.width >= desk.width - 2;
        }),
      'closed assistant gives the manuscript all available width after resize',
    );
    const desk = await page.locator('.novel-desk').boundingBox();
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
    if (desk.width <= 1050)
      assert.equal(
        await writing.isVisible(),
        false,
        'Narrow AVAILABLE workspace uses one pane, even with a wide viewport/sidebar.',
      );
    else assert.ok((await writing.boundingBox()).width >= 650, 'Wide split prioritizes readable manuscript.');
    assert.equal(await page.locator('[data-composer-seat]').count(), 1);
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-pipeline-layout-' + width + '.png'),
      fullPage: true,
    });
  }
  await page.reload();
  await waitEditor(page.getByRole('textbox', { name: '书稿正文', exact: true }), prose);
  // Legacy arbitrary drafts are visible, can be adopted without regeneration,
  // preserve source bytes and never bypass managed candidate acceptance.
  const draft = await context.request.put(base + 'document', {
    data: { path: 'drafts/boss-01.md', text: '# 旧场景\n\n旧场景完整正文。', expectedHash: null },
  });
  assert.equal(draft.status(), 200);
  await draft.dispose();
  await page.reload();
  await openChapterDirectory(page);
  await page.locator('.novel-loose-drafts summary').click();
  await page.getByRole('button', { name: 'boss-01.md', exact: true }).click();
  await page.getByRole('button', { name: '收录为章节', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '已收录为章节' }).waitFor();
  assert.equal((await get('document?path=drafts/boss-01.md')).text, '# 旧场景\n\n旧场景完整正文。');
  console.log(
    'Native novel pipeline passed: ordinary author input -> missing outline -> validated new plan -> associated chapter -> live left manuscript -> explicit final new-only publication; browse/resize/reload, 390–1440 available-width layouts, one native composer and legacy draft adoption. Local synthetic model only.',
  );
}
