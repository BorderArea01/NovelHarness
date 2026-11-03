import { test, expect } from '@playwright/test';

test('setup, create a project and use the full AI workbench as the primary workspace', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.getByPlaceholder('四位 PIN')).toBeVisible();
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await expect(page.getByRole('heading', { name: '📚 我的小说' })).toBeVisible();
  await page.getByRole('button', { name: 'API 设置' }).click();
  const settingsDialog = page.locator('#settingsDialog');
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole('button', { name: '下次刷新显示引导' })).toHaveCount(0);
  await settingsDialog.getByRole('button', { name: '取消' }).click();
  await expect(settingsDialog).not.toBeVisible();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  const projectDialog = page.locator('#projectDialog');
  await projectDialog.getByRole('button', { name: '取消' }).click();
  await expect(projectDialog).not.toBeVisible();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('端到端测试小说');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await expect(page.locator('#serverSaveIndicator')).toBeVisible();
  await expect(page).toHaveTitle(/长篇小说写作助手/);
  await expect(page.getByRole('button', { name: /生成.*大纲|大纲/ }).first()).toBeVisible();
  await expect(page.locator('#tab-creative-flow')).toBeVisible();
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal.show');
  if (await onboarding.isVisible()) {
    await expect(onboarding.getByRole('heading', { name: '从画布开始' })).toBeVisible();
    await expect(onboarding.locator('.guide-steps')).toHaveCount(0);
    await expect(onboarding).toContainText('双击建便笺，拖线连思路。');
    await onboarding.getByRole('button', { name: '✕' }).click();
  }
  const canvas = page.locator('#creativeCanvasViewport');
  const stageNodes = page.locator('.creative-canvas-stage');
  await expect(stageNodes).toHaveCount(0);
  const canvasEmptyState = page.locator('#creativeCanvasEmpty');
  await expect(canvasEmptyState).toContainText('从一个念头开始');
  await expect(canvasEmptyState.getByRole('button', { name: '写下灵感' })).toBeVisible();
  await expect(canvasEmptyState.getByRole('button', { name: '随机灵感' })).toBeVisible();
  await canvasEmptyState.getByRole('button', { name: '写下灵感' }).click();
  const firstIdeaNote = page.locator('.creative-canvas-note');
  await expect(firstIdeaNote).toHaveCount(1);
  await expect(canvasEmptyState).toBeHidden();
  page.once('dialog', (dialog) => dialog.accept());
  await firstIdeaNote.getByRole('button', { name: '删除' }).click();
  await expect(firstIdeaNote).toHaveCount(0);
  await expect(canvasEmptyState).toBeVisible();
  await canvasEmptyState.getByRole('button', { name: '随机灵感' }).click();
  await expect(firstIdeaNote).toHaveCount(1);
  await expect(firstIdeaNote.getByLabel('便笺内容')).not.toHaveValue('');
  page.once('dialog', (dialog) => dialog.accept());
  await firstIdeaNote.getByRole('button', { name: '删除' }).click();
  await expect(canvasEmptyState).toBeVisible();
  await expect(page.getByRole('button', { name: 'AI 共创', exact: true })).toHaveCount(0);
  await expect(page.locator('.creative-canvas-toolbar button:visible')).toHaveCount(4);
  await canvas.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/creative-workflow-focused-start.png', fullPage: true });
  const stagePresets = [
    ['premise', '故事起点'],
    ['bible', '人物与世界'],
    ['outline', '故事结构'],
    ['draft', '章节写作'],
    ['revise', '编辑与审阅'],
    ['publish', '整理与发布'],
    ['spark', '灵感共创'],
  ];
  await page.getByRole('button', { name: '添加节点' }).click();
  await page
    .locator('#creativeCanvasAddMenu')
    .getByRole('menuitem', { name: '故事起点', exact: true })
    .click();
  await expect(page.locator('.creative-canvas-stage[data-workflow-id="premise"]')).toBeVisible();
  await page.evaluate(async () => {
    state.uiDrafts.creativeCanvas = {
      version: 1,
      nodes: [
        { id: 'stage:premise', kind: 'stage', stageId: 'premise', x: 80, y: 350 },
        { id: 'stage:bible', kind: 'stage', stageId: 'bible', x: 410, y: 55 },
        { id: 'stage:outline', kind: 'stage', stageId: 'outline', x: 420, y: 350 },
        { id: 'stage:draft', kind: 'stage', stageId: 'draft', x: 760, y: 350 },
        { id: 'stage:revise', kind: 'stage', stageId: 'revise', x: 1100, y: 210 },
        { id: 'stage:publish', kind: 'stage', stageId: 'publish', x: 1100, y: 590 },
        { id: 'stage:spark', kind: 'stage', stageId: 'spark', x: 770, y: 55 },
      ],
      edges: [
        { id: 'edge:default:0', from: 'stage:premise', to: 'stage:outline', kind: 'main' },
        { id: 'edge:default:1', from: 'stage:outline', to: 'stage:draft', kind: 'main' },
        { id: 'edge:default:2', from: 'stage:draft', to: 'stage:revise', kind: 'main' },
        { id: 'edge:default:3', from: 'stage:revise', to: 'stage:publish', kind: 'main' },
        { id: 'edge:default:4', from: 'stage:bible', to: 'stage:outline', kind: 'reference' },
        { id: 'edge:default:5', from: 'stage:spark', to: 'stage:outline', kind: 'reference' },
        { id: 'edge:default:6', from: 'stage:spark', to: 'stage:draft', kind: 'reference' },
      ],
      hiddenStageIds: [],
      arcPositions: {},
    };
    await Store.save();
  });
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(stageNodes).toHaveCount(0);
  await expect(page.locator('#creativeCanvasEmpty')).toBeVisible();
  const migratedCanvas = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const canvas = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
    return {
      nodes: canvas.nodes.length,
      edges: canvas.edges.length,
      hidden: canvas.hiddenStageIds,
    };
  });
  expect(migratedCanvas).toEqual({
    nodes: 7,
    edges: 7,
    hidden: ['premise', 'bible', 'outline', 'draft', 'revise', 'publish', 'spark'],
  });
  for (const [stageId, title] of stagePresets) {
    await page.getByRole('button', { name: '添加节点' }).click();
    const addMenu = page.locator('#creativeCanvasAddMenu');
    await expect(addMenu).toBeVisible();
    await addMenu.getByRole('menuitem', { name: `恢复：${title}`, exact: true }).click();
    await expect(page.locator(`.creative-canvas-stage[data-workflow-id="${stageId}"]`)).toBeVisible();
  }
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const initialCanvasFitsAllStages = await page.evaluate(() => {
    const viewport = document.querySelector('#creativeCanvasViewport')!.getBoundingClientRect();
    return [...document.querySelectorAll('.creative-canvas-stage')].every((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.left >= viewport.left &&
        rect.top >= viewport.top &&
        rect.right <= viewport.right &&
        rect.bottom <= viewport.bottom
      );
    });
  });
  expect(initialCanvasFitsAllStages).toBeTruthy();
  await expect(page.locator('#creativeCanvasZoom')).not.toHaveText('80%');
  const stageId = await stageNodes.first().getAttribute('data-workflow-id');
  const sourceNode = page.locator(`.creative-canvas-stage[data-workflow-id="${stageId}"]`);
  const sourcePositionBefore = await sourceNode.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    top: Number.parseFloat((element as HTMLElement).style.top),
  }));
  const dragSource = sourceNode.locator('[data-node-drag]');
  const sourceBox = await dragSource.boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 74, sourceBox!.y + sourceBox!.height / 2 + 46, {
    steps: 6,
  });
  await page.mouse.up();
  await expect
    .poll(() =>
      sourceNode.evaluate((element) => ({
        left: Number.parseFloat((element as HTMLElement).style.left),
        top: Number.parseFloat((element as HTMLElement).style.top),
      })),
    )
    .not.toEqual(sourcePositionBefore);
  await expect
    .poll(async () =>
      page.evaluate(async (workflowStageId) => {
        const id = new URLSearchParams(location.search).get('project');
        const bundle = await (await fetch(`/api/projects/${id}/state`)).json();
        const node = bundle.state.uiDrafts.creativeCanvas.nodes.find(
          (candidate: { stageId: string }) => candidate.stageId === workflowStageId,
        );
        return { x: node.x, y: node.y };
      }, stageId),
    )
    .not.toEqual(sourcePositionBefore);
  const zoomBefore = await page.locator('#creativeCanvasZoom').textContent();
  await page.getByRole('button', { name: '放大画布' }).click();
  await expect(page.locator('#creativeCanvasZoom')).not.toHaveText(zoomBefore!);
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const worldPositionBeforePan = await page
    .locator('#creativeCanvasWorld')
    .evaluate((element) => element.style.transform);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + canvasBox!.width - 38, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox!.x + canvasBox!.width - 86, canvasBox!.y + canvasBox!.height / 2 + 28, {
    steps: 5,
  });
  await page.mouse.up();
  const worldPositionAfterPan = await page
    .locator('#creativeCanvasWorld')
    .evaluate((element) => element.style.transform);
  expect(worldPositionAfterPan).not.toBe(worldPositionBeforePan);
  await page.locator('#creativeInboxTray > summary').click();
  await page.locator('#creativeInboxInput').fill('让青铜钥匙每次开门都会抹去持有者的一段记忆。');
  await page.getByRole('button', { name: '保存灵感' }).click();
  await expect(page.locator('.creative-idea-card')).toContainText('青铜钥匙');
  const keyIdea = page.locator('.creative-idea-card').filter({ hasText: '青铜钥匙' });
  await expect(keyIdea.getByRole('button', { name: '放画布' })).toHaveCount(0);
  await keyIdea.getByRole('button', { name: 'AI 推演' }).click();
  await expect(page.locator('#chatInput')).toHaveValue(/青铜钥匙/);
  await page.getByRole('button', { name: '创作流程' }).click();
  const canvasNote = page.locator('.creative-canvas-note');
  await expect(canvasNote).toHaveCount(1);
  await canvasNote.getByLabel('便笺内容').fill('青铜钥匙会抹去持有者的记忆。');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = new URLSearchParams(location.search).get('project');
        const bundle = await (await fetch(`/api/projects/${id}/state`)).json();
        return bundle.state.uiDrafts.creativeCanvas.nodes.find(
          (node: { kind: string }) => node.kind === 'note',
        )?.text;
      }),
    )
    .toContain('青铜钥匙会抹去');
  await page.evaluate(async () => {
    state.project = {
      ...state.project,
      title: '雾港来信',
      genre: '悬疑奇幻',
      setting: '潮汐倒转时，雾港的钟楼会收到尚未发生的来信。',
      characters: '沈澄：守夜人，想找回姐姐；闻砚：替钟楼抄信，隐瞒一次旧事故。',
      novelNote: '每个谜面都要影响人物关系，不能只提供谜底。',
    };
    state.creativeRules = {
      ...state.creativeRules,
      toneAtmosphere: '冷峻、克制，偶尔出现温情',
      styleConstraints: '用具体行动推进悬疑，线索必须可回溯。',
      forbiddenItems: '不允许巧合解谜；不允许角色无缘无故隐瞒。',
      narrativePOV: 'third-limited',
      narrativePerspective: '仅限沈澄的认知，不进入闻砚内心。',
    };
    state.memory = {
      ...state.memory,
      characters: {
        ...(state.memory?.characters || {}),
        沈澄: { currentStatus: '刚发现姐姐的来信来自三年前。', goal: '找回姐姐。' },
      },
    };
    state.memoryTrust = { ...(state.memoryTrust || {}), 'character:沈澄': 'confirmed' };
    const setValue = (id: string, value: string) => {
      const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (element) element.value = value;
    };
    setValue('novelGenre', '悬疑奇幻');
    setValue('novelSetting', '潮汐倒转时，雾港的钟楼会收到尚未发生的来信。');
    setValue('novelCharacters', state.project.characters);
    setValue('toneAtmosphere', state.creativeRules.toneAtmosphere);
    setValue('styleConstraints', state.creativeRules.styleConstraints);
    setValue('forbiddenItems', state.creativeRules.forbiddenItems);
    await Store.save();
  });
  await canvasNote.getByRole('button', { name: '让 AI 推演这条灵感' }).click();
  await expect(page.locator('#chatInput')).toHaveValue(/青铜钥匙会抹去/);
  await expect(page.locator('#chatInput')).toHaveValue(
    /人物与关键设定原文[\s\S]*沈澄[\s\S]*冷峻[\s\S]*作者确认的长期记忆/,
  );
  let branchOutlineRequests = 0;
  let truncateCanvasOutlineReview = false;
  let returnDuplicateBrainstormReview = false;
  const duplicateBrainstormBody = `行动因果：沈澄把青铜钥匙放回钟楼暗格，想阻止它继续吞掉记忆。夜巡司却在封档前包围值夜台，并拿出姐姐当年签过的领用单。她试着用登记簿证明钥匙已经归还，闻砚却指出登记时间晚于姐姐失踪日，反而让她成了最后接触钥匙的人。她只好在值夜者和闻砚之间选择证人。人物抉择：她要求闻砚公开旧记录。代价余波：闻砚因此失去守塔资格，沈澄也暴露了自己藏下拓印的事实。后续悬念：封存室里还留着一份没有名字的领用单。`;
  const duplicateBrainstormReview = [
    `1. 守住钥匙｜${duplicateBrainstormBody}`,
    `2. 交出钥匙｜${duplicateBrainstormBody}`,
    '3. 摔碎钥匙｜行动：她摔碎钥匙。',
  ].join('\n');
  const distinctBrainstormRepair = [
    '1. 倒扣旧钟｜行动因果：沈澄不交钥匙，而是带它进入封存室，对照姐姐三年前的领用记录。夜巡司锁死外门，闻砚却从里面扣上门闩，逼她在救同伴与追查暗格间选择。她拆开钟壳，在齿轮缝里找到一片写着自己名字的铜箔。人物抉择：她把铜箔交给闻砚，让他先带同伴离开，自己留下核对。代价余波：她错过封档时限，钥匙上的一段记忆随钟声消失。后续悬念：铜箔上的日期竟是明天。',
    '2. 换取录音｜行动因果：闻砚拿出姐姐失踪前的值夜录音，提出用钥匙交换原始档案。沈澄听出录音里有第二个人的呼吸声，却发现夜巡司已经剪掉关键片段。她把钥匙放到桌上，要求闻砚当众重播完整磁带。人物抉择：她决定让围观值夜者共同作证，不再独自追查。代价余波：录音暴露闻砚曾替姐姐改过一次登记，他因此失去所有人的信任。后续悬念：磁带末尾传来沈澄尚未说出口的名字。',
    '3. 让钥匙失效｜行动因果：沈澄发现钥匙每开启一次暗格，就会抹去持有者一段最重要的记忆。她没有继续试锁，而是把钥匙浸入退潮后的盐水，观察齿纹是否仍在转动。暗格随即吐出一张烧焦的潮汐表，守塔人赶来阻止她保存证据。人物抉择：她先救出被困在钟楼夹层的守塔人，再折返取走潮汐表。代价余波：钥匙失去开门能力，但守塔人认出上面刻着自己的旧名。后续悬念：那名字属于三年前已经死亡的人。',
  ].join('\n');
  const receivedOutlinePrompts: string[] = [];
  const receivedReviewPrompts: string[] = [];
  const receivedBrainstormPrompts: string[] = [];
  const receivedBrainstormModels: string[] = [];
  const receivedStepPrompts: string[] = [];
  const receivedStepModels: string[] = [];
  await page.route('https://mock-novel-api.test/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON() as {
      model?: string;
      messages?: Array<{ content?: string }>;
    };
    const prompt = (payload.messages || []).map((message) => message.content || '').join('\n');
    if (prompt.includes('执行作者自定义的创作步骤')) {
      receivedStepPrompts.push(prompt);
      receivedStepModels.push(payload.model || '');
      const stepArtifact = prompt.includes('【创作结果精修任务】')
        ? '【成果标题：守夜人留下的证词】\n主角在值夜记录里发现，钥匙由守夜人以姐姐的一段记忆为代价铸成。她必须决定是否公开这条证词；公开能找到姐姐，却会让闻砚因旧事故失去守塔资格。闻砚留下的删改痕迹证明，他隐瞒的不是事故本身，而是姐姐曾主动交出记忆。'
        : '【成果标题：旧钟里的约定】\n守夜人将钥匙铸成，用来封存姐姐的一段记忆。';
      const stepContent = prompt.includes('【创作结果精修任务】')
        ? `【精修诊断】无需实质改动。\n【修订稿】\n${stepArtifact}`
        : stepArtifact;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: stepContent } }] }),
          'data: [DONE]',
          '',
        ].join('\n'),
      });
      return;
    }
    if (prompt.includes('你是资深小说审稿编辑')) {
      receivedReviewPrompts.push(prompt);
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"chapters":[{"chapter":1,"suggestions":[]}]}' } }] })}`,
          'data: [DONE]',
          '',
        ].join('\n'),
      });
      return;
    }
    if (prompt.includes('【画布选定分支】')) {
      branchOutlineRequests += 1;
      receivedOutlinePrompts.push(prompt);
      if (branchOutlineRequests === 1) {
        await route.fulfill({
          status: 402,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: { message: 'mock insufficient balance' } }),
        });
        return;
      }
      if (prompt.includes('【故事结构规划任务】')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            `data: ${JSON.stringify({ choices: [{ delta: { content: '【故事结构蓝图】\n核心戏剧问题：青铜钥匙为何吞噬记忆，以及沈澄是否愿意为查明姐姐失踪承担代价。\n因果弧：钥匙的代价引发调查，证据迫使沈澄与夜巡司正面对抗，最终由公开证词改变封存规则。人物弧：她从独自保密转向让他人共同作证。' } }] })}`,
            'data: [DONE]',
            '',
          ].join('\n'),
        });
        return;
      }
      const outline = JSON.stringify(
        branchOutlineRequests >= 4 && prompt.includes('生成 3—5 个连续新章节')
          ? [
              {
                chapter: 1,
                title: '门后的代价',
                summary: '主角追入第二个入口，必须在记忆与同伴之间作出选择。',
                plotPoints: ['入口要求交出一段记忆', '同伴替主角承担代价'],
              },
              {
                chapter: 2,
                title: '借来的记忆',
                summary: '主角发现钥匙保存的记忆属于失踪的守钟人。',
                plotPoints: ['找到守钟人的记录', '确认记忆并非主角所有'],
              },
              {
                chapter: 3,
                title: '钟声停下时',
                summary: '停止钟声会封死通道，也会唤醒守钟人。',
                plotPoints: ['决定是否停钟', '守钟人留下新的线索'],
              },
            ]
          : [
              {
                chapter: 1,
                title: '钥匙的回声',
                summary: '主角锁起钥匙，却发现记忆正从钟声中逐步消失。',
                plotPoints: ['确认钥匙代价', '追查钟楼里的第二个入口'],
              },
            ],
      );
      if (truncateCanvasOutlineReview && prompt.includes('【结构精修任务】')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            `data: ${JSON.stringify({ choices: [{ delta: { content: outline } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`,
            'data: [DONE]',
            '',
          ].join('\n'),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          `data: ${JSON.stringify({ choices: [{ delta: { content: prompt.includes('【结构精修任务】') ? `【精修诊断】无需实质改动。\n【修订稿】\n${outline}` : outline } }] })}`,
          'data: [DONE]',
          '',
        ].join('\n'),
      });
      return;
    }
    receivedBrainstormPrompts.push(prompt);
    receivedBrainstormModels.push(payload.model || '');
    if (prompt.includes('【剧情路线质量校验修复】')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          `data: ${JSON.stringify({ choices: [{ delta: { content: distinctBrainstormRepair } }] })}`,
          'data: [DONE]',
          '',
        ].join('\n'),
      });
      return;
    }
    if (prompt.includes('【剧情路线精修任务】')) {
      if (returnDuplicateBrainstormReview) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            `data: ${JSON.stringify({ choices: [{ delta: { content: `【精修诊断】前两条路线的冲突与代价重合，第三条也未展开。\n【修订稿】\n${duplicateBrainstormReview}` } }] })}`,
            'data: [DONE]',
            '',
          ].join('\n'),
        });
        return;
      }
      await route.fulfill({
        status: 402,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'mock refinement balance exhausted' } }),
      });
      return;
    }
    const brainstormReply = prompt.includes('一只灰猫')
      ? '1. 追踪午夜来电｜行动：灰猫带主人找到一间早已封闭的电话亭。｜代价：主人听见了自己尚未拨出的求救电话。\n2. 错过一次铃声｜行动：主人故意离开灰猫半小时。｜代价：邻居替他接起了那通电话。\n3. 反向拨号｜行动：主人在铃声响起前拨出号码。｜代价：接听者认出了灰猫的声音。'
      : '1. 封存钥匙｜行动：主角把钥匙锁进旧钟。｜代价：失去唯一线索。\n2. 交给对手｜行动：主角公开交出钥匙。｜代价：对手先一步找到入口。\n3. 亲自试用｜行动：主角再次用钥匙开门。｜代价：忘记最重要的人。';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: brainstormReply } }] })}`,
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });
  await page.evaluate(async () => {
    state.baseURL = 'https://mock-novel-api.test';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    state.modelRoutes = {
      ...state.modelRoutes,
      outline: 'test-global-planner',
      editing: 'test-editor',
      chapter: 'test-writer',
    };
    await Store.save();
  });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const branchActions = page.locator('.creative-canvas-branch-actions button');
  await expect(branchActions).toHaveCount(3);
  const qualityReport = page.locator('.creative-canvas-quality-report').last();
  await expect(qualityReport).toContainText('未完成审校');
  await expect(qualityReport).toContainText('保留初稿');
  await expect(page.locator('#toast')).toContainText('精修服务失败');
  await expect(page.locator('#toast')).toContainText('少于至少 160 字');
  await expect.poll(() => receivedBrainstormPrompts.length).toBeGreaterThanOrEqual(2);
  expect(receivedBrainstormPrompts[0]).toContain('悬疑奇幻');
  expect(receivedBrainstormPrompts[0]).toContain('人物与关键设定原文');
  expect(receivedBrainstormPrompts[0]).toContain('沈澄');
  expect(receivedBrainstormPrompts[0]).toContain('作者确认的长期记忆');
  expect(receivedBrainstormPrompts.at(-1)).toContain('【剧情路线精修任务】');
  expect(receivedBrainstormModels.slice(0, 2)).toEqual(['test-global-planner', 'test-editor']);
  await branchActions.nth(0).click();
  await expect(page.locator('#tab-creative-flow')).toBeVisible();
  await expect(page.locator('.creative-canvas-note')).toHaveCount(2);
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(1);
  await expect(page.locator('.creative-canvas-note').filter({ hasText: '封存钥匙' })).toHaveCount(1);
  const branchState = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const projectState = (await (await fetch(`/api/projects/${id}/state`)).json()).state;
    const note = projectState.uiDrafts.creativeCanvas.nodes.find(
      (node: { kind: string; text: string }) => node.kind === 'note' && node.text.includes('封存钥匙'),
    );
    return {
      note: note?.text,
      hasSourceEdge: projectState.uiDrafts.creativeCanvas.edges.some(
        (edge: { from: string; to: string }) => edge.to === note?.id,
      ),
      savedChatBranch: projectState.chatWindows.some((chat: { messages: unknown[] }) =>
        chat.messages.some(
          (message: {
            content?: string;
            creativeCanvasBranchFrom?: string;
            creativeCanvasQuality?: { status?: string };
          }) =>
            message.content?.includes('封存钥匙') &&
            Boolean(message.creativeCanvasBranchFrom) &&
            message.creativeCanvasQuality?.status === 'unverified',
        ),
      ),
    };
  });
  expect(branchState.note).toContain('失去唯一线索');
  expect(branchState.hasSourceEdge).toBeTruthy();
  expect(branchState.savedChatBranch).toBeTruthy();
  await page.reload();
  await expect(page.locator('.creative-canvas-note')).toHaveCount(2);
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(1);
  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '显示全部节点' }).click();
  await page
    .locator('.creative-canvas-stage[data-workflow-id="spark"]')
    .getByRole('button', { name: '打开' })
    .click();
  await expect(page.getByRole('button', { name: '创作流程' })).toHaveClass(/active/);
  await expect(page.locator('.creative-canvas-branch-actions button').first()).toBeDisabled();
  await expect(page.locator('.creative-canvas-branch-actions button').first()).toHaveText(/封存钥匙/);
  await page.getByRole('button', { name: '创作流程' }).click();
  await page.evaluate(() => {
    state.baseURL = 'https://mock-novel-api.test';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
  });
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '封存钥匙' })
    .getByRole('button', { name: '让 AI 推演这条灵感' })
    .click();
  await expect.poll(() => receivedBrainstormPrompts.length).toBeGreaterThanOrEqual(4);
  await expect(page.locator('.creative-canvas-branch-actions').last().locator('button')).toHaveCount(3);
  expect(receivedBrainstormPrompts.at(-2)).toContain('上游工作流节点（沿连线回溯）');
  expect(receivedBrainstormPrompts.at(-2)).toContain('青铜钥匙');
  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: '随机灵感' }).click();
  await expect(page.locator('.creative-canvas-note')).toHaveCount(3);
  await expect(page.locator('.creative-canvas-note').nth(1).getByLabel('便笺内容')).not.toHaveValue('');
  await expect(page.locator('.creative-canvas-note').nth(2).getByLabel('便笺内容')).toHaveValue(
    /青铜钥匙|封存钥匙/,
  );
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(2);
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const keyboardConnectSource = canvasNote.first().locator('[data-node-connect]');
  await keyboardConnectSource.focus();
  await keyboardConnectSource.press('Enter');
  await expect(canvas).toHaveClass(/is-connect-mode/);
  const keyboardConnectTarget = sourceNode.locator('[data-node-connect]');
  await keyboardConnectTarget.focus();
  await keyboardConnectTarget.press('Enter');
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(3);
  await expect(canvas).not.toHaveClass(/is-connect-mode/);
  const manualEdgeId = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const projectState = (await (await fetch(`/api/projects/${id}/state`)).json()).state;
    const note = projectState.uiDrafts.creativeCanvas.nodes.find(
      (node: { kind: string; text: string }) => node.kind === 'note' && node.text.includes('青铜钥匙'),
    );
    const stage = projectState.uiDrafts.creativeCanvas.nodes.find(
      (node: { stageId?: string }) => node.stageId,
    );
    return projectState.uiDrafts.creativeCanvas.edges.find(
      (edge: { from: string; to: string }) => edge.from === note?.id && edge.to === stage?.id,
    )?.id;
  });
  const customEdge = page.locator(`[data-canvas-edge="${manualEdgeId}"]`);
  await customEdge.focus();
  await customEdge.press('Enter');
  await expect(page.getByRole('button', { name: '删除选中连线' })).toBeEnabled();
  await page.getByRole('button', { name: '删除选中连线' }).click();
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(2);
  const directSource = page.locator('.creative-canvas-note').filter({ hasText: '封存钥匙' }).first();
  const directTarget = page.locator('.creative-canvas-stage[data-workflow-id="revise"]');
  await directSource.hover();
  const sourceBeforeLink = await directSource.boundingBox();
  const connectPort = await directSource.locator('[data-node-connect]').boundingBox();
  const targetBox = await directTarget.boundingBox();
  expect(sourceBeforeLink).toBeTruthy();
  expect(connectPort).toBeTruthy();
  expect(targetBox).toBeTruthy();
  await page.mouse.move(connectPort!.x + connectPort!.width / 2, connectPort!.y + connectPort!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 10,
  });
  await expect(page.locator('.creative-canvas-edge-preview')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.creative-canvas-edge-preview')).toHaveCount(0);
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(3);
  const directLinkState = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const projectState = (await (await fetch(`/api/projects/${id}/state`)).json()).state;
    const source = projectState.uiDrafts.creativeCanvas.nodes.find(
      (node: { kind: string; text: string }) => node.kind === 'note' && node.text.includes('封存钥匙'),
    );
    return {
      sourceId: source?.id,
      targetId: 'stage:revise',
      saved: projectState.uiDrafts.creativeCanvas.edges.some(
        (edge: { from: string; to: string }) => edge.from === source?.id && edge.to === 'stage:revise',
      ),
    };
  });
  expect(directLinkState.saved).toBeTruthy();
  expect((await directSource.boundingBox())?.x).toBeCloseTo(sourceBeforeLink!.x, 0);
  expect((await directSource.boundingBox())?.y).toBeCloseTo(sourceBeforeLink!.y, 0);

  const routedCanvasContexts = await page.evaluate(async () => {
    const model = state.uiDrafts.creativeCanvas;
    const probes = [
      { id: 'note:e2e-outline-context', kind: 'note', text: '只供大纲的测试灵感', x: 1500, y: 100 },
      { id: 'note:e2e-draft-context', kind: 'note', text: '只供写作的测试灵感', x: 1500, y: 320 },
      { id: 'note:e2e-outgoing-context', kind: 'note', text: '不可逆向读到的测试灵感', x: 1500, y: 540 },
      { id: 'note:e2e-graph-root', kind: 'note', text: 'E2E_GRAPH_ROOT：守夜人先藏下证词', x: 1800, y: 100 },
      {
        id: 'note:e2e-graph-middle',
        kind: 'note',
        text: 'E2E_GRAPH_MIDDLE：债权人循证词逼近',
        x: 2100,
        y: 100,
      },
      {
        id: 'note:e2e-graph-reference',
        kind: 'note',
        text: 'E2E_GRAPH_REFERENCE：港口习俗',
        x: 1800,
        y: 220,
      },
      {
        id: 'note:e2e-graph-unlinked',
        kind: 'note',
        text: 'E2E_GRAPH_UNLINKED：不可见孤立想法',
        x: 1800,
        y: 340,
      },
    ];
    model.nodes.push(...probes);
    model.edges.push(
      { id: 'edge:e2e-outline-context', from: probes[0].id, to: 'stage:outline', kind: 'custom' },
      { id: 'edge:e2e-draft-context', from: probes[1].id, to: 'stage:draft', kind: 'custom' },
      { id: 'edge:e2e-outline-to-draft', from: 'stage:outline', to: 'stage:draft', kind: 'main' },
      { id: 'edge:e2e-outgoing-context', from: 'stage:draft', to: probes[2].id, kind: 'custom' },
      { id: 'edge:e2e-graph-root-middle', from: probes[3].id, to: probes[4].id, kind: 'custom' },
      { id: 'edge:e2e-graph-middle-outline', from: probes[4].id, to: 'stage:outline', kind: 'custom' },
      { id: 'edge:e2e-graph-reference-outline', from: probes[5].id, to: 'stage:outline', kind: 'reference' },
    );
    await globalThis.saveState();
    const contexts = {
      outline: globalThis.buildExtraWritingContext('outline'),
      chapter: globalThis.buildExtraWritingContext('chapter'),
    };
    model.nodes = model.nodes.filter((node: { id: string }) => !probes.some((probe) => probe.id === node.id));
    model.edges = model.edges.filter((edge: { id: string }) => !edge.id.startsWith('edge:e2e-'));
    await globalThis.saveState();
    return contexts;
  });
  expect(routedCanvasContexts.outline).toContain('只供大纲的测试灵感');
  expect(routedCanvasContexts.outline).not.toContain('只供写作的测试灵感');
  expect(routedCanvasContexts.outline.indexOf('E2E_GRAPH_ROOT')).toBeLessThan(
    routedCanvasContexts.outline.indexOf('E2E_GRAPH_MIDDLE'),
  );
  expect(routedCanvasContexts.outline).toContain(
    '[作者输入连线（上游供下游参考，不自动断言因果）] 便笺「E2E_GRAPH_ROOT：守夜人先藏下证词」 → 便笺「E2E_GRAPH_MIDDLE：债权人循证词逼近」',
  );
  expect(routedCanvasContexts.outline).toContain(
    '[参考输入（背景材料，不规定情节先后）] 便笺「E2E_GRAPH_REFERENCE：港口习俗」 → 故事结构',
  );
  expect(routedCanvasContexts.outline).not.toContain('E2E_GRAPH_UNLINKED');
  expect(routedCanvasContexts.chapter).toContain('只供写作的测试灵感');
  expect(routedCanvasContexts.chapter).toContain('只供大纲的测试灵感');
  expect(routedCanvasContexts.chapter).not.toContain('不可逆向读到的测试灵感');
  expect(routedCanvasContexts.chapter).toContain('[主流程（创作阶段顺序）] 故事结构 → 章节写作');

  await page.evaluate(async () => {
    const originalChapters = state.chapters;
    const originalChapterNumber = state.currentChapter;
    state.chapters = [{ chapter: 1, content: '主角握住青铜钥匙，钟声从墙后传来。' }];
    state.currentChapter = 1;
    await globalThis.saveState();
    await globalThis.runExpertReview({ silent: true, currentOnly: true });
    state.chapters = originalChapters;
    state.currentChapter = originalChapterNumber;
    await globalThis.saveState();
  });
  expect(receivedReviewPrompts.at(-1)).toContain('连入编辑审阅流程的画布节点');
  expect(receivedReviewPrompts.at(-1)).toContain('青铜钥匙会抹去持有者的记忆');

  const aiBranchNode = page.locator('.creative-canvas-note').filter({ hasText: '封存钥匙' });
  await aiBranchNode.getByRole('button', { name: '发展成章节大纲' }).click();
  await expect(page.locator('#outlineContainer')).toContainText('尚未生成大纲');
  const outlineAfterFailure = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json()).state.outline;
  });
  expect(outlineAfterFailure).toEqual([]);
  await page.getByRole('button', { name: '创作流程' }).click();
  truncateCanvasOutlineReview = true;
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '封存钥匙' })
    .getByRole('button', { name: '发展成章节大纲' })
    .click();
  const truncatedOutlineProposal = page.locator('#canvasOutlineProposalModal');
  await expect(truncatedOutlineProposal).toBeVisible();
  await expect(page.locator('#toast')).toContainText('模型长度上限');
  await expect(page.locator('#toast')).not.toContainText('大纲已完成因果与设定精修');
  await truncatedOutlineProposal.getByRole('button', { name: '取消' }).click();
  truncateCanvasOutlineReview = false;
  await page.getByRole('button', { name: '创作流程' }).click();
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '封存钥匙' })
    .getByRole('button', { name: '发展成章节大纲' })
    .click();
  const outlineProposal = page.locator('#canvasOutlineProposalModal');
  await expect(outlineProposal).toBeVisible();
  await expect(outlineProposal).toContainText('钥匙的回声');
  expect(receivedOutlinePrompts.at(-1)).toContain('【沿连线回溯的前置灵感】');
  expect(receivedOutlinePrompts.at(-1)).toContain('青铜钥匙会抹去持有者的记忆');
  expect(receivedOutlinePrompts.at(-1)).toContain('便笺「青铜钥匙会抹去持有者的记忆。」 → 便笺「封存钥匙」');
  expect(receivedOutlinePrompts.at(-1)).toContain('【结构精修任务】');
  expect(receivedOutlinePrompts.at(-1)).toContain('每章关键点数量');
  const outlineBeforeConfirm = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json()).state.outline;
  });
  expect(outlineBeforeConfirm).toEqual([]);
  await outlineProposal.getByRole('button', { name: '取消' }).click();
  await expect(outlineProposal).not.toBeVisible();
  await expect(page.locator('#outlineContainer')).toContainText('尚未生成大纲');
  await page.getByRole('button', { name: '创作流程' }).click();
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '封存钥匙' })
    .getByRole('button', { name: '发展成章节大纲' })
    .click();
  await expect(page.locator('#canvasOutlineProposalModal')).toBeVisible();
  await page.getByRole('button', { name: '采用这版大纲' }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = new URLSearchParams(location.search).get('project');
        const bundle = await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json();
        return bundle.state.outline[0]?.sourceCanvasBranchId;
      }),
    )
    .toContain('note:');
  const adoptedOutline = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json()).state.outline;
  });
  expect(adoptedOutline).toHaveLength(1);
  expect(adoptedOutline[0].title).toBe('钥匙的回声');

  await page.getByRole('button', { name: '创作流程' }).click();
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '封存钥匙' })
    .getByRole('button', { name: '发展成章节大纲' })
    .click();
  const appendPreview = page.locator('#canvasOutlineProposalModal');
  await expect(appendPreview).toContainText('门后的代价');
  expect(receivedOutlinePrompts.at(-1)).toContain('生成 3—5 个连续新章节');
  await page.evaluate(() => {
    state.outline = [
      ...state.outline,
      { chapter: 2, title: '并发保留', summary: '预览期间出现的新内容。', plotPoints: [] },
    ];
  });
  await appendPreview.getByRole('button', { name: '追加为新剧情段' }).click();
  await expect(appendPreview).toContainText('大纲已变化');
  await expect(appendPreview.getByRole('button', { name: '追加为新剧情段' })).toBeDisabled();
  await appendPreview.getByRole('button', { name: '关闭', exact: true }).click();

  await page.evaluate(async () => {
    state.project.chapterCount = 2;
    const chapterCountInput = document.getElementById('chapterCount') as HTMLInputElement | null;
    if (chapterCountInput) chapterCountInput.value = '2';
    await globalThis.saveState();
  });
  await page.getByRole('button', { name: '创作流程' }).click();
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '封存钥匙' })
    .getByRole('button', { name: '发展成章节大纲' })
    .click();
  const confirmedAppend = page.locator('#canvasOutlineProposalModal');
  await expect(confirmedAppend).toContainText('3 章');
  await page.getByRole('button', { name: '追加为新剧情段' }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = new URLSearchParams(location.search).get('project');
        return (await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json()).state.outline
          .length;
      }),
    )
    .toBe(5);
  const appendedOutline = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json()).state.outline;
  });
  expect(appendedOutline.map((chapter: { title: string }) => chapter.title)).toEqual([
    '钥匙的回声',
    '并发保留',
    '门后的代价',
    '借来的记忆',
    '钟声停下时',
  ]);
  expect(appendedOutline.map((chapter: { chapter: number }) => chapter.chapter)).toEqual([1, 2, 3, 4, 5]);
  const expandedChapterCount = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json()).state.project
      .chapterCount;
  });
  expect(expandedChapterCount).toBe(5);

  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const storyArc = page.locator('.creative-canvas-arc');
  await expect(storyArc).toHaveCount(1);
  await expect(storyArc).toContainText('0/4 章');
  const arcBranchId = await storyArc.getAttribute('data-story-arc');
  const arcLeftBeforeMove = await storyArc.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.left),
  );
  await storyArc.locator('[data-node-drag]').press('ArrowRight');
  await expect
    .poll(async () =>
      page.evaluate(async (branchId) => {
        const id = new URLSearchParams(location.search).get('project');
        const bundle = await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json();
        return bundle.state.uiDrafts.creativeCanvas.arcPositions[branchId]?.x;
      }, arcBranchId),
    )
    .toBeGreaterThan(arcLeftBeforeMove);
  const arcLeftAfterMove = await storyArc.evaluate((element) => (element as HTMLElement).style.left);
  await storyArc.getByRole('button', { name: '写第1章' }).click();
  await expect(page.locator('#chNavLabel')).toHaveText('第 1 章');
  await page.locator('#chapterEditor').fill('第一章正文完成，青铜钥匙的代价终于显现。');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = new URLSearchParams(location.search).get('project');
        const bundle = await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json();
        return bundle.state.chapters.find((chapter: { chapter: number }) => chapter.chapter === 1)?.content;
      }),
    )
    .toContain('青铜钥匙的代价');
  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(storyArc).toContainText('1/4 章');
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(page.locator('.creative-canvas-arc')).toContainText('1/4 章');
  await expect(page.locator('.creative-canvas-arc')).toHaveCSS('left', arcLeftAfterMove);

  await page.getByRole('button', { name: '显示全部节点' }).click();
  const draftStage = page.locator('.creative-canvas-stage[data-workflow-id="draft"]');
  await expect(draftStage.getByRole('button', { name: '写第2章' })).toBeVisible();
  await draftStage.getByRole('button', { name: '写第2章' }).click();
  await expect(page.locator('#chNavLabel')).toHaveText('第 2 章');
  for (let chapter = 3; chapter <= 5; chapter += 1) {
    await page.getByTitle('下一章').click();
    await expect(page.locator('#chNavLabel')).toHaveText(`第 ${chapter} 章`);
  }

  await page.evaluate(() => {
    state.outline = state.outline.slice(0, 1);
    state.project.chapterCount = 24;
    state.project.setting = state.project.setting || '测试用故事设定';
    state.currentChapter = 1;
    state.agentEditHistory = [{ id: 'simulated-review', chapter: 1 }];
    state.reviewReports = { chapter1: { status: 'reviewed' } };
  });
  await page.getByRole('button', { name: '创作流程' }).click();
  const continuationStage = page.locator('.creative-canvas-stage[data-workflow-id="draft"]');
  await expect(continuationStage.locator('.creative-phase-status')).not.toHaveText('下一步');
  await expect(continuationStage.getByRole('button', { name: '写第2章' })).toBeVisible();
  await page.reload();

  await page.getByRole('button', { name: '创作流程' }).click();
  await page.locator('#creativeInboxTray > summary').click();
  await page.locator('#creativeInboxInput').fill('一只灰猫总能提前十分钟听见电话铃。');
  await page.getByRole('button', { name: '保存灵感' }).click();
  const ideaCards = page.locator('.creative-idea-card');
  await expect(ideaCards).toHaveCount(2);
  await expect(ideaCards.nth(0)).toContainText('一只灰猫');
  const workflowData = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    return (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeInbox;
  });
  expect(workflowData[0].text).toContain('一只灰猫');
  expect(workflowData.some((item: { text: string }) => item.text.includes('青铜钥匙'))).toBeTruthy();
  await expect(
    ideaCards.filter({ hasText: '一只灰猫' }).getByRole('button', { name: '追加到故事简介' }),
  ).toHaveCount(0);
  const grayCatCard = ideaCards.filter({ hasText: '一只灰猫' });
  const grayCatIdeaId = await grayCatCard.getAttribute('data-idea-id');
  const notesBeforeGrayCat = await page.locator('.creative-canvas-note').count();
  await page.evaluate(async () => {
    state.baseURL = 'https://mock-novel-api.test';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    await Store.save();
  });
  await grayCatCard.getByRole('button', { name: 'AI 推演' }).click();
  await expect.poll(() => receivedBrainstormPrompts.length).toBeGreaterThanOrEqual(6);
  expect(receivedBrainstormPrompts.at(-2)).toContain('一只灰猫');
  await expect(
    page.locator('.creative-canvas-note').filter({ hasText: '灰猫' }).getByLabel('便笺内容'),
  ).toHaveValue(/灰猫/);
  await expect(page.locator('.creative-canvas-note')).toHaveCount(notesBeforeGrayCat + 1);
  const grayCatSource = await page.evaluate(async (ideaId) => {
    const id = new URLSearchParams(location.search).get('project');
    const projectState = (await (await fetch(`/api/projects/${id}/state`)).json()).state;
    return projectState.uiDrafts.creativeCanvas.nodes.find(
      (node: { sourceIdeaId?: string }) => node.sourceIdeaId === ideaId,
    );
  }, grayCatIdeaId);
  expect(grayCatSource?.text).toContain('一只灰猫');
  await expect(page.locator('.creative-canvas-branch-actions')).toHaveCount(3);
  const grayCatActions = page.locator('.creative-canvas-branch-actions').last();
  await expect(grayCatActions.getByRole('button')).toHaveCount(3);
  let failedCanvasSave = false;
  let allowCanvasSaveRetry = false;
  const failOneCanvasSave = async (route: import('@playwright/test').Route) => {
    const requestBody = route.request().postData() || '';
    if (
      !allowCanvasSaveRetry &&
      ['PUT', 'PATCH'].includes(route.request().method()) &&
      requestBody.includes('【追踪午夜来电】')
    ) {
      failedCanvasSave = true;
      await route.fulfill({
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'temporary canvas save failure' }),
      });
      return;
    }
    await route.continue();
  };
  await page.route('**/api/projects/*/state', failOneCanvasSave);
  await grayCatActions.getByRole('button').nth(0).click();
  expect(failedCanvasSave).toBeTruthy();
  await expect(grayCatActions.getByRole('button').nth(0)).toHaveAttribute('aria-label', /重试保存/);
  await expect(grayCatActions.getByRole('button').nth(0)).toBeEnabled();
  const failedSaveServerState = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const projectState = (await (await fetch(`/api/projects/${id}/state`)).json()).state;
    return projectState.uiDrafts.creativeCanvas.nodes.some(
      (node: { aiBranch?: boolean; text: string }) => node.aiBranch && node.text.includes('追踪午夜来电'),
    );
  });
  expect(failedSaveServerState).toBeFalsy();
  allowCanvasSaveRetry = true;
  await grayCatActions.getByRole('button').nth(0).click();
  await expect(page.getByRole('button', { name: '创作流程' })).toHaveClass(/active/);
  await page.unroute('**/api/projects/*/state', failOneCanvasSave);
  await expect(page.locator('.creative-canvas-note')).toHaveCount(notesBeforeGrayCat + 2);
  const grayCatBranch = await page.evaluate(async (sourceId) => {
    const id = new URLSearchParams(location.search).get('project');
    const canvas = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
    const edge = canvas.edges.find((item: { from: string }) => item.from === sourceId);
    return {
      edge,
      branch: canvas.nodes.find((node: { id: string }) => node.id === edge?.to)?.text,
    };
  }, grayCatSource.id);
  expect(grayCatBranch.edge).toBeTruthy();
  expect(grayCatBranch.branch).toContain('追踪午夜来电');
  await ideaCards.filter({ hasText: '青铜钥匙' }).getByRole('button', { name: 'AI 推演' }).click();
  await expect.poll(() => receivedBrainstormPrompts.length).toBeGreaterThanOrEqual(8);
  expect(receivedBrainstormPrompts.at(-2)).toContain('青铜钥匙');
  await expect(page.locator('.creative-canvas-branch-actions')).toHaveCount(4);

  const brainstormActionGroupsBeforeRepair = await page.locator('.creative-canvas-branch-actions').count();
  const brainstormRequestsBeforeRepair = receivedBrainstormPrompts.length;
  returnDuplicateBrainstormReview = true;
  await page.getByRole('button', { name: '创作流程' }).click();
  await page
    .locator('.creative-canvas-note')
    .filter({ hasText: '一只灰猫' })
    .first()
    .getByRole('button', { name: '让 AI 推演这条灵感' })
    .click();
  await expect
    .poll(() => receivedBrainstormPrompts.length)
    .toBeGreaterThanOrEqual(brainstormRequestsBeforeRepair + 3);
  const routeRepairPrompt = receivedBrainstormPrompts.at(-1) || '';
  expect(routeRepairPrompt).toContain('【剧情路线质量校验修复】');
  expect(routeRepairPrompt).toContain('路线「守住钥匙」与路线「交出钥匙」内容高度重复');
  expect(routeRepairPrompt).toContain('路线「摔碎钥匙」约 ');
  expect(routeRepairPrompt).toContain('少于至少 160 字');
  await expect(page.locator('.creative-canvas-branch-actions')).toHaveCount(
    brainstormActionGroupsBeforeRepair + 1,
  );
  await expect(page.locator('.creative-canvas-branch-actions').last().getByRole('button')).toHaveCount(3);
  const repairedBrainstormMessage = page.locator('#chatMessages > .chat-msg.assistant').last();
  await expect(repairedBrainstormMessage).toContainText('倒扣旧钟');
  await expect(repairedBrainstormMessage).not.toContainText('守住钥匙');
  returnDuplicateBrainstormReview = false;

  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
  await expect(page.locator('#toast')).not.toHaveClass(/show/);
  await page.getByRole('button', { name: '显示全部节点' }).click();
  await page.locator('#creativeInboxTray > summary').click();
  await page.screenshot({ path: 'test-results/creative-workflow-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '故事设定' }).click();
  const povPanel = page.locator('.detailed-pov-panel');
  await expect(povPanel.getByText('叙事人称与角色视角')).toBeVisible();
  await povPanel.getByRole('button', { name: '第一人称' }).click();
  await povPanel.getByRole('button', { name: /多角色轮换/ }).click();
  await expect(povPanel.getByText('作者视角规则')).toBeVisible();
  await expect(povPanel.getByText('AI 资料索引')).toBeVisible();
  const currentChapter = await page.evaluate(() => state.currentChapter);
  await povPanel.getByPlaceholder('直接输入角色名，不依赖资料库').fill('林尘');
  await povPanel.getByRole('button', { name: '添加角色' }).click();
  await povPanel.getByPlaceholder('直接输入角色名，不依赖资料库').fill('苏璃');
  await povPanel.getByRole('button', { name: '添加角色' }).click();
  await povPanel.locator('#povSwitchRule').selectOption('scene');
  await povPanel.getByText(/章节视角覆盖/).click();
  await povPanel.getByPlaceholder('章节号').fill(String(currentChapter));
  await povPanel.getByPlaceholder('角色名；多人用逗号分隔').fill('苏璃');
  await povPanel.getByRole('button', { name: '添加覆盖' }).click();
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  const povContext = await page.evaluate(() => (globalThis as any).buildCreativeRulesContext('chapter'));
  expect(povContext).toContain('第一人称');
  expect(povContext).toContain('多角色轮换');
  expect(povContext).toContain('本章使用 苏璃 的视角');
  await page.getByRole('button', { name: '人物与世界' }).click();
  const biblePage = page.locator('#tab-service-bible');
  await expect(biblePage.getByRole('heading', { name: '小说资料库' })).toBeVisible();
  await expect(biblePage.getByRole('button', { name: '用 AI 更新索引' })).toBeVisible();
  await expect(biblePage.getByRole('button', { name: /物品/ })).toBeVisible();
  await expect(biblePage.getByRole('button', { name: /组织/ })).toBeVisible();
  await biblePage
    .getByPlaceholder('人物、世界观、势力、关键物品、规则……可以直接自由书写，不需要先填表。')
    .fill('林尘属于巡夜司，持有一把有三层封印的青铜钥匙。');
  await biblePage.getByRole('button', { name: '保存原文' }).click();
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  await page.getByRole('button', { name: '故事设定' }).click();
  await expect(page.getByText('常用类型')).toBeVisible();
  await page.locator('.genre-preset-block').getByRole('button', { name: '科幻' }).click();
  await expect(page.locator('#novelGenre')).toHaveValue('科幻');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('.style-preset-block').getByRole('button', { name: '悬疑克制' }).click();
  await expect(page.locator('#toneAtmosphere')).toHaveValue('冷峻、压抑、疑云重重');
  await page.locator('.methodology-preset-block').getByRole('button', { name: '自然对白' }).click();
  await expect(page.locator('#methodologyCardName')).toHaveValue('自然对白');
  await expect(page.locator('#methodologyCardText')).toHaveValue(/每句对白都体现角色立场/);
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  await expect(
    page.locator('#novelSetting').evaluate((element) => element.clientHeight),
  ).resolves.toBeGreaterThanOrEqual(180);
  await expect(
    page.locator('#novelCharacters').evaluate((element) => element.clientHeight),
  ).resolves.toBeGreaterThanOrEqual(220);
  const peer = await page.context().newPage();
  await peer.goto(page.url());
  await expect(peer.locator('#serverSaveIndicator')).toBeVisible();
  await peer.waitForTimeout(180);
  const peerOnboarding = peer.locator('#onboardingModal.show');
  if (await peerOnboarding.isVisible()) await peerOnboarding.getByRole('button', { name: '✕' }).click();
  await peer.getByRole('button', { name: '故事设定' }).click();
  await page.locator('#novelTitle').fill('工作台保存验证');
  await page.getByRole('button', { name: '💾 保存项目' }).click();
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  const saved = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const loaded = await (await fetch(`/api/projects/${id}/state`)).json();
    return { title: loaded.state.project.title, freeText: loaded.state.storyBibleFreeText };
  });
  expect(saved.title).toBe('工作台保存验证');
  expect(saved.freeText).toContain('青铜钥匙');

  await peer.locator('#novelTitle').fill('同行设备的本地标题');
  await peer.getByRole('button', { name: '💾 保存项目' }).click();
  const conflictModal = peer.locator('#serverConflictModal.show');
  await expect(conflictModal.getByRole('heading', { name: '版本冲突解决' })).toBeVisible();
  const titleConflict = conflictModal.locator('.server-conflict-card').filter({ hasText: '小说标题' });
  await expect(titleConflict.locator('textarea').nth(0)).toHaveValue('同行设备的本地标题');
  await expect(titleConflict.locator('textarea').nth(1)).toHaveValue('工作台保存验证');
  await conflictModal.getByRole('button', { name: '合并并保存' }).click();
  await expect(peer.locator('#novelTitle')).toHaveValue('同行设备的本地标题');
  await peer.close();

  const fullSummary = `这是必须完整显示的章节概要。${'人物在漫长的夜路上逐步发现真相，并作出影响后续剧情的选择。'.repeat(18)}`;
  await page.evaluate(async (summary) => {
    const id = new URLSearchParams(location.search).get('project');
    const bundle = await (await fetch(`/api/projects/${id}/state`)).json();
    await fetch(`/api/projects/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: bundle.revision,
        state: {
          ...bundle.state,
          outline: [
            {
              chapter: 1,
              title: '夜路真相',
              summary,
              plotPoints: [
                { desc: '这一条剧情关键点也必须完整显示，不能用省略号截断。' },
                { desc: '第二条关键点可拖动调整先后顺序，并与服务器内容保持一致。' },
              ],
            },
            {
              chapter: 2,
              title: '下一步行动',
              summary: '人物根据第一章发现的线索采取行动。',
              plotPoints: [],
            },
          ],
          project: { ...bundle.state.project, setting: '一座会在午夜移动的旧灯塔。' },
          chapters: [{ chapter: 1, content: '第一章的正文已经完成。' }],
          agentEditHistory: [{ id: 'test-agent-edit', chapter: 1 }],
          reviewReports: { chapter1: { status: 'reviewed' } },
        },
      }),
    });
  }, fullSummary);
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const nextDraftStage = page.locator('.creative-canvas-stage[data-workflow-id="draft"]');
  await expect(nextDraftStage.getByRole('button', { name: '写第2章' })).toBeVisible();
  await nextDraftStage.getByRole('button', { name: '写第2章' }).click();
  await expect(page.locator('#chNavLabel')).toHaveText('第 2 章');
  await page.getByRole('button', { name: '章节大纲', exact: true }).click();
  await page.getByText('夜路真相').click();
  await expect(page.getByText(fullSummary, { exact: true })).toBeVisible();
  await expect(page.getByText('这一条剧情关键点也必须完整显示，不能用省略号截断。')).toBeVisible();
  await page.locator('.creative-plotpoint-row').first().getByRole('button', { name: '关键点下移' }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = new URLSearchParams(location.search).get('project');
        const points = (await (await fetch(`/api/projects/${id}/state`)).json()).state.outline[0].plotPoints;
        return points[0].desc;
      }),
    )
    .toContain('第二条关键点');
  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(page.locator('.creative-canvas-stage.is-complete')).toHaveCount(6);
  await expect(page.locator('.creative-canvas-stage[data-workflow-id="publish"]')).toHaveClass(/is-complete/);

  await page.getByRole('button', { name: '显示全部节点' }).click();
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: 'AI 步骤' }).click();
  let customStep = page.locator('.creative-canvas-step').last();
  await expect(customStep).toBeVisible();
  const customStepId = (await customStep.getAttribute('data-canvas-node-id'))!;
  expect(customStepId).toBeTruthy();
  await customStep.getByLabel('步骤名称').fill('追查钥匙的来历');
  await customStep.getByLabel('步骤要求').fill('从上游灵感中找出钥匙被制造的原因与新的代价。');
  const sourceForStep = page.locator('.creative-canvas-note').filter({ hasText: '封存钥匙' }).first();
  const customEdgeCountBeforeStep = await page.locator('[data-canvas-edge].custom').count();
  const sourcePort = sourceForStep.locator('[data-node-connect]');
  await sourcePort.focus();
  await sourcePort.press('Enter');
  const stepPort = customStep.locator('[data-node-connect]');
  await stepPort.focus();
  await stepPort.press('Enter');
  const sourceForStepId = (await sourceForStep.getAttribute('data-canvas-node-id'))!;
  const expectedCustomEdgeCount = customEdgeCountBeforeStep + 1;
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(expectedCustomEdgeCount);
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ stepId, sourceId }) => {
          const id = new URLSearchParams(location.search).get('project');
          const saved = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts
            .creativeCanvas;
          const step = saved.nodes.find((node: { id: string }) => node.id === stepId);
          return {
            title: step?.title,
            instruction: step?.instruction,
            hasIncoming: saved.edges.some(
              (edge: { from: string; to: string }) => edge.to === stepId && edge.from === sourceId,
            ),
          };
        },
        { stepId: customStepId, sourceId: sourceForStepId },
      ),
    )
    .toEqual({
      title: '追查钥匙的来历',
      instruction: '从上游灵感中找出钥匙被制造的原因与新的代价。',
      hasIncoming: true,
    });
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(expectedCustomEdgeCount);
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  customStep = page.locator(`.creative-canvas-step[data-canvas-node-id="${customStepId}"]`);
  await expect(customStep.getByLabel('步骤名称')).toHaveValue('追查钥匙的来历');
  await expect(customStep.getByLabel('步骤要求')).toHaveValue(/钥匙被制造/);
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(expectedCustomEdgeCount);
  const stepContextOriginals = await page.evaluate(async (stepId) => {
    const clone = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}));
    const originals = {
      memory: clone(state.memory),
      memoryTrust: clone(state.memoryTrust),
      methodologyCards: clone(state.methodologyCards || []),
      currentChapter: state.currentChapter,
      outline: clone(state.outline || []),
      chapters: clone(state.chapters || []),
    };
    state.baseURL = 'https://mock-novel-api.test';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    state.modelRoutes = {
      ...state.modelRoutes,
      outline: 'test-global-planner',
      editing: 'test-editor',
      chapter: 'test-writer',
    };
    state.methodologyCards = [
      {
        id: 'e2e-outline-methodology',
        name: 'E2E 大纲专用卡',
        cardText: 'E2E_OUTLINE_ONLY_CARD',
        enabledForOutline: true,
        enabledForChapter: false,
        createdAt: Date.now(),
      },
      {
        id: 'e2e-chapter-methodology',
        name: 'E2E 正文专用卡',
        cardText: 'E2E_CHAPTER_ONLY_CARD',
        enabledForOutline: false,
        enabledForChapter: true,
        createdAt: Date.now(),
      },
    ];
    const pastEvent = { chapter: 1, event: 'E2E_PAST_MEMORY_EVENT' };
    const futureEvent = { chapter: 99, event: 'E2E_FUTURE_MEMORY_EVENT' };
    const pastForeshadow = 'E2E_PAST_FORESHADOW';
    const futureForeshadow = 'E2E_FUTURE_FORESHADOW';
    const pastCard = {
      chapter: 1,
      title: '上一章记忆',
      summary: 'E2E_PAST_MEMORY_CARD',
      foreshadowsAdded: [pastForeshadow],
      foreshadowsResolved: [],
    };
    const futureCard = {
      chapter: 99,
      title: '未来记忆',
      summary: 'E2E_FUTURE_MEMORY_CARD',
      foreshadowsAdded: [futureForeshadow],
      foreshadowsResolved: [],
    };
    const appWindow = window as unknown as {
      memoryTextOf: (value: unknown) => string;
      simpleHash: (value: string) => string;
    };
    const hash = (value: unknown) => appWindow.simpleHash(appWindow.memoryTextOf(value));
    state.memory = {
      ...state.memory,
      characters: {
        ...state.memory?.characters,
        待处理角色: { currentStatus: 'E2E_FUTURE_CHARACTER_STATUS', goal: 'E2E_FUTURE_CHARACTER_GOAL' },
      },
      importantEvents: [pastEvent, futureEvent],
      foreshadows: {
        ...state.memory?.foreshadows,
        active: [pastForeshadow, futureForeshadow],
      },
      chapterCards: [pastCard, futureCard],
    };
    state.memoryTrust = {
      ...state.memoryTrust,
      'character:待处理角色': 'confirmed',
      [`event:1:${hash(pastEvent)}`]: 'confirmed',
      [`event:99:${hash(futureEvent)}`]: 'confirmed',
      'chapterCard:1': 'confirmed',
      'chapterCard:99': 'confirmed',
      [`foreshadow:active:${hash(pastForeshadow)}`]: 'confirmed',
      [`foreshadow:active:${hash(futureForeshadow)}`]: 'confirmed',
    };
    state.currentChapter = 2;
    state.outline = [
      ...(state.outline || []).filter((chapter: { chapter: number }) => Number(chapter.chapter) !== 99),
      {
        chapter: 99,
        title: '未来章节哨兵',
        summary: 'E2E_FUTURE_CHAPTER_CONTEXT',
        plotPoints: ['未来章节的独有事实'],
      },
    ];
    state.chapters = [
      ...(state.chapters || []).filter((chapter: { chapter: number }) => Number(chapter.chapter) !== 99),
      { chapter: 99, content: 'E2E_FUTURE_CHAPTER_TEXT_SENTINEL' },
    ];
    const canvas = state.uiDrafts.creativeCanvas;
    const outlineStage = canvas.nodes.find(
      (node: { kind: string; stageId?: string }) => node.kind === 'stage' && node.stageId === 'outline',
    );
    if (!outlineStage) throw new Error('E2E fixture is missing the outline stage');
    canvas.edges.push({
      id: 'e2e-stage-model-route-outline',
      from: outlineStage.id,
      to: stepId,
      kind: 'custom',
    });
    await Store.save();
    return originals;
  }, customStepId);
  await customStep.getByRole('button', { name: '让 AI 执行此步骤' }).click();
  await expect.poll(() => receivedStepPrompts.length).toBeGreaterThanOrEqual(2);
  const stepActions = page.locator('.creative-canvas-branch-actions').last().locator('button');
  await expect(stepActions).toHaveCount(1);
  await expect(page.locator('.creative-canvas-quality-report').last()).toContainText('审校通过');
  expect(receivedStepPrompts[0]).toContain('追查钥匙的来历');
  expect(receivedStepPrompts[0]).toContain('作者确认的长期记忆');
  expect(receivedStepPrompts[0]).toContain('上游工作流节点（沿连线回溯）');
  expect(receivedStepPrompts[0]).toContain('E2E_OUTLINE_ONLY_CARD');
  expect(receivedStepPrompts[0]).not.toContain('E2E_CHAPTER_ONLY_CARD');
  expect(receivedStepPrompts[0]).toContain('E2E_FUTURE_CHAPTER_CONTEXT');
  expect(receivedStepPrompts[0]).toContain('E2E_FUTURE_MEMORY_EVENT');
  expect(receivedStepPrompts[0]).toContain('E2E_FUTURE_MEMORY_CARD');
  expect(receivedStepPrompts[0]).toContain('E2E_FUTURE_CHARACTER_STATUS');
  expect(receivedStepPrompts.at(-1)).toContain('封存钥匙');
  expect(receivedStepPrompts.at(-1)).toContain('【创作结果精修任务】');
  expect(receivedStepPrompts.at(-1)).toContain('守夜人将钥匙铸成');
  expect(receivedStepModels.slice(0, 2)).toEqual(['test-global-planner', 'test-editor']);
  await page.getByRole('button', { name: '创作流程' }).click();
  await page.evaluate(async (stepId) => {
    const canvas = state.uiDrafts.creativeCanvas;
    canvas.edges = canvas.edges.filter((edge: { id: string }) => edge.id !== 'e2e-stage-model-route-outline');
    const draftStage = canvas.nodes.find(
      (node: { kind: string; stageId?: string }) => node.kind === 'stage' && node.stageId === 'draft',
    );
    if (!draftStage) throw new Error('E2E fixture is missing the draft stage');
    canvas.edges.push({
      id: 'e2e-stage-model-route-draft',
      from: draftStage.id,
      to: stepId,
      kind: 'custom',
    });
    await Store.save();
  }, customStepId);
  customStep = page.locator(`.creative-canvas-step[data-canvas-node-id="${customStepId}"]`);
  await customStep.getByRole('button', { name: '让 AI 执行此步骤' }).click();
  await expect.poll(() => receivedStepPrompts.length).toBeGreaterThanOrEqual(4);
  expect(receivedStepModels.slice(2, 4)).toEqual(['test-writer', 'test-editor']);
  expect(receivedStepPrompts[2]).toContain('E2E_CHAPTER_ONLY_CARD');
  expect(receivedStepPrompts[2]).not.toContain('E2E_OUTLINE_ONLY_CARD');
  expect(receivedStepPrompts[2]).toContain('当前写作目标｜第 2 章《下一步行动》');
  expect(receivedStepPrompts[2]).not.toContain('E2E_FUTURE_CHAPTER_CONTEXT');
  expect(receivedStepPrompts[2]).not.toContain('E2E_FUTURE_CHAPTER_TEXT_SENTINEL');
  expect(receivedStepPrompts[2]).toContain('E2E_PAST_MEMORY_EVENT');
  expect(receivedStepPrompts[2]).not.toContain('E2E_FUTURE_MEMORY_EVENT');
  expect(receivedStepPrompts[2]).toContain('E2E_PAST_MEMORY_CARD');
  expect(receivedStepPrompts[2]).not.toContain('E2E_FUTURE_MEMORY_CARD');
  expect(receivedStepPrompts[2]).not.toContain('E2E_FUTURE_CHARACTER_STATUS');
  expect(receivedStepPrompts[2]).toContain('E2E_PAST_FORESHADOW');
  expect(receivedStepPrompts[2]).toContain('后续或出现章节未标注的作者伏笔规划');
  expect(receivedStepPrompts[2]).toContain('E2E_FUTURE_FORESHADOW');
  expect(receivedStepPrompts[2]).toContain('不代表已在目标章前发生或为视角人物所知');
  await page.evaluate(async (originals) => {
    state.memory = originals.memory;
    state.memoryTrust = originals.memoryTrust;
    state.methodologyCards = originals.methodologyCards;
    state.currentChapter = originals.currentChapter;
    state.outline = originals.outline;
    state.chapters = originals.chapters;
    await Store.save();
  }, stepContextOriginals);
  await stepActions.first().click();
  await expect(page.getByRole('button', { name: '创作流程' })).toBeVisible();
  const createdStepBranch = page
    .locator('.creative-canvas-note')
    .filter({ hasText: '守夜人留下的证词' })
    .first();
  await expect(createdStepBranch).toBeVisible();
  const stepBranchSaved = await page.evaluate(
    async ({ stepId }) => {
      const id = new URLSearchParams(location.search).get('project');
      const saved = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
      const branch = saved.nodes.find(
        (node: { kind: string; text: string }) =>
          node.kind === 'note' && node.text.includes('守夜人留下的证词'),
      );
      return saved.edges.some(
        (edge: { from: string; to: string }) => edge.from === stepId && edge.to === branch?.id,
      );
    },
    { stepId: customStepId },
  );
  expect(stepBranchSaved).toBeTruthy();

  const sparkStage = page.locator('.creative-canvas-stage[data-workflow-id="spark"]');
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const contextSource = page.locator('.creative-canvas-note').filter({ hasText: '封存钥匙' }).first();
  const contextSourcePort = contextSource.locator('[data-node-connect]');
  await contextSourcePort.focus();
  await contextSourcePort.press('Enter');
  const sparkPort = sparkStage.locator('[data-node-connect]');
  await sparkPort.focus();
  await sparkPort.press('Enter');
  await sparkStage.locator('[data-node-connect]').focus();
  await sparkStage.locator('[data-node-connect]').press('Enter');
  const outlinePort = page.locator('.creative-canvas-stage[data-workflow-id="outline"] [data-node-connect]');
  await outlinePort.focus();
  await outlinePort.press('Enter');
  const customEdgesBeforeHide = await page.locator('[data-canvas-edge].custom').count();
  const contextBeforeHide = await page.evaluate(() => globalThis.buildExtraWritingContext('outline'));
  expect(contextBeforeHide).toContain('封存钥匙');
  const canvasBeforeHide = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const model = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
    return {
      node: model.nodes.find((node: { id: string }) => node.id === 'stage:spark'),
      edges: model.edges.filter((edge: { from: string; to: string }) =>
        [edge.from, edge.to].includes('stage:spark'),
      ),
    };
  });
  await sparkStage.locator('[data-canvas-hide-stage="spark"]').click();
  await expect(sparkStage).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = new URLSearchParams(location.search).get('project');
        const model = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
        return model.hiddenStageIds.includes('spark');
      }),
    )
    .toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(page.locator('.creative-canvas-stage[data-workflow-id="spark"]')).toHaveCount(0);
  const hiddenStageState = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const model = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
    return {
      node: model.nodes.find((node: { id: string }) => node.id === 'stage:spark'),
      hidden: model.hiddenStageIds.includes('spark'),
      edges: model.edges.filter((edge: { from: string; to: string }) =>
        [edge.from, edge.to].includes('stage:spark'),
      ),
    };
  });
  expect(hiddenStageState.node).toEqual(canvasBeforeHide.node);
  expect(hiddenStageState.hidden).toBeTruthy();
  expect(hiddenStageState.edges).toEqual(canvasBeforeHide.edges);
  const contextWhileHidden = await page.evaluate(() => globalThis.buildExtraWritingContext('outline'));
  expect(contextWhileHidden).toContain('封存钥匙');
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: '恢复：灵感共创' }).click();
  await expect(page.locator('.creative-canvas-stage[data-workflow-id="spark"]')).toBeVisible();
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(customEdgesBeforeHide);

  await page.getByRole('link', { name: '← 返回书库' }).click();
  await expect(page.getByRole('heading', { name: '📚 我的小说' })).toBeVisible();
  await page.getByRole('button', { name: '资料库' }).click();
  await expect(page).toHaveURL(/\?project=.*&tab=bible/);
  await expect(page.getByRole('heading', { name: 'AI 结构化索引' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '物品' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '组织' })).toBeVisible();
  await page
    .getByRole('heading', { name: '人物' })
    .locator('..')
    .getByRole('button', { name: '＋ 手动添加' })
    .click();
  const entityDialog = page.locator('#entityDialog');
  await entityDialog.getByLabel('姓名').fill('声音字段验收');
  await entityDialog.getByLabel('说话方式 / 语言习惯').fill('先观察，再用短句确认');
  await entityDialog.getByRole('button', { name: '保存' }).click();
  await expect(entityDialog).not.toBeVisible();
  await expect(page.locator('#characterList')).toContainText('先观察，再用短句确认');
  await page.screenshot({ path: 'test-results/speech-style-character-card.png', fullPage: true });
  const savedSpeechStyle = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const result = await (await fetch(`/api/projects/${id}/characters`)).json();
    return result.characters.find((character: { name: string }) => character.name === '声音字段验收')
      ?.speechStyle;
  });
  expect(savedSpeechStyle).toBe('先观察，再用短句确认');

  await page.getByRole('button', { name: '← 书库' }).click();
  await page.getByRole('button', { name: '进入写作' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
});

test('outline and chapter generation refine results before saving', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('生成质量验收');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await expect(page.locator('#promptOutline')).toHaveValue(/长篇结构质量要求/);
  await expect(page.locator('#promptWrite')).toHaveValue(/场景推进与作者声音/);
  await expect(page.locator('#promptWrite')).not.toHaveValue(/内容要充实，有具体的情节推进和细节描写/);
  await expect(page.locator('#promptEnding')).toHaveValue(/章节结尾收束要求/);
  await expect(page.locator('#promptWrite')).toHaveValue(/不要执行通用词语黑名单/);
  await expect(page.locator('#promptWrite')).not.toHaveValue(/绝对不要使用破折号/);
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal.show');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();

  // Persist the test story's focus before seeding cards through the API so the
  // autosave queue cannot race those revision-checked test fixtures.
  await page.evaluate(async () => {
    state.project.setting = '雾港的逆潮钟楼由夜巡司封存事故档案。';
    state.project.characters = '沈澄与闻砚共同追查姐姐留下的来信。';
    await Store.save();
  });

  await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    if (!id) throw new Error('missing test project id');
    const project = await (await fetch(`/api/projects/${id}`)).json();
    let revision = Number(project.revision);
    const refreshRevision = async () => {
      const latest = await (await fetch(`/api/projects/${id}`)).json();
      revision = Number(latest.revision);
    };
    const entityIds: Record<string, string> = {};
    const entities = [
      {
        path: 'characters',
        key: 'protagonist',
        data: {
          name: '沈澄',
          role: '主角',
          basicInfo: '旧港钟楼档案员，二十六岁',
          appearance: '左手食指留有墨痕',
          personality: '谨慎，擅长观察细节',
          speechStyle: '先观察、短句确认',
          background: '十五年前的雾港火灾中失去姐姐',
          motivation: '查清姐姐失踪前留下的来信',
          goals: '确认信件为何比寄件日期早一天',
          secrets: '曾替姐姐改过一份事故登记',
          currentStatus: '正核对当夜的寄件簿',
          notes: '紧张时会用指甲抵住拇指',
          tags: ['叙事主角'],
          customFields: { 说话节奏: '先观察、短句确认' },
          trust: 'manual',
        },
      },
      {
        path: 'characters',
        key: 'unconfirmed',
        data: {
          name: '待确认人物',
          role: '未知身份',
          basicInfo: '身份尚未核实的黑衣人',
          trust: 'auto',
        },
      },
      {
        path: 'locations',
        key: 'tower',
        data: {
          name: '逆潮钟楼',
          type: '旧港档案塔',
          description: '退潮时会露出通往地下层的铁梯',
          geography: '塔基伸入退潮后的河床',
          culture: '值夜者从不在午夜后报全名',
          rules: '午夜后只能走北侧楼梯',
          currentStatus: '第七层已封存',
          trust: 'manual',
        },
      },
      {
        path: 'items',
        key: 'key',
        data: {
          name: '银钥匙',
          type: '旧式校时钥匙',
          description: '表面刻着一圈逆向刻度',
          owner: '沈澄',
          abilities: '可打开钟楼校时匣',
          origin: '姐姐失踪前交给沈澄',
          currentStatus: '收在信封夹层',
          trust: 'manual',
        },
      },
      {
        path: 'organizations',
        key: 'nightWatch',
        data: {
          name: '夜巡司',
          type: '港口巡查组织',
          description: '负责封存夜间事故记录',
          purpose: '维持旧港宵禁秩序',
          culture: '以口头誓词确认交班',
          rules: '不得私自开启封存档案',
          leaders: '闻砚',
          headquarters: '钟楼东翼',
          currentStatus: '暂停对外接待',
          trust: 'confirmed',
        },
      },
    ];
    for (const entry of entities) {
      await refreshRevision();
      const response = await fetch(`/api/projects/${id}/${entry.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...entry.data, expectedRevision: revision }),
      });
      const saved = await response.json();
      if (!response.ok)
        throw new Error(`failed to seed ${entry.data.name} at revision ${revision}: ${saved.error}`);
      revision = saved.revision;
      entityIds[entry.key] = saved.entity.id;
    }
    await refreshRevision();
    const relationResponse = await fetch(`/api/projects/${id}/relations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'character',
        sourceId: entityIds.protagonist,
        targetType: 'item',
        targetId: entityIds.key,
        label: '持有',
        description: '姐姐失踪前将钥匙交给沈澄',
        tags: ['关键线索'],
        customFields: { ownership: '临时保管' },
        trust: 'manual',
        expectedRevision: revision,
      }),
    });
    const relation = await relationResponse.json();
    if (!relationResponse.ok)
      throw new Error(`failed to seed story relation at revision ${revision}: ${relation.error}`);

    // Stress the prompt projection with a large unrelated archive. The cards must remain
    // in SQLite, while the current story's explicitly named cast and setting stay visible.
    for (let index = 0; index < 10; index += 1) {
      const serial = String(index + 1).padStart(2, '0');
      const unrelated = `ZXQDECOY${serial}_UNRELATED_WORLD `;
      await refreshRevision();
      const response = await fetch(`/api/projects/${id}/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `远岸样本点${serial}`,
          type: '隔离测试资料',
          description: unrelated.repeat(160),
          expectedRevision: revision,
        }),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(`failed to seed ${serial} at revision ${revision}: ${saved.error}`);
      revision = saved.revision;
    }
    await Store.load();
  });

  const requests: Array<{
    system: string;
    lastUser: string;
    draft: string;
    context?: string;
  }> = [];
  let outlineDraftModel = '';
  let outlinePlannerModel = '';
  let outlineReviewModel = '';
  let chapterPlannerModel = '';
  let chapterDraftModel = '';
  let chapterReviewModel = '';
  let chapterRepairModel = '';
  const completeOutlineSummary = (base: string) => {
    const additions = [
      '这条线索迫使她在保住证据和追上寄件者之间选择，结果改变她对姐姐最后一夜的判断。',
      '阻力也来自她曾经隐瞒的登记记录，每次核实都让旧案中的责任变得更具体。',
      '她采取的办法留下可验证的痕迹，同时暴露自己的目的，使冲突沿着因果继续升级。',
      '本章结尾把新证据与行动代价并置，让下一章必须处理这次选择造成的后果。',
      '拓印能证明登记簿曾被人改动，却不能单独指出修改者，还需寻找第二项证据。',
    ];
    let summary = base;
    let index = 0;
    while (Array.from(summary.replace(/\s/g, '')).length < 220 && index < additions.length)
      summary += additions[index++];
    if (Array.from(summary.replace(/\s/g, '')).length < 220)
      summary += '她暂时保存证据，等到下一次核对时再验证这项判断。';
    return summary;
  };
  const draftOutline = JSON.stringify([
    {
      chapter: 1,
      title: '逆潮来信',
      summary: completeOutlineSummary('沈澄在逆潮钟声里收到姐姐的来信，发现信上的墨迹尚未干透。'),
      plotPoints: [
        '沈澄收到姐姐的来信并认出只有姐妹知道的暗号',
        '钟楼登记簿上的日期比来信寄出时间早一天',
        '沈澄决定趁天亮前查清寄件记录是谁改写的',
      ],
    },
  ]);
  const outlineArchitecture = [
    '核心戏剧问题：如果沈澄拿到能证明姐姐被抹去的证据，她要接受自己也曾篡改旧案，还是继续让责任留在暗处？',
    '人物与对抗力量：沈澄想查清姐姐失踪；闻砚要维持夜巡司封档秩序，并通过控制证据争取时间。两人的目标在证据是否公开上冲突。',
    '故事因果弧：来信与日期矛盾迫使沈澄查登记簿；封存柜拓印让闻砚介入并暴露旧案；沈澄发现自己曾替姐姐改过记录，必须公开证据并承担共同责任。',
    '章节职责：第 1 章建立信件与日期冲突；第 2 章以拓印和闻砚的选择将调查升级为公开责任。每章带来的证据和代价推动下一步。',
  ].join('\n');
  const draftContinuationOutline = JSON.stringify([
    {
      chapter: 2,
      title: '钟楼暗层',
      summary: completeOutlineSummary('沈澄循着封存柜找到暗层入口，闻砚试图阻拦。'),
      plotPoints: [
        '沈澄循着封存柜划痕找到暗层入口',
        '闻砚赶来阻拦并说漏事故日期',
        '沈澄留下拓印证据后独自进入暗层',
      ],
    },
  ]);
  const revisedContinuationOutline = JSON.stringify([
    {
      chapter: 2,
      title: '暗层的旧日期',
      summary: completeOutlineSummary(
        '沈澄沿封存柜上的旧划痕找到暗层入口。闻砚赶来阻拦时说漏了事故日期，迫使她先留下能证明两人都到过此处的拓印，再独自进入暗层。',
      ),
      plotPoints: [
        '沈澄用封存柜上的旧划痕找到暗层入口',
        '闻砚说漏事故日期，沈澄留下拓印后独自进入暗层',
        '暗层门在她身后锁死，断绝原路返回的可能',
      ],
    },
  ]);
  const revisedOutline = JSON.stringify([
    {
      chapter: 1,
      title: '明日寄来的信',
      summary: completeOutlineSummary(
        '沈澄在逆潮钟声里收到姐姐的来信；她按信中地址追查，发现钟楼的寄件记录比现实早一天。',
      ),
      plotPoints: [
        '沈澄收到姐姐的来信并认出只有姐姐知道的暗号',
        '钟楼的寄件记录比现实早一天，迫使她当夜追查寄信人',
        '她藏起登记簿拓印，决定在夜巡司封档前进入钟楼',
      ],
    },
    {
      chapter: 2,
      title: '封存柜上的新痕',
      summary: completeOutlineSummary(
        '沈澄沿着寄件日期找到封存柜，发现柜门的新划痕指向姐姐失踪前最后值守的钟楼暗层。',
      ),
      plotPoints: [
        '沈澄从登记簿找出封存柜位置',
        '闻砚出现并试图夺走她留下的拓印',
        '她决定在天亮前进入钟楼暗层并留下退路',
      ],
    },
  ]);
  const repeatedSummarySentence = '沈澄把拓印夹进值夜簿，留下可供夜巡司复核的证据。';
  const repeatedSummarySentenceOutlineRepaired = JSON.parse(revisedOutline);
  repeatedSummarySentenceOutlineRepaired[0].summary += repeatedSummarySentence;
  const repeatedSummarySentenceOutline = JSON.parse(JSON.stringify(repeatedSummarySentenceOutlineRepaired));
  repeatedSummarySentenceOutline[0].summary += repeatedSummarySentence;
  const repeatedSummarySentenceOutlineReview = JSON.stringify(repeatedSummarySentenceOutline);
  const duplicateOutlineChapters = JSON.parse(revisedOutline);
  const duplicateOutlineReview = JSON.stringify([
    {
      ...duplicateOutlineChapters[0],
      plotPoints: [
        duplicateOutlineChapters[0].plotPoints[0],
        duplicateOutlineChapters[0].plotPoints[0],
        duplicateOutlineChapters[0].plotPoints[2],
      ],
    },
    { ...duplicateOutlineChapters[1], summary: duplicateOutlineChapters[0].summary },
  ]);
  const nearDuplicateOutlineChapters = JSON.parse(revisedOutline);
  const nearDuplicateOutlineReview = JSON.stringify([
    {
      ...nearDuplicateOutlineChapters[0],
      summary: completeOutlineSummary('沈澄在逆潮钟声里收到姐姐来信，发现信上的墨迹尚未干。'),
      plotPoints: [
        ...nearDuplicateOutlineChapters[0].plotPoints,
        '沈澄逐字核对登记簿，发现寄件日期比来信早一天',
        '沈澄逐字核对登记簿，发现寄件日期竟比来信早一天',
      ],
    },
    {
      ...nearDuplicateOutlineChapters[1],
      summary: completeOutlineSummary('沈澄在逆潮钟声里拆开姐姐来信，发现信上的墨迹尚未干。'),
    },
  ]);
  const sharedMotifOutlineChapters = JSON.parse(revisedOutline);
  const sharedMotifOutlineReview = JSON.stringify([
    {
      ...sharedMotifOutlineChapters[0],
      summary: completeOutlineSummary(
        '沈澄在逆潮钟声里收到姐姐来信，发现墨迹指向封存柜。她沿地址追查寄件日期，拓印登记簿并决定趁封档前找出改写者。',
      ),
    },
    {
      ...sharedMotifOutlineChapters[1],
      summary: completeOutlineSummary(
        '沈澄在逆潮钟声里拆开姐姐寄来的第二封信，发现墨迹指向封存柜。她沿地址追查寄件日期，烧毁登记簿并决定趁封档前保护改写者。',
      ),
    },
  ]);
  const expandedPointOutline = JSON.stringify(
    JSON.parse(revisedOutline).map((chapter, index) =>
      index === 0
        ? {
            ...chapter,
            plotPoints: [
              ...chapter.plotPoints.slice(0, 2),
              '沈澄把异常日期拓印下来，留下可供核验的登记簿证据',
              '她藏好拓印，决定赶在夜巡司封档前进入钟楼追查更改者',
            ],
          }
        : chapter,
    ),
  );
  const overfullOutlineDraft = JSON.stringify([
    {
      chapter: 1,
      title: '七项原稿',
      summary: completeOutlineSummary('沈澄在逆潮钟声里收到来信，夜巡司要求她在封档前交出登记簿。'),
      plotPoints: [
        '沈澄赶到值夜台接替当夜的档案工作',
        '沈澄拆开姐姐来信并认出姐妹间的暗号',
        '她发现登记簿记录的寄信日期早于来信本身',
        '夜巡司要求她立即交出登记簿停止追查',
        '沈澄从装订线里找到被替换的薄纸页',
        '她拓下早一天的寄件记录并藏好证据',
        '沈澄决定在封档前进入钟楼核对原件',
      ],
    },
  ]);
  const revisedOverfullOutline = JSON.stringify([
    {
      chapter: 1,
      title: '封档前的六个决定',
      summary: completeOutlineSummary(
        '沈澄在逆潮钟声里拆开姐姐的来信，认出姐妹暗号，并发现登记簿的寄件日期早于信件。夜巡司催她交出档案时，她找到被换过的薄页、拓下日期并藏起证据，最终决定在封档前进入钟楼核对原件。',
      ),
      plotPoints: [
        '沈澄赶到值夜台接班，在姐姐来信中认出只有姐妹知道的暗号',
        '她核对寄件簿，发现日期竟比来信早了一天',
        '夜巡司要求交出档案，沈澄从装订线发现被替换的薄页',
        '她拓下早一天的记录，先把能证明改动的证据藏进袖口',
        '薄页上的印记指向钟楼封档室，证明登记簿原件仍在那里',
        '沈澄决定趁封档前进入钟楼，闻砚赶来阻拦',
      ],
    },
    {
      chapter: 2,
      title: '封存柜上的新痕',
      summary: completeOutlineSummary(
        '沈澄沿着寄件日期找到封存柜，发现柜门的新划痕指向姐姐失踪前最后值守的钟楼暗层。',
      ),
      plotPoints: [
        '沈澄从登记簿找出封存柜位置',
        '闻砚出现并试图夺走她留下的拓印',
        '她决定在天亮前进入钟楼暗层并留下退路',
      ],
    },
  ]);
  const unrelatedOutlineReview = JSON.stringify([
    {
      chapter: 1,
      title: '雪岭掌门令',
      summary: completeOutlineSummary('沈澄在雪岭遇见旧友，决定继承门派掌门之位并迎战魔君。'),
      plotPoints: [
        '沈澄在雪岭遇见旧友并接下门派掌门令牌',
        '她跟随师父踏入寒潭寻找失落的剑谱',
        '魔君率众突袭山门，沈澄选择留下断后',
      ],
    },
    {
      chapter: 2,
      title: '封存柜上的新痕',
      summary: completeOutlineSummary(
        '沈澄沿着寄件日期找到封存柜，发现柜门的新划痕指向姐姐失踪前最后值守的钟楼暗层。',
      ),
      plotPoints: [
        '沈澄从登记簿找出封存柜位置',
        '闻砚出现并试图夺走她留下的拓印',
        '她决定在天亮前进入钟楼暗层并留下退路',
      ],
    },
  ]);
  const singlePointSwapOutlineReview = JSON.stringify([
    {
      chapter: 1,
      title: '姐姐来信与雪岭异变',
      summary: completeOutlineSummary('沈澄收到姐姐的来信，却发现登记簿上的寄件日期早了一天。'),
      plotPoints: [
        '沈澄收到姐姐的来信并认出只有姐妹知道的暗号',
        '钟楼登记簿上的日期比来信寄出时间早一天',
        '魔君率众突袭山门并击退守军，门派长老带领弟子撤离',
      ],
    },
    {
      chapter: 2,
      title: '封存柜上的新痕',
      summary: completeOutlineSummary(
        '沈澄沿着寄件日期找到封存柜，发现柜门的新划痕指向姐姐失踪前最后值守的钟楼暗层。',
      ),
      plotPoints: [
        '沈澄从登记簿找出封存柜位置',
        '闻砚出现并试图夺走她留下的拓印',
        '她决定在天亮前进入钟楼暗层并留下退路',
      ],
    },
  ]);
  const draftChapter =
    '逆潮的钟声穿过雾港，沈澄在值夜台上拆开姐姐的来信。她没有立刻相信，只把信纸压进登记簿，去查寄件时间。【PP1】登记簿上那行墨迹比眼前的信早了一天。【PP2】她决定趁夜巡司封档前查清改动者。【PP3】';
  const chapterDraftWithSceneBlueprint = `【本章场景蓝图】
1｜沈澄 / 值夜台｜核对来信日期｜登记簿出现提前一天的墨迹｜她决定赶在封档前查证｜承载 PP1、PP2
2｜沈澄 / 夜巡司封档前｜查清改动者｜时间与证据即将消失｜她决定追查｜承载 PP3
【本章正文开始】
${draftChapter}`;
  const chapterSceneBlueprint = chapterDraftWithSceneBlueprint
    .split('【本章正文开始】')[0]
    .replace('【本章场景蓝图】\n', '')
    .trim();
  const chapterDraftWithoutBodyHeader = `【本章场景蓝图】
场景1｜沈澄 / 值夜台｜核对来信日期｜登记簿出现提前一天的墨迹｜她决定赶在封档前查证｜承载 PP1、PP2
场景2｜沈澄 / 夜巡司封档前｜查清改动者｜时间与证据即将消失｜她决定追查｜承载 PP3

${draftChapter}`;
  const autoSupplementChapterDraft =
    '沈澄对照登记簿找到封存柜。【PP1】闻砚堵住门口，伸手要拓印。【PP2】她收起拓印，在门边留下假线索。【PP3】';
  const autoSupplementChapterReview = `EARLY_AUTO_SUPPLEMENT_HISTORY_ANCHOR\n${'桥底值守者每晚核对三道暗号，第三道总被雨水抹去一半。\n'.repeat(120)}沈澄对照登记簿找到封存柜编号，先记住门边的新痕。【PP1】闻砚堵住门口，伸手索要拓印；她把拓印折进袖中，没有让出门口。【PP2】她在门边留下假线索，准备从暗层绕入柜后。【PP3】`;
  const autoSupplementRawAppend = 'RAW_APPEND_SHOULD_NOT_APPEAR。她沿着柜边摸索，找到一块松动的砖。';
  const autoSupplementReviewedAppend =
    '沈澄没有推门，而是顺着新痕反向摸到柜侧。松砖后压着一张旧交班签，墨迹被水泡散，唯有闻砚惯用的三短一长仍清晰。她终于明白，他抢拓印不是要销毁日期，而是要遮住当年最后一次开柜的人。她把签纸留在砖缝，只带走拓印；明早闻砚若来取，就会知道她已经看见了那道暗记。她把旧签重新压平，水痕下还露出一笔被刮去的编号。那不是开柜人的姓名，而是交班人代领钥匙时用的临时印记。门外闻砚连换三种说法，却始终没提这串编号；沈澄把拓印与旧签分开收好，一份留在登记簿，一份送到夜巡司值房，确保其中一份被毁也不能抹掉线索。她不再贸然追进暗层，而是决定让天亮后的公开交班成为下一步试探。';
  const autoSupplementBaseLength = Array.from(
    autoSupplementChapterReview.replace(/\s|【PP\s*\d+】/g, ''),
  ).length;
  const autoSupplementTarget = Math.ceil((autoSupplementBaseLength + 200) / 0.7);
  const autoSupplementMinimum = Math.ceil(autoSupplementTarget * 0.7);
  const revisedChapter =
    '逆潮钟声响起时，值夜台的玻璃先蒙上一层白雾。沈澄拆开信，姐姐留下的暗号只有她们两人认得。她没有把信收进口袋，而是压进登记簿，逐页核对寄件时间；登记簿上的墨迹早了一天，逼得她必须在天亮前找到寄信人。【PP1】她循着日期查到封存柜，柜门上的新划痕与姐姐信末的地址吻合。【PP2】她将拓印藏进袖口，决定赶在夜巡司封档前入塔。【PP3】';
  const looseChapterMarkers =
    '雾港的钟声在夜色里反复响起，值夜台的木门被风吹得撞上墙面。沈澄拆开姐姐的信，认出只有姐妹知道的暗号。【PP1】登记簿上的日期确实早了一天，夜巡司的人在门外催她交出记录，她必须赶在封档前留下证据。【PP2】【PP3】';
  const continuationDraft =
    '沈澄没有立刻打开封存柜。她先把柜门划痕拓在信封背面，发现缺口的方向与钟楼齿轮的转动相反。闻砚赶来阻止她，却说漏了只有事故记录里才有的日期。';
  const continuationDraftWithSceneBlueprint = `【本章场景蓝图】
场景1｜沈澄 / 值夜台 / 夜深｜确认划痕对应的登记页｜闻砚阻止她继续核对｜她先拓下缺口并留下可复查的证据｜局势从猜测变为可验证的调查

【本章正文开始】
${continuationDraft}`;
  const continuationSceneBlueprint = continuationDraftWithSceneBlueprint
    .split('【本章正文开始】')[0]
    .replace('【本章场景蓝图】\n', '')
    .trim();
  const endingDraft =
    '她把拓下的日期压进值夜台的灯影里，墨色缺口正好对上夜巡司封档前的暗记。远处钟声停了一拍。沈澄收起纸片，没有合上登记簿；天亮前，她还要拿着这条证据去找闻砚。';
  const refinedEnding =
    '灯影移过纸面，那处缺口仍像被什么咬去一角。沈澄把拓印夹回登记簿，空出一只手去拉门。塔外巡更的脚步停在台阶下；她认出了闻砚惯用的三短一长，却没有应声。册页留在桌上，下一次有人翻开时，墨迹会替她作证。';
  let returnIncompleteOutline = false;
  let returnLengthLimitedOutlineReview = false;
  let returnLengthLimitedOutlineDraft = false;
  let returnMalformedEndingReview = false;
  let returnMalformedChapterScenePlan = false;
  let returnScenePlanWithoutBodyHeader = false;
  let returnEmptyChapterDraft = false;
  let returnUnmarkedEndingReview = false;
  let returnInvalidOutlineReview = false;
  let returnInvalidOutlineRepair = false;
  let returnRepeatedSummarySentenceReview = false;
  let returnShallowOutlineReview = false;
  let returnOverfullOutline = false;
  let returnUnrelatedOutlineReview = false;
  let returnDuplicateOutlineReview = false;
  let returnNearDuplicateOutlineReview = false;
  let returnSharedMotifOutlineReview = false;
  let returnSharedMotifOutlineRepairUnchanged = false;
  let returnSinglePointSwapOutline = false;
  let returnExpandedPointOutline = false;
  let returnLooseChapterMarkers = false;
  let returnUnchangedChapterReview = false;
  let returnLengthLimitedEndingReview = false;
  let returnEmptyEndingDraft = false;
  let returnShortAutoSupplementChapter = false;
  let returnUnmarkedAutoSupplementReview = false;
  let duplicateAppendBody = '';
  let returnDuplicateContinuationDraft = false;
  let returnDuplicateContinuationReview = false;
  let returnDuplicateContinuationRepair = false;
  const shallowOutline = JSON.stringify([
    {
      chapter: 1,
      title: '过短概要',
      summary: '沈澄收到一封信并发现日期不对。',
      plotPoints: ['沈澄收到来信', '寄件日期异常'],
    },
    {
      chapter: 2,
      title: '两条关键点',
      summary: '沈澄进入钟楼寻找线索。',
      plotPoints: ['找到钟楼入口', '闻砚赶来阻拦'],
    },
  ]);
  await page.route('https://mock-quality.test/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON() as {
      model?: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    const messages = payload.messages || [];
    const system = messages.find((message) => message.role === 'system')?.content || '';
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
    const isOutlineReview = lastUser.includes('【结构精修任务】');
    const isEndingReview = lastUser.includes('【章节收束精修任务】');
    const isOutlineRepair = lastUser.includes('【大纲质量校验修复】');
    const isChapterRepair = lastUser.includes('【正文质量校验修复】');
    const isContinueRepair = lastUser.includes('【续写质量校验修复】');
    const isOutlinePlanner = lastUser.includes('【故事结构规划任务】');
    const isScenePlanner = lastUser.includes('【场景蓝图规划任务】');
    const model = String(payload.model || '');
    if (isOutlineReview) outlineReviewModel = model;
    else if (isOutlinePlanner) outlinePlannerModel = model;
    else if (system.includes('只输出纯净 JSON') && !isOutlineRepair) outlineDraftModel = model;
    if (lastUser.includes('【章节正文精修任务】')) chapterReviewModel = model;
    else if (isChapterRepair) chapterRepairModel = model;
    else if (isScenePlanner) chapterPlannerModel = model;
    else if (system.includes('你是一位出色的小说作家')) chapterDraftModel = model;
    const finishReason =
      (returnLengthLimitedOutlineReview && isOutlineReview) ||
      (returnLengthLimitedEndingReview && isEndingReview) ||
      (returnLengthLimitedOutlineDraft &&
        !isOutlineReview &&
        !isOutlinePlanner &&
        system.includes('只输出纯净 JSON'))
        ? 'length'
        : 'stop';
    let result = '{}';
    if (isEndingReview) {
      requests.push({
        system,
        lastUser,
        draft: messages.at(-2)?.content || '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = returnMalformedEndingReview ? '【精修诊断】第 1 段需要更具体的动作落点。' : refinedEnding;
    } else if (isOutlinePlanner) {
      requests.push({
        system,
        lastUser,
        draft: '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = `【故事结构蓝图】\n${outlineArchitecture}`;
    } else if (isOutlineReview || isOutlineRepair) {
      requests.push({
        system,
        lastUser,
        draft: messages.at(-2)?.content || '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = isOutlineRepair
        ? returnInvalidOutlineRepair
          ? shallowOutline
          : returnSharedMotifOutlineRepairUnchanged
            ? sharedMotifOutlineReview
            : returnRepeatedSummarySentenceReview
              ? JSON.stringify(repeatedSummarySentenceOutlineRepaired)
              : revisedOutline
        : returnInvalidOutlineReview
          ? '这不是合法的大纲 JSON'
          : returnRepeatedSummarySentenceReview
            ? repeatedSummarySentenceOutlineReview
            : returnShallowOutlineReview
              ? shallowOutline
              : returnOverfullOutline
                ? revisedOverfullOutline
                : returnDuplicateOutlineReview
                  ? duplicateOutlineReview
                  : returnNearDuplicateOutlineReview
                    ? nearDuplicateOutlineReview
                    : returnSharedMotifOutlineReview
                      ? sharedMotifOutlineReview
                      : returnUnrelatedOutlineReview
                        ? unrelatedOutlineReview
                        : returnSinglePointSwapOutline
                          ? singlePointSwapOutlineReview
                          : returnExpandedPointOutline
                            ? expandedPointOutline
                            : returnIncompleteOutline
                              ? draftOutline
                              : lastUser.includes('只输出本次新增章节')
                                ? revisedContinuationOutline
                                : revisedOutline;
    } else if (system.includes('只输出用户要求新增的缺失章节')) {
      requests.push({ system, lastUser, draft: '' });
      result = draftContinuationOutline;
    } else if (system.includes('只输出纯净 JSON')) {
      requests.push({ system, lastUser, draft: '' });
      result = returnOverfullOutline ? overfullOutlineDraft : draftOutline;
    } else if (lastUser.includes('【章节正文精修任务】')) {
      requests.push({
        system,
        lastUser,
        draft: messages.at(-2)?.content || '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = returnLooseChapterMarkers
        ? looseChapterMarkers
        : returnUnchangedChapterReview
          ? messages.at(-2)?.content || ''
          : returnShortAutoSupplementChapter
            ? autoSupplementChapterReview
            : revisedChapter;
    } else if (isChapterRepair) {
      requests.push({
        system,
        lastUser,
        draft: messages.at(-2)?.content || '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = returnLooseChapterMarkers ? looseChapterMarkers : revisedChapter;
    } else if (isContinueRepair) {
      requests.push({ system, lastUser, draft: messages.at(-2)?.content || '' });
      result = returnDuplicateContinuationRepair ? duplicateAppendBody : continuationDraft;
    } else if (isScenePlanner) {
      requests.push({
        system,
        lastUser,
        draft: '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = returnMalformedChapterScenePlan
        ? '【本章场景蓝图】\n这还不是可执行的场景卡。'
        : `【本章场景蓝图】\n${system.includes('请根据已有内容继续往下写') ? continuationSceneBlueprint : chapterSceneBlueprint}`;
    } else if (lastUser.includes('【续写精修任务】')) {
      requests.push({
        system,
        lastUser,
        draft: messages.at(-2)?.content || '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = returnShortAutoSupplementChapter
        ? returnUnmarkedAutoSupplementReview
          ? '只给出了意见，没有提供可采用的续写稿。'
          : autoSupplementReviewedAppend
        : returnDuplicateContinuationReview
          ? duplicateAppendBody
          : '她离开了。';
    } else if (system.includes('请根据已有内容继续往下写')) {
      requests.push({ system, lastUser, draft: '' });
      result = returnShortAutoSupplementChapter
        ? autoSupplementRawAppend
        : returnDuplicateContinuationDraft
          ? duplicateAppendBody
          : lastUser.includes('【按场景蓝图续写｜正文阶段】')
            ? continuationDraftWithSceneBlueprint
            : continuationDraft;
    } else if (system.includes('请根据已有内容和用户要求续写章节收尾')) {
      requests.push({ system, lastUser, draft: '' });
      result = returnEmptyEndingDraft ? '' : endingDraft;
    } else if (system.includes('你是一位出色的小说作家')) {
      requests.push({
        system,
        lastUser,
        draft: '',
        context: messages.map((message) => message.content || '').join('\n'),
      });
      result = returnScenePlanWithoutBodyHeader
        ? chapterDraftWithoutBodyHeader
        : returnEmptyChapterDraft
          ? ''
          : returnShortAutoSupplementChapter
            ? autoSupplementChapterDraft
            : draftChapter;
    }
    const isEditorialReview = [
      '【结构精修任务】',
      '【章节正文精修任务】',
      '【章节收束精修任务】',
      '【续写精修任务】',
      '【创作结果精修任务】',
      '【剧情路线精修任务】',
      '【大纲质量校验修复】',
      '【正文质量校验修复】',
      '【续写质量校验修复】',
    ].some((marker) => lastUser.includes(marker));
    if (
      isEditorialReview &&
      !(isEndingReview && (returnMalformedEndingReview || returnUnmarkedEndingReview)) &&
      !(returnUnmarkedAutoSupplementReview && lastUser.includes('【续写精修任务】'))
    )
      result = `【精修诊断】第 1 章：日期线索尚未改变人物选择；让沈澄据此采取一次可验证的查证行动。\n【修订稿】\n${result}`;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: result } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}`,
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });
  await page.evaluate(async () => {
    state.baseURL = 'https://mock-quality.test';
    state.apiKey = 'test-only';
    state.model = 'quality-mock';
    state.project.setting = '雾港的逆潮钟楼由夜巡司封存事故档案。';
    state.project.characters = '沈澄与闻砚共同追查姐姐留下的来信。';
    (document.getElementById('novelSetting') as HTMLTextAreaElement).value = state.project.setting;
    (document.getElementById('novelCharacters') as HTMLTextAreaElement).value = state.project.characters;
    state.project.chapterCount = 2;
    state.project.wordsPerChapter = 200;
    state.selectedLength = 'brief';
    state.autoContinue = false;
    state.chapterContinuity = false;
    state.currentChapter = 1;
    state.contextFull = true;
    const testWindow = globalThis as typeof globalThis & {
      buildChapterContextMessages: (
        chapter: number,
        mode: string,
      ) => Array<{ role: 'user' | 'assistant'; content: string }>;
      __originalChapterContextMessages?: (
        chapter: number,
        mode: string,
      ) => Array<{ role: 'user' | 'assistant'; content: string }>;
    };
    testWindow.__originalChapterContextMessages = testWindow.buildChapterContextMessages;
    testWindow.buildChapterContextMessages = (_chapter, mode) => [
      { role: 'user', content: `【${mode}上下文】` },
      {
        role: 'assistant',
        content: mode === 'full' ? '全文模式保留的关键伏笔' : '摘要模式的概括信息',
      },
    ];
    (document.getElementById('chapterCount') as HTMLInputElement).value = '2';
    (document.getElementById('wordsPerChapter') as HTMLInputElement).value = '200';
    await Store.save();
  });

  const bibleProjection = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const context = globalThis.buildExtraWritingContext('outline');
    const savedLocations = await (await fetch(`/api/projects/${id}/locations`)).json();
    return {
      context,
      contextLength: context.length,
      locationCount: savedLocations.locations.length,
      savedLongDescriptionLength: savedLocations.locations.find(
        (location: { name: string }) => location.name === '远岸样本点01',
      )?.description.length,
    };
  });
  expect(bibleProjection.contextLength).toBeLessThan(24000);
  expect(bibleProjection.context).toContain('作者确认资料 · 人物：沈澄');
  expect(bibleProjection.context).toContain('作者确认资料 · 地点：逆潮钟楼');
  expect(bibleProjection.context).toContain('作者确认资料 · 组织：夜巡司');
  expect(bibleProjection.context).toContain('物品「银钥匙」');
  expect(bibleProjection.context).not.toContain('远岸样本点01');
  expect(bibleProjection.context).not.toContain('ZXQDECOY01_UNRELATED_WORLD');
  expect(bibleProjection.locationCount).toBe(11);
  expect(bibleProjection.savedLongDescriptionLength).toBe('ZXQDECOY01_UNRELATED_WORLD '.repeat(160).length);

  await page.evaluate(async () => {
    state.modelRoutes = {
      ...state.modelRoutes,
      outline: 'quality-outline-route',
      chapter: 'quality-writer-route',
      editing: null,
    };
    await Store.save();
  });
  await page.locator('[data-tab="outline"]').click();
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            request.system.includes('只输出纯净 JSON') &&
            !request.lastUser.includes('【结构精修任务】') &&
            !request.lastUser.includes('【故事结构规划任务】'),
        ).length,
    )
    .toBe(1);
  const outlinePlanRequest = requests.find((request) => request.lastUser.includes('【故事结构规划任务】'));
  expect(outlinePlanRequest?.lastUser).toContain('戏剧问题');
  expect(outlinePlanRequest?.lastUser).toContain('替换性测试');
  expect(outlinePlanRequest?.lastUser).toContain('两种都要付代价的选择');
  expect(outlinePlanRequest?.lastUser).toContain('共 2 章');
  expect(outlinePlanRequest?.context).toContain('地理：塔基伸入退潮后的河床');
  expect(outlinePlannerModel).toBe('quality-outline-route');
  const outlineDraftRequest = requests.find(
    (request) =>
      request.system.includes('只输出纯净 JSON') &&
      !request.lastUser.includes('【结构精修任务】') &&
      !request.lastUser.includes('【故事结构规划任务】'),
  );
  expect(outlineDraftRequest?.lastUser).toContain('【长篇结构质量要求】');
  expect(outlineDraftRequest?.lastUser).toContain('【按故事结构蓝图生成章节大纲】');
  expect(outlineDraftRequest?.lastUser).toContain('【故事结构蓝图｜结构参照】');
  expect(outlineDraftRequest?.lastUser).toContain('核心戏剧问题：如果沈澄');
  expect(outlineDraftModel).toBe('quality-outline-route');
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(1);
  const outlineReview = requests.find((request) => request.lastUser.includes('【结构精修任务】'));
  expect(outlineReview?.system).toContain('【本轮角色：独立内容编辑】');
  expect(outlineReviewModel).toBe('quality-outline-route');
  expect(outlineReview?.system).toContain('作品辨识度与读者承诺');
  expect(outlineReview?.lastUser).toContain('人物想达成什么');
  expect(outlineReview?.lastUser).toContain('比较各章的叙事功能与章末状态');
  expect(outlineReview?.lastUser).toContain('共享意象和母题可以回环');
  expect(outlineReview?.lastUser).toContain('不能只把专有名词贴在通用剧情模板上');
  expect(outlineReview?.lastUser).toContain('替换性测试');
  expect(outlineReview?.lastUser).toContain('不强迫每章都反转或用悬崖钩子收尾');
  expect(outlineReview?.lastUser).toContain('【精修交付格式】');
  expect(outlineReview?.lastUser).toContain('【故事结构蓝图｜质量参照】');
  expect(outlineReview?.lastUser).toContain('每章关键点数量');
  expect(outlineReview?.lastUser).toContain('概要篇幅契约】每章概要 200-300 字');
  expect(outlineReview?.lastUser).toContain('每章关键点数量契约】每章 3-6 个');
  expect(outlineReview?.lastUser).toContain('共 2 章');
  expect(outlineReview?.lastUser).toContain('初稿当前包含 1 章');
  expect(outlineReview?.context).toContain('地理：塔基伸入退潮后的河床');
  expect(outlineReview?.context).toContain('文化：值夜者从不在午夜后报全名');
  expect(outlineReview?.context).toContain('来历：姐姐失踪前交给沈澄');
  expect(outlineReview?.context).toContain('目的：维持旧港宵禁秩序');
  expect(outlineReview?.context).not.toContain('待确认人物');
  await expect.poll(() => page.evaluate(() => state.outline[0]?.title || '')).toBe('明日寄来的信');
  await expect.poll(() => page.evaluate(() => state.outline.length)).toBe(2);
  await expect(page.locator('#outlineStreamModal')).not.toHaveClass(/show/);
  const outline = await page.evaluate(() => state.outline[0]);
  expect(outline.title).toBe('明日寄来的信');
  expect(outline.plotPoints).toHaveLength(3);
  expect(JSON.stringify(outline)).not.toContain('【精修诊断】');
  expect((await page.evaluate(() => state.outline[1])).chapter).toBe(2);
  const outlineQualityReport = page.locator('[data-generation-quality-target="outline"]');
  await expect(outlineQualityReport).toContainText('审校通过');
  await outlineQualityReport.locator(':scope > summary').click();
  const outlineArchitectureReport = page.locator('[data-outline-architecture="true"]');
  await expect(outlineArchitectureReport.locator('summary')).toHaveText('故事结构蓝图');
  await outlineArchitectureReport.locator('summary').click();
  await expect(outlineArchitectureReport).toContainText('核心戏剧问题：如果沈澄');
  const staleOutlineLabel = await page.evaluate(async () => {
    const summary = state.outline[0].summary;
    state.outline[0].summary = `${summary}E2E_STALE_REPORT_SENTINEL`;
    globalThis.renderOutline();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const label = document.querySelector('[data-generation-quality-target="outline"] summary')?.textContent;
    state.outline[0].summary = summary;
    globalThis.renderOutline();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return label;
  });
  expect(staleOutlineLabel).toContain('内容已改');

  await page.locator('[data-tab="write"]').click();
  returnUnchangedChapterReview = true;
  const chapterRepairCountBefore = requests.filter((request) =>
    request.lastUser.includes('【正文质量校验修复】'),
  ).length;
  await page.locator('#btnGenChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.system.includes('你是一位出色的小说作家')).length)
    .toBe(4);
  const chapterPlanRequest = requests.find((request) => request.lastUser.includes('【场景蓝图规划任务】'));
  expect(chapterPlanRequest?.lastUser).toContain('每场压成一行');
  expect(chapterPlanRequest?.lastUser).toContain('每卡约 100–220 字');
  expect(chapterPlanRequest?.lastUser).toContain('情绪/关系怎样通过行为或潜台词微变');
  expect(chapterPlanRequest?.lastUser).toContain('作品特有的规则、关系、物件或环境细节如何参与因果');
  expect(chapterPlanRequest?.lastUser).toContain('PP1');
  expect(chapterPlanRequest?.context).toContain('说话方式：先观察、短句确认');
  expect(chapterPlannerModel).toBe('quality-writer-route');
  const chapterDraftRequest = requests.find(
    (request) =>
      request.system.includes('你是一位出色的小说作家') &&
      !request.lastUser.includes('【章节正文精修任务】') &&
      !request.lastUser.includes('【场景蓝图规划任务】'),
  );
  expect(chapterDraftRequest?.lastUser).toContain('【场景推进与作者声音】');
  expect(chapterDraftRequest?.lastUser).toContain('【按场景蓝图写作｜正文阶段】');
  expect(chapterDraftRequest?.lastUser).toContain('【本轮场景蓝图｜结构参照】');
  expect(chapterDraftRequest?.lastUser).toContain('核对来信日期');
  expect(chapterDraftRequest?.lastUser).toContain('PP1');
  expect(chapterDraftRequest?.context).not.toContain('PPd+');
  expect(chapterDraftRequest?.context).not.toContain('内容要充实，有具体的情节推进和细节描写');
  expect(chapterDraftRequest?.context).toContain('人物卡提供「说话方式」时');
  expect(chapterDraftRequest?.context).toContain('说话方式：先观察、短句确认');
  expect(chapterDraftRequest?.context).toContain('【下一章接力方向｜仅供当前章收束参考】');
  expect(chapterDraftRequest?.context).toContain('沈澄沿着寄件日期找到封存柜');
  expect(chapterDraftRequest?.context).toContain('不得提前演出下一章专属事件');
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).length)
    .toBe(1);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【正文质量校验修复】')).length)
    .toBe(chapterRepairCountBefore + 1);
  const chapterRepairRequest = requests.find((request) => request.lastUser.includes('【正文质量校验修复】'));
  expect(chapterRepairRequest?.lastUser).toContain('修订稿与初稿内容相同');
  returnUnchangedChapterReview = false;
  await expect(page.locator('#chChapterStatus')).toContainText('本章已完成');
  const chapterQualityReport = page.locator('[data-generation-quality-target="chapter"]');
  await expect(chapterQualityReport).toContainText('修复后通过');
  await chapterQualityReport.locator(':scope > summary').click();
  await expect(chapterQualityReport.locator('.generation-quality-detail')).toContainText('日期线索');
  const sceneBlueprint = chapterQualityReport.locator('[data-scene-blueprint="true"]');
  await expect(sceneBlueprint.locator('summary')).toHaveText('场景蓝图');
  await sceneBlueprint.locator('summary').click();
  await expect(sceneBlueprint).toContainText('核对来信日期');
  await page.screenshot({ path: 'test-results/generation-quality-report-desktop.png' });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sceneBlueprint.locator('.generation-quality-blueprint-text')).toBeVisible();
  const sceneReportOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(sceneReportOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/generation-quality-report-mobile.png' });
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  await chapterQualityReport.locator(':scope > summary').click();
  const chapter = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(chapter).toContain('逐页核对寄件时间');
  expect(chapter).toContain('封存柜');
  expect(chapter).not.toContain('【精修诊断】');
  expect(chapter).not.toContain('【PP1】');
  expect(chapter).not.toContain('【本章场景蓝图】');
  expect(chapter).not.toContain('【本章正文开始】');
  expect(requests.find((request) => request.lastUser.includes('【章节正文精修任务】'))?.draft).toContain(
    '逆潮的钟声穿过雾港',
  );
  const chapterReview = requests.find((request) => request.lastUser.includes('【章节正文精修任务】'));
  expect(chapterDraftModel).toBe('quality-writer-route');
  expect(chapterReviewModel).toBe('quality-writer-route');
  expect(chapterReview?.lastUser).toContain('人物当下目标、阻力、策略或选择');
  expect(chapterReview?.lastUser).toContain('人物卡中的「说话方式」是稳定倾向');
  expect(chapterReview?.lastUser).toContain('复现的信息要增加新含义或迫使新选择');
  expect(chapterReview?.lastUser).toContain('替换性测试');
  expect(chapterReview?.lastUser).toContain('不强行套用固定场景公式');
  expect(chapterReview?.lastUser).toContain('避免机械套用词语黑名单');
  expect(chapterReview?.lastUser).toContain('关键事件要演出来');
  expect(chapterReview?.lastUser).toContain('逐个核验每个【PPn】标记前的文本确实演出了对应事件');
  expect(chapterReview?.lastUser).toContain('目标约 110 字');
  expect(chapterReview?.lastUser).toContain('【精修交付格式】');
  expect(chapterReview?.lastUser).toContain('【首稿场景蓝图｜结构参照】');
  expect(chapterReview?.context).toContain('核对来信日期');
  expect(chapterReview?.context).toContain('承载 PP1、PP2');
  expect(chapterReview?.draft).toBe(draftChapter);
  expect(chapterReview?.context).toContain('全文模式保留的关键伏笔');
  expect(chapterReview?.context).not.toContain('摘要模式的概括信息');
  expect(chapterReview?.context).toContain('左手食指留有墨痕');
  expect(chapterReview?.context).toContain('说话方式：先观察、短句确认');
  expect(chapterReview?.context).toContain('说话方式：先观察、短句确认');
  expect(chapterReview?.context).toContain('曾替姐姐改过一份事故登记');
  expect(chapterReview?.context).toContain('先观察、短句确认');
  expect(chapterReview?.context).toContain('塔基伸入退潮后的河床');
  expect(chapterReview?.context).toContain('姐姐失踪前交给沈澄');
  expect(chapterReview?.context).toContain('以口头誓词确认交班');
  expect(chapterReview?.context).toContain('人物「沈澄」 —持有→ 物品「银钥匙」');
  expect(chapterReview?.context).not.toContain('AI待确认建议 · 人物：待确认人物');
  const savedGenerationQuality = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('project');
    const bundle = await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json();
    const reports = bundle.state.uiDrafts.generationQualityReports;
    return {
      outline: reports?.outline?.status,
      chapter: reports?.chapters?.['1']?.status,
      hasEditorialFeedback: Boolean(reports?.chapters?.['1']?.feedback),
      sceneBlueprint: reports?.chapters?.['1']?.sceneBlueprint,
    };
  });
  expect(savedGenerationQuality).toEqual({
    outline: 'reviewed',
    chapter: 'repaired',
    hasEditorialFeedback: true,
    sceneBlueprint: chapterSceneBlueprint,
  });

  const continuationReviewCountBeforeAutoSupplement = requests.filter((request) =>
    request.lastUser.includes('【续写精修任务】'),
  ).length;
  returnShortAutoSupplementChapter = true;
  await page.evaluate(async (target) => {
    state.autoContinue = true;
    state.selectedLength = 'medium';
    state.project.wordsPerChapter = target;
    (document.getElementById('wordsPerChapter') as HTMLInputElement).value = String(target);
    (globalThis as typeof globalThis & { navChapter: (chapter: number) => void }).navChapter(2);
    await Store.save();
  }, autoSupplementTarget);
  await page.locator('#btnGenChapter').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            request.lastUser.includes('【续写精修任务】') && request.lastUser.includes('【补写篇幅】'),
        ).length,
    )
    .toBe(1);
  const autoSupplementPrompt = requests.find((request) => request.lastUser.includes('【本章篇幅缺口】'));
  expect(autoSupplementPrompt?.lastUser).toContain(`最低篇幅 ${autoSupplementMinimum} 字`);
  expect(autoSupplementPrompt?.lastUser).toContain('✓ 已在正文发生');
  const autoSupplementDraft = requests
    .filter(
      (request) =>
        request.system.includes('请根据已有内容继续往下写') &&
        request.lastUser.includes('【本章已有正文连续性上下文】'),
    )
    .at(-1);
  expect(autoSupplementDraft?.lastUser).toContain('EARLY_AUTO_SUPPLEMENT_HISTORY_ANCHOR');
  const autoSupplementReview = requests.find(
    (request) => request.lastUser.includes('【续写精修任务】') && request.lastUser.includes('【补写篇幅】'),
  );
  expect(autoSupplementReview?.context).toContain('【此前已审校的本章正文｜只作连续性参考】');
  expect(autoSupplementReview?.context).toContain('EARLY_AUTO_SUPPLEMENT_HISTORY_ANCHOR');
  expect(autoSupplementReview?.context).toContain('准备从暗层绕入柜后');
  expect(autoSupplementReview?.draft).toContain('RAW_APPEND_SHOULD_NOT_APPEAR');
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 2)?.content || ''))
    .toContain('明早闻砚若来取');
  const autoSupplementResult = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 2)?.content || '',
  );
  expect(autoSupplementResult).toContain('准备从暗层绕入柜后');
  expect(autoSupplementResult).toContain(autoSupplementReviewedAppend);
  expect(autoSupplementResult).not.toContain('RAW_APPEND_SHOULD_NOT_APPEAR');
  expect(autoSupplementResult.startsWith(autoSupplementChapterReview.replace(/【PP\d+】/g, ''))).toBe(true);
  expect(await page.evaluate(() => state.uiDrafts.generationQualityReports.chapters['2']?.status)).toBe(
    'reviewed',
  );
  expect(requests.filter((request) => request.lastUser.includes('【续写精修任务】')).length).toBe(
    continuationReviewCountBeforeAutoSupplement + 1,
  );

  const continuationReviewCountBeforeRejectedSupplement = requests.filter(
    (request) => request.lastUser.includes('【续写精修任务】') && request.lastUser.includes('【补写篇幅】'),
  ).length;
  returnUnmarkedAutoSupplementReview = true;
  await page.locator('#btnGenChapter').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            request.lastUser.includes('【续写精修任务】') && request.lastUser.includes('【补写篇幅】'),
        ).length,
    )
    .toBe(continuationReviewCountBeforeRejectedSupplement + 1);
  const rejectedSupplementBody = autoSupplementChapterReview.replace(/【PP\d+】/g, '');
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 2)?.content || ''))
    .toBe(rejectedSupplementBody);
  await expect
    .poll(() => page.evaluate(() => state.uiDrafts.generationQualityReports.chapters['2']?.status))
    .toBe('unverified');
  await expect(
    page.locator('[data-generation-quality-target="chapter"] .generation-quality-detail'),
  ).toContainText('自动补写未通过审校');
  expect(
    await page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 2)?.content || ''),
  ).not.toContain('RAW_APPEND_SHOULD_NOT_APPEAR');
  expect(
    await page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 2)?.content || ''),
  ).not.toContain(autoSupplementReviewedAppend);
  returnUnmarkedAutoSupplementReview = false;
  returnShortAutoSupplementChapter = false;
  await page.evaluate(async () => {
    state.autoContinue = false;
    state.selectedLength = 'brief';
    state.project.wordsPerChapter = 200;
    (document.getElementById('wordsPerChapter') as HTMLInputElement).value = '200';
    (globalThis as typeof globalThis & { navChapter: (delta: number) => void }).navChapter(-1);
    await Store.save();
  });

  const trustAwareProjections = await page.evaluate(() => {
    const previousCharacters = state.project.characters;
    state.project.characters = `${previousCharacters}；待确认人物`;
    const outlineContext = globalThis.buildExtraWritingContext('outline');
    const chapterContext = globalThis.buildExtraWritingContext('chapter');
    state.project.characters = previousCharacters;
    return { outlineContext, chapterContext };
  });
  expect(trustAwareProjections.outlineContext).not.toContain('AI待确认建议 · 人物：待确认人物');
  expect(trustAwareProjections.chapterContext).toContain('AI待确认建议 · 人物：待确认人物');
  await page.evaluate(() => {
    const testWindow = globalThis as typeof globalThis & {
      buildChapterContextMessages: (
        chapter: number,
        mode: string,
      ) => Array<{ role: 'user' | 'assistant'; content: string }>;
      __originalChapterContextMessages?: (
        chapter: number,
        mode: string,
      ) => Array<{ role: 'user' | 'assistant'; content: string }>;
    };
    if (testWindow.__originalChapterContextMessages)
      testWindow.buildChapterContextMessages = testWindow.__originalChapterContextMessages;
    delete testWindow.__originalChapterContextMessages;
    state.contextFull = false;
  });
  expect(
    requests.find(
      (request) =>
        request.system.includes('你是一位出色的小说作家') &&
        !request.lastUser.includes('【章节正文精修任务】'),
    )?.lastUser,
  ).toContain('【PP2】');

  const qualityDraft = await page.evaluate(() =>
    state.chapterSnapshots.find(
      (snapshot) => Number(snapshot.chapter) === 1 && snapshot.source === 'AI 初稿（精修前）',
    ),
  );
  expect(qualityDraft?.content).toContain('逆潮的钟声穿过雾港');
  expect(qualityDraft?.content).not.toContain('【PP1】');
  expect(chapter).toContain('封存柜');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileQualityReportBounds = await page
    .locator('[data-generation-quality-target="chapter"]')
    .boundingBox();
  expect(mobileQualityReportBounds).not.toBeNull();
  expect(mobileQualityReportBounds!.x + mobileQualityReportBounds!.width).toBeLessThanOrEqual(390);
  await page.locator('.workbench-more > summary').click();
  await page.locator('button[onclick="openSnapshotModal()"]:visible').click();
  await expect(page.locator('[data-quality-snapshot-compare]')).toBeVisible();
  await page.getByRole('button', { name: '与正文对比' }).click();
  await expect(page.locator('#rewriteCompareModal')).toHaveClass(/show/);
  await expect(page.locator('#rewriteCompareOldDiff')).toContainText('逆潮的钟声穿过雾港');
  await expect(page.locator('#rewriteCompareNewDiff')).toContainText('封存柜');
  const compareOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(compareOverflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '恢复所选版本' }).click();
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''))
    .toContain('逆潮的钟声穿过雾港');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          state.chapterSnapshots.find(
            (snapshot) => Number(snapshot.chapter) === 1 && snapshot.source === '对比前当前正文',
          )?.content || '',
      ),
    )
    .toContain('封存柜');

  const appendContextBudget = await page.evaluate(() => {
    const testWindow = globalThis as typeof globalThis & {
      buildAppendChapterContext: (text: string) => string;
    };
    const source = `APPEND_CONTEXT_OPENING_SENTINEL${'a'.repeat(7000)}APPEND_CONTEXT_MIDDLE_SENTINEL${'b'.repeat(13000)}APPEND_CONTEXT_RECENT_SENTINEL`;
    const excerpt = testWindow.buildAppendChapterContext(source);
    return {
      hasOpening: excerpt.includes('APPEND_CONTEXT_OPENING_SENTINEL'),
      hasRecent: excerpt.includes('APPEND_CONTEXT_RECENT_SENTINEL'),
      omittedMiddle: !excerpt.includes('APPEND_CONTEXT_MIDDLE_SENTINEL'),
      explainsOmission: excerpt.includes('本章中段省略'),
    };
  });
  expect(appendContextBudget).toEqual({
    hasOpening: true,
    hasRecent: true,
    omittedMiddle: true,
    explainsOmission: true,
  });

  const longContinuationOpening = `EARLY_CONTINUATION_HISTORY_ANCHOR\n${'旧案旁注：每当钟楼的旧铃响过三次，值夜台的窗沿就会多一道盐痕；沈澄始终记得姐姐曾用指尖描过相同的痕迹。\n'.repeat(90)}`;
  await page.locator('#chapterEditor').evaluate((element, opening) => {
    const editor = element as HTMLTextAreaElement;
    editor.value = `${opening}${editor.value}`;
  }, longContinuationOpening);
  duplicateAppendBody = await page.locator('#chapterEditor').inputValue();
  returnDuplicateContinuationReview = true;
  const continuationReviewCountBeforeDuplicate = requests.filter((request) =>
    request.lastUser.includes('【续写精修任务】'),
  ).length;
  await page.locator('#btnContinueChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【续写精修任务】')).length)
    .toBe(continuationReviewCountBeforeDuplicate + 1);
  const manualContinuationPlan = requests
    .filter(
      (request) =>
        request.system.includes('请根据已有内容继续往下写') &&
        request.lastUser.includes('【场景蓝图规划任务】') &&
        request.lastUser.includes('【本章已有正文连续性上下文】'),
    )
    .at(-1);
  expect(manualContinuationPlan?.lastUser).toContain('只规划现有正文最后真实状态之后的新增场景');
  expect(manualContinuationPlan?.lastUser).toContain('尚待推进');
  expect(manualContinuationPlan?.context).toContain('EARLY_CONTINUATION_HISTORY_ANCHOR');
  const manualContinuationDraft = requests
    .filter(
      (request) =>
        request.system.includes('请根据已有内容继续往下写') &&
        request.lastUser.includes('【本章已有正文连续性上下文】'),
    )
    .at(-1);
  expect(manualContinuationDraft?.lastUser).toContain('EARLY_CONTINUATION_HISTORY_ANCHOR');
  expect(manualContinuationDraft?.lastUser).toContain('✓ 已在正文发生');
  expect(manualContinuationDraft?.lastUser).toContain('○ 尚待推进');
  expect(manualContinuationDraft?.lastUser).toContain('只承接后果，不得重新演出');
  expect(manualContinuationDraft?.lastUser).toContain('【按场景蓝图续写｜正文阶段】');
  expect(manualContinuationDraft?.lastUser).toContain('【本轮场景蓝图｜结构参照】');
  const manualContinuationReview = requests
    .filter((request) => request.lastUser.includes('【续写精修任务】'))
    .at(-1);
  expect(manualContinuationReview?.lastUser).toContain('【续写场景蓝图｜仅新增部分参照】');
  expect(manualContinuationReview?.context).toContain('【本章已有正文连续性上下文】');
  expect(manualContinuationReview?.context).toContain('EARLY_CONTINUATION_HISTORY_ANCHOR');
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【续写质量校验修复】')).length)
    .toBe(1);
  const duplicateContinuationReview = requests.find((request) =>
    request.lastUser.includes('【续写质量校验修复】'),
  );
  expect(duplicateContinuationReview?.lastUser).toContain('重复包含了已有完整正文');
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''))
    .toContain(continuationDraft);
  const continuedChapter = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(continuedChapter).not.toContain('她离开了。');
  expect(continuedChapter).not.toContain('【精修诊断】');
  expect(continuedChapter.startsWith(duplicateAppendBody)).toBe(true);
  expect(continuedChapter).toBe(
    await page.evaluate(({ base, append }) => globalThis.mergeContinuationText(base, append), {
      base: duplicateAppendBody,
      append: continuationDraft,
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => state.uiDrafts.generationQualityReports.chapters['1']?.sceneBlueprint || ''),
    )
    .toContain('场景1｜沈澄 / 值夜台 / 夜深');
  const continuationQualityReport = page.locator('[data-generation-quality-target="chapter"]');
  await continuationQualityReport.locator(':scope > summary').click();
  await expect
    .poll(() => continuationQualityReport.locator('[data-scene-blueprint="true"] summary').textContent())
    .toBe('续写片段蓝图');

  duplicateAppendBody = continuedChapter;
  returnDuplicateContinuationDraft = true;
  returnDuplicateContinuationRepair = true;
  const reviewCountBeforeUnsafeFallback = requests.filter((request) =>
    request.lastUser.includes('【续写精修任务】'),
  ).length;
  const repairCountBeforeUnsafeFallback = requests.filter((request) =>
    request.lastUser.includes('【续写质量校验修复】'),
  ).length;
  await page.locator('#btnContinueChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【续写精修任务】')).length)
    .toBe(reviewCountBeforeUnsafeFallback + 1);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【续写质量校验修复】')).length)
    .toBe(repairCountBeforeUnsafeFallback + 1);
  await expect(page.locator('#toast')).toContainText('避免重复追加');
  await expect(page.locator('#chapterEditor')).toHaveValue(duplicateAppendBody);
  expect(
    await page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''),
  ).toBe(duplicateAppendBody);

  returnIncompleteOutline = true;
  returnInvalidOutlineRepair = true;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-tab="outline"]').click();
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(2);
  await expect(page.locator('#toast')).toContainText('大纲仅覆盖 1/2 章');
  await expect.poll(() => page.evaluate(() => state.outline.length)).toBe(1);

  returnIncompleteOutline = false;
  returnInvalidOutlineRepair = false;
  await page.locator('#btnOutlineActionArrow').evaluate((button) => (button as HTMLButtonElement).click());
  await page.locator('#outlineActionDropdown [data-mode="continue"]').click();
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(3);
  const continuationReview = requests
    .filter((request) => request.lastUser.includes('【结构精修任务】'))
    .at(-1);
  expect(continuationReview?.lastUser).toContain('第 2 至第 2 章，共 1 章');
  await expect.poll(() => page.evaluate(() => state.outline.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => state.outline[1]?.chapter)).toBe(2);

  returnLengthLimitedOutlineReview = true;
  await page.locator('#btnOutlineActionArrow').evaluate((button) => (button as HTMLButtonElement).click());
  await page.locator('#outlineActionDropdown [data-mode="generate"]').click();
  await page.locator('#btnGenOutline').click();
  await expect(page.locator('#toast')).toContainText('长度上限');
  await expect(page.locator('#toast')).toContainText('初稿仍未通过自动检查');
  await expect.poll(() => page.evaluate(() => state.outline.length)).toBe(1);

  returnLengthLimitedOutlineReview = false;
  returnLengthLimitedOutlineDraft = true;
  returnInvalidOutlineReview = true;
  returnInvalidOutlineRepair = true;
  await page.locator('#btnGenOutline').click();
  await expect(page.locator('#toast')).toContainText('长度上限');
  await expect.poll(() => page.evaluate(() => state.outline.length)).toBe(1);

  returnLengthLimitedOutlineDraft = false;
  returnInvalidOutlineReview = false;
  returnInvalidOutlineRepair = false;
  returnShallowOutlineReview = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(6);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(3);
  const repairedOutlineRequest = requests
    .filter((request) => request.lastUser.includes('【大纲质量校验修复】'))
    .at(-1);
  expect(repairedOutlineRequest?.lastUser).toContain('概要篇幅、关键点数量、章节范围与编号');
  expect(repairedOutlineRequest?.lastUser).toContain('【自动校验发现的具体问题】');
  expect(repairedOutlineRequest?.lastUser).toContain('第 1 章概要为');
  expect(repairedOutlineRequest?.lastUser).toContain('剧情关键点为 2 项，要求 3-6 项');
  await expect.poll(() => page.evaluate(() => state.outline[0]?.title || '')).toBe('明日寄来的信');
  const outlineAfterShallowReview = await page.evaluate(() => ({
    title: state.outline[0]?.title,
    summaryLength: Array.from(String(state.outline[0]?.summary || '').replace(/\s/g, '')).length,
    pointCount: state.outline[0]?.plotPoints?.length,
    chapterCount: state.outline.length,
  }));
  expect(outlineAfterShallowReview.title).toBe('明日寄来的信');
  expect(outlineAfterShallowReview.summaryLength).toBeGreaterThanOrEqual(200);
  expect(outlineAfterShallowReview.pointCount).toBe(3);
  expect(outlineAfterShallowReview.chapterCount).toBe(2);
  expect(await page.evaluate(() => JSON.stringify(state.outline))).not.toContain('【精修诊断】');

  // When the draft exceeds the explicit per-chapter maximum, a valid review
  // should be allowed to merge related beats down to the contract instead of
  // being rejected and leaving the overfull draft in place.
  await page.evaluate(async () => {
    const prompt = document.getElementById('promptOutline') as HTMLTextAreaElement;
    prompt.value = prompt.value
      .replace('200-300 字的内容概要', '每章概要应控制在 200 到 300 字之间')
      .replace('3-6 个具体剧情关键点', '每章剧情关键点数量保持 3 至 6 项');
    state.savedPrompts.outline = prompt.value;
    await Store.save();
  });
  returnShallowOutlineReview = false;
  returnOverfullOutline = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(7);
  const overfullReview = requests.filter((request) => request.lastUser.includes('【结构精修任务】')).at(-1);
  expect(overfullReview?.lastUser).toContain('概要篇幅契约】每章概要 200-300 字');
  expect(overfullReview?.lastUser).toContain('每章关键点数量契约】每章 3-6 个');
  await expect.poll(() => page.evaluate(() => state.outline[0]?.title || '')).toBe('封档前的六个决定');
  const outlineAfterOverfullReview = await page.evaluate(() => ({
    title: state.outline[0]?.title,
    pointCount: state.outline[0]?.plotPoints?.length,
    chapterCount: state.outline.length,
  }));
  expect(outlineAfterOverfullReview.title).toBe('封档前的六个决定');
  expect(outlineAfterOverfullReview.pointCount).toBe(6);
  expect(outlineAfterOverfullReview.chapterCount).toBe(2);
  returnOverfullOutline = false;

  // Equal chapter length and point count are not enough: reject a review that
  // replaces the story beats with an unrelated storyline and keep the draft if
  // its single focused repair also fails.
  returnInvalidOutlineRepair = true;
  returnUnrelatedOutlineReview = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(8);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(4);
  await expect.poll(() => page.evaluate(() => state.outline[0]?.title || '')).toBe('逆潮来信');
  await expect(page.locator('#toast')).toContainText('剧情保留要求');
  returnInvalidOutlineRepair = false;
  returnUnrelatedOutlineReview = false;

  // Aggregate overlap alone can hide the loss of one event if the other two
  // points are copied almost verbatim. Each original event needs a small amount
  // of wording-level continuity, even when the chapter-wide overlap is high.
  returnInvalidOutlineRepair = true;
  returnSinglePointSwapOutline = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(9);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(5);
  const singlePointSwapRepair = requests
    .filter((request) => request.lastUser.includes('【大纲质量校验修复】'))
    .at(-1);
  expect(singlePointSwapRepair?.lastUser).toContain('未充分保留初稿中每一条独立关键剧情事件');
  await expect.poll(() => page.evaluate(() => state.outline[0]?.title || '')).toBe('逆潮来信');
  await expect(page.locator('#toast')).toContainText('剧情保留要求');
  returnInvalidOutlineRepair = false;
  returnSinglePointSwapOutline = false;

  // A valid outline may add a distinct causal beat while staying inside the
  // user's range; refinement must not be forced to copy the draft's exact count.
  returnExpandedPointOutline = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(10);
  await expect.poll(() => page.evaluate(() => state.outline[0]?.plotPoints?.length)).toBe(4);
  await expect
    .poll(() => page.evaluate(() => state.outline[0]?.plotPoints?.[2]?.desc || ''))
    .toContain('拓印');
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(5);
  returnExpandedPointOutline = false;

  returnDuplicateOutlineReview = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(11);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(6);
  const duplicateOutlineRepair = requests
    .filter((request) => request.lastUser.includes('【大纲质量校验修复】'))
    .at(-1);
  expect(duplicateOutlineRepair?.lastUser).toContain('第 2 章概要与第 1 章完全重复');
  expect(duplicateOutlineRepair?.lastUser).toContain('第 1 章第 2 个剧情关键点与第 1 个完全重复');
  const outlineAfterDuplicateRepair = await page.evaluate(() =>
    state.outline.map((chapter) => ({
      summary: chapter.summary,
      points: chapter.plotPoints.map((point) => point.desc),
    })),
  );
  expect(outlineAfterDuplicateRepair[0].summary).not.toBe(outlineAfterDuplicateRepair[1].summary);
  expect(new Set(outlineAfterDuplicateRepair[0].points).size).toBe(3);
  await expect.poll(() => page.evaluate(() => state.generating)).toBe(false);
  returnDuplicateOutlineReview = false;

  returnNearDuplicateOutlineReview = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length, {
      timeout: 15000,
    })
    .toBe(12);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(7);
  const nearDuplicateOutlineRepair = requests
    .filter((request) => request.lastUser.includes('【大纲质量校验修复】'))
    .at(-1);
  expect(nearDuplicateOutlineRepair?.lastUser).toContain('第 2 章概要与第 1 章词面高度相近');
  expect(nearDuplicateOutlineRepair?.lastUser).toContain('轻微换词后的重复推进');
  expect(nearDuplicateOutlineRepair?.lastUser).toContain('共享母题、线索');
  expect(nearDuplicateOutlineRepair?.lastUser).toContain('第 1 章第 5 个剧情关键点与第 4 个词面高度相近');
  await expect.poll(() => page.evaluate(() => state.outline[0]?.title || '')).toBe('明日寄来的信');
  returnNearDuplicateOutlineReview = false;

  // Similar chapter language can still carry different actions and stakes. The
  // advisory repair may recommend a check, but must not reject that story arc.
  returnSharedMotifOutlineReview = true;
  returnSharedMotifOutlineRepairUnchanged = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(13);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(8);
  const sharedMotifRepair = requests
    .filter((request) => request.lastUser.includes('【大纲质量校验修复】'))
    .at(-1);
  expect(sharedMotifRepair?.lastUser).toContain('共享母题、线索');
  await expect.poll(() => page.evaluate(() => state.outline[1]?.summary || '')).toContain('烧毁登记簿');
  returnSharedMotifOutlineReview = false;
  returnSharedMotifOutlineRepairUnchanged = false;

  await expect.poll(() => page.evaluate(() => state.generating)).toBe(false);
  returnRepeatedSummarySentenceReview = true;
  await page.locator('#btnGenOutline').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【结构精修任务】')).length)
    .toBe(14);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【大纲质量校验修复】')).length)
    .toBe(9);
  const repeatedSummaryRepair = requests
    .filter((request) => request.lastUser.includes('【大纲质量校验修复】'))
    .at(-1);
  expect(repeatedSummaryRepair?.lastUser).toContain('第 1 章概要内部第');
  expect(repeatedSummaryRepair?.lastUser).toContain('不能以复述凑篇幅');
  const repairedRepeatedSummary = await page.evaluate(() => state.outline[0]?.summary || '');
  expect(repairedRepeatedSummary.split(repeatedSummarySentence).length - 1).toBe(1);
  await expect(page.locator('[data-generation-quality-target="outline"]')).toContainText('修复后通过');
  returnRepeatedSummarySentenceReview = false;

  // A structurally valid edit must not replace a chapter draft if it falls below
  // the requested minimum length; this guards against refinement making the result worse.
  await page.locator('[data-tab="write"]').click();
  await page.evaluate(async () => {
    state.currentChapter = 1;
    state.selectedLength = 'brief';
    state.project.wordsPerChapter = 1000;
    state.autoContinue = false;
    (document.getElementById('wordsPerChapter') as HTMLInputElement).value = '1000';
    state.modelRoutes = { ...state.modelRoutes, editing: 'quality-editor-route' };
    await Store.save();
  });
  const shortChapterRepairCountBefore = requests.filter((request) =>
    request.lastUser.includes('【正文质量校验修复】'),
  ).length;
  const chapterReviewCountBeforeShortChapter = requests.filter((request) =>
    request.lastUser.includes('【章节正文精修任务】'),
  ).length;
  await page.locator('#btnGenChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).length)
    .toBe(chapterReviewCountBeforeShortChapter + 1);
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【正文质量校验修复】')).length)
    .toBe(shortChapterRepairCountBefore + 1);
  const shortChapterRepair = requests
    .filter((request) => request.lastUser.includes('【正文质量校验修复】'))
    .at(-1);
  expect(chapterDraftModel).toBe('quality-writer-route');
  expect(chapterReviewModel).toBe('quality-editor-route');
  expect(chapterRepairModel).toBe('quality-editor-route');
  expect(shortChapterRepair?.lastUser).toContain('低于本章最低篇幅 385 字');
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''))
    .toContain('登记簿上那行墨迹比眼前的信早了一天');
  const shortRefinementResult = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(shortRefinementResult).not.toContain('封存柜上的新划痕');
  await expect(page.locator('#toast')).toContainText('仍低于本章篇幅底线');

  // A reviewer may preserve every required PP marker yet fail to write the
  // corresponding event. Adjacent markers are a clear structural failure and
  // must not replace the complete first draft.
  returnLooseChapterMarkers = true;
  const markerRepairCountBefore = requests.filter((request) =>
    request.lastUser.includes('【正文质量校验修复】'),
  ).length;
  const chapterReviewCountBeforeLooseMarkers = requests.filter((request) =>
    request.lastUser.includes('【章节正文精修任务】'),
  ).length;
  await page.evaluate(() => {
    state.currentChapter = 1;
    state.selectedLength = 'brief';
    state.project.wordsPerChapter = 200;
    state.autoContinue = false;
    (document.getElementById('wordsPerChapter') as HTMLInputElement).value = '200';
  });
  await page.locator('#btnGenChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).length)
    .toBe(chapterReviewCountBeforeLooseMarkers + 1);
  const markerReview = requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).at(-1);
  expect(markerReview?.lastUser).toContain('不能只放置标记、复述关键点描述');
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【正文质量校验修复】')).length)
    .toBe(markerRepairCountBefore + 1);
  const looseMarkerRepair = requests
    .filter((request) => request.lastUser.includes('【正文质量校验修复】'))
    .at(-1);
  expect(looseMarkerRepair?.lastUser).toContain('剧情标记前没有完整演出对应事件');
  await expect(page.locator('#chChapterStatus')).toContainText('本章已完成');
  const markerFallbackResult = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(markerFallbackResult).toContain('逆潮的钟声穿过雾港');
  expect(markerFallbackResult).not.toContain('值夜台的木门被风吹得撞上墙面');
  returnLooseChapterMarkers = false;

  // Chapter endings are a separate, user-triggered generation path. They must
  // receive the same editorial pass and preserve the first draft on truncation.
  const endingNextChapterBaseline = await page.evaluate(async () => {
    state.outline = Array.isArray(state.outline) ? state.outline : [];
    const nextIndex = state.outline.findIndex((chapter) => Number(chapter.chapter) === 2);
    const previous = nextIndex >= 0 ? structuredClone(state.outline[nextIndex]) : null;
    const fixture = {
      ...(previous || { chapter: 2, plotPoints: [] }),
      title: '结尾交接边界验收',
      summary: 'ENDING_NEXT_CHAPTER_HANDOFF_SENTINEL：天亮之后，闻砚将带来第二封信。',
    };
    if (nextIndex >= 0) state.outline[nextIndex] = fixture;
    else state.outline.push(fixture);
    await Store.save();
    return previous;
  });
  const longEndingOpening = `EARLY_ENDING_HISTORY_ANCHOR\n${'钟楼值夜记录：每次交接都要核对窗沿盐痕、灯芯长度与登记簿页码，三项同时对不上才允许封档。\n'.repeat(90)}`;
  await page.locator('#chapterEditor').evaluate((element, opening) => {
    const editor = element as HTMLTextAreaElement;
    editor.value = `${opening}${editor.value}`;
  }, longEndingOpening);
  await page.locator('#btnEndChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节收束精修任务】')).length)
    .toBe(1);
  await expect(page.locator('#btnEndChapter')).toBeEnabled();
  const endingDraftRequest = requests.find((request) =>
    request.system.includes('请根据已有内容和用户要求续写章节收尾'),
  );
  expect(endingDraftRequest?.lastUser).toContain('EARLY_ENDING_HISTORY_ANCHOR');
  expect(endingDraftRequest?.lastUser).toContain('【章节结尾收束要求】');
  expect(endingDraftRequest?.lastUser).toContain('下一章《结尾交接边界验收》');
  expect(endingDraftRequest?.lastUser).toContain('ENDING_NEXT_CHAPTER_HANDOFF_SENTINEL');
  expect(endingDraftRequest?.lastUser).toContain('不得提前演出下一章专属事件');
  expect(endingDraftRequest?.lastUser).not.toContain('避免使用破折号「——」');
  const endingReview = requests.find((request) => request.lastUser.includes('【章节收束精修任务】'));
  expect(endingReview?.lastUser).toContain('不强行反转或制造悬崖式悬念');
  expect(endingReview?.lastUser).toContain('下一章独有事件、揭示或人物变化');
  expect(endingReview?.lastUser).toContain('【精修交付格式】');
  expect(endingReview?.context).toContain('逆潮的钟声穿过雾港');
  expect(endingReview?.context).toContain('EARLY_ENDING_HISTORY_ANCHOR');
  expect(endingReview?.context).toContain('ENDING_NEXT_CHAPTER_HANDOFF_SENTINEL');
  expect(endingReview?.draft).toContain('她把拓下的日期压进值夜台的灯影里');
  const chapterWithRefinedEnding = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(chapterWithRefinedEnding).toContain('灯影移过纸面');
  expect(chapterWithRefinedEnding).not.toContain('ENDING_NEXT_CHAPTER_HANDOFF_SENTINEL');
  expect(chapterWithRefinedEnding).not.toContain('【精修诊断】');
  expect(chapterWithRefinedEnding).not.toContain('她把拓下的日期压进值夜台的灯影里');
  const endingDraftSnapshot = await page.evaluate(() =>
    state.chapterSnapshots.find((snapshot) => snapshot.source === 'AI 结尾初稿（精修前）'),
  );
  expect(endingDraftSnapshot?.content).toContain('她把拓下的日期压进值夜台的灯影里');

  returnLengthLimitedEndingReview = true;
  await page.locator('#btnEndChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节收束精修任务】')).length)
    .toBe(2);
  await expect(page.locator('#btnEndChapter')).toBeEnabled();
  const chapterWithFallbackEnding = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(chapterWithFallbackEnding).toContain('她把拓下的日期压进值夜台的灯影里');
  expect(chapterWithFallbackEnding).toContain('灯影移过纸面');
  await expect(page.locator('#toast')).toContainText('精修输出触及模型长度上限');
  returnLengthLimitedEndingReview = false;

  // A response that contains a diagnosis but omits its actual artifact is
  // rejected without replacing the complete chapter with review text.
  returnMalformedEndingReview = true;
  await page.locator('#btnEndChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节收束精修任务】')).length)
    .toBe(3);
  await expect(page.locator('#btnEndChapter')).toBeEnabled();
  await page.evaluate(async () => {
    await Store.saving;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const chapterWithMalformedFallback = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(chapterWithMalformedFallback).toContain('她把拓下的日期压进值夜台的灯影里');
  expect(chapterWithMalformedFallback).not.toContain('【精修诊断】');
  returnMalformedEndingReview = false;

  // A plain rewritten artifact without the required diagnosis contract is not
  // evidence that an independent quality pass actually ran.
  returnUnmarkedEndingReview = true;
  await page.locator('#btnEndChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节收束精修任务】')).length)
    .toBe(4);
  await expect(page.locator('#btnEndChapter')).toBeEnabled();
  await expect(page.locator('[data-generation-quality-target="chapter"]')).toContainText('审校未完成');
  await expect(page.locator('[data-generation-quality-target="chapter"]')).toContainText('缺少精修诊断');
  returnUnmarkedEndingReview = false;

  returnEmptyEndingDraft = true;
  await page.locator('#btnEndChapter').click();
  await expect(page.locator('#toast')).toContainText('模型未返回结尾内容');
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''))
    .toContain('她把拓下的日期压进值夜台的灯影里');
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节收束精修任务】')).length)
    .toBe(4);
  returnEmptyEndingDraft = false;
  const continuationContextAfterEnding = await page.evaluate(() =>
    globalThis.buildExtraWritingContext('continue'),
  );
  expect(continuationContextAfterEnding).not.toContain('ENDING_NEXT_CHAPTER_HANDOFF_SENTINEL');
  await page.evaluate(async (previousNextChapter) => {
    const nextIndex = (state.outline || []).findIndex((chapter) => Number(chapter.chapter) === 2);
    if (previousNextChapter) {
      if (nextIndex >= 0) state.outline[nextIndex] = previousNextChapter;
      else state.outline.push(previousNextChapter);
    } else state.outline = (state.outline || []).filter((chapter) => Number(chapter.chapter) !== 2);
    await Store.save();
  }, endingNextChapterBaseline);

  await page.reload();
  await expect(page.locator('#chapterEditor')).toBeAttached();
  await page.evaluate(() => {
    state.baseURL = 'https://mock-quality.test';
    state.apiKey = 'test-only';
    state.model = 'quality-mock';
    state.modelRoutes = {
      ...state.modelRoutes,
      chapter: 'quality-writer-route',
      editing: 'quality-editor-route',
    };
  });
  await page.evaluate(async () => {
    state.project.wordsPerChapter = 100;
    state.selectedLength = 'brief';
    state.autoContinue = false;
    const wordsPerChapter = document.getElementById('wordsPerChapter') as HTMLInputElement | null;
    if (wordsPerChapter) wordsPerChapter.value = '100';
    await Store.save();
  });
  await page.locator('[data-tab="outline"]').click();
  await expect(page.locator('[data-generation-quality-target="outline"]')).toBeVisible();
  await page.locator('[data-tab="write"]').click();
  await expect(page.locator('[data-generation-quality-target="chapter"]')).toBeVisible();

  const chapterBeforeMalformedScenePlan = await page.locator('#chapterEditor').inputValue();
  const chapterReviewCountBeforeMalformedScenePlan = requests.filter((request) =>
    request.lastUser.includes('【章节正文精修任务】'),
  ).length;
  returnMalformedChapterScenePlan = true;
  await page.locator('#btnGenChapter').click();
  await expect(page.locator('#toast')).toContainText('场景规划结果不完整');
  await expect(page.locator('#btnGenChapter')).toBeEnabled();
  await expect(page.locator('#chapterEditor')).toHaveValue(chapterBeforeMalformedScenePlan);
  expect(
    await page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''),
  ).toBe(chapterBeforeMalformedScenePlan);
  expect(requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).length).toBe(
    chapterReviewCountBeforeMalformedScenePlan,
  );
  returnMalformedChapterScenePlan = false;

  returnScenePlanWithoutBodyHeader = true;
  await page.locator('#btnGenChapter').click();
  await expect
    .poll(() => requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).length)
    .toBe(chapterReviewCountBeforeMalformedScenePlan + 1);
  await expect(page.locator('#btnGenChapter')).toBeEnabled();
  const recoveredSceneChapter = await page.evaluate(
    () => state.chapters.find((item) => Number(item.chapter) === 1)?.content || '',
  );
  expect(recoveredSceneChapter).toContain('逐页核对寄件时间');
  expect(recoveredSceneChapter).not.toContain('【本章场景蓝图】');
  expect(recoveredSceneChapter).not.toContain('场景1｜沈澄');
  const recoveredSceneReport = await page.evaluate(async () => {
    await Store.saving;
    const id = new URLSearchParams(location.search).get('project');
    const bundle = await (await fetch(`/api/projects/${id}/state`, { cache: 'no-store' })).json();
    return bundle.state.uiDrafts.generationQualityReports.chapters['1']?.sceneBlueprint || '';
  });
  expect(recoveredSceneReport).toContain('1｜沈澄 / 值夜台');
  returnScenePlanWithoutBodyHeader = false;

  const chapterBeforeEmptyDraft = await page.locator('#chapterEditor').inputValue();
  const reviewCountBeforeEmptyDraft = requests.filter((request) =>
    request.lastUser.includes('【章节正文精修任务】'),
  ).length;
  returnEmptyChapterDraft = true;
  await page.locator('#btnGenChapter').click();
  await expect(page.locator('#toast')).toContainText('没有返回章节正文');
  await expect(page.locator('#btnGenChapter')).toBeEnabled();
  await expect(page.locator('#chapterEditor')).toHaveValue(chapterBeforeEmptyDraft);
  await expect
    .poll(() => page.evaluate(() => state.chapters.find((item) => Number(item.chapter) === 1)?.content || ''))
    .toBe(chapterBeforeEmptyDraft);
  expect(requests.filter((request) => request.lastUser.includes('【章节正文精修任务】')).length).toBe(
    reviewCountBeforeEmptyDraft,
  );
  returnEmptyChapterDraft = false;
});

test('mobile library and story bible stay within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await expect(page.getByRole('heading', { name: '📚 我的小说' })).toBeVisible();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  const mobileProjectDialog = page.locator('#projectDialog');
  await page.getByLabel('书名').last().fill('移动端画布测试');
  await mobileProjectDialog.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal.show');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();
  await page.getByRole('button', { name: '故事设定' }).click();
  await expect(
    page.locator('#novelSetting').evaluate((element) => element.clientHeight),
  ).resolves.toBeGreaterThanOrEqual(200);
  await expect(
    page.locator('#novelCharacters').evaluate((element) => element.clientHeight),
  ).resolves.toBeGreaterThanOrEqual(240);
  await expect(page.locator('.project-preset-strip').first()).toBeVisible();
  const workbenchOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(workbenchOverflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '创作流程' }).click();
  await expect(page.locator('#tab-creative-flow')).toBeVisible();
  const mobileCanvas = page.locator('#creativeCanvasViewport');
  await expect(mobileCanvas).toBeVisible();
  const mobileEmptyState = page.locator('#creativeCanvasEmpty');
  await expect(mobileEmptyState).toContainText('故事引擎 → 大纲 → 正文 → 审阅');
  await expect(mobileEmptyState.getByRole('button', { name: '布置高质量起步路径' })).toBeVisible();
  await expect(mobileEmptyState.getByRole('button', { name: '写下灵感' })).toBeVisible();
  await page.screenshot({ path: 'test-results/creative-workflow-mobile-start.png', fullPage: true });
  await mobileEmptyState.getByRole('button', { name: '布置高质量起步路径' }).click();
  await expect(page.locator('.creative-canvas-stage')).toHaveCount(4);
  await expect(
    page.locator('.creative-canvas-step[data-canvas-node-id="step:starter-story-engine"]'),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/creative-workflow-mobile-starter-path.png', fullPage: true });
  const mobileStarterPositions = await page.evaluate(() => {
    const canvas = state.uiDrafts.creativeCanvas;
    return ['premise', 'outline', 'draft', 'revise'].map((stageId) =>
      canvas.nodes.find((node: { stageId?: string }) => node.stageId === stageId),
    );
  });
  expect(
    mobileStarterPositions.every(
      (position, index) => index === 0 || position.y > mobileStarterPositions[index - 1].y,
    ),
  ).toBeTruthy();
  const mobileStarterContext = await page.evaluate(() => globalThis.buildCreativeRulesContext('outline'));
  expect(mobileStarterContext).toContain('作品独有的因果机制');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.evaluate(async () => {
    state.uiDrafts.creativeCanvas = {
      version: 1,
      nodes: [],
      edges: [],
      hiddenStageIds: [],
      arcPositions: {},
    };
    await Store.save();
  });
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  const resetMobileEmptyState = page.locator('#creativeCanvasEmpty');
  await expect(resetMobileEmptyState).toBeVisible();
  await expect(resetMobileEmptyState.getByRole('button', { name: '写下灵感' })).toBeVisible();
  await resetMobileEmptyState.getByRole('button', { name: '写下灵感' }).click();
  await expect(page.locator('.creative-canvas-note')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.creative-canvas-note').getByRole('button', { name: '删除' }).click();
  await expect(mobileEmptyState).toBeVisible();
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: 'AI 步骤' }).click();
  const mobileStep = page.locator('.creative-canvas-step').last();
  await expect(mobileStep).toBeVisible();
  await expect(mobileStep.getByLabel('步骤名称')).toBeVisible();
  await expect(mobileStep).toHaveCSS('min-height', '222px');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  const mapHeaderLayout = await page.locator('.creative-map-header').evaluate((element) => {
    const title = element.querySelector('h2')!.getBoundingClientRect();
    return {
      direction: getComputedStyle(element).flexDirection,
      titleTop: title.top,
      hasProgressMeter: Boolean(element.querySelector('#creativeProgressOrbit')),
    };
  });
  expect(mapHeaderLayout.direction).toBe('row');
  expect(mapHeaderLayout.hasProgressMeter).toBeFalsy();
  await page.screenshot({ path: 'test-results/creative-workflow-mobile.png', fullPage: true });
  const mobileNode = page.locator('.creative-canvas-step').first();
  const mobilePositionBefore = await mobileNode.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    top: Number.parseFloat((element as HTMLElement).style.top),
  }));
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const mobileHandle = mobileNode.locator('[data-node-drag]');
  await mobileHandle.scrollIntoViewIfNeeded();
  await expect(mobileHandle).toBeInViewport();
  const mobileHandleBox = await mobileHandle.boundingBox();
  expect(mobileHandleBox).not.toBeNull();
  await page.mouse.move(mobileHandleBox!.x + 10, mobileHandleBox!.y + 10);
  await page.mouse.down();
  await page.mouse.move(mobileHandleBox!.x + 58, mobileHandleBox!.y + 46, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() =>
      mobileNode.evaluate((element) => ({
        left: Number.parseFloat((element as HTMLElement).style.left),
        top: Number.parseFloat((element as HTMLElement).style.top),
      })),
    )
    .not.toEqual(mobilePositionBefore);
  await page.getByRole('button', { name: '缩小画布' }).click();
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const fittedMobileZoom = await page.locator('#creativeCanvasZoom').textContent();
  await page.reload();
  await expect(page.locator('#creativeCanvasZoom')).toHaveText(fittedMobileZoom!);
  const zoomBeforePinch = await page.locator('#creativeCanvasZoom').textContent();
  const canvasBox = await mobileCanvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.evaluate(({ x, y, width, height }) => {
    const canvas = document.querySelector('#creativeCanvasViewport')!;
    const first = { x: x + width * 0.25, y: y + height * 0.76 };
    const second = { x: x + width * 0.6, y: y + height * 0.76 };
    const pointer = (type: string, pointerId: number, point: { x: number; y: number }) =>
      new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: pointerId === 51,
        clientX: point.x,
        clientY: point.y,
      });
    canvas.dispatchEvent(pointer('pointerdown', 51, first));
    canvas.dispatchEvent(pointer('pointerdown', 52, second));
    window.dispatchEvent(pointer('pointermove', 52, { x: second.x + 64, y: second.y }));
    window.dispatchEvent(pointer('pointerup', 51, first));
    window.dispatchEvent(pointer('pointerup', 52, second));
  }, canvasBox!);
  await expect(page.locator('#creativeCanvasZoom')).not.toHaveText(zoomBeforePinch!);
  const worldCenterBeforeResize = await page.evaluate(() => {
    const viewport = document.querySelector('#creativeCanvasViewport')!;
    const world = document.querySelector('#creativeCanvasWorld')!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    const rect = viewport.getBoundingClientRect();
    return { x: (rect.width / 2 - matrix.e) / matrix.a, y: (rect.height / 2 - matrix.f) / matrix.d };
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  const tabletOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(tabletOverflow).toBeLessThanOrEqual(1);
  await expect
    .poll(async () =>
      page.evaluate((before) => {
        const viewport = document.querySelector('#creativeCanvasViewport')!;
        const world = document.querySelector('#creativeCanvasWorld')!;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
        const rect = viewport.getBoundingClientRect();
        const after = {
          x: (rect.width / 2 - matrix.e) / matrix.a,
          y: (rect.height / 2 - matrix.f) / matrix.d,
        };
        return Math.hypot(after.x - before.x, after.y - before.y);
      }, worldCenterBeforeResize),
    )
    .toBeLessThan(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    state.uiDrafts.creativeCanvas.nodes.push(
      { id: 'note:fit-left', kind: 'note', text: '左侧节点', x: 0, y: 0 },
      { id: 'note:fit-right', kind: 'note', text: '右侧节点', x: 5752, y: 3816 },
    );
    await Store.save();
    globalThis.switchTab('project');
    globalThis.switchTab('creative-flow');
  });
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const mobileFitGeometry = await page.evaluate(() => {
    const viewport = document.querySelector('#creativeCanvasViewport')!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.creative-canvas-node')];
    return {
      zoom: Number.parseFloat(document.querySelector('#creativeCanvasZoom')!.textContent || '0'),
      allInside: nodes.every((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.left >= viewport.left &&
          rect.top >= viewport.top &&
          rect.right <= viewport.right &&
          rect.bottom <= viewport.bottom
        );
      }),
    };
  });
  expect(mobileFitGeometry.zoom).toBeLessThan(8);
  expect(mobileFitGeometry.allInside).toBeTruthy();

  const browser = page.context().browser();
  expect(browser).not.toBeNull();
  const touchContext = await browser!.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const touchPage = await touchContext.newPage();
    await touchPage.goto('/');
    await touchPage.getByPlaceholder('四位 PIN').fill('2468');
    await touchPage.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
    await touchPage.getByRole('button', { name: '＋ 新建小说' }).click();
    await touchPage.getByLabel('书名').last().fill('触屏画布验证');
    await touchPage.getByRole('button', { name: '创建' }).click();
    await expect(touchPage).toHaveURL(/\/workbench\.html\?project=/);
    await touchPage.waitForTimeout(220);
    const touchOnboarding = touchPage.locator('#onboardingModal.show');
    if (await touchOnboarding.isVisible()) await touchOnboarding.getByRole('button', { name: '✕' }).click();
    await expect(touchOnboarding).toBeHidden();
    await touchPage.getByRole('button', { name: '创作流程' }).click();
    await expect(touchPage.locator('.creative-canvas-stage')).toHaveCount(0);
    await touchPage.getByRole('button', { name: '添加节点' }).click();
    await touchPage.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: '便笺' }).click();
    await touchPage.getByRole('button', { name: '添加节点' }).click();
    await touchPage.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: '故事结构' }).click();
    await touchPage.getByRole('button', { name: '显示全部节点' }).click();
    const touchNote = touchPage.locator('.creative-canvas-note').first();
    await expect(touchNote).toBeInViewport();
    const touchEditor = touchNote.getByLabel('便笺内容');
    await touchEditor.fill(
      Array.from({ length: 16 }, (_, index) => `触屏滚动测试段落 ${index + 1}。`).join('\n'),
    );
    const editorMetrics = await touchEditor.evaluate((element) => ({
      scroll: element.scrollHeight,
      client: element.clientHeight,
    }));
    expect(editorMetrics.scroll).toBeGreaterThan(editorMetrics.client);
    const touchSession = await touchContext.newCDPSession(touchPage);
    const editorBox = await touchEditor.boundingBox();
    expect(editorBox).not.toBeNull();
    const touchX = editorBox!.x + editorBox!.width / 2;
    const touchStartY = editorBox!.y + editorBox!.height - 18;
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: touchX, y: touchStartY, id: 7, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: touchX, y: touchStartY - 72, id: 7, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => touchEditor.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const grip = touchNote.locator('[data-node-drag]');
    const gripBox = await grip.boundingBox();
    expect(gripBox).not.toBeNull();
    const beforeTouchDrag = await touchNote.evaluate((element) => Number.parseFloat(element.style.left));
    const gripX = gripBox!.x + gripBox!.width / 2;
    const gripY = gripBox!.y + gripBox!.height / 2;
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: gripX, y: gripY, id: 8, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: gripX + 54, y: gripY + 38, id: 8, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect
      .poll(() => touchNote.evaluate((element) => Number.parseFloat(element.style.left)))
      .not.toBe(beforeTouchDrag);
    await touchPage.getByRole('button', { name: '显示全部节点' }).click();
    const touchConnectPort = await touchNote.locator('[data-node-connect]').boundingBox();
    const touchTarget = touchPage.locator('.creative-canvas-stage[data-workflow-id="outline"]');
    const touchTargetBox = await touchTarget.boundingBox();
    expect(touchConnectPort).not.toBeNull();
    expect(touchTargetBox).not.toBeNull();
    const linkStart = {
      x: touchConnectPort!.x + touchConnectPort!.width / 2,
      y: touchConnectPort!.y + touchConnectPort!.height / 2,
    };
    const linkEnd = {
      x: touchTargetBox!.x + touchTargetBox!.width / 2,
      y: touchTargetBox!.y + touchTargetBox!.height / 2,
    };
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...linkStart, id: 9, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...linkEnd, id: 9, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await expect(touchPage.locator('.creative-canvas-edge-preview')).toHaveCount(1);
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(touchPage.locator('.creative-canvas-edge-preview')).toHaveCount(0);
    await expect(touchPage.locator('[data-canvas-edge].custom')).toHaveCount(1);

    await touchPage.getByRole('button', { name: '添加节点' }).click();
    await touchPage.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: 'AI 步骤' }).click();
    const touchStep = touchPage.locator('.creative-canvas-step').last();
    const touchStepId = (await touchStep.getAttribute('data-canvas-node-id'))!;
    await expect
      .poll(async () =>
        touchPage.evaluate(async (stepId) => {
          const id = new URLSearchParams(location.search).get('project');
          const saved = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts
            .creativeCanvas;
          return saved.nodes.some((node: { id: string }) => node.id === stepId);
        }, touchStepId),
      )
      .toBeTruthy();
    const touchStepEditor = touchStep.getByLabel('步骤要求');
    await touchStepEditor.fill(
      Array.from({ length: 16 }, (_, index) => `步骤触屏滚动测试 ${index + 1}：继续补充创作要求。`).join(
        '\n',
      ),
    );
    await expect(touchStepEditor).toHaveValue(/步骤触屏滚动测试 1/);
    const stepEditorMetrics = await touchStepEditor.evaluate((element) => ({
      scroll: element.scrollHeight,
      client: element.clientHeight,
    }));
    expect(stepEditorMetrics.scroll).toBeGreaterThan(stepEditorMetrics.client);
    await expect
      .poll(() =>
        touchPage
          .locator('#creativeCanvasViewport')
          .evaluate((element) => getComputedStyle(element).touchAction),
      )
      .toBe('pan-y');
    const stepEditorBox = await touchStepEditor.boundingBox();
    expect(stepEditorBox).not.toBeNull();
    const stepTouchX = stepEditorBox!.x + stepEditorBox!.width / 2;
    const stepTouchStartY = stepEditorBox!.y + stepEditorBox!.height - 18;
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: stepTouchX, y: stepTouchStartY, id: 10, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: stepTouchX, y: stepTouchStartY - 72, id: 10, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => touchStepEditor.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await touchSession.detach();
  } finally {
    await touchContext.close();
  }
});

test('stale chapter memory is excluded after its source chapters change', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('记忆新鲜度验收');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();
  await expect(onboarding).not.toHaveClass(/show/);

  const baseline = await page.evaluate(() => ({
    chapters: structuredClone(state.chapters || []),
    chapterMemories: structuredClone(state.chapterMemories || {}),
    memory: structuredClone(state.memory || {}),
    memoryTrust: structuredClone(state.memoryTrust || {}),
    currentChapter: state.currentChapter,
  }));
  try {
    const evidence = await page.evaluate(() => {
      state.currentChapter = 2;
      const oldChapterText = '旧版本正文：石桥下埋着一把蓝色钥匙。';
      state.chapters = [{ chapter: 1, content: oldChapterText }];
      const sourceHash = globalThis.getChapterMemorySourceHash(2);
      state.chapterMemories = {
        '2': {
          chapter: 2,
          content: '旧记忆：石桥下埋着蓝色钥匙。STALE_MEMORY_SENTINEL',
          sourceHash,
        },
      };
      const oldCard = {
        chapter: 1,
        title: '石桥下的钥匙',
        summary: '旧记忆卡：石桥下埋着蓝色钥匙。STALE_CARD_SENTINEL',
        keyEvents: ['旧事件：石桥下埋着蓝色钥匙。STALE_CARD_SENTINEL'],
        characterChanges: [],
        foreshadowsAdded: [],
        foreshadowsResolved: [],
        locations: ['石桥'],
        propsAndRules: ['蓝色钥匙'],
        endingState: '守門人尚未出现。',
        keywords: ['蓝色钥匙', '石桥'],
        contentHash: globalThis.chapterContentHash(oldChapterText),
        source: 'ai-summary-card',
      };
      state.memory = {
        ...globalThis.getEmptyMemory(),
        characters: { 闻砚: { currentStatus: '未来状态不得提前写入', goal: '未来目标' } },
        importantEvents: [
          { chapter: 1, event: '前情：钥匙被转移。' },
          { chapter: 3, event: '未来事件不得提前出现。' },
        ],
        foreshadows: {
          active: [
            { chapter: 1, desc: '前文已出现的钟楼铃声' },
            { chapter: 3, desc: '未来才出现的黑色印记' },
          ],
          resolved: [],
        },
        worldBuilding: [
          { concept: '前文规则', description: '已在第一章展示', chaptersAppeared: [1] },
          { concept: '未来规则', description: '第三章才揭示', chaptersAppeared: [1, 3] },
          { concept: '来源待核验规则', description: '只供 AI 联想，不是既定事实', chaptersAppeared: [] },
        ],
        chapterCards: [oldCard],
      };
      state.memoryTrust = {};
      const freshPrompt = globalThis.buildChapterMemoryPrompt(2);
      const freshRelevantCards = JSON.stringify(
        globalThis.getRelevantChapterCards(2, { title: '', summary: '' }, [{ desc: '蓝色钥匙 石桥' }], 6),
      );
      const freshOutlineContext = JSON.parse(globalThis.buildOutlineMemoryContext());

      state.chapters[0].content =
        '作者修订后的正史：石桥并不存在，钥匙在钟楼，守门人闻砚只在黎明前出现。CURRENT_CANON_SENTINEL';
      const stalePrompt = globalThis.buildChapterMemoryPrompt(2);
      const staleRelevantCards = JSON.stringify(
        globalThis.getRelevantChapterCards(2, { title: '', summary: '' }, [{ desc: '钟楼 闻砚' }], 6),
      );
      const staleOutlineContext = JSON.parse(globalThis.buildOutlineMemoryContext());
      const safeLegacyMemoryContext = globalThis.buildMemoryPrompt(2);
      globalThis.renderMemoryViewer();
      return {
        freshPrompt,
        stalePrompt,
        freshRelevantCards,
        staleRelevantCards,
        freshOutlineCards: JSON.stringify(freshOutlineContext.longTermMemory.chapterCards || []),
        staleOutlineCards: JSON.stringify(staleOutlineContext.longTermMemory.chapterCards || []),
        staleOutlineChapterMemories: JSON.stringify(staleOutlineContext.chapterMemories || []),
        safeLegacyMemoryContext,
        staleNotice: document.querySelector('[data-chapter-memory-freshness]')?.textContent || '',
        preservedStaleMemory: state.chapterMemories['2'].content,
        preservedStaleCard: state.memory.chapterCards[0]?.summary || '',
      };
    });

    expect(evidence.freshPrompt).toContain('STALE_MEMORY_SENTINEL');
    expect(evidence.freshRelevantCards).toContain('STALE_CARD_SENTINEL');
    expect(evidence.freshOutlineCards).toContain('STALE_CARD_SENTINEL');
    expect(evidence.stalePrompt).toContain('CURRENT_CANON_SENTINEL');
    expect(evidence.stalePrompt).not.toContain('STALE_MEMORY_SENTINEL');
    expect(evidence.staleRelevantCards).toContain('CURRENT_CANON_SENTINEL');
    expect(evidence.staleRelevantCards).not.toContain('STALE_CARD_SENTINEL');
    expect(evidence.staleOutlineCards).toContain('CURRENT_CANON_SENTINEL');
    expect(evidence.staleOutlineCards).not.toContain('STALE_CARD_SENTINEL');
    expect(evidence.staleOutlineChapterMemories).not.toContain('STALE_MEMORY_SENTINEL');
    expect(evidence.safeLegacyMemoryContext).toContain('人物名称候选');
    expect(evidence.safeLegacyMemoryContext).toContain('闻砚');
    expect(evidence.safeLegacyMemoryContext).not.toContain('未来状态不得提前写入');
    expect(evidence.safeLegacyMemoryContext).toContain('前情：钥匙被转移');
    expect(evidence.safeLegacyMemoryContext).not.toContain('未来事件不得提前出现');
    expect(evidence.safeLegacyMemoryContext).toContain('前文已出现的钟楼铃声');
    expect(evidence.safeLegacyMemoryContext).not.toContain('未来才出现的黑色印记');
    expect(evidence.safeLegacyMemoryContext).toContain('前文规则');
    expect(evidence.safeLegacyMemoryContext).not.toContain('未来规则');
    expect(evidence.safeLegacyMemoryContext).toContain('来源待核验规则');
    expect(evidence.staleNotice).toContain('已过期');
    expect(evidence.preservedStaleMemory).toContain('STALE_MEMORY_SENTINEL');
    expect(evidence.preservedStaleCard).toContain('STALE_CARD_SENTINEL');

    await page.locator('[data-tab="write"]').click();
    await page.locator('#tab-write summary').filter({ hasText: '长期记忆' }).click();
    await expect(page.locator('.chapter-memory-freshness-note')).toBeVisible();
    await page.screenshot({ path: 'test-results/chapter-memory-freshness-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.chapter-memory-freshness-note')).toBeVisible();
    const memoryNoticeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(memoryNoticeOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'test-results/chapter-memory-freshness-mobile.png', fullPage: true });

    const unknownEvidence = await page.evaluate(() => {
      state.chapterMemories['2'] = {
        chapter: 2,
        content: '缺少来源版本的旧记忆。UNKNOWN_MEMORY_SENTINEL',
      };
      const unknownPrompt = globalThis.buildChapterMemoryPrompt(2);
      const unknownOutlineContext = JSON.parse(globalThis.buildOutlineMemoryContext());
      globalThis.renderMemoryViewer();
      return {
        unknownPrompt,
        unknownOutlineMemories: JSON.stringify(unknownOutlineContext.chapterMemories || []),
        unknownNotice: document.querySelector('[data-chapter-memory-freshness]')?.textContent || '',
      };
    });
    expect(unknownEvidence.unknownPrompt).toContain('CURRENT_CANON_SENTINEL');
    expect(unknownEvidence.unknownPrompt).not.toContain('UNKNOWN_MEMORY_SENTINEL');
    expect(unknownEvidence.unknownOutlineMemories).not.toContain('UNKNOWN_MEMORY_SENTINEL');
    expect(unknownEvidence.unknownNotice).toContain('来源未核验');
  } finally {
    if (!page.isClosed())
      await page.evaluate((saved) => {
        state.chapters = saved.chapters;
        state.chapterMemories = saved.chapterMemories;
        state.memory = saved.memory;
        state.memoryTrust = saved.memoryTrust;
        state.currentChapter = saved.currentChapter;
        globalThis.renderMemoryViewer();
      }, baseline);
  }
});

test('summary context stays recent while retrieving a distant chapter needed by the current outline', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('长篇上下文检索验收');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();
  await expect(onboarding).not.toHaveClass(/show/);

  const baseline = await page.evaluate(() => ({
    chapters: structuredClone(state.chapters || []),
    outline: structuredClone(state.outline || []),
    memory: structuredClone(state.memory || {}),
    memoryTrust: structuredClone(state.memoryTrust || {}),
    currentChapter: state.currentChapter,
    contextFull: state.contextFull,
    creativeRules: structuredClone(state.creativeRules || {}),
    uiDrafts: structuredClone(state.uiDrafts || {}),
    operationLogs: structuredClone(state.operationLogs || []),
  }));
  try {
    const evidence = await page.evaluate(() => {
      const chapters = Array.from({ length: 12 }, (_, index) => ({
        chapter: index + 1,
        content:
          index === 0
            ? '第1章正文：赤铜铃只在无风时响起，铃声会指向西门暗渠。'
            : index === 11
              ? `${'第十二章铺垫。'.repeat(100)}\n\n“VOICE_SAMPLE_SENTINEL：闻砚站在门外，听见雨停了，却没有收伞。”${'他没有解释。'.repeat(24)}\n\n${'第十二章收束。'.repeat(800)}`
              : `第${index + 1}章正文：主角继续调查城中发生的案件。`,
      }));
      chapters[9].content = `${'第十章铺垫。'.repeat(130)}\n沈澄低声问：“CHARACTER_VOICE_CHEN_SENTINEL：第二声从门后传来，你听见了吗？”\n闻砚短促地回道：“CHARACTER_VOICE_WEN_SENTINEL REVIEWED_STYLE_SENTINEL：我听见了，但没打算告诉值夜司。”\n${'第十章收束。'.repeat(130)}`;
      chapters[11].content += [
        '沈澄低声问：“CHARACTER_VOICE_CHEN_SENTINEL：第二声从门后传来，你听见了吗？”',
        '闻砚短促地回道：“CHARACTER_VOICE_WEN_SENTINEL：我只听见你翻页。”',
        '陆泊问：“NON_POV_VOICE_SENTINEL：封档时间不会变。”',
        '沈澄再次问：“CHARACTER_VOICE_CHEN_SENTINEL VOICE_SAMPLE_SENTINEL：墙里的回响比钟声慢了半拍。”',
      ].join('\n');
      const outline = Array.from({ length: 12 }, (_, index) => ({
        chapter: index + 1,
        title: `第${index + 1}章`,
        summary: `主角在城中调查第${index + 1}件相关事件。`,
        plotPoints: [],
      }));
      const currentOutline = {
        chapter: 13,
        title: '无风时，赤铜铃再次响起',
        summary: '主角沿铃声重返西门暗渠，寻找失踪的同伴。',
        plotPoints: [{ id: 'pp-13-1', desc: '赤铜铃在无风时自行响起，主角沿铃声找到暗渠第二道门。' }],
      };
      const nextOutline = {
        chapter: 14,
        title: '门后的第二道回声',
        summary: '沈澄用赤铜铃核对暗渠第二道门后的回声，确认失踪同伴留下的敲击节奏。',
        plotPoints: [{ id: 'pp-14-1', desc: '沈澄在第二道门后辨认出同伴留下的节奏。' }],
      };
      const chapterCards = chapters.map((chapter, index) => ({
        chapter: chapter.chapter,
        title: `第${chapter.chapter}章`,
        summary:
          index === 0
            ? '第一章留下的线索：赤铜铃只在无风时指向西门暗渠。REMOTE_RECALL_SENTINEL'
            : `主角调查城中案件，取得第${chapter.chapter}章线索。`,
        keyEvents: [chapter.content],
        characterChanges: [],
        foreshadowsAdded: [],
        foreshadowsResolved: [],
        locations: [],
        propsAndRules: [],
        endingState: chapter.content,
        keywords: [],
        contentHash: globalThis.chapterContentHash(chapter.content),
        source: 'ai-summary-card',
      }));
      state.currentChapter = 13;
      state.contextFull = false;
      state.creativeRules = {
        ...(state.creativeRules || {}),
        detailedPOVEnabled: true,
        povMode: 'multi',
        povCharacters: ['沈澄', '闻砚'],
        chapterPOVOverrides: {},
      };
      state.chapters = chapters;
      state.chapters.push({
        chapter: 13,
        content: 'CURRENT_CHAPTER_DRAFT_SENTINEL：这是重新生成前保存的旧稿。',
      });
      state.outline = [...outline, currentOutline, nextOutline];
      state.memory = { ...globalThis.getEmptyMemory(), chapterCards };
      state.memoryTrust = { 'chapterCard:12': 'ignored' };
      state.operationLogs = [];
      const reviewedStyleText = globalThis.sanitizeGeneratedText(chapters[9].content);
      let styleFingerprintHash = 2166136261;
      for (let index = 0; index < reviewedStyleText.length; index += 1) {
        styleFingerprintHash ^= reviewedStyleText.charCodeAt(index);
        styleFingerprintHash = Math.imul(styleFingerprintHash, 16777619);
      }
      state.uiDrafts = {
        ...(state.uiDrafts || {}),
        generationQualityReports: {
          outline: null,
          chapters: {
            10: {
              status: 'reviewed',
              fingerprint: `${reviewedStyleText.length.toString(36)}-${(styleFingerprintHash >>> 0).toString(16).padStart(8, '0')}`,
            },
            12: { status: 'unverified', fingerprint: 'stale-draft' },
          },
        },
      };

      const summaryMessages = globalThis.buildChapterContextMessages(13, 'summary');
      const fullMessages = globalThis.buildChapterContextMessages(13, 'full');
      const dynamicContext = globalThis.buildDynamicChapterContext(
        13,
        currentOutline,
        currentOutline.plotPoints,
        '{note}{novelNote}',
      );
      const writingRulesContext = globalThis.buildExtraWritingContext('chapter');
      const continuationRulesContext = globalThis.buildExtraWritingContext('continue');
      const recentStyleSample = globalThis.buildRecentProseStyleContext('chapter');
      const characterVoiceContext = recentStyleSample.split('【正文风格参照')[0] || '';
      const proseStyleSample = recentStyleSample.split('【正文风格参照')[1] || '';
      return {
        summaryCount: summaryMessages.length,
        summaryFirstChapter: summaryMessages[0]?.content || '',
        summaryLastChapter: summaryMessages.at(-2)?.content || '',
        summaryIncludesRemoteChapter: JSON.stringify(summaryMessages).includes('REMOTE_RECALL_SENTINEL'),
        fullCount: fullMessages.length,
        fullIncludesChapterOne: JSON.stringify(fullMessages).includes('第1章正文'),
        retrievedRemoteCard: dynamicContext.includes('REMOTE_RECALL_SENTINEL'),
        duplicatedRecentCard: dynamicContext.includes('第12章线索'),
        retrievedVoiceSample: dynamicContext.includes('VOICE_SAMPLE_SENTINEL'),
        characterVoiceReachesGeneration:
          dynamicContext.includes('CHARACTER_VOICE_CHEN_SENTINEL') &&
          dynamicContext.includes('CHARACTER_VOICE_WEN_SENTINEL'),
        styleSampleSource: writingRulesContext.includes('REVIEWED_STYLE_SENTINEL'),
        continuationStyleSample: continuationRulesContext.includes('REVIEWED_STYLE_SENTINEL'),
        recentStyleSampleIncludesDialogue: recentStyleSample.includes('REVIEWED_STYLE_SENTINEL'),
        styleSampleChapter:
          recentStyleSample.split('\n').find((line) => line.startsWith('【正文风格参照')) || '',
        recentStyleSampleCharacterCount: recentStyleSample.length,
        recentStyleSampleGuidance: recentStyleSample,
        characterVoiceContext,
        proseStyleSample,
        nextChapterHandoff: writingRulesContext.includes('下一章接力方向'),
        nextChapterTitle: writingRulesContext.includes('门后的第二道回声'),
        nextChapterSummary: writingRulesContext.includes(nextOutline.summary),
        nextChapterBoundary: writingRulesContext.includes('不得提前演出下一章专属事件'),
        continuationLeaksNextChapter: continuationRulesContext.includes('门后的第二道回声'),
        leakedCurrentDraft: dynamicContext.includes('CURRENT_CHAPTER_DRAFT_SENTINEL'),
        leakedDraftInStyleContext: writingRulesContext.includes('CURRENT_CHAPTER_DRAFT_SENTINEL'),
        contextTitle: document.getElementById('contextLabel')?.title || '',
      };
    });

    expect(evidence.summaryCount).toBe(6);
    expect(evidence.summaryFirstChapter).toContain('第10章');
    expect(evidence.summaryLastChapter).toContain('第12章');
    expect(evidence.summaryIncludesRemoteChapter).toBe(false);
    expect(evidence.fullCount).toBe(24);
    expect(evidence.fullIncludesChapterOne).toBe(true);
    expect(evidence.retrievedRemoteCard).toBe(true);
    expect(evidence.duplicatedRecentCard).toBe(false);
    expect(evidence.retrievedVoiceSample).toBe(true);
    expect(evidence.characterVoiceReachesGeneration).toBe(true);
    expect(evidence.styleSampleSource).toBe(true);
    expect(evidence.continuationStyleSample).toBe(true);
    expect(evidence.recentStyleSampleIncludesDialogue).toBe(true);
    expect(evidence.styleSampleChapter).toContain('第10章（审校通过）');
    expect(evidence.recentStyleSampleCharacterCount).toBeLessThan(1400);
    expect(evidence.recentStyleSampleGuidance).toContain('不把样本人物的口吻套给其他角色');
    expect(evidence.recentStyleSampleGuidance).toContain('回退到最近的已写章节');
    expect(evidence.characterVoiceContext).toContain('沈澄');
    expect(evidence.characterVoiceContext).toContain('CHARACTER_VOICE_CHEN_SENTINEL');
    expect(evidence.characterVoiceContext).toContain('闻砚');
    expect(evidence.characterVoiceContext).toContain('CHARACTER_VOICE_WEN_SENTINEL');
    expect(evidence.characterVoiceContext).not.toContain('NON_POV_VOICE_SENTINEL');
    expect(evidence.proseStyleSample).toContain('REVIEWED_STYLE_SENTINEL');
    expect(evidence.nextChapterHandoff).toBe(true);
    expect(evidence.nextChapterTitle).toBe(true);
    expect(evidence.nextChapterSummary).toBe(true);
    expect(evidence.nextChapterBoundary).toBe(true);
    expect(evidence.continuationLeaksNextChapter).toBe(false);
    expect(evidence.leakedCurrentDraft).toBe(false);
    expect(evidence.leakedDraftInStyleContext).toBe(false);
    expect(evidence.contextTitle).toContain('最近 3 章摘要');

    const revisionSelection = await page.evaluate(() => {
      const report = state.uiDrafts.generationQualityReports.chapters['12'];
      const reviewTime = Date.now() - 5_000;
      state.uiDrafts.generationQualityReports.chapters['12'] = {
        ...report,
        status: 'reviewed',
        fingerprint: 'before-author-revision',
        updatedAt: reviewTime,
      };
      state.operationLogs = [];
      const authorRevision = globalThis.buildRecentProseStyleContext('chapter');
      state.operationLogs = [
        {
          chapter: 12,
          type: 'expert-review-rewrite',
          createdAt: new Date(reviewTime + 1_000).toISOString(),
        },
      ];
      const aiRewrite = globalThis.buildRecentProseStyleContext('chapter');
      const sourceLabel = (context: string) =>
        context.split('\n').find((line) => line.startsWith('【正文风格参照')) || '';
      return {
        authorRevisionLabel: sourceLabel(authorRevision),
        authorRevisionGuidance: authorRevision,
        aiRewriteLabel: sourceLabel(aiRewrite),
      };
    });
    expect(revisionSelection.authorRevisionLabel).toContain('第12章（审校后有修订）');
    expect(revisionSelection.authorRevisionGuidance).toContain('优先把这份修订视作作者反馈');
    expect(revisionSelection.authorRevisionGuidance).toContain('第10章（审校通过）');
    expect(revisionSelection.aiRewriteLabel).toContain('第10章（审校通过）');

    await page.evaluate(() => {
      const report = state.uiDrafts.generationQualityReports.chapters['12'];
      report.updatedAt = Date.now() - 5_000;
      report.fingerprint = 'before-trusted-author-edit';
      delete report.authorRevision;
      state.operationLogs = [
        {
          chapter: 12,
          type: 'agent-edit',
          createdAt: new Date(Number(report.updatedAt) + 1_000).toISOString(),
        },
      ];
      state.currentChapter = 12;
      const editor = document.getElementById('chapterEditor') as HTMLTextAreaElement;
      editor.dataset.chapter = '12';
      editor.value = state.chapters.find((chapter) => chapter.chapter === 12)?.content || '';
    });
    await page.evaluate(() => globalThis.switchTab('write'));
    await expect(page.locator('#chapterEditor')).toBeVisible();
    await page.locator('#chapterEditor').fill('作者手工修订：让人物先做出选择，再用动作和后果呈现情绪变化。');
    await page.waitForTimeout(450);
    const authorFeedbackSelection = await page.evaluate(() => {
      state.currentChapter = 13;
      const report = state.uiDrafts.generationQualityReports.chapters['12'];
      return {
        recorded:
          typeof report.authorRevision?.fingerprint === 'string' &&
          Number(report.authorRevision?.updatedAt) > Number(report.updatedAt),
        context: globalThis.buildRecentProseStyleContext('chapter'),
      };
    });
    expect(authorFeedbackSelection.recorded).toBe(true);
    expect(authorFeedbackSelection.context).toContain('第12章（审校后有修订）');
    expect(authorFeedbackSelection.context).toContain('第10章（审校通过）');
    expect(authorFeedbackSelection.context).toContain('作者反馈');

    const rewrittenAfterAuthorEdit = await page.evaluate(() => {
      const chapter = state.chapters.find((entry) => entry.chapter === 12);
      if (chapter) chapter.content = 'AI 后续重写了这一章，不能误判为作者修订。';
      state.operationLogs.unshift({
        chapter: 12,
        type: 'expert-review-rewrite',
        createdAt: new Date().toISOString(),
      });
      return globalThis.buildRecentProseStyleContext('chapter');
    });
    expect(rewrittenAfterAuthorEdit).toContain('第10章（审校通过）');
    expect(rewrittenAfterAuthorEdit).not.toContain('第12章（审校后有修订）');

    await page.evaluate(() => {
      state.currentChapter = 11;
      delete state.uiDrafts.generationQualityReports.chapters['11'];
      const editor = document.getElementById('chapterEditor') as HTMLTextAreaElement;
      editor.dataset.chapter = '11';
      editor.value = state.chapters.find((chapter) => chapter.chapter === 11)?.content || '';
    });
    await page.locator('#chapterEditor').fill('作者手写的未审校段落：她把门留了一线，等对方先开口。');
    await page.waitForTimeout(450);
    const unreviewedAuthorFeedback = await page.evaluate(() => {
      state.currentChapter = 13;
      const feedback = state.uiDrafts.authorProseFeedback?.['11'];
      return {
        recorded: typeof feedback?.fingerprint === 'string' && Number(feedback?.updatedAt) > 0,
        context: globalThis.buildRecentProseStyleContext('chapter'),
      };
    });
    expect(unreviewedAuthorFeedback.recorded).toBe(true);
    expect(unreviewedAuthorFeedback.context).toContain('第11章（作者修订）');
    expect(unreviewedAuthorFeedback.context).toContain('第10章（审校通过）');
    expect(unreviewedAuthorFeedback.context.length).toBeLessThan(1800);

    const fullContextStyleGuidance = await page.evaluate(() => {
      const previous = state.contextFull;
      state.contextFull = true;
      const context = globalThis.buildRecentProseStyleContext('chapter');
      const generationContext = globalThis.buildExtraWritingContext('chapter');
      const fullMessages = globalThis.buildChapterContextMessages(13, 'full');
      state.contextFull = previous;
      return {
        context,
        generationContext,
        fullContainsAuthorRevision: JSON.stringify(fullMessages).includes('作者手写的未审校段落'),
      };
    });
    expect(fullContextStyleGuidance.context).toContain('全文上下文里的作者风格锚点');
    expect(fullContextStyleGuidance.context).toContain('第11章（作者修订）');
    expect(fullContextStyleGuidance.context).toContain('第10章（审校通过）');
    expect(fullContextStyleGuidance.context).not.toContain('作者手写的未审校段落');
    expect(fullContextStyleGuidance.context.length).toBeLessThan(1000);
    expect(fullContextStyleGuidance.generationContext).toContain('全文上下文里的作者风格锚点');
    expect(fullContextStyleGuidance.fullContainsAuthorRevision).toBe(true);
  } finally {
    if (!page.isClosed())
      await page.evaluate((saved) => {
        state.chapters = saved.chapters;
        state.outline = saved.outline;
        state.memory = saved.memory;
        state.memoryTrust = saved.memoryTrust;
        state.currentChapter = saved.currentChapter;
        state.contextFull = saved.contextFull;
        state.creativeRules = saved.creativeRules;
        state.uiDrafts = saved.uiDrafts;
        state.operationLogs = saved.operationLogs;
        globalThis.setWriterToggleLabels();
      }, baseline);
  }
});

test('chapter drafting gets a concrete scene-quality brief and AI memory cannot overwrite confirmed canon', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('成稿质量与正史保护验收');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();

  const memoryPackagePrompts: string[] = [];
  const candidateMemoryPackage = {
    chapterCard: {
      chapter: 2,
      title: 'AI 新标题',
      summary: 'AI 擅自改写的第二章概要',
      keyEvents: ['AI 擅自改写的第二章事件'],
      characterChanges: [],
      foreshadowsAdded: [],
      foreshadowsResolved: [],
      locations: ['雾港钟楼'],
      propsAndRules: ['潮湿的来信'],
      endingState: '沈澄决定去查钟楼档案。',
      keywords: ['来信', '钟楼'],
    },
    memoryDelta: {
      characters: {
        沈澄: { currentStatus: 'AI 擅自改写的状态', goal: 'AI 擅自改写的目标' },
        闻砚: { currentStatus: '刚从雾港返回', goal: '寻找钟楼里的旧信' },
      },
      locations: [],
      factions: [],
      importantEvents: [{ chapter: 2, event: '第二章中发现一页潮湿的来信' }],
      foreshadows: { added: [], resolved: [] },
      worldBuilding: [],
    },
  };
  const longChapterText = [
    '第二章开端：FULL_CHAPTER_OPENING_SENTINEL 沈澄收到一封落款日期早于钟楼建成的信。',
    '中段：FULL_CHAPTER_MIDDLE_SENTINEL 她没有立刻拆信，而是先去查封存登记，发现登记被人改过。',
    '结尾：FULL_CHAPTER_ENDING_SENTINEL 闻砚承认改过登记，但没有解释原因。',
  ].join('\n');
  await page.route('https://mock-memory-quality.test/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON() as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = (payload.messages || []).map((message) => message.content || '').join('\n');
    const isMemoryPackage = prompt.includes('生成章节记忆包');
    if (isMemoryPackage) memoryPackagePrompts.push(prompt);
    else throw new Error('Unexpected model request in memory protection test');
    const content = JSON.stringify(candidateMemoryPackage);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ['data: ' + JSON.stringify({ choices: [{ delta: { content } }] }), 'data: [DONE]', ''].join('\n'),
    });
  });

  const evidence = await page.evaluate(async (fullChapterText) => {
    const original = {
      baseURL: state.baseURL,
      apiKey: state.apiKey,
      model: state.model,
      currentChapter: state.currentChapter,
      chapters: structuredClone(state.chapters || []),
      outline: structuredClone(state.outline || []),
      memory: structuredClone(state.memory || {}),
      memoryTrust: structuredClone(state.memoryTrust || {}),
      uiDrafts: structuredClone(state.uiDrafts || {}),
    };
    state.baseURL = 'https://mock-memory-quality.test/v1';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    state.currentChapter = 2;
    state.chapters = [
      {
        chapter: 1,
        content: '第一章：沈澄守在雾港钟楼，确认她不会交出旧钥匙。',
      },
    ];
    state.outline = [
      { chapter: 1, title: '旧钥匙', summary: '沈澄守住钟楼旧钥匙。', plotPoints: [] },
      {
        chapter: 2,
        title: '潮湿的来信',
        summary: '沈澄发现一封来信的日期不对。',
        plotPoints: [{ id: 'pp-2-1', desc: '发现来信日期早于钟楼建成。' }],
      },
    ];
    const confirmedEvent = { chapter: 1, event: '沈澄拒绝交出旧钥匙' };
    const autoHistoricalEvent = { chapter: 1, event: '未确认但已保存的第一章历史事件' };
    state.memory = {
      ...globalThis.getEmptyMemory(),
      characters: {
        沈澄: { currentStatus: '作者确认的守塔人', goal: '作者确认：守住旧钥匙' },
      },
      importantEvents: [confirmedEvent, autoHistoricalEvent],
      chapterCards: [
        {
          chapter: 1,
          title: '钥匙留在塔中',
          summary: '作者确认的第一章完整概要',
          keyEvents: ['沈澄拒绝交出旧钥匙'],
          characterChanges: [],
          foreshadowsAdded: [],
          foreshadowsResolved: [],
          locations: ['雾港钟楼'],
          propsAndRules: ['旧钥匙'],
          endingState: '旧钥匙仍在沈澄手中。',
          keywords: ['旧钥匙'],
          contentHash: globalThis.chapterContentHash('第一章：沈澄守在雾港钟楼，确认她不会交出旧钥匙。'),
          source: 'ai-summary-card',
        },
        {
          chapter: 2,
          title: '作者确认的第二章标题',
          summary: '作者确认的第二章完整概要',
          keyEvents: ['作者确认的第二章事件'],
          characterChanges: [],
          foreshadowsAdded: [],
          foreshadowsResolved: [],
          locations: ['雾港钟楼'],
          propsAndRules: ['旧钥匙'],
          endingState: '作者确认的第二章结尾状态。',
          keywords: ['旧钥匙'],
          contentHash: 'confirmed-chapter-two-hash',
          source: 'ai-summary-card',
        },
      ],
    };
    state.memoryTrust = {
      'character:沈澄': 'confirmed',
      'chapterCard:1': 'confirmed',
      'chapterCard:2': 'confirmed',
      ['event:1:' + globalThis.simpleHash(globalThis.memoryTextOf(confirmedEvent))]: 'confirmed',
    };
    await Store.save();
    const qualityContext = globalThis.buildExtraWritingContext('chapter');
    const defaultWritingPrompt = globalThis.getPrompts().write;
    const confirmedContext = globalThis.buildMemoryPrompt(2);
    await globalThis.updateMemory(2, fullChapterText);
    await Store.save();
    return {
      original,
      qualityContext,
      defaultWritingPrompt,
      confirmedContext,
      character: state.memory.characters.沈澄,
      chapterCard: state.memory.chapterCards.find((card: { chapter: number }) => card.chapter === 2),
      events: state.memory.importantEvents,
      autoHistoricalEvent,
      proposals: structuredClone(state.uiDrafts.memoryProposals || []),
      memoryTrust: structuredClone(state.memoryTrust || {}),
    };
  }, longChapterText);

  expect(evidence.qualityContext).toContain('【场景组织｜把大纲写成戏】');
  expect(evidence.qualityContext).toContain('不要求“一点一幕”');
  expect(evidence.qualityContext).toContain('人物此刻要什么、阻力怎样具体作用');
  expect(evidence.defaultWritingPrompt).toContain('不要执行通用词语黑名单');
  expect(evidence.defaultWritingPrompt).not.toContain('绝对不要使用破折号');
  expect(evidence.defaultWritingPrompt).not.toContain('全文不超过 3 次');
  expect(evidence.confirmedContext).toContain('作者确认角色记忆');
  expect(evidence.confirmedContext).toContain('作者确认的守塔人');
  expect(evidence.character).toEqual({ currentStatus: '作者确认的守塔人', goal: '作者确认：守住旧钥匙' });
  expect(evidence.chapterCard?.summary).toBe('作者确认的第二章完整概要');
  expect(evidence.events).toContainEqual({ chapter: 1, event: '沈澄拒绝交出旧钥匙' });
  expect(evidence.events).toContainEqual(evidence.autoHistoricalEvent);
  expect(evidence.memoryTrust['character:沈澄']).toBe('confirmed');
  expect(evidence.memoryTrust['chapterCard:2']).toBe('confirmed');
  expect(evidence.proposals).toHaveLength(2);
  expect(evidence.proposals.map((proposal: { kind: string }) => proposal.kind).sort()).toEqual([
    'chapter-card',
    'character',
  ]);
  expect(evidence.proposals.find((proposal: { kind: string }) => proposal.kind === 'chapter-card')?.key).toBe(
    'chapterCard:2',
  );
  expect(
    evidence.proposals.find((proposal: { kind: string }) => proposal.kind === 'character')?.suggested,
  ).toMatchObject({ currentStatus: 'AI 擅自改写的状态' });
  expect(memoryPackagePrompts).toHaveLength(1);
  expect(memoryPackagePrompts[0]).toContain('作者确认的守塔人');
  expect(memoryPackagePrompts[0]).toContain('未确认但已保存的第一章历史事件');
  expect(memoryPackagePrompts[0]).toContain('FULL_CHAPTER_OPENING_SENTINEL');
  expect(memoryPackagePrompts[0]).toContain('FULL_CHAPTER_MIDDLE_SENTINEL');
  expect(memoryPackagePrompts[0]).toContain('FULL_CHAPTER_ENDING_SENTINEL');
  expect(memoryPackagePrompts[0]).not.toContain('本章正文（仅末尾部分）');

  await page.reload();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await expect(page.locator('#serverSaveIndicator')).toContainText('已保存');
  await page.waitForTimeout(180);
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();
  await page.locator('.tab-btn[data-tab="write"]').click();
  await page.locator('#tab-write summary').filter({ hasText: '长期记忆' }).click();
  const characterProposal = page.locator('.memory-proposal-card').filter({ hasText: '人物记忆：沈澄' });
  await expect(characterProposal).toContainText('作者确认的守塔人');
  await expect(characterProposal).toContainText('AI 擅自改写的状态');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.memory-proposal-panel')).toBeVisible();
  const proposalPanelOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(proposalPanelOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/memory-proposals-mobile.png', fullPage: true });
  await characterProposal.getByRole('button', { name: '对比后采用' }).click();
  await expect(page.locator('.memory-proposal-panel')).toContainText('1 条待确认');
  const persisted = await page.evaluate(async () => {
    const projectId = new URLSearchParams(location.search).get('project');
    const result = await fetch(`/api/projects/${projectId}/state`);
    return (await result.json()).state;
  });
  expect(persisted.memory.characters.沈澄.currentStatus).toBe('AI 擅自改写的状态');
  expect(persisted.memory.chapterCards.find((card: { chapter: number }) => card.chapter === 2)?.summary).toBe(
    '作者确认的第二章完整概要',
  );
  expect(persisted.memoryTrust['character:沈澄'].status || persisted.memoryTrust['character:沈澄']).toBe(
    'confirmed',
  );
  expect(
    persisted.uiDrafts.memoryProposals.find((proposal: { kind: string }) => proposal.kind === 'character')
      ?.status,
  ).toBe('accepted');
});

test('canvas AI成果可保存接力，过期输入不会被下游误用', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('画布成果接力验收');
  await page.locator('#projectDialog').getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal.show');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();

  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '显示全部节点' }).click();
  const addStep = async (title: string, instruction: string) => {
    await page.getByRole('button', { name: '添加节点' }).click();
    await page.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: 'AI 步骤' }).click();
    const step = page.locator('.creative-canvas-step').last();
    await step.getByLabel('步骤名称').fill(title);
    await step.getByLabel('步骤要求').fill(instruction);
    return step;
  };
  const addedFirst = await addStep('追查钟楼证词', '从值夜记录中找出钥匙被制造的原因与代价。');
  const firstId = (await addedFirst.getAttribute('data-canvas-node-id'))!;
  await addStep('写出证词的余波', '承接证词，写清公开它将如何改变人物关系。');
  const downstreamId = (await page
    .locator('.creative-canvas-step')
    .last()
    .getAttribute('data-canvas-node-id'))!;
  const firstStep = page.locator(`.creative-canvas-step[data-canvas-node-id="${firstId}"]`);
  const downstreamStep = page.locator(`.creative-canvas-step[data-canvas-node-id="${downstreamId}"]`);
  await firstStep.locator('[data-node-connect]').focus();
  await firstStep.locator('[data-node-connect]').press('Enter');
  await downstreamStep.locator('[data-node-connect]').focus();
  await downstreamStep.locator('[data-node-connect]').press('Enter');
  await expect(page.locator('[data-canvas-edge].custom')).toHaveCount(1);

  const prompts: string[] = [];
  const firstDraft =
    '【成果标题：钟楼证词】\n守夜人承认，他用姐姐的一段记忆铸成钥匙。沈澄公开记录，闻砚因此失去守塔资格。';
  const firstRevision = `${firstDraft}姐姐亲笔写下的封存日期比失踪日早了三天，证明她曾主动把记忆交给钟楼。`;
  const nextDraft = '【成果标题：证词引发的裂痕】\n公开记录让值夜人不再相信闻砚。';
  const nextRevision = `${nextDraft}沈澄把姐姐亲笔日期交给所有人核验；闻砚失去守塔资格，却因此说出姐姐主动封存记忆的真相。`;
  await page.evaluate(async () => {
    state.baseURL = 'https://mock-novel-api.test/v1';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    await Store.save();
  });
  await page.route('https://mock-novel-api.test/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON() as { messages?: Array<{ content?: string }> };
    const prompt = (payload.messages || []).map((message) => message.content || '').join('\n');
    prompts.push(prompt);
    const isNextStep = prompt.includes('写出证词的余波');
    const artifact = isNextStep ? nextDraft : firstDraft;
    const content = prompt.includes('【创作结果精修任务】')
      ? `【精修诊断】已补足代价与后续影响。\n【修订稿】\n${isNextStep ? nextRevision : firstRevision}`
      : artifact;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`, 'data: [DONE]', ''].join('\n'),
    });
  });

  await firstStep.getByRole('button', { name: '让 AI 执行此步骤' }).click();
  await expect.poll(() => prompts.length).toBe(2);
  await expect
    .poll(async () =>
      page.evaluate(async (stepId) => {
        const id = new URLSearchParams(location.search).get('project');
        const saved = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
        return saved.nodes.find((node: { id: string }) => node.id === stepId)?.output?.text || '';
      }, firstId),
    )
    .toContain('姐姐亲笔写下的封存日期');

  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.locator('#creativeCanvasAddMenu').getByRole('menuitem', { name: '故事结构' }).click();
  const outlineStage = page.locator('.creative-canvas-stage[data-workflow-id="outline"]');
  await firstStep.locator('[data-node-connect]').focus();
  await firstStep.locator('[data-node-connect]').press('Enter');
  await outlineStage.locator('[data-node-connect]').focus();
  await outlineStage.locator('[data-node-connect]').press('Enter');
  const outlineContext = await page.evaluate(() => globalThis.buildExtraWritingContext('outline'));
  expect(outlineContext).toContain('姐姐亲笔写下的封存日期比失踪日早了三天');
  await page.reload();
  await page.getByRole('button', { name: '创作流程' }).click();
  await page.getByRole('button', { name: '显示全部节点' }).click();
  await page.evaluate(async () => {
    state.baseURL = 'https://mock-novel-api.test/v1';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    await Store.save();
  });
  const savedFirstStep = page.locator(`.creative-canvas-step[data-canvas-node-id="${firstId}"]`);
  const savedDownstreamStep = page.locator(`.creative-canvas-step[data-canvas-node-id="${downstreamId}"]`);
  await expect(savedFirstStep.locator('.creative-canvas-step-output-text')).toContainText(
    '姐姐亲笔写下的封存日期',
  );
  await savedDownstreamStep.getByRole('button', { name: '让 AI 执行此步骤' }).click();
  await expect.poll(() => prompts.length).toBe(4);
  expect(prompts[2]).toContain('【审校通过的创作提案｜不是已确认正史】');
  expect(prompts[2]).toContain('姐姐亲笔写下的封存日期比失踪日早了三天');

  await page.getByRole('button', { name: '创作流程' }).click();
  await savedFirstStep.getByLabel('步骤名称').fill('重新核对钟楼证词');
  await expect(savedFirstStep.locator('[data-canvas-step-status]')).toContainText('成果已过期');
  const promptsBeforeBlockedRun = prompts.length;
  await savedDownstreamStep.getByRole('button', { name: '让 AI 执行此步骤' }).click();
  await expect(page.locator('#toast')).toContainText('先完成上游步骤');
  expect(prompts).toHaveLength(promptsBeforeBlockedRun);
});

test('高质量起步路径把故事引擎交付接入大纲并自动修复缺项', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByPlaceholder('四位 PIN').fill('2468');
  await page.getByRole('button', { name: /设置 PIN|进入书库/ }).click();
  await page.getByRole('button', { name: '＋ 新建小说' }).click();
  await page.getByLabel('书名').last().fill('故事引擎质量验收');
  await page.locator('#projectDialog').getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(/\/workbench\.html\?project=/);
  await page.waitForTimeout(180);
  const onboarding = page.locator('#onboardingModal.show');
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '✕' }).click();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '创作流程' }).click();
  const emptyState = page.locator('#creativeCanvasEmpty');
  await expect(emptyState.getByRole('button', { name: '布置高质量起步路径' })).toBeVisible();
  await emptyState.getByRole('button', { name: '布置高质量起步路径' }).click();
  const storyEngine = page.locator('.creative-canvas-step[data-canvas-node-id="step:starter-story-engine"]');
  await expect(storyEngine.getByLabel('步骤名称')).toHaveValue('提炼故事引擎');
  await expect(page.locator('.creative-canvas-stage')).toHaveCount(4);
  await expect(page.locator('.creative-canvas-edge.main')).toHaveCount(4);
  const outlineContext = await page.evaluate(() => globalThis.buildCreativeRulesContext('outline'));
  expect(outlineContext).toContain('三段升级链');
  expect(outlineContext).toContain('对抗力量的目标与策略');

  const completedArtifact = [
    '【成果标题：雾港的倒流来信】',
    '【读者承诺 / 核心戏剧问题】每封提前寄到的信都能救一个人，却会抹去寄信者与收信者共享的一段记忆；沈澄要怎样找回姐姐，又不让港城忘掉她？',
    '【主角欲望 / 错误信念 / 代价】沈澄想找回失踪的姐姐，相信只要掌握完整记录就能避免伤害；她必须面对自己曾销毁一页值夜簿的事实，代价是失去港民对她的信任。',
    '【对抗力量的目标与策略】闻砚想让钟楼停止寄信，因为每次救人都会吞掉一段共同记忆；他暗中调换潮汐刻度，让沈澄先怀疑姐姐仍在操纵来信。',
    '【作品独有的因果机制】钟楼只会寄出收信人尚未作出的选择，而拆信者会失去与寄信者共同经历的一段记忆；沈澄越追查姐姐，越无法确定自己的证词是否真实。',
    '【三段升级链】',
    '1. 沈澄发现姐姐的信早于失踪日寄出；她公开信件求助，闻砚揭出她删过值夜簿；她因此失去港民信任，必须从公开记录查起。',
    '2. 值夜簿证明闻砚调换过潮汐刻度；沈澄选择暂缓逮捕他以换取原始记录；钟楼按时寄出新信，闻砚的记忆开始消失，两人不得不共查。',
    '3. 原始刻度指向沈澄亲手停过的钟；她选择承认并重启钟楼；港民因此想起被抹去的亲人，却也认出她曾参与掩盖，调查转成公开审判。',
    '【开篇场景与长线承诺】退潮前，沈澄在空无一人的值夜台收到姐姐三年前寄给自己的信；她必须在钟声前决定是否拆封，开篇即兑现“救人与失忆”的代价，并留下姐姐如何预知未来的长线谜题。',
  ].join('\n');
  const incompleteArtifact = '【成果标题：雾港来信】\n沈澄想找到姐姐，对抗力量试图阻止她。';
  const requests: string[] = [];
  await page.evaluate(async () => {
    state.baseURL = 'https://mock-story-engine.test/v1';
    state.apiKey = 'test-only';
    state.model = 'mock-model';
    await Store.save();
  });
  await page.route('https://mock-story-engine.test/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON() as { messages?: Array<{ content?: string }> };
    const prompt = (payload.messages || []).map((message) => message.content || '').join('\n');
    requests.push(prompt);
    const content = prompt.includes('【故事引擎质量校验修复】')
      ? `【修订稿】\n${completedArtifact}`
      : prompt.includes('【创作结果精修任务】')
        ? `【精修诊断】故事方向成立，但分节不完整。\n【修订稿】\n${incompleteArtifact}`
        : incompleteArtifact;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`, 'data: [DONE]', ''].join('\n'),
    });
  });

  await storyEngine.getByRole('button', { name: '让 AI 执行此步骤' }).click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(storyEngine.locator('[data-canvas-step-status]')).toHaveText('修复通过');
  await expect(storyEngine.locator('.creative-canvas-step-output-text')).toContainText('三段升级链');
  await expect(storyEngine.getByRole('button', { name: /生成大纲/ })).toBeVisible();
  expect(requests[2]).toContain('缺少必需分节');
  const downstreamContext = await page.evaluate(() => globalThis.buildCreativeRulesContext('outline'));
  expect(downstreamContext).toContain('闻砚的记忆开始消失');

  const projectId = await page.evaluate(() => new URLSearchParams(location.search).get('project'));
  const savedOutput = await page.evaluate(async (id) => {
    const saved = (await (await fetch(`/api/projects/${id}/state`)).json()).state.uiDrafts.creativeCanvas;
    return saved.nodes.find((node: { id: string }) => node.id === 'step:starter-story-engine')?.output;
  }, projectId);
  expect(savedOutput?.qualityStatus).toBe('repaired');
  expect(savedOutput?.text).toContain('三段升级链');
  expect(savedOutput?.feedback).toContain('结构校验：');
  expect(savedOutput?.feedback).toContain('缺少必需分节');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
});
