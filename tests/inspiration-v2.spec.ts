import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';

const base = 'https://inspiration-v2-model.test/v1';
const synopsis = (n: number) => {
  const events = [
    '拆开失踪姐姐的信',
    '核对潮汐登记簿',
    '追查废弃邮局',
    '听取渡船人的证词',
    '查验城门封印',
    '潜入钟楼暗层',
    '寻找失忆的抄写员',
    '公开被删掉的值夜记录',
  ];
  return `第${n}天，沈澄决定${events[(n - 1) % events.length]}，不再依赖闻砚替她解释钟声。她以自己的值夜资格换取查阅原件的许可，并把得到的纸页交给港民保存，避免一份证据被人销毁后再也无法追回。闻砚必须公开他保留的旧抄本，否则守夜人的证词将无法核验；这一要求使他失去隐瞒姐姐行踪的余地。两人当面对照不同来源的日期，发现第${n + 2}次潮汐被记录成了另一种刻度，而更改刻度的人拥有进入封存柜的权限。沈澄没有急着指认凶手，她留下两份拓印，约定下次钟声前分别核验；港民因此第一次拥有不依赖守塔人记忆的记录，后续调查必须围绕原件的来历展开。`;
};
const outlineRows = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => ({
    chapter: start + i,
    title: `钟楼证词 ${start + i}`,
    summary: synopsis(start + i),
    plotPoints: ['取得姐姐来信中的证据', '留下两份独立记录并承担代价'],
  }));
const prose =
  '沈澄在钟楼底下收到姐姐的信。她拆开信，决定留下证据。' +
  Array.from(
    { length: 44 },
    (_, i) =>
      `\n\n沈澄翻到值夜簿第${i + 1}页，闻砚把当日的名字交给她。她把刻痕描在新纸上，再请邻居核验；这一次没有人替她作决定。两份记录各有一处折角，经过钟声也没有褪去。`,
  ).join('') +
  '\n钟声停了，她仍然记得姐姐。';
const markedProse = () => {
  const split = prose.indexOf('\n\n', 1200);
  return (
    prose.slice(0, split) +
    '【PP1】' +
    prose.slice(split).replace('她仍然记得姐姐。', '她仍然记得姐姐。【PP2】')
  );
};

async function login(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await expect(page.locator('#libraryView')).toBeVisible();
}
async function configure(page: Page, url = base) {
  const response = await page.request.put('/api/settings', {
    data: {
      apiConfigs: [{ id: 'inspiration-v2', name: 'test', baseURL: url, model: 'mock', apiKey: 'test-only' }],
      activeConfigId: 'inspiration-v2',
    },
  });
  expect(response.ok()).toBeTruthy();
}
async function saved(page: Page) {
  return page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`)).json()).state;
  });
}
async function project(page: Page, overrides: Record<string, unknown> = {}) {
  const created = await (
    await page.request.post('/api/projects', {
      data: { title: '保留原书', inspiration: '一封来自明天的信。' },
    })
  ).json();
  const initial = await (await page.request.get(`/api/projects/${created.id}/state`)).json();
  await page.request.put(`/api/projects/${created.id}/state`, {
    data: {
      revision: initial.revision,
      state: { ...initial.state, project: { ...initial.state.project, chapterCount: 3 }, ...overrides },
    },
  });
  await page.goto(`/workbench.html?project=${created.id}&mode=inspiration`);
  await expect(page.locator('#tab-inspiration')).toBeVisible();
  return created.id;
}
async function mock(
  page: Page,
  options: { incomplete?: boolean; malformedFoundation?: boolean; failBatchOnceFrom?: number } = {},
) {
  const requests: string[] = [];
  let failedBatch = false;
  await page.route(`${base}/chat/completions`, async (route) => {
    const messages = route.request().postDataJSON().messages as Array<{ role: string; content: string }>;
    const all = messages.map((message) => message.content).join('\n');
    const last = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
    requests.push(all);
    if (
      !failedBatch &&
      options.failBatchOnceFrom &&
      last.includes('【按故事结构蓝图生成章节大纲】') &&
      Number(all.match(/生成第 (\d+)–(\d+) 章/)?.[1]) === options.failBatchOnceFrom
    ) {
      failedBatch = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":{"message":"TEST_BATCH_UNAVAILABLE"}}',
      });
      return;
    }
    let content = '{}';
    if (last.includes('【灵感开写 · 故事方向】'))
      content = options.malformedFoundation
        ? '{"title":"缺字段"}'
        : JSON.stringify({
            title: '钟声遗忘之城',
            genre: '悬疑奇幻',
            setting: '钟声能抹去共同记忆，但纸上的刻痕仍在。',
            characters: '沈澄想找回姐姐，闻砚害怕公开值夜簿。',
            direction: '找到姐姐需要保护独立证据；越公开记录，越必须承担失去守塔信任的代价。',
          });
    else if (last.includes('【故事结构规划任务】'))
      content = `【故事结构蓝图】\n${'人物保护证据的选择让对手不得不公开旧记录，钟声的规则影响证词是否可信；每条纸面记录会转变人物关系，并回收姐姐失踪前留下的时间线。'.repeat(3)}`;
    else if (
      last.includes('【结构精修任务】') ||
      last.includes('【大纲质量校验修复】') ||
      last.includes('【灵感开写 · 章节大纲】')
    ) {
      const match = all.match(/生成第 (\d+)–(\d+) 章/)!;
      const rows = outlineRows(Number(match[1]), Number(match[2]));
      if (options.incomplete) rows.pop();
      const json = JSON.stringify(rows);
      content = last.includes('【结构精修任务】')
        ? `【精修诊断】无需实质改动；保留角色选择与证据流转的具体代价。\n【修订稿】\n${json}`
        : json;
    } else if (last.includes('【场景蓝图规划任务】'))
      content =
        '【本章场景蓝图】\n场景1｜沈澄在钟下拆信，把值夜资格交给闻砚换取原件｜PP1｜1000字\n场景2｜两份纸面记录让港民开始独立核验，闻砚必须承担公开抄本的代价｜PP2｜1200字';
    else if (last.includes('【章节正文精修任务】'))
      content = `【精修诊断】将抽象感受改成记住姐姐的具体状态，保留证据传递与选择。\n【修订稿】\n${markedProse()}`;
    else if (last.includes('【按场景蓝图写作｜正文阶段】'))
      content = markedProse().replace('她仍然记得姐姐。', '她觉得姐姐很重要。');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    });
  });
  return requests;
}

async function heldProseServer(
  hold: 'draft' | 'review' = 'draft',
  thinking = false,
  options: { partial?: string; splitAt?: number } = {},
) {
  const requests: string[] = [];
  let advance = () => {};
  let finishReview = () => {};
  const partial =
    options.partial || '第二章，沈澄留下两份纸面记录。她没有等待闻砚允许，而是把原件交给邻居核验。';
  const splitAt = options.splitAt ?? 20;
  const reviewed = prose.replace('她仍然记得姐姐。', '她把姐姐的名字写在第二份记录上。');
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let input = '';
    req.on('data', (chunk) => {
      input += chunk;
    });
    req.on('end', () => {
      const last = JSON.parse(input).messages.at(-1).content;
      requests.push(last);
      const isDraft = last.includes('【按场景蓝图写作｜正文阶段】');
      const isReview = last.includes('【章节正文精修任务】');
      const content = isDraft
        ? hold === 'review'
          ? markedProse()
          : partial
        : isReview
          ? '【精修诊断】REVIEW_ONLY_SENTINEL：正在修改场景，但尚未交付修订稿。'
          : '【本章场景蓝图】\n场景1｜沈澄保护原件，闻砚交出抄本｜PP1｜1000字\n场景2｜港民核验记录，证词不再属于一个人｜PP2｜1200字';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (last === 'AUXILIARY_SENTINEL') {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'AUX_THINKING' } }] })}\n\n`,
        );
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{}' } }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (thinking && isDraft) {
        const send = (delta: Record<string, string>) =>
          res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        send({ reasoning_content: 'THINKING_ONLY_SENTINEL：梳理人物选择。' });
        let step = 0;
        advance = () => {
          if (step++ === 0) {
            send({ content: partial.slice(0, splitAt) + '【PP1】' });
            send({ reasoning_content: 'INTERLEAVED_THINKING_SENTINEL' });
          } else send({ content: partial.slice(splitAt) });
        };
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      if (hold === 'review' && isReview)
        finishReview = () => {
          const revision = markedProse().replace('她仍然记得姐姐。', '她把姐姐的名字写在第二份记录上。');
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '\n【修订稿】\n' + revision } }] })}\n\ndata: [DONE]\n\n`,
          );
        };
      if (!((hold === 'draft' && isDraft) || (hold === 'review' && isReview))) res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    partial,
    reviewed,
    advance: () => advance(),
    finishReview: () => finishReview(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const stage of ['draft', 'review'] as const) {
  test(`inspiration-v2 ${stage}等待期间切回新章仍能阅读初稿，不靠下一片流刷新`, async ({ page }) => {
    const model = await heldProseServer(stage);
    const draft = stage === 'review' ? prose : model.partial;
    try {
      await login(page);
      await configure(page, model.url);
      await project(page, {
        outline: outlineRows(1, 3).map((item) => ({
          ...item,
          plotPoints: item.plotPoints.map((desc) => ({ desc })),
        })),
        chapters: [{ chapter: 1, content: '旧章作者正文，只供阅读，不可被新章预览替换。' }],
      });
      await page.locator('#inspirationWrite').click();
      await expect(page.locator('#inspirationProcessText')).toContainText(
        stage === 'review' ? 'REVIEW_ONLY_SENTINEL' : model.partial,
      );
      await expect(page.locator('#inspirationEditor')).toHaveValue(draft);
      const requests = model.requests.length;
      await page.locator('#inspirationChapterSelect').selectOption('1');
      await expect(page.locator('#inspirationEditor')).toHaveValue(
        '旧章作者正文，只供阅读，不可被新章预览替换。',
      );
      await page.locator('#inspirationChapterSelect').selectOption('2');
      await expect(page.locator('#inspirationEditor')).toHaveValue(draft);
      await expect(page.locator('#inspirationWords')).toContainText('初稿预览');
      await expect(page.locator('#inspirationProseQuality')).toBeHidden();
      await page.locator('[data-inspiration-view="outline"]').click();
      await page.locator('[data-inspiration-view="write"]').click();
      await expect(page.locator('#inspirationEditor')).toHaveValue(draft);
      expect(model.requests.length).toBe(requests);
      const current = await saved(page);
      expect(current.chapters.find((item: { chapter: number }) => item.chapter === 2)).toBeUndefined();
      if (stage === 'review') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#inspirationEditor').scrollIntoViewIfNeeded();
        await page.screenshot({ path: 'test-results/inspiration-v2-reading-review-mobile.png' });
      }
      if (stage === 'review') {
        await page.locator('#inspirationChapterSelect').selectOption('1');
        model.finishReview();
        await expect(page.locator('#inspirationStatus')).toContainText('第 2 章已保存');
        await expect(page.locator('#inspirationEditor')).toHaveValue(
          '旧章作者正文，只供阅读，不可被新章预览替换。',
        );
        await page.locator('#inspirationChapterSelect').selectOption('2');
        await expect(page.locator('#inspirationEditor')).toHaveValue(model.reviewed);
        await expect(page.locator('#inspirationProseQuality')).toHaveAttribute('data-freshness', 'current');
      } else {
        await page.locator('#inspirationStop').click();
        await expect(page.locator('#inspirationStop')).toBeHidden();
        await expect(page.locator('#inspirationEditor')).toHaveValue(draft);
      }
      await expect(page.locator('#inspirationWords')).not.toContainText('初稿预览');
      expect((await saved(page)).chapters[0].content).toBe('旧章作者正文，只供阅读，不可被新章预览替换。');
    } finally {
      await model.close();
    }
  });
}

test('inspiration-v2 手机生成操作栏精简，切章与停止可用，正文不被悬停栏遮住', async ({ page }) => {
  const model = await heldProseServer('review');
  try {
    await login(page);
    await configure(page, model.url);
    await project(page, {
      outline: outlineRows(1, 3).map((item) => ({
        ...item,
        plotPoints: item.plotPoints.map((desc) => ({ desc })),
      })),
      chapters: [{ chapter: 1, content: '原第一章正文，不应被新章预览替换。' }],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#inspirationWrite').click();
    await expect(page.locator('#inspirationProcessText')).toContainText('REVIEW_ONLY_SENTINEL');
    await expect(page.locator('#inspirationTaskLabel')).toContainText('第 2 章');
    await expect(page.locator('#inspirationTaskLabel')).toContainText(
      await page.locator('#inspirationProcessLabel').innerText(),
    );
    await expect(page.locator('#inspirationRun')).toBeHidden();
    await expect(page.locator('#inspirationWrite')).toBeHidden();
    await expect(page.locator('#inspirationPlanGate')).toBeHidden();
    await expect(page.locator('#inspirationSave')).toBeHidden();
    await expect(page.locator('#inspirationStop')).toBeVisible();
    await expect(page.locator('#inspirationSidebar')).toBeHidden();
    const footer = page.locator('.inspiration-footer');
    expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(80);
    await page.locator('#inspirationProcessLabel').click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: 'test-results/inspiration-v2-compact-generation-mobile.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    );
    await page.locator('#inspirationChapterSelect').selectOption('1');
    await expect(page.locator('#inspirationEditor')).toHaveValue('原第一章正文，不应被新章预览替换。');
    await page.locator('#inspirationEditor').evaluate((node) => node.scrollIntoView({ block: 'start' }));
    const editorBox = (await page.locator('#inspirationEditor').boundingBox())!;
    const footerBox = (await footer.boundingBox())!;
    expect(editorBox.y).toBeGreaterThanOrEqual(footerBox.y + footerBox.height);
    await page.locator('#inspirationStop').click({ trial: true });
    await page.locator('[data-inspiration-view="outline"]').click();
    await expect(page.locator('#inspirationSidebar')).toBeVisible();
    await page.locator('[data-inspiration-view="write"]').click();
    for (const width of [768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('#inspirationSidebar')).toBeVisible();
      await expect(page.locator('#inspirationStop')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `test-results/inspiration-v2-compact-generation-${width}.png` });
    }
    model.finishReview();
    await expect(page.locator('#inspirationStatus')).toContainText('第 2 章已保存');
    await expect(page.locator('#inspirationTaskLabel')).toBeHidden();
    await expect(page.locator('#inspirationStop')).toBeHidden();
    await expect(page.locator('#inspirationWrite')).toBeVisible();
    await expect(page.locator('#inspirationSave')).toBeEnabled();
    await expect(page.locator('#inspirationSave')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#inspirationChapterSelect').selectOption('2');
    await expect(page.locator('#inspirationEditor')).toHaveValue(model.reviewed);
    await page.locator('[data-inspiration-view="outline"]').click();
    await expect(page.locator('#inspirationAddChapter')).toBeVisible();
    await expect(page.locator('#inspirationAddChapter')).toBeEnabled();
  } finally {
    await model.close();
  }
});

test('inspiration-v2 新流片段不改变阅读初稿时的滚动位置与选区', async ({ page }) => {
  const model = await heldProseServer('draft', true, {
    partial: prose + '\nSTREAM_APPEND_SENTINEL',
    splitAt: 2000,
  });
  try {
    await login(page);
    await configure(page, model.url);
    await project(page, {
      outline: outlineRows(1, 3).map((item) => ({
        ...item,
        plotPoints: item.plotPoints.map((desc) => ({ desc })),
      })),
      chapters: [{ chapter: 1, content: '原第一章正文。' }],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#inspirationWrite').click();
    await expect(page.locator('#inspirationProcessText')).toContainText('THINKING_ONLY_SENTINEL');
    model.advance();
    await expect(page.locator('#inspirationEditor')).toHaveValue(model.partial.slice(0, 2000));
    const reading = await page.locator('#inspirationEditor').evaluate((node) => {
      const editor = node as HTMLTextAreaElement;
      editor.focus();
      editor.setSelectionRange(12, 34);
      editor.scrollTop = 180;
      return { top: editor.scrollTop, start: editor.selectionStart, end: editor.selectionEnd };
    });
    expect(reading.top).toBeGreaterThan(0);
    model.advance();
    await expect(page.locator('#inspirationEditor')).toHaveValue(model.partial);
    const updated = await page.locator('#inspirationEditor').evaluate((node) => {
      const editor = node as HTMLTextAreaElement;
      return { top: editor.scrollTop, start: editor.selectionStart, end: editor.selectionEnd };
    });
    expect(updated).toEqual(reading);
    await page.locator('#inspirationStop').click();
    await expect(page.locator('#inspirationStop')).toBeHidden();
    expect((await saved(page)).chapters[0].content).toBe('原第一章正文。');
  } finally {
    await model.close();
  }
});

test('inspiration-v2 思考流与后台记忆隔离，停止后只保存正文', async ({ page }) => {
  const model = await heldProseServer('draft', true);
  try {
    await login(page);
    await configure(page, model.url);
    await project(page, {
      outline: outlineRows(1, 3).map((item) => ({
        ...item,
        plotPoints: item.plotPoints.map((desc) => ({ desc })),
      })),
      chapters: [{ chapter: 1, content: '第一章原文始终保留。' }],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#inspirationWrite').click();
    await expect(page.locator('#inspirationProcessText')).toContainText('THINKING_ONLY_SENTINEL');
    await expect(page.locator('#inspirationStatus')).toContainText('章节正文 · 思考');
    await expect(page.locator('#inspirationEditor')).not.toHaveValue(/THINKING_ONLY_SENTINEL/);
    const operation = await page.locator('#generationStreamDock').getAttribute('data-operation');
    const before = await page.locator('#inspirationProcessText').textContent();
    const callbacks = await page.evaluate(async () => {
      const runtime = globalThis as typeof globalThis & {
        apiStreamChat: (messages: unknown[], chunk: (s: string) => void, opts: unknown) => Promise<string>;
      };
      let content = '',
        reasoning = '';
      const text = await runtime.apiStreamChat(
        [{ role: 'user', content: 'AUXILIARY_SENTINEL' }],
        (chunk) => {
          content += chunk;
        },
        {
          route: 'memory',
          signal: new AbortController().signal,
          onReasoning: (chunk: string) => {
            reasoning += chunk;
          },
        },
      );
      window.dispatchEvent(
        new CustomEvent('novel-generation-progress', {
          detail: {
            ownerId: 'previous-task',
            type: 'chunk',
            text: 'STALE_TASK_SENTINEL',
            phase: '章节正文',
            kind: 'content',
          },
        }),
      );
      return { text, content, reasoning };
    });
    expect(callbacks).toEqual({ text: '{}', content: '{}', reasoning: 'AUX_THINKING' });
    await expect(page.locator('#inspirationProcessText')).toHaveText(before!);
    await expect(page.locator('#generationStreamDock')).toHaveAttribute('data-operation', operation!);
    await expect(page.locator('#generationStreamDock')).toHaveAttribute('data-status', 'running');
    model.advance();
    await expect(page.locator('#inspirationProcessText')).toContainText('INTERLEAVED_THINKING_SENTINEL');
    await expect(page.locator('#inspirationEditor')).toHaveValue(model.partial.slice(0, 20));
    model.advance();
    await expect(page.locator('#inspirationEditor')).toHaveValue(model.partial);
    await page.screenshot({ path: 'test-results/inspiration-v2-streaming-mobile.png' });
    await expect
      .poll(async () => (await saved(page)).uiDrafts.inspirationWriter.recoveryDraft?.prose)
      .toContain(model.partial.slice(20));
    await page.locator('#inspirationStop').click();
    await expect(page.locator('#inspirationStop')).toBeHidden();
    await expect
      .poll(
        async () =>
          (await saved(page)).chapters.find((item: { chapter: number }) => item.chapter === 2)?.content,
      )
      .toBe(model.partial);
    await page.reload();
    await expect(page.locator('#inspirationEditor')).toHaveValue(model.partial);
    expect((await saved(page)).chapters[0].content).toBe('第一章原文始终保留。');
  } finally {
    await model.close();
  }
});

test('inspiration-v2 200章串行分批，统一蓝图只请求一次，整份交付后才提交', async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  await configure(page);
  const requests = await mock(page);
  await project(page, {
    project: {
      title: '长篇小说',
      genre: '悬疑',
      setting: '纸面记录可以抵抗钟声抹除记忆。',
      chapterCount: 200,
      wordsPerChapter: 2200,
    },
  });
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存', { timeout: 60000 });
  const data = await saved(page);
  expect(data.outline.map((item: { chapter: number }) => item.chapter)).toEqual(
    Array.from({ length: 200 }, (_, i) => i + 1),
  );
  expect(data.chapters).toEqual([]);
  expect(data.uiDrafts.inspirationWriter.outlineBatchDraft).toBeUndefined();
  const planning = requests.filter((req) => req.includes('【故事结构规划任务】'));
  expect(planning).toHaveLength(1);
  expect(planning[0]).toContain('完整规划范围：第 1–200 章');
  const batches = data.uiDrafts.generationQualityReports.outline.batches;
  expect(batches).toHaveLength(17);
  expect(batches[16]).toMatchObject({ start: 193, end: 200 });
  for (const batch of batches) expect(batch.end - batch.start + 1).toBeLessThanOrEqual(12);
  expect(requests.some((req) => req.includes('相邻前批完整规划') && req.includes(synopsis(12)))).toBe(true);
  const pointIds = data.outline.flatMap((item: { plotPoints: { id: string }[] }) =>
    item.plotPoints.map((point) => point.id),
  );
  expect(new Set(pointIds).size).toBe(pointIds.length);
});

test('inspiration-v2 分批失败不覆盖原大纲，刷新重试只生成剩余章节', async ({ page }) => {
  test.setTimeout(60000);
  await login(page);
  await configure(page);
  const requests = await mock(page, { failBatchOnceFrom: 14 });
  const existing = outlineRows(1, 25).map((item) => ({
    ...item,
    summary: `原大纲 ${item.chapter}：作者保留内容。`,
    plotPoints: item.plotPoints.map((desc) => ({ desc })),
  }));
  await project(page, {
    project: {
      title: '保留原书',
      setting: '纸面记录可以抵抗钟声抹除记忆。',
      chapterCount: 25,
      wordsPerChapter: 2200,
    },
    outline: existing,
    chapters: [{ chapter: 1, content: '第一章作者定稿，不可覆盖。' }],
  });
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('TEST_BATCH_UNAVAILABLE');
  await expect(page.locator('#inspirationRun')).toBeEnabled();
  const partial = await saved(page);
  expect(partial.outline.map((item: { summary: string }) => item.summary)).toEqual(
    existing.map((item) => item.summary),
  );
  expect(partial.uiDrafts.inspirationWriter.outlineBatchDraft).toMatchObject({
    start: 2,
    end: 25,
    nextStart: 14,
  });
  expect(partial.uiDrafts.inspirationWriter.outlineBatchDraft.chapters).toHaveLength(12);
  await page.reload();
  await page.locator('[data-inspiration-view="outline"]').click();
  await expect(page.locator('#inspirationBatchPreviewLabel')).toContainText('12 / 24 章');
  await page.locator('#inspirationBatchPreviewLabel').click();
  await expect(page.locator('#inspirationBatchPreviewContent')).toContainText(synopsis(13));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#inspirationBatchPreviewLabel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/inspiration-v2-batch-recovery-mobile.png' });
  const requestCount = requests.length;
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存');
  const retry = requests.slice(requestCount);
  expect(retry).not.toHaveLength(0);
  expect(retry.every((req) => req.includes('生成第 14–25 章'))).toBe(true);
  expect(retry.some((req) => req.includes('【故事结构规划任务】'))).toBe(false);
  const complete = await saved(page);
  expect(complete.outline).toHaveLength(25);
  expect(complete.outline[0].summary).toBe(existing[0].summary);
  expect(complete.chapters[0].content).toBe('第一章作者定稿，不可覆盖。');
  expect(complete.uiDrafts.inspirationWriter.outlineBatchDraft).toBeUndefined();
});

test('inspiration-v2 修改灵感使旧分批草稿失效，旧稿保留在历史中', async ({ page }) => {
  await login(page);
  await configure(page);
  const requests = await mock(page, { failBatchOnceFrom: 13 });
  await project(page, { project: { title: '长篇小说', setting: '钟声抹除记忆。', chapterCount: 25 } });
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('TEST_BATCH_UNAVAILABLE');
  await expect(page.locator('#inspirationRun')).toBeEnabled();
  await page.locator('[data-inspiration-view="ideas"]').click();
  await page
    .locator('#inspirationSeedInput')
    .fill('NEW_AUTHOR_INTENT：钟声其实来自未来，主角要查清纸面证据的时间来源。');
  const count = requests.length;
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存');
  expect(requests.slice(count).some((req) => req.includes('生成第 1–12 章'))).toBe(true);
  expect(requests.slice(count).every((req) => req.includes('NEW_AUTHOR_INTENT'))).toBe(true);
  const history = (await saved(page)).uiDrafts.inspirationWriter.outlineHistory;
  expect(
    history.some(
      (item: { source: string; chapters: unknown[] }) =>
        item.source.includes('未完成规划草稿') && item.chapters.length === 12,
    ),
  ).toBe(true);
});

test('inspiration-v2 分批审校记录缺失时不冒充已审校，也不重新付费生成', async ({ page }) => {
  await login(page);
  await configure(page);
  const requests = await mock(page, { failBatchOnceFrom: 13 });
  await project(page, { project: { title: '长篇小说', setting: '钟声抹除记忆。', chapterCount: 25 } });
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('TEST_BATCH_UNAVAILABLE');
  await expect(page.locator('#inspirationRun')).toBeEnabled();
  await page.evaluate(async () => {
    state.uiDrafts.inspirationWriter.outlineBatchDraft.reports = [];
    await Store.save();
  });
  await page.reload();
  const count = requests.length;
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('分批审校记录缺失');
  expect(requests.length).toBe(count);
  const data = await saved(page);
  expect(data.outline).toEqual([]);
  expect(data.uiDrafts.inspirationWriter.outlineBatchDraft.chapters).toHaveLength(12);
  expect(data.uiDrafts.generationQualityReports?.outline).toBeFalsy();
});

test('inspiration-v2 单一灵感先生成完整大纲，确认与手改后才写正文', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await configure(page);
  const requests = await mock(page);
  await page.locator('#inspirationSeed').fill('每次钟声响起，城里就有一个人被所有人遗忘。');
  await page.getByRole('button', { name: '开始规划小说 →' }).click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存', { timeout: 30000 });
  expect((await saved(page)).outline).toHaveLength(24);
  expect((await saved(page)).chapters).toEqual([]);
  expect(requests.some((request) => request.includes('【故事结构规划任务】'))).toBe(true);
  expect(requests.some((request) => request.includes('【结构精修任务】'))).toBe(true);
  expect(requests.some((request) => request.includes('【按场景蓝图写作｜正文阶段】'))).toBe(false);
  await expect(page.locator('#inspirationOutlineOverview')).toContainText(synopsis(24));
  await expect(page.locator('#inspirationOutlineQuality')).toHaveAttribute('data-freshness', 'current');
  await expect(page.locator('#inspirationOutlineQuality details')).not.toHaveAttribute('open', '');
  expect((await page.locator('#inspirationWrite').boundingBox())!.y).toBeLessThan(400);
  await page.screenshot({ path: 'test-results/inspiration-v2-outline-desktop.png' });
  await page.locator('[data-outline-chapter="1"]').click();
  await page.locator('#inspirationOutlineTitle').fill('作者修改的钟下之信');
  await expect(page.locator('#inspirationOutlineQuality')).toContainText('内容已改');
  await page.locator('#inspirationOutlineSummary').fill(synopsis(1) + '作者要求：她把信封夹进值夜簿。');
  await page.getByRole('button', { name: '＋ 关键事件' }).click();
  await page.getByLabel('关键事件 3', { exact: true }).fill('新加事件可调整次序，不必编辑 JSON。');
  await page.getByRole('button', { name: '上移事件 3', exact: true }).click();
  await expect(page.getByLabel('关键事件 2', { exact: true })).toHaveValue(
    '新加事件可调整次序，不必编辑 JSON。',
  );
  await page.getByRole('button', { name: '删除事件 2', exact: true }).click();
  await page.locator('#inspirationSaveState').click();
  await page.reload();
  await page.locator('[data-outline-chapter="1"]').click();
  await expect(page.locator('#inspirationOutlineTitle')).toHaveValue('作者修改的钟下之信');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/inspiration-v2-outline-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '确认大纲，写第 1 章 →' }).click();
  await expect(page.locator('#inspirationStatus')).toContainText('第 1 章已保存', { timeout: 30000 });
  await expect(page.locator('#inspirationEditor')).toHaveValue(prose);
  expect(requests.find((request) => request.includes('【按场景蓝图写作｜正文阶段】'))).toContain(
    '作者要求：她把信封夹进值夜簿。',
  );
  await page.locator('#inspirationEditor').fill(prose + '\n作者手改正文。');
  await expect(page.locator('#inspirationProseQuality')).toContainText('内容已改');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await page.reload();
  await page.locator('[data-inspiration-view="write"]').click();
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('#inspirationEditor')).toHaveValue(prose + '\n作者手改正文。');
  await expect(page.getByRole('button', { name: '写第 2 章 →', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/inspiration-v2-prose-mobile.png' });
  await page.getByRole('button', { name: '完整工作台 ↗' }).click();
  await expect(page.locator('#tab-write')).toBeVisible();
});

test('inspiration-v2 新灵感先更新未来大纲，历史恢复不改变已写章节', async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  await configure(page);
  const requests = await mock(page);
  await project(page, {
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc, i) => ({ id: `point-${i}`, desc })),
    })),
    chapters: [{ chapter: 1, content: '作者已完成的第一章。' }],
    memory: {
      chapterCards: [{ chapter: 1, summary: 'STALE_INSPIRATION_MEMORY', contentHash: 'stale-source' }],
    },
    chapterMemories: { '2': { chapter: 2, content: 'STALE_INSPIRATION_NOTE', sourceHash: 'stale-source' } },
  });
  await page.locator('#inspirationAdditional > summary').click();
  await page.locator('#inspirationAdditionInput').fill('下一章守夜人带来一本失踪者账本。');
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
  await page.getByRole('button', { name: '更新未写章节大纲' }).click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存', { timeout: 30000 });
  const update = requests.find((request) => request.includes('【灵感开写 · 章节大纲】'))!;
  expect(update).toContain('生成第 2–3 章');
  expect(update).toContain('失踪者账本');
  expect(update).toContain('作者已完成的第一章。');
  expect(update).not.toContain('STALE_INSPIRATION_MEMORY');
  expect(update).not.toContain('STALE_INSPIRATION_NOTE');
  const data = await saved(page);
  expect(data.chapters[0].content).toBe('作者已完成的第一章。');
  expect(data.outline[0].summary).toBe(synopsis(1));
  expect(data.uiDrafts.inspirationWriter.additions[0].planned).toBe(true);
  await page.locator('[data-outline-chapter="2"]').click();
  await page.locator('#inspirationOutlineTitle').fill('手改后的第二章');
  await page.locator('#inspirationSaveState').click();
  await page.locator('#inspirationSidebar > details > summary').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '恢复未写章节' }).click();
  await expect(page.locator('#inspirationHistoryPreview')).toBeVisible();
  await expect(page.locator('#inspirationHistoryChanges')).toContainText('手改后的第二章');
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page.locator('#inspirationSaveState').click();
  const restored = await saved(page);
  expect(restored.chapters[0].content).toBe('作者已完成的第一章。');
  expect(restored.outline[1].title).toBe('钟楼证词 2');
  await page.getByRole('button', { name: '确认大纲，写第 2 章 →' }).click();
  await expect(page.locator('#inspirationStatus')).toContainText('第 2 章已保存', { timeout: 30000 });
  await page.locator('#inspirationChapterSelect').selectOption('1');
  await expect(page.locator('#inspirationEditor')).toHaveValue('作者已完成的第一章。');
});

test('inspiration-v2 连续追加灵感保留写作要求、关键点身份，正文沿用已采用意图', async ({ page }) => {
  test.setTimeout(60000);
  await login(page);
  await configure(page);
  const requests = await mock(page);
  await project(page, {
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      authorExtension: `chapter-${item.chapter}`,
      plotPoints: item.plotPoints.map((desc, i) => ({
        id: `original-${item.chapter}-${i}`,
        desc: item.chapter === 2 && i === 1 ? '需要被新计划替换的旧事件' : desc,
        done: true,
        authorAnnotation: '保留不变事件的作者标记',
      })),
    })),
    chapters: [{ chapter: 1, content: '第一章作者定稿。' }],
  });
  await page.locator('[data-inspiration-view="outline"]').click();
  await page.locator('[data-outline-chapter="2"]').click();
  await page.locator('#inspirationOutlineEditor details > summary').click();
  const note = 'AUTHOR_DIRECTIVE：本章不揭露姐姐的身份，用动作而非旁白说明人物矛盾。';
  await page.locator('#inspirationOutlineNote').fill(note);
  await page.locator('#inspirationAdditional > summary').click();
  const firstIdea = 'ADOPTED_FIRST：下一章守夜人交换证据时必须放弃值夜资格。';
  await page.locator('#inspirationAdditionInput').fill(firstIdea);
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存');
  const first = await saved(page);
  const revised = first.outline[1];
  expect(revised.note).toBe(note);
  expect(revised.authorExtension).toBe('chapter-2');
  expect(revised.plotPoints[0]).toEqual({
    id: 'original-2-0',
    desc: outlineRows(2, 2)[0].plotPoints[0],
    done: true,
    authorAnnotation: '保留不变事件的作者标记',
  });
  expect(revised.plotPoints[1].done).toBe(false);
  expect(revised.plotPoints[1].id).not.toBe('original-2-1');
  const pointIds = first.outline.flatMap((ch: { plotPoints: { id: string }[] }) =>
    ch.plotPoints.map((p) => p.id),
  );
  expect(new Set(pointIds).size).toBe(pointIds.length);
  expect(first.outline[0].plotPoints[0].id).toBe('original-1-0');
  await page.reload();
  await page.locator('[data-outline-chapter="2"]').click();
  await expect(page.locator('#inspirationOutlineNote')).toHaveValue(note);
  await page.locator('#inspirationOutlineEditor details > summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#inspirationOutlineNote').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/inspiration-v2-retained-instructions-mobile.png' });
  await page.locator('#inspirationAdditional > summary').click();
  const secondIdea = 'ADOPTED_SECOND：找到姐姐之前必须留下两份可以独立核验的记录。';
  await page.locator('#inspirationAdditionInput').fill(secondIdea);
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存');
  const update = requests.filter((req) => req.includes('【灵感开写 · 章节大纲】')).at(-1)!;
  expect(update).toContain(firstIdea);
  expect(update).toContain(secondIdea);
  expect(update).toContain(note);
  const second = await saved(page);
  expect(second.outline[1].plotPoints).toEqual(revised.plotPoints);
  expect(second.outline[1].note).toBe(note);
  await page.locator('#inspirationWrite').click();
  await expect(page.locator('#inspirationStatus')).toContainText('第 2 章已保存');
  for (const stage of ['【场景蓝图规划任务】', '【按场景蓝图写作｜正文阶段】', '【章节正文精修任务】']) {
    const request = requests.find((req) => req.includes(stage))!;
    expect(request).toContain(firstIdea);
    expect(request).toContain(secondIdea);
    expect(request).toContain(note);
    expect(request).toContain('不是已发生的正史');
  }
  expect((await saved(page)).chapters[0].content).toBe('第一章作者定稿。');
});

test('inspiration-v2 完整工作台也沿用采用的灵感，未融入的改动不进入正文上下文', async ({ page }) => {
  await login(page);
  await configure(page);
  await project(page, {
    uiDrafts: {
      inspirationWriter: {
        version: 2,
        mode: 'inspiration',
        phase: 'review',
        view: 'ideas',
        seed: 'UNPLANNED_SEED：作者正在修改的新起点。',
        builtSeed: 'PLANNED_SEED：已经采用的故事起点。',
        additions: [
          { id: 'adopted', text: 'ADOPTED_INTENT：暴露证据必须付出关系代价。', planned: true },
          { id: 'pending', text: 'PENDING_INTENT：未经更新的新灵感。', planned: false },
        ],
      },
    },
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc) => ({ desc })),
    })),
  });
  await page.locator('#inspirationFull').click();
  const contexts = await page.evaluate(() =>
    Object.fromEntries(
      ['outline', 'chapter', 'continue', 'review', 'memory'].map((target) => [
        target,
        globalThis.buildExtraWritingContext(target),
      ]),
    ),
  );
  expect(contexts.outline).toContain('UNPLANNED_SEED');
  expect(contexts.outline).toContain('PENDING_INTENT');
  for (const target of ['chapter', 'continue', 'review']) {
    expect(contexts[target]).toContain('PLANNED_SEED');
    expect(contexts[target]).toContain('ADOPTED_INTENT');
    expect(contexts[target]).not.toContain('UNPLANNED_SEED');
    expect(contexts[target]).not.toContain('PENDING_INTENT');
    expect(contexts[target]).toContain('不让视角人物预知未来');
  }
  expect(contexts.memory).not.toContain('ADOPTED_INTENT');
});

test('inspiration-v2 余额失败与保存冲突在请求前停止，不误进入正文', async ({ page }) => {
  await login(page);
  await configure(page);
  let calls = 0;
  await page.route(`${base}/chat/completions`, async (route) => {
    calls++;
    await route.fulfill({ status: 402, body: '{"error":{"message":"Insufficient Balance"}}' });
  });
  const id = await project(page);
  await page.getByRole('button', { name: '生成章节大纲 →' }).click();
  await expect(page.locator('#inspirationStatus')).toContainText('HTTP 402');
  expect(calls).toBe(1);
  await page.reload();
  await expect(page.locator('#inspirationStatus')).toContainText('HTTP 402');
  await expect(page.locator('#inspirationSeedInput')).toHaveValue('一封来自明天的信。');
  const current = await (await page.request.get(`/api/projects/${id}/state`)).json();
  await page.request.put(`/api/projects/${id}/state`, {
    data: {
      revision: current.revision,
      state: { ...current.state, project: { ...current.state.project, setting: '另一台设备确认的新背景' } },
    },
  });
  await page.getByRole('button', { name: '重试章节大纲' }).click();
  await expect(page.locator('#serverConflictModal.show')).toBeVisible();
  await expect(page.locator('#inspirationStatus')).toContainText('保存冲突');
  expect(calls).toBe(1);
  expect((await saved(page)).project.setting).toBe('另一台设备确认的新背景');
});

test('inspiration-v2 不完整输出不覆盖已有大纲，也不能用新灵感绕过确认', async ({ page }) => {
  test.setTimeout(60000);
  await login(page);
  await configure(page);
  await mock(page, { incomplete: true });
  const original = outlineRows(1, 3).map((item) => ({
    ...item,
    plotPoints: item.plotPoints.map((desc) => ({ desc })),
  }));
  await project(page, { outline: original });
  await page.locator('#inspirationAdditional > summary').click();
  await page.locator('#inspirationAdditionInput').fill('保留原事件，补足人物代价。');
  await page.getByRole('button', { name: '更新未写章节大纲' }).click();
  await expect(page.locator('#inspirationStatus')).toContainText('大纲不完整', { timeout: 30000 });
  expect((await saved(page)).outline.map((item: { title: string }) => item.title)).toEqual(
    original.map((item) => item.title),
  );
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
  expect((await saved(page)).chapters).toEqual([]);
});

test('inspiration-v2 真实分块流式接收时可浏览旧章，停止与刷新保留草稿', async ({ page }) => {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '【故事结构蓝图】\n正在规划但尚未结束的章节大纲' } }] })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await login(page);
    await configure(page, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await project(page, { chapters: [{ chapter: 1, content: '第一章原文，不可覆盖。' }] });
    await page.getByRole('button', { name: '生成章节大纲 →' }).click();
    await expect(page.locator('#inspirationProcessText')).toContainText('正在规划但尚未结束');
    await page.locator('[data-inspiration-view="write"]').click();
    await expect(page.locator('#inspirationEditor')).toHaveValue('第一章原文，不可覆盖。');
    await page.evaluate(() => globalThis.saveEditableStateNow());
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试章节大纲' })).toBeEnabled();
    expect((await saved(page)).chapters[0].content).toBe('第一章原文，不可覆盖。');
    await page.reload();
    await expect(page.locator('#inspirationProcessText')).toContainText('正在规划但尚未结束');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('inspiration-v2 旧单章模式安全升级且允许手工补齐大纲', async ({ page }) => {
  await login(page);
  await configure(page);
  await project(page, {
    uiDrafts: {
      inspirationWriter: { mode: 'inspiration', seed: '旧版灵感', phase: 'done', plans: { 1: {} } },
    },
    outline: [
      { chapter: 1, title: '旧第一章', summary: '旧版概要保持不变', plotPoints: [{ desc: '旧事件' }] },
    ],
    chapters: [{ chapter: 1, content: '旧正文保持不变。' }],
  });
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
  await page.getByRole('button', { name: '＋ 补一章' }).click();
  await page.locator('#inspirationOutlineSummary').fill('手动补齐第二章');
  await page.getByLabel('关键事件 1', { exact: true }).fill('第二章事件');
  await page.getByRole('button', { name: '＋ 补一章' }).click();
  await page.locator('#inspirationOutlineSummary').fill('手动补齐第三章');
  await page.getByLabel('关键事件 1', { exact: true }).fill('第三章事件');
  await page.locator('#inspirationSaveState').click();
  await expect(page.locator('#inspirationWrite')).toBeEnabled();
  const data = await saved(page);
  expect(data.chapters[0].content).toBe('旧正文保持不变。');
  expect(data.outline[0].summary).toBe('旧版概要保持不变');
});

test('inspiration-v2 正文流式期间可阅读旧章，取消后保留正文草稿与重试目标', async ({ page }) => {
  const partial = '第二章，沈澄把原件交给邻居。闻砚第一次无法独占证词，她决定留下两份纸面记录。';
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let input = '';
    req.on('data', (chunk) => {
      input += chunk;
    });
    req.on('end', () => {
      const last = JSON.parse(input).messages.at(-1).content;
      const isProse = last.includes('【按场景蓝图写作｜正文阶段】');
      const content = isProse
        ? partial
        : '【本章场景蓝图】\n场景1｜沈澄保护原件，闻砚必须交出抄本｜PP1｜1000字\n场景2｜港民独立核验记录，证词不再属于一个人｜PP2｜1200字';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      if (!isProse) res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await login(page);
    await configure(page, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await project(page, {
      outline: outlineRows(1, 3).map((item) => ({
        ...item,
        plotPoints: item.plotPoints.map((desc) => ({ desc })),
      })),
      chapters: [{ chapter: 1, content: '第一章作者原文，保持不变。' }],
    });
    await page.locator('#inspirationWrite').click();
    await expect(page.locator('#inspirationEditor')).toHaveValue(partial);
    await page.locator('#inspirationChapterSelect').selectOption('1');
    await expect(page.locator('#inspirationEditor')).toHaveValue('第一章作者原文，保持不变。');
    await page.evaluate(() => globalThis.saveEditableStateNow());
    await page.locator('#inspirationStop').click();
    await expect(page.getByRole('button', { name: '重试第 2 章', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('button', { name: '重试第 2 章', exact: true })).toBeEnabled();
    const data = await saved(page);
    expect(data.chapters.find((item: { chapter: number }) => item.chapter === 1).content).toBe(
      '第一章作者原文，保持不变。',
    );
    expect(data.chapters.find((item: { chapter: number }) => item.chapter === 2).content).toContain(partial);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('inspiration-v2 无效方向建议只修复一次，错误保留灵感且不开始大纲或正文', async ({ page }) => {
  await login(page);
  await configure(page);
  const requests = await mock(page, { malformedFoundation: true });
  await project(page);
  await page.screenshot({ path: 'test-results/inspiration-v2-ideas-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#inspirationView-ideas details')).not.toHaveAttribute('open', '');
  await expect(page.locator('#inspirationProcess')).toBeHidden();
  await page.screenshot({ path: 'test-results/inspiration-v2-ideas-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.locator('#inspirationRun').click();
  await expect(page.getByRole('button', { name: '重试章节大纲', exact: true })).toBeEnabled();
  expect(requests).toHaveLength(2);
  expect((await saved(page)).outline).toEqual([]);
  expect((await saved(page)).chapters).toEqual([]);
  await page.reload();
  await expect(page.locator('#inspirationSeedInput')).toHaveValue('一封来自明天的信。');
});

test('inspiration-v2 已有大纲的旧书修改初始灵感也必须先更新计划', async ({ page }) => {
  await login(page);
  await configure(page);
  await project(page, {
    uiDrafts: {
      inspirationWriter: { version: 2, mode: 'inspiration', seed: '', phase: 'review', view: 'ideas' },
    },
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc) => ({ desc })),
    })),
  });
  await expect(page.locator('#inspirationWrite')).toBeEnabled();
  await page.locator('#inspirationSeedInput').fill('作者新灵感：原件上的署名来自未来。');
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
  await page.locator('#inspirationSaveState').click();
  await page.reload();
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
  await page.locator('#inspirationSeedInput').fill('');
  await expect(page.locator('#inspirationWrite')).toBeEnabled();
});

for (const hold of ['draft', 'review'] as const) {
  test(`inspiration-v2 ${hold}阶段直接刷新，检查点可恢复正文且不混入精修诊断`, async ({ page }) => {
    const model = await heldProseServer(hold);
    try {
      await login(page);
      await configure(page, model.url);
      await project(page, {
        outline: outlineRows(1, 3).map((item) => ({
          ...item,
          plotPoints: item.plotPoints.map((desc) => ({ desc })),
        })),
        chapters: [{ chapter: 1, content: '第一章原文始终保留。' }],
      });
      await page.locator('#inspirationWrite').click();
      await expect(page.locator('#inspirationProcessText')).toContainText(
        hold === 'review' ? 'REVIEW_ONLY_SENTINEL' : model.partial,
      );
      await expect
        .poll(async () => (await saved(page)).uiDrafts.inspirationWriter.recoveryDraft?.prose)
        .toContain(hold === 'review' ? '沈澄在钟楼底下' : model.partial);
      await expect(page.locator('#inspirationSaveState')).toHaveText('草稿已保存');
      expect(
        (await saved(page)).chapters.find((item: { chapter: number }) => item.chapter === 2),
      ).toBeUndefined();
      const requestCount = model.requests.length;
      page.once('dialog', (dialog) => dialog.accept());
      await page.reload();
      const expectedDraft = hold === 'review' ? prose : model.partial;
      const afterReload = await saved(page);
      const alreadyRecovered =
        afterReload.chapters.find((item: { chapter: number }) => item.chapter === 2)?.content ===
        expectedDraft;
      // The native abort handler may have committed the draft during navigation.
      // In that case no redundant restore button is needed; prove the same text survived.
      if (!alreadyRecovered) await expect(page.locator('#inspirationRecoverProse')).toBeVisible();
      if (hold === 'review') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: 'test-results/inspiration-v2-recovery-mobile.png' });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        await page.locator('#inspirationProcessLabel').click();
        await page.locator('[data-inspiration-view="outline"]').click();
        await expect(page.locator('#inspirationProcess')).not.toHaveAttribute('open', '');
        await page.locator('#inspirationProcessLabel').click();
      }
      expect(model.requests).toHaveLength(requestCount);
      if (!alreadyRecovered) {
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#inspirationRecoverProse').click();
        await expect(page.locator('#inspirationStatus')).toContainText('接收初稿已恢复并保存');
      }
      await expect(page.locator('#inspirationEditor')).toHaveValue(hold === 'review' ? prose : model.partial);
      const data = await saved(page);
      expect(data.chapters[0].content).toBe('第一章原文始终保留。');
      expect(data.chapters[1].content).not.toContain('REVIEW_ONLY_SENTINEL');
      if (!alreadyRecovered)
        expect(data.uiDrafts.generationQualityReports.chapters['2'].status).toBe('unverified');
      await page.reload();
      await expect(page.locator('#inspirationEditor')).toHaveValue(hold === 'review' ? prose : model.partial);
      await expect(page.locator('#inspirationRecovery')).toBeHidden();
      expect(model.requests).toHaveLength(requestCount);
    } finally {
      await model.close();
    }
  });
}

test('inspiration-v2 生成中的检查点冲突会停止请求，保留其他设备版本', async ({ page }) => {
  const model = await heldProseServer();
  try {
    await login(page);
    await configure(page, model.url);
    const id = await project(page, {
      outline: outlineRows(1, 3).map((item) => ({
        ...item,
        plotPoints: item.plotPoints.map((desc) => ({ desc })),
      })),
      chapters: [{ chapter: 1, content: '另一设备的原文。' }],
    });
    await page.locator('#inspirationWrite').click();
    await expect(page.locator('#inspirationProcessText')).toContainText(model.partial);
    const remote = await (await page.request.get(`/api/projects/${id}/state`)).json();
    const updated = await page.request.put(`/api/projects/${id}/state`, {
      data: {
        revision: remote.revision,
        state: { ...remote.state, project: { ...remote.state.project, setting: 'OTHER_DEVICE_CANON' } },
      },
    });
    expect(updated.ok()).toBeTruthy();
    await expect(page.locator('#inspirationStatus')).toContainText('保存冲突', { timeout: 10000 });
    await expect(page.locator('#inspirationStop')).toBeHidden();
    expect(model.requests.filter((request) => request.includes('【按场景蓝图写作｜正文阶段】'))).toHaveLength(
      1,
    );
    const preserved = await (await page.request.get(`/api/projects/${id}/state`)).json();
    expect(preserved.state.project.setting).toBe('OTHER_DEVICE_CANON');
    expect(preserved.state.chapters).toHaveLength(1);
    await expect(page.locator('#inspirationProcessText')).toContainText(model.partial);
  } finally {
    await model.close();
  }
});

test('inspiration-v2 恢复草稿不静默替换当前正文，确认后保留原稿快照', async ({ page }) => {
  await login(page);
  await configure(page);
  const requests = await mock(page);
  const original = '作者后来重新写好的第二章。';
  await project(page, {
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc) => ({ desc })),
    })),
    chapters: [
      { chapter: 1, content: '第一章保持不变。' },
      { chapter: 2, content: original },
    ],
    uiDrafts: {
      inspirationWriter: {
        version: 2,
        mode: 'inspiration',
        seed: '旧灵感',
        view: 'write',
        phase: 'writing',
        lastTask: 'write',
        pendingChapter: 2,
        recoveryDraft: {
          task: 'write',
          phase: '精修',
          chapter: 2,
          prose: '收到的早期第二章初稿。',
          text: '精修尚未完成。',
          previousContentHash: 'old-checkpoint',
        },
      },
    },
  });
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('正文已在检查点后变化');
    return dialog.dismiss();
  });
  await page.locator('#inspirationRecoverProse').click();
  expect((await saved(page)).chapters[1].content).toBe(original);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#inspirationRecoverProse').click();
  await expect(page.locator('#inspirationStatus')).toContainText('接收初稿已恢复并保存');
  const data = await saved(page);
  expect(data.chapters[0].content).toBe('第一章保持不变。');
  expect(data.chapters[1].content).toBe('收到的早期第二章初稿。');
  expect(
    data.chapterSnapshots.some(
      (item: { chapter: number; content: string }) => item.chapter === 2 && item.content === original,
    ),
  ).toBe(true);
  expect(requests).toEqual([]);
});

test('inspiration-v2 较早的保存返回时，不能误报后续修改已保存', async ({ page }) => {
  await login(page);
  const id = await project(page);
  await page.evaluate(async () => {
    await Store.saving;
  });
  const release: Array<() => void> = [];
  let writes = 0;
  await page.route(`**/api/projects/${id}/state`, async (route) => {
    if (!['PUT', 'PATCH'].includes(route.request().method())) {
      await route.continue();
      return;
    }
    writes++;
    if (writes <= 2) await new Promise<void>((resolve) => release.push(resolve));
    await route.continue();
  });
  try {
    await page.locator('#inspirationSeedInput').fill('第一版灵感');
    await page.locator('#inspirationSaveState').click();
    await expect.poll(() => writes).toBe(1);
    await page.locator('#inspirationSeedInput').fill('保存尚未结束时，作者又补充了新的灵感。');
    await page.locator('#inspirationSaveState').click();
    release[0]();
    await expect.poll(() => writes).toBe(2);
    await expect(page.locator('#inspirationSaveState')).toHaveText('保存中');
    expect(
      await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    release[1]();
    await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
    await page.reload();
    await expect(page.locator('#inspirationSeedInput')).toHaveValue('保存尚未结束时，作者又补充了新的灵感。');
  } finally {
    release.forEach((resolve) => resolve());
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('inspiration-v2 手改查看中的旧章会使审校过期，并记录到正确章节', async ({ page }) => {
  await login(page);
  await configure(page);
  const requests = await mock(page);
  await project(page, {
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc) => ({ desc })),
    })),
    chapters: [
      { chapter: 1, content: '已审校第一章。' },
      { chapter: 2, content: '已审校第二章。' },
    ],
  });
  await page.evaluate(() => {
    state.uiDrafts.generationQualityReports = {
      chapters: {
        '1': globalThis.generationQuality.createReport(
          { status: 'reviewed', mode: 'chapter', feedback: '第一章审校意见。' },
          'chapter',
          1,
          '已审校第一章。',
        ),
        '2': globalThis.generationQuality.createReport(
          { status: 'reviewed', mode: 'chapter', feedback: '第二章审校意见。' },
          'chapter',
          2,
          '已审校第二章。',
        ),
      },
    };
    state.currentChapter = 2;
    state.editorAgent.focusExcerpts = [
      { id: 'old-focus', chapter: 1, start: 0, end: '已审校第一章。'.length, text: '已审校第一章。' },
    ];
    globalThis.renderWriteTab();
    globalThis.switchTab('inspiration');
  });
  await page.locator('[data-inspiration-view="write"]').click();
  await page.locator('#inspirationChapterSelect').selectOption('1');
  await expect(page.locator('#inspirationProseQuality')).toHaveAttribute('data-freshness', 'current');
  await page.locator('#inspirationProseQuality summary').click();
  await page.locator('#inspirationEditor').fill('作者修订了第一章的对话与人物选择。');
  await expect(page.locator('#inspirationProseQuality')).toContainText('内容已改');
  await expect(page.locator('#inspirationProseQuality details')).toHaveAttribute('open', '');
  await expect
    .poll(() => page.evaluate(() => !!state.uiDrafts.authorProseFeedback?.['1']?.fingerprint))
    .toBe(true);
  expect(await page.evaluate(() => state.uiDrafts.authorProseFeedback?.['2'])).toBeUndefined();
  expect(await page.evaluate(() => state.editorAgent.focusExcerpts)).toEqual([]);
  await page.locator('#inspirationSaveState').click();
  await page.reload();
  await page.locator('[data-inspiration-view="write"]').click();
  await page.locator('#inspirationChapterSelect').selectOption('1');
  await expect(page.locator('#inspirationProseQuality')).toContainText('原审校仅供参考');
  await page.locator('#inspirationFull').click();
  await expect(page.locator('#tab-write')).toBeVisible();
  expect(await page.evaluate(() => state.currentChapter)).toBe(1);
  await expect(page.locator('#chapterEditor')).toHaveValue('作者修订了第一章的对话与人物选择。');
  expect(requests).toEqual([]);
});

test('inspiration-v2 审校指纹只跟踪故事文本，兼容旧版报告', async ({ page }) => {
  await login(page);
  await project(page);
  const result = await page.evaluate(() => {
    const old = [
      { chapter: 1, title: '标题', summary: '概要', plotPoints: [{ id: 'old', desc: '事件', done: false }] },
    ];
    const report = globalThis.generationQuality.createReport({ status: 'reviewed' }, 'outline', 0, old);
    const progress = [{ ...old[0], note: '', plotPoints: [{ id: 'new', desc: '事件', done: true }] }];
    const edited = [{ ...progress[0], summary: '作者重新安排了事件因果。' }];
    const raw = JSON.stringify(old);
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const legacy = {
      status: 'reviewed',
      fingerprint: `${raw.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`,
    };
    return {
      progress: globalThis.generationQuality.freshness(report, 'outline', progress),
      edited: globalThis.generationQuality.freshness(report, 'outline', edited),
      legacy: globalThis.generationQuality.freshness(legacy, 'outline', old),
      unknown: globalThis.generationQuality.freshness({ status: 'reviewed' }, 'outline', old),
    };
  });
  expect(result).toEqual({ progress: 'current', edited: 'stale', legacy: 'current', unknown: 'unknown' });
});

test('inspiration-v2 恢复历史大纲不会把后来的灵感误判为已融入', async ({ page }) => {
  await login(page);
  await configure(page);
  await mock(page);
  await project(page, {
    outline: outlineRows(1, 3).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc) => ({ desc })),
    })),
    chapters: [{ chapter: 1, content: '作者已经完成的第一章，始终不变。' }],
  });
  await page.locator('[data-outline-chapter="2"]').click();
  await page.locator('#inspirationOutlineTitle').fill('旧版第二章：先追查邮局');
  await page.locator('[data-inspiration-view="ideas"]').click();
  await page.locator('#inspirationSeedInput').fill('新灵感：邮局是一台会篡改未来的机器。');
  await page.locator('#inspirationAdditional > summary').click();
  await page.locator('#inspirationAdditionInput').fill('机器只能用守夜人的记忆运行。');
  await page.locator('#inspirationRun').click();
  await expect(page.locator('#inspirationStatus')).toContainText('章节大纲已保存');
  await page.locator('#inspirationSidebar > details > summary').click();
  await page.locator('#inspirationRestore').click();
  await expect(page.locator('#inspirationHistorySource')).toContainText('来自不同灵感');
  await expect(page.locator('#inspirationHistoryChanges')).toContainText('旧版第二章：先追查邮局');
  await page.screenshot({ path: 'test-results/inspiration-v2-history-desktop.png' });
  await expect(page.locator('.inspiration-history-versions h4')).toHaveCount(2);
  await expect(page.locator('.inspiration-history-versions h4').first()).toHaveText('章节标题');
  await expect(page.locator('.inspiration-history-versions details').first()).not.toHaveAttribute('open', '');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    document.getElementById('inspirationHistoryPreview')!.scrollIntoView({ block: 'start' }),
  );
  await page.screenshot({ path: 'test-results/inspiration-v2-history-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#inspirationHistoryConfirm').click();
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
  await page.locator('#inspirationSaveState').click();
  const data = await saved(page);
  expect(data.uiDrafts.inspirationWriter.seed).toBe('新灵感：邮局是一台会篡改未来的机器。');
  expect(data.uiDrafts.inspirationWriter.additions[0].planned).toBe(false);
  expect(data.chapters[0].content).toBe('作者已经完成的第一章，始终不变。');
  expect(data.outline[1].title).toBe('旧版第二章：先追查邮局');
  await page.reload();
  await expect(page.locator('#inspirationWrite')).toBeDisabled();
});

test('inspiration-v2 损坏的历史版本只展示警告，不移除当前大纲', async ({ page }) => {
  await login(page);
  const original = outlineRows(1, 3).map((item) => ({
    ...item,
    plotPoints: item.plotPoints.map((desc) => ({ desc })),
  }));
  await project(page, {
    outline: original,
    uiDrafts: {
      inspirationWriter: {
        version: 2,
        seed: '灵感',
        view: 'outline',
        phase: 'review',
        outlineHistory: [{ id: 'broken', time: Date.now(), source: '旧版缺字段记录', chapters: null }],
      },
    },
  });
  await page.locator('#inspirationSidebar > details > summary').click();
  await page.locator('#inspirationRestore').click();
  await expect(page.locator('#inspirationHistorySummary')).toContainText('不能恢复');
  await expect(page.locator('#inspirationHistoryConfirm')).toBeDisabled();
  expect((await saved(page)).outline.map((item: { title: string }) => item.title)).toEqual(
    original.map((item) => item.title),
  );
});

test('inspiration-v2 页面切换与无改动保存不新增版本，标签页仍记住视图', async ({ page }) => {
  await login(page);
  const id = await project(page);
  await page.locator('#inspirationSaveState').click();
  await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
  const before = await (await page.request.get(`/api/projects/${id}/state`)).json();
  const writes: string[] = [];
  page.on('request', (req) => {
    if (['PUT', 'PATCH'].includes(req.method())) writes.push(req.url());
  });
  for (const view of ['outline', 'write', 'ideas', 'write'])
    await page.locator(`[data-inspiration-view="${view}"]`).click();
  await page.evaluate(async () => {
    await Store.save();
  });
  const after = await (await page.request.get(`/api/projects/${id}/state`)).json();
  expect(after.revision).toBe(before.revision);
  expect(writes).toEqual([]);
  await page.reload();
  await expect(page.locator('#inspirationView-write')).toBeVisible();
});

test('inspiration-v2 修改小说不会把另一设备更新的共享 API 配置覆盖回旧值', async ({ page }) => {
  await login(page);
  await configure(page);
  await project(page);
  await page.locator('#inspirationSaveState').click();
  await page.request.put('/api/settings', {
    data: {
      apiConfigs: [
        {
          id: 'new-global',
          name: '其他设备新配置',
          baseURL: base,
          model: 'new-model',
          apiKey: 'new-test-only-key',
        },
      ],
      activeConfigId: 'new-global',
      ui: { theme: 'dark', accent: 'teal' },
    },
  });
  await page.locator('#inspirationSeedInput').fill('只修改当前书的灵感。');
  await page.locator('#inspirationSaveState').click();
  await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
  const settings = await (await page.request.get('/api/settings/runtime')).json();
  expect(settings.activeConfigId).toBe('new-global');
  expect(settings.apiConfigs[0].apiKey).toBe('new-test-only-key');
  expect(settings.ui).toEqual({ theme: 'dark', accent: 'teal' });
});

test('inspiration-v2 另一标签页只浏览生成检查点，不中断原设备任务', async ({ page, context }) => {
  const model = await heldProseServer();
  const reader = await context.newPage();
  try {
    await login(page);
    await configure(page, model.url);
    const id = await project(page, {
      outline: outlineRows(1, 3).map((item) => ({
        ...item,
        plotPoints: item.plotPoints.map((desc) => ({ desc })),
      })),
      chapters: [{ chapter: 1, content: '已写第一章。' }],
    });
    await page.locator('#inspirationWrite').click();
    await expect(page.locator('#inspirationProcessText')).toContainText(model.partial);
    await expect(page.locator('#inspirationSaveState')).toHaveText('草稿已保存');
    const before = await (await page.request.get(`/api/projects/${id}/state`)).json();
    const writes: string[] = [];
    reader.on('request', (req) => {
      if (['PUT', 'PATCH'].includes(req.method())) writes.push(req.url());
    });
    await reader.goto(`/workbench.html?project=${id}&mode=inspiration`);
    await expect(reader.locator('#tab-inspiration')).toBeVisible();
    await reader.locator('[data-inspiration-view="outline"]').click();
    await reader.locator('[data-inspiration-view="write"]').click();
    await reader.evaluate(async () => {
      await Store.save();
    });
    const after = await (await page.request.get(`/api/projects/${id}/state`)).json();
    expect(after.revision).toBe(before.revision);
    expect(after.state.uiDrafts.inspirationWriter.phase).toBe('writing');
    expect(writes).toEqual([]);
    await expect(page.locator('#inspirationStop')).toBeVisible();
    await page.locator('#inspirationStop').click();
    await expect(page.locator('#inspirationStop')).toBeHidden();
  } finally {
    await reader.close();
    await model.close();
  }
});

for (const kind of ['outline', 'write'] as const) {
  test(`inspiration-v2 ${kind}已生成但保存失败时，只重试保存而不再次生成`, async ({ page }) => {
    await login(page);
    await configure(page);
    const requests = await mock(page);
    const id = await project(
      page,
      kind === 'write'
        ? {
            outline: outlineRows(1, 3).map((item) => ({
              ...item,
              plotPoints: item.plotPoints.map((desc) => ({ desc })),
            })),
          }
        : {},
    );
    let blocked = true,
      holdRetry = false,
      retryHeld = false;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    await page.route(`**/api/projects/${id}/state`, async (route) => {
      if (['PUT', 'PATCH'].includes(route.request().method())) {
        const payload = route.request().postDataJSON();
        const updates =
          payload.patch?.operations?.filter((op: { op: string }) => ['add', 'replace'].includes(op.op)) || [];
        const phase =
          payload.state?.uiDrafts?.inspirationWriter?.phase ??
          updates.find((op: { path: string }) => op.path === '/uiDrafts/inspirationWriter/phase')?.value ??
          updates.find((op: { path: string }) => op.path === '/uiDrafts/inspirationWriter')?.value?.phase;
        if (blocked && phase === (kind === 'write' ? 'done' : 'review')) {
          await route.fulfill({ status: 503, json: { error: '模拟保存服务暂时不可用' } });
          return;
        }
        if (!blocked && holdRetry && phase === 'done') {
          holdRetry = false;
          retryHeld = true;
          await retryGate;
        }
      }
      await route.continue();
    });
    await page.locator(kind === 'write' ? '#inspirationWrite' : '#inspirationRun').click();
    const retry = page.getByRole('button', {
      name: kind === 'write' ? '重试保存第 1 章' : '重试保存大纲',
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await expect(page.locator('#inspirationStatus')).toContainText('仅需重试保存');
    const workRequests = () =>
      requests.filter(
        (r) =>
          r.includes('【灵感开写 · 章节大纲】') ||
          r.includes('【按场景蓝图写作｜正文阶段】') ||
          r.includes('【章节正文精修任务】'),
      ).length;
    const before = workRequests();
    if (kind === 'write') {
      await expect(page.locator('#inspirationEditor')).toHaveValue(prose);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'test-results/inspiration-v2-save-retry-mobile.png' });
    }
    blocked = false;
    holdRetry = kind === 'write';
    await retry.click();
    let expectedProse = prose;
    if (kind === 'write') {
      try {
        await expect.poll(() => retryHeld).toBe(true);
        expectedProse = prose + '\n重试保存期间，作者追加的文字也不能丢失。';
        await page.locator('#inspirationEditor').fill(expectedProse);
      } finally {
        releaseRetry();
      }
    }
    await expect(page.locator('#inspirationStatus')).toContainText('已保存');
    expect(workRequests()).toBe(before);
    const data = await saved(page);
    expect(data.uiDrafts.inspirationWriter.phase).toBe(kind === 'write' ? 'done' : 'review');
    if (kind === 'write') expect(data.chapters[0].content).toBe(expectedProse);
    else expect(data.outline).toHaveLength(3);
    await page.reload();
    expect(workRequests()).toBe(before);
  });
}

test('inspiration-v2 修改200章小说的一章只传改动，刷新后所有正文与历史保持一致', async ({ page }) => {
  await login(page);
  await configure(page);
  const chapters = Array.from({ length: 200 }, (_, i) => ({
    chapter: i + 1,
    content: `STORED_CHAPTER_${i + 1}：` + '原作者内容。'.repeat(160),
  }));
  const id = await project(page, {
    project: { title: '长篇增量保存', chapterCount: 200, wordsPerChapter: 2200 },
    chapters,
    outline: outlineRows(1, 200).map((item) => ({
      ...item,
      plotPoints: item.plotPoints.map((desc) => ({ desc })),
    })),
    chapterSnapshots: [{ id: 'old-snapshot', chapter: 42, content: '既有快照，不应重新发送或丢失。' }],
    uiDrafts: {
      inspirationWriter: {
        version: 2,
        mode: 'inspiration',
        phase: 'done',
        lastTask: 'write',
        view: 'write',
        seed: '',
        builtSeed: '',
      },
    },
  });
  await page.locator('#inspirationChapterSelect').selectOption('1');
  const writes: { method: string; body: string }[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith(`/api/projects/${id}/state`) && ['PUT', 'PATCH'].includes(req.method()))
      writes.push({ method: req.method(), body: req.postData() || '' });
  });
  const newBody = chapters[0].content + '\nSTORED_CHAPTER_1_MODIFIED：作者的最新修订。';
  await page.locator('#inspirationEditor').fill(newBody);
  await page.locator('#inspirationSave').click();
  await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((write) => write.method === 'PATCH')).toBe(true);
  expect(writes.map((write) => write.body).join('')).not.toContain('STORED_CHAPTER_42');
  expect(writes.reduce((total, write) => total + Buffer.byteLength(write.body), 0)).toBeLessThan(100_000);
  const data = await saved(page);
  expect(data.chapters).toHaveLength(200);
  expect(data.chapters[0].content).toBe(newBody);
  expect(data.chapters[41].content).toBe(chapters[41].content);
  expect(data.chapterSnapshots.some((row: { id: string }) => row.id === 'old-snapshot')).toBe(true);
  await page.reload();
  await page.locator('#inspirationChapterSelect').selectOption('1');
  await expect(page.locator('#inspirationEditor')).toHaveValue(newBody);
});

test('inspiration-v2 相同内容的排队保存只提交一次，真正的 API 配置修改仍能保存', async ({ page }) => {
  await login(page);
  await configure(page);
  const id = await project(page);
  await page.locator('#inspirationSaveState').click();
  await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
  const before = await (await page.request.get(`/api/projects/${id}/state`)).json();
  const writes: string[] = [];
  page.on('request', (req) => {
    if (['PUT', 'PATCH'].includes(req.method())) writes.push(req.url());
  });
  await page.locator('#inspirationSeedInput').fill('这一次只改一项灵感。');
  await page.evaluate(async () => {
    await Promise.all([Store.save(), Store.save(), Store.save()]);
  });
  await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
  const after = await (await page.request.get(`/api/projects/${id}/state`)).json();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.state.uiDrafts.inspirationWriter.seed).toBe('这一次只改一项灵感。');
  expect(writes.filter((url) => url.endsWith(`/projects/${id}/state`))).toHaveLength(1);
  expect(writes.filter((url) => url.endsWith('/settings'))).toHaveLength(0);
  await page.evaluate(async () => {
    state.apiConfigs[0].name = '作者明确改了配置名';
    await Store.save();
  });
  expect((await (await page.request.get('/api/settings/runtime')).json()).apiConfigs[0].name).toBe(
    '作者明确改了配置名',
  );
  expect(writes.filter((url) => url.endsWith('/settings'))).toHaveLength(1);
});

test('inspiration-v2 延迟保存冲突时，对比界面包含请求发出后的最新本地修改', async ({ page }) => {
  await login(page);
  const id = await project(page);
  await page.locator('#inspirationSaveState').click();
  await expect(page.locator('#inspirationSaveState')).toHaveText('已保存');
  const original = await (await page.request.get(`/api/projects/${id}/state`)).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/projects/${id}/state`, async (route) => {
    if (!intercepted && ['PUT', 'PATCH'].includes(route.request().method())) {
      intercepted = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.locator('#inspirationSeedInput').fill('最早发出的修改。');
    await page.locator('#inspirationSaveState').click();
    await expect.poll(() => intercepted).toBe(true);
    const remote = structuredClone(original.state);
    remote.uiDrafts.inspirationWriter.seed = '另一设备写下的灵感。';
    expect(
      (
        await page.request.put(`/api/projects/${id}/state`, {
          data: { revision: original.revision, state: remote },
        })
      ).ok(),
    ).toBe(true);
    await page.locator('#inspirationSeedInput').fill('等待保存期间写下的最新本地修改。');
    release();
    await expect(page.locator('#serverConflictModal')).toBeVisible();
    await expect(page.locator('#serverConflictModal')).toContainText('等待保存期间写下的最新本地修改。');
    expect(
      (await (await page.request.get(`/api/projects/${id}/state`)).json()).state.uiDrafts.inspirationWriter
        .seed,
    ).toBe('另一设备写下的灵感。');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
