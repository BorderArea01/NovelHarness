import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { waitEditor } from './editor-client.mjs';
import { visibleViewportFixture } from './visible-viewport-fixture.mjs';
import { newFixtureApi } from './fixture-api.mjs';
import { verifyConversationReading } from './conversation-reading-scenario.mjs';

// Diagnostic only: original native ask_user_question, no paid provider or
// production book/settings writes. A synthetic provider tests delivery, not
// whether an actual model chooses to ask a good creative question.
export async function verifyCreativeQuestions({ page, context, origin, model, waitFor, root }) {
  const apiClient = await newFixtureApi(context);
  try {
    const bookId = await page.locator('.novel-manuscript').getAttribute('data-book-id');
    const get = async (route) => {
      const response = await apiClient.get(origin + '/api/novels/' + bookId + '/' + route);
      assert.equal(response.status(), 200);
      const body = await response.json();
      await response.dispose();
      return body;
    };
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 780 });
      await page.locator('.novel-native-frame[data-novel-narrow]').waitFor();
      const deskBefore = await page.locator('.novel-desk').boundingBox();
      await page.getByRole('button', { name: '展开导航', exact: true }).click();
      const scrim = page.getByRole('button', { name: '关闭导航', exact: true });
      await scrim.waitFor();
      const deskAfter = await page.locator('.novel-desk').boundingBox();
      assert.ok(
        Math.abs(deskBefore.width - deskAfter.width) < 2,
        'Opening a mobile drawer overlays instead of squeezing the manuscript.',
      );
      assert.ok((await scrim.boundingBox()).width >= 40, 'A tappable outside area remains.');
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-mobile-drawer-' + width + '.png'),
        fullPage: true,
      });
      await scrim.click();
      await page.getByRole('button', { name: '展开导航', exact: true }).waitFor();
      await page.getByRole('button', { name: '展开导航', exact: true }).click();
      await scrim.waitFor();
      await page.keyboard.press('Escape');
      await scrim.waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
    const { visibleViewport, restoreViewport } = visibleViewportFixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const originalComposer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
    const unsent = '尚未发送的灵感，不应因为键盘、菜单或视口变化丢失。';
    await originalComposer.fill(unsent);
    await visibleViewport(360, 18);
    await waitFor(
      async () => Math.abs((await page.locator('.novel-native-frame').boundingBox()).height - 360) < 1,
      'visual-only resize fits native frame',
    );
    await page.getByRole('button', { name: /^选择模型，当前/ }).click();
    const modelMenu = page.getByRole('menu', { name: '模型与推理等级', exact: true });
    await modelMenu.waitFor();
    const menuBox = await modelMenu.boundingBox();
    assert.ok(
      menuBox.y >= 18 && menuBox.y + menuBox.height <= 378,
      'Model menu stays within visual viewport without changing settings.',
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-visible-model-menu.png'),
      fullPage: true,
    });
    await modelMenu.getByRole('menuitem', { name: /^模型/ }).click();
    const models = page.getByRole('group', { name: '模型与推理等级', exact: true });
    await models.getByRole('menuitemradio').first().waitFor();
    const modelsBox = await models.boundingBox();
    assert.ok(
      modelsBox.y >= 18 && modelsBox.y + modelsBox.height <= 378,
      'The loaded model list remains within the visible viewport.',
    );
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-visible-model-list.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    if (await modelMenu.isVisible()) await page.keyboard.press('Escape');
    await visibleViewport(360, 18, 2);
    await waitFor(
      () => page.evaluate(() => !document.documentElement.hasAttribute('data-novel-visible-viewport')),
      'pinch zoom relinquishes layout fitting',
    );
    assert.equal(await originalComposer.textContent(), unsent);
    await restoreViewport();
    await originalComposer.fill('');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const selected = width === 390 ? '我想让来信来自未来的自己' : '调查失踪的姐姐';
      const plan = {
        storyPlan: '来信来自未来的自己，沈澄必须在失忆前查出钟楼的秘密。',
        chapters: [
          {
            chapter: 1,
            title: '未来笔迹',
            summary: '沈澄认出未来自己的笔迹，决定赴钟楼。',
            plotPoints: ['认出笔迹', '赴钟楼'],
          },
        ],
      };
      const prose = '# 未来笔迹\n\n沈澄把信翻过来。最后一笔的停顿，与她昨晚写给自己的便笺一模一样。';
      const previous = ({ task, results, step }) =>
        JSON.parse(results.get('fixture_' + task.id + '_' + (step - 1)).text);
      const task = model.register({
        steps: [
          {
            name: 'ask_user_question',
            input: {
              questions: [
                {
                  id: 'story-direction',
                  header: '故事方向',
                  question:
                    width === 390
                      ? '钟楼每天送来一封明天的信，而姐姐的失踪也牵涉其中。你更希望这份灵感围绕寻找亲人、改变未来，还是守护钟楼的秘密展开？'
                      : '钟楼送来明天的信，你更想从哪个方向开始？',
                  options: [
                    { label: '调查失踪的姐姐', description: '围绕线索与亲情展开悬疑。' },
                    { label: '改变明天的灾难', description: '每次改变未来都要付出记忆。' },
                    { label: '成为新的守钟人', description: '从责任与诱惑展开人物选择。' },
                  ],
                },
                ...(width !== 390
                  ? []
                  : [
                      {
                        id: 'narrator',
                        question: '这段故事跟随谁的所见所知？',
                        options: [
                          { label: '沈澄', description: '只展示她当时知道的信息，不提前透露来信真相。' },
                          { label: '姐姐', description: '从失踪者的处境出发，逐步揭开她付出的代价。' },
                        ],
                      },
                    ]),
              ],
            },
            expected: selected,
          },
          ...(width !== 390
            ? []
            : [
                {
                  name: 'novel_proposal_prepare',
                  input: { mode: 'new-chapter', chapter: 1, instruction: selected + '。先大纲后正文。' },
                  expected: '"prerequisite":"outline"',
                },
                {
                  name: 'novel_proposal_submit',
                  input: (scope) => {
                    const p = previous(scope);
                    assert.ok(p.authorRequest.includes(selected));
                    assert.equal(p.task.kind, 'outline');
                    assert.ok(p.task.template.body.includes('方向未定'));
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
                  input: { mode: 'new-chapter', chapter: 1, instruction: selected + '。按章纲写第一章。' },
                },
                {
                  name: 'novel_proposal_submit',
                  input: (scope) => {
                    const p = previous(scope);
                    assert.equal(p.prerequisite, null);
                    return {
                      proposal_id: p.proposalId,
                      expected_hash: p.expectedHash,
                      content: prose,
                      complete: true,
                    };
                  },
                  expected: '"published":true',
                },
              ]),
        ],
        finalText: '已收到你的方向，接下来按这个选择继续。' + width,
      });
      const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
      await composer.fill(
        '钟楼每天多一封明天的信，请给我几个可点选的方向。' +
          (width === 390 ? '我选定后请先写大纲再写第一章。' : '') +
          task.marker,
      );
      await composer.press('Enter');
      const panel = page.locator('[data-question-key]');
      await panel.getByRole('radio', { name: '调查失踪的姐姐', exact: true }).waitFor();
      const body = task.bodies[0];
      const system =
        typeof body.system === 'string'
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((block) => block.text ?? '').join('\n')
            : body.messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n');
      assert.ok(!system.includes('灵感定向：'));
      assert.ok(!system.includes('你的交付是创作讨论与可读小说'));
      assert.equal(
        (await get('documents')).documents.filter((d) => d.category === 'chapter').length,
        0,
        'Unanswered inspiration choices do not publish prose.',
      );
      if (width === 390) {
        const beforeReload = model.requests.length;
        await page.reload();
        await panel.getByRole('radio', { name: '调查失踪的姐姐', exact: true }).waitFor();
        assert.equal(
          model.requests.length,
          beforeReload,
          'Refresh recovers native pending questions without resubmitting.',
        );
        await page.getByRole('button', { name: '提示词', exact: true }).click();
        assert.equal(
          await panel.isVisible(),
          true,
          'Optional manuscript tabs cannot hide the native answer area.',
        );
        await page.getByRole('textbox', { name: '提示词 write', exact: true }).focus();
        assert.equal(
          await panel.isVisible(),
          true,
          'Focusing a manuscript field cannot hide pending native answers.',
        );
        await page.getByRole('button', { name: '大纲', exact: true }).click();
        assert.equal(await panel.isVisible(), true);
      }
      await panel.getByRole('radio', { name: '成为新的守钟人', exact: true }).scrollIntoViewIfNeeded();
      const unobscured = async (locator) => {
        assert.ok(
          await locator.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const dock = node.closest('.novel-author-dock').getBoundingClientRect();
            const card = node.closest('[data-question-key] > section').getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (
              rect.top >= Math.max(0, dock.top) &&
              rect.bottom <=
                Math.min(innerHeight, visualViewport.height + visualViewport.offsetTop, dock.bottom) + 1 &&
              rect.left >= card.left &&
              rect.right <= card.right + 1 &&
              (hit === node || node.contains(hit))
            );
          }),
          'Question heading and action must be on screen, inside their dock and not covered.',
        );
      };
      if (width === 390) {
        await page.setViewportSize({ width: 320, height: 320 });
        await unobscured(panel.locator('h2'));
        await unobscured(panel.locator('footer').getByRole('button', { name: '下一题', exact: true }).last());
        assert.ok(
          (await panel.locator('[data-question-scroll]').boundingBox()).height >= 43,
          'Short screens retain a usable independently scrollable answer body.',
        );
        await page.screenshot({
          path: resolve(root, 'test-results/cloud-mobile-question-short.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await panel.getByPlaceholder('输入你的答案', { exact: true }).focus();
        await visibleViewport(320, 18);
        await waitFor(
          () => page.evaluate(() => document.documentElement.hasAttribute('data-novel-visible-viewport')),
          'pending answers follow visual-only shrink',
        );
        await unobscured(panel.locator('h2'));
        await unobscured(panel.locator('footer').getByRole('button', { name: '下一题', exact: true }).last());
        await page.screenshot({
          path: resolve(root, 'test-results/cloud-mobile-visible-question.png'),
          fullPage: true,
        });
        await restoreViewport();
      }
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-creative-question-' + width + '.png'),
        fullPage: true,
      });
      assert.equal(await page.locator('[data-composer-seat]').count(), 1);
      if (width === 390) {
        await panel.getByPlaceholder('输入你的答案', { exact: true }).fill(selected);
        await panel.locator('footer').getByRole('button', { name: '下一题', exact: true }).last().click();
        await panel.getByRole('radio', { name: '沈澄', exact: true }).click();
        await unobscured(panel.locator('h2'));
        await unobscured(panel.getByRole('button', { name: '提交', exact: true }));
      } else await panel.getByRole('radio', { name: selected, exact: true }).click();
      await panel.getByRole('button', { name: '提交', exact: true }).click();
      await waitFor(
        () => task.completedSteps === task.steps.length,
        'native creative answer reaches same-agent outline and prose tools',
      );
      await panel.waitFor({ state: 'hidden' });
      await page.getByText(task.finalText, { exact: true }).waitFor({ state: 'attached' });
      if (width === 390) {
        assert.equal(
          await page.locator('.novel-desk').getAttribute('data-assistant'),
          'closed',
          'Answering from the manuscript does not force navigation.',
        );
        assert.equal(await page.locator('.novel-desk-writing').isVisible(), true);
        const documents = (await get('documents')).documents;
        assert.ok((await get('document?path=outline.json')).text.includes('未来自己的笔迹'));
        const chapter = documents.find((d) => d.category === 'chapter');
        assert.ok(chapter);
        assert.equal((await get('document?path=' + encodeURIComponent(chapter.path))).text, prose);
      }
    }
    const previous = ({ task, results, step }) =>
      JSON.parse(results.get('fixture_' + task.id + '_' + (step - 1)).text);
    const freeProse = '# 不再等信\n\n沈澄把门反锁，这次她不打算等钟声响起。';
    const clear = model.register({
      holdBeforeStep: 2,
      steps: [
        { name: 'novel_outline_update', input: { action: 'inspect' }, expected: 'outlineHash' },
        {
          name: 'novel_outline_update',
          input: (scope) => {
            const p = previous(scope);
            return {
              action: 'apply',
              expected_outline_hash: p.outlineHash,
              expected_direction_hash: p.directionHash,
              clear: true,
              reason: '作者要求清空旧大纲，然后直接写正文',
            };
          },
          expected: '"applied":true',
        },
        {
          name: 'novel_proposal_prepare',
          input: {
            mode: 'new-chapter',
            instruction: '不要大纲，直接写一章完整正文。',
            without_outline: true,
          },
        },
        {
          name: 'novel_proposal_submit',
          input: (scope) => {
            const p = previous(scope);
            assert.equal(p.prerequisite, null);
            assert.equal(p.task.withoutOutline, true);
            return {
              proposal_id: p.proposalId,
              expected_hash: p.expectedHash,
              content: freeProse,
              complete: true,
            };
          },
          expected: '"published":true',
        },
      ],
      finalText: '已清空旧规划，正文已入书；旧稿保留。',
    });
    await page.getByRole('button', { name: '大纲', exact: true }).click();
    await page
      .getByText(/第 1 章 · 未来笔迹/)
      .first()
      .waitFor();
    await page.getByRole('button', { name: '创作助手', exact: true }).click();
    const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
    await composer.fill('清空旧大纲，不要重新生成大纲，直接写正文。' + clear.marker);
    await composer.press('Enter');
    await waitFor(() => clear.holds.length > 0, 'explicit native clear applies before direct prose');
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
    await page.getByText('还没有章纲。它是可选的规划工具，不是开始写作的门槛。', { exact: true }).waitFor();
    assert.equal((await get('document?path=outline.json')).text.trim(), '[]');
    assert.equal((await get('document?path=notes/story-plan.md')).text, '');
    assert.equal((await get('documents')).documents.filter((d) => d.category === 'chapter').length, 1);
    model.release(clear);
    await waitFor(
      () => clear.completedSteps === 4,
      'without-outline prose publishes through the original candidate transaction',
    );
    const final = (await get('documents')).documents.filter((d) => d.category === 'chapter');
    assert.equal(final.length, 2, 'Clearing plans preserves old prose and adds a distinct free chapter.');
    const free = final.find((d) => d.path.startsWith('chapters/free-'));
    assert.equal((await get('document?path=' + encodeURIComponent(free.path))).text, freeProse);
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(editor, freeProse);
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await editor.focus();
      await editor.press('ControlOrMeta+End');
      await visibleViewport(320, 18);
      await waitFor(
        async () => Math.abs((await page.locator('.novel-native-frame').boundingBox()).height - 320) < 1,
        'manuscript editor fits the same visual viewport',
      );
      await waitEditor(editor, freeProse);
      await waitFor(
        () =>
          editor.evaluate(async (element) => {
            const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
            const view = EditorView.findFromDOM(element);
            const caret = view.coordsAtPos(view.state.selection.main.head);
            const body = element.closest('.novel-ms-body').getBoundingClientRect();
            return (
              caret &&
              caret.top >= Math.max(body.top, visualViewport.offsetTop) &&
              caret.bottom <= Math.min(body.bottom, visualViewport.offsetTop + visualViewport.height)
            );
          }),
        'original manuscript caret stays visible after visual-only resize',
      );
      await restoreViewport();
      await waitEditor(editor, freeProse);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Start zoom before instrumentation. A preceding ordinary window resize can
    // still be delivered between Playwright calls; it is not a pinch event.
    await visibleViewport(320, 18, 2);
    await page.evaluate(async () => {
      const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
      window.__originalCaretReveal = EditorView.scrollIntoView;
      window.__caretRevealCount = 0;
      EditorView.scrollIntoView = (...args) => {
        window.__caretRevealCount++;
        return window.__originalCaretReveal(...args);
      };
      // This observed zoom resize and instrumentation share one browser task.
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await page.evaluate(() => window.__caretRevealCount),
      0,
      'Pinch zoom must not trigger our caret-reveal controller.',
    );
    await page.evaluate(async () => {
      const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
      EditorView.scrollIntoView = window.__originalCaretReveal;
      delete window.__originalCaretReveal;
      delete window.__caretRevealCount;
    });
    await restoreViewport();
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-free-prose.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '提示词', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: '提示词 write', exact: true });
    await prompt.waitFor();
    await prompt.focus();
    await visibleViewport(320, 18);
    await waitFor(
      async () => Math.abs((await page.locator('.novel-native-frame').boundingBox()).height - 320) < 1,
      'prompt editor fits visual viewport',
    );
    await waitFor(
      () =>
        prompt.evaluate((el) => {
          const rect = el.getBoundingClientRect(),
            body = el.closest('.novel-ms-body').getBoundingClientRect();
          return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1 && rect.height >= 60;
        }),
      'focused native prompt remains fully usable after visible-only shrink',
    );
    const promptText = '{chapterTitle}\n' + '作者的自定义提示词，保存后仍可继续修改。\n'.repeat(25);
    await prompt.fill(promptText);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-visible-prompt.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(JSON.parse((await get('document?path=rules.json')).text).savedPrompts.write, promptText);
    // A clean form retires save rather than reserving a permanent row. Its
    // real action must return and stay clickable within the visual viewport
    // on the next edit, even after the field loses focus.
    const save = page.getByRole('button', { name: '保存提示词', exact: true });
    assert.equal(await save.count(), 0);
    await prompt.fill(promptText + '\n临时修改，暂不提交。');
    await save.focus();
    assert.ok(
      await save.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          frame = el.closest('.novel-native-frame').getBoundingClientRect(),
          hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return (
          r.top >= frame.top && r.bottom <= frame.bottom && r.height >= 44 && (hit === el || el.contains(hit))
        );
      }),
    );
    await prompt.fill(promptText);
    assert.equal(await save.count(), 0);
    await restoreViewport();
    // Keep bounded synthetic navigation evidence if a late native projection
    // reselects prose while the author is opening prompts after reload.
    const reloadReads = [];
    const recordRead = (request) => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' || !url.pathname.startsWith('/api/novels/')) return;
      reloadReads.push(url.pathname.split('/').at(-1) + url.search);
      if (reloadReads.length > 30) reloadReads.shift();
    };
    page.on('request', recordRead);
    try {
      await page.reload();
      await page.getByRole('button', { name: '提示词', exact: true }).click();
      await prompt.waitFor();
    } catch (error) {
      console.error('Synthetic prompt reload reads:', reloadReads);
      console.error(
        'Synthetic prompt reload UI:',
        await page.locator('.novel-ms-tabs,.novel-ms-path,.novel-ms-status').allTextContents(),
      );
      throw error;
    } finally {
      page.off('request', recordRead);
    }
    assert.equal(await prompt.inputValue(), promptText);
    const rules = page.getByLabel('提示词编辑器', { exact: true });
    const style = rules.getByRole('textbox', { name: '提示词 write', exact: true });
    const styleText = '以人物的选择推进剧情，不替读者总结。\n'.repeat(20);
    await style.fill(styleText);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await style.focus();
      await visibleViewport(320, 18);
      await waitFor(
        () =>
          style.evaluate((el) => {
            const r = el.getBoundingClientRect(),
              b = el.closest('.novel-ms-body').getBoundingClientRect();
            return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
          }),
        'native style field visible at ' + width,
      );
      assert.equal(await style.inputValue(), styleText);
      await restoreViewport();
    }
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(JSON.parse((await get('document?path=rules.json')).text).savedPrompts.write, styleText);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '设定', exact: true }).click();
    await page.getByRole('button', { name: '人物与资料', exact: true }).click();
    await page.getByRole('button', { name: '＋ 人物', exact: true }).click();
    await page.getByRole('textbox', { name: '新人物名称', exact: true }).fill('移动端测试人物');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.locator('.novel-canon-detail .novel-custom-fields > summary').click();
    await page.getByRole('button', { name: '＋ 字段', exact: true }).click();
    await page.getByRole('textbox', { name: '新字段名', exact: true }).fill('底线');
    const custom = page.getByRole('textbox', { name: '新字段内容', exact: true });
    await custom.fill('保住钟楼，也不能牺牲送信人。');
    await visibleViewport(320, 18);
    await waitFor(
      () =>
        custom.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            b = el.closest('.novel-ms-body').getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
        }),
      'custom canon field visible after keyboard geometry changes',
    );
    await page.getByRole('button', { name: '添加字段', exact: true }).click();
    await page.getByRole('button', { name: '保存设定', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(
      JSON.parse((await get('document?path=canon.json')).text).characters.find(
        (p) => p.name === '移动端测试人物',
      ).customFields.底线,
      '保住钟楼，也不能牺牲送信人。',
    );
    await restoreViewport();
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-canon-form.png'),
      fullPage: true,
    });
    await page.locator('.novel-reference-source > summary').click();
    const source = page.getByRole('textbox', { name: '资料源文件', exact: true });
    const sourceBefore = await source.inputValue();
    await source.focus();
    await visibleViewport(320, 18);
    await waitFor(
      () =>
        source.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            b = el.closest('.novel-ms-body').getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.height >= 60;
        }),
      'complete raw source field fits without its desktop minimum height',
    );
    assert.equal(await source.inputValue(), sourceBefore);
    assert.equal((await get('document?path=canon.json')).text, sourceBefore);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-mobile-visible-raw-source.png'),
      fullPage: true,
    });
    await restoreViewport();
    await verifyConversationReading({ page, model, waitFor, root });
    console.log(
      'Native mobile/creative path passed: overlay drawers; long questions at 320x320 retain full heading, contained actions and scrollable answers; visual-only shrink/offset keeps original input, loaded model list and questions visible with drafts intact; original manuscript caret is visible at 390/768 without text changes; native prompt/style/custom canon fields remain visible and save through original VFS with reload persistence; pinch zoom releases fitting; reload, original Agent outline/prose and explicit clear/free chapter. Visual viewport metrics are simulated, not a physical OS keyboard; no paid requests or quality claim.',
    );
  } finally {
    await apiClient.dispose();
  }
}
