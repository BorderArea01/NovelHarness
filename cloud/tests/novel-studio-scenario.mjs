import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  fillEditor,
  readEditor,
  waitEditor,
  clickSidebarEntry,
  openGenerationRecords,
} from './editor-client.mjs';
import { proposalSteps } from './proposal-tool-fixture.mjs';
const systemText = (body) =>
  typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((block) => block.text ?? '').join('\n')
      : (body.messages ?? [])
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
const effectiveRequestText = (body) =>
  systemText(body) +
  '\n' +
  (body.messages ?? [])
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((block) => block.text ?? '').join('\n')
          : '',
    )
    .join('\n');

export async function renameAndOpenBook(page, id, title) {
  await clickSidebarEntry(page, 'link', '小说库');
  const card = page.locator('.book[data-book-id="' + id + '"]');
  await card.getByRole('button', { name: '改名', exact: true }).click();
  await card.getByRole('textbox', { name: '小说新书名', exact: true }).fill(title);
  await card.getByRole('button', { name: '保存书名', exact: true }).click();
  await card.getByRole('heading', { name: title, exact: true }).waitFor();
  await card.getByRole('button', { name: '进入创作', exact: true }).click();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: title }).waitFor();
}

export async function createGuidedBook(page, { title, seed = '' }) {
  await page.getByRole('button', { name: '＋ 新建小说', exact: true }).click();
  await page.getByRole('textbox', { name: '书名', exact: true }).fill(title);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('textbox', { name: '故事起点（选填）', exact: true }).fill(seed);
  await page.getByRole('button', { name: '创建并打开', exact: true }).click();
}

// Full product path on the actual pinned native application/Pages/VFS. Only
// localhost model fixtures; this verifies functionality, not literary quality.
export async function verifyNovelStudio({ page, context, origin, model, root, waitFor }) {
  const workspace = page.getByRole('main', { name: '小说创作工作台', exact: true });
  await workspace.waitFor();
  assert.equal(model.requests.length, 0, 'Creating/opening a book must not invoke a model.');
  await page.getByRole('region', { name: '章节大纲', exact: true }).waitFor();
  await page.locator('.novel-author-dock').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.novel-desk-assistant').isVisible(), false);
  assert.equal(
    await page.getByRole('region', { name: '创作要求与操作', exact: true }).count(),
    0,
    'Outline planning uses its own request form; an unrelated composer must not crowd it.',
  );
  for (const name of ['正文', '大纲', '连写', '设定', '提示词'])
    assert.equal(await page.getByRole('button', { name, exact: true }).isVisible(), true);
  assert.equal(await page.getByText('从一个念头开始', { exact: true }).count(), 0);
  assert.equal(await page.locator('.novel-studio-sidebar').count(), 1);
  const book = await page.evaluate(
    async () => (await (await import('/novel-assets/workspace.mjs')).makeWorkspaceClient().list())[0],
  );
  const base = origin + '/api/novels/' + book.id + '/';
  const get = async (route) => {
    const response = await context.request.get(base + route);
    assert.equal(response.status(), 200);
    const result = await response.json();
    await response.dispose();
    return result;
  };
  // Five editable original templates, project-scoped save, no provider call.
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: '提示词 write', exact: true });
  await prompt.waitFor();
  const customized = (await prompt.inputValue()) + '\n独立测试规则：用证物的变化推动选择。';
  await prompt.fill(customized);
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(JSON.parse((await get('document?path=rules.json')).text).savedPrompts.write, customized);
  assert.equal(model.requests.length, 0);
  // Generate a chapter outline through the original native tools and streaming
  // turn. Browse freely while it is held, return to the ORIGINAL proposal.
  const summary =
    '沈澄核对铜钥匙上的刻痕，发现它只开启钟楼的登记匣，因此必须在封楼前取走姐姐留下的回信。'.repeat(30);
  const planned = {
    storyPlan: '回信留下不可撤回的代价，沈澄必须在失去证据前决定是否登楼。',
    chapters: [
      {
        chapter: 1,
        title: '第三声钟',
        summary,
        plotPoints: ['比对钥匙刻痕', '取回登记匣中的信'],
        note: '限沈澄视角',
      },
    ],
  };
  const plan = model.register({
    holdBeforeStep: 0,
    holdFinish: true,
    prepare(text, self) {
      self.draft = text.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
      assert.ok(self.draft);
      self.steps = proposalSteps(text, JSON.stringify(planned), { complete: true });
    },
  });
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  await page.getByLabel('本批规划章数', { exact: true }).fill('1');
  await page.getByLabel('本次规划要求', { exact: true }).fill(plan.marker);
  await page.getByRole('button', { name: '生成规划候选', exact: true }).click();
  await waitFor(() => plan.holds.length > 0, 'original outline model stream');
  const activity = page.getByLabel('当前对话执行状态', { exact: true });
  await activity.filter({ hasText: 'AI 执行中' }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const card = page.locator('.novel-task-card').first();
  await card.waitFor();
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  assert.equal(plan.holds[0].closed, false, 'Browsing must not cancel an in-flight turn.');
  model.release(plan);
  await waitFor(
    () => plan.completedSteps === 2 && plan.holds.length > 1,
    'outline candidate written via native tools',
  );
  assert.equal(JSON.parse((await get('document?path=outline.json')).text)[0].summary, summary);
  model.release(plan);
  await activity.filter({ hasText: 'AI 已结束' }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  assert.ok((await page.locator('.novel-outline-editor').textContent()).includes(summary));
  assert.equal(await page.getByRole('button', { name: '接受本批规划', exact: true }).count(), 0);
  await page.getByRole('button', { name: '起草本章', exact: true }).click();
  await waitFor(
    async () => (await get('documents')).documents.some((item) => item.category === 'chapter'),
    'outline chapter creation commits before reading it',
  );
  const initial = (await get('documents')).documents.find((item) => item.category === 'chapter');
  assert.ok(initial);
  const chapterURL = 'document?path=' + encodeURIComponent(initial.path);
  const original = await get(chapterURL);
  const prose =
    '沈澄将铜钥匙翻过来，第三道刻痕比前两道更深。钟楼下，封条还没有贴紧。\n\n她把姐姐的回信藏进衣袖，留下登记匣敞开着。';
  const write = model.register({
    argumentPreviewAtStep: 1,
    argumentPreviewText: '沈澄将铜钥匙翻过来，第三道刻痕',
    prepare(text, self) {
      assert.ok(text.includes('"proposal_id"'));
      assert.ok(!text.includes('executionPrompt'));
      self.draft = text.match(/\/workspace\/novels\/b-[a-f0-9]{32}\/drafts\/[a-f0-9-]{36}\.md/)?.[0];
      self.steps = proposalSteps(text, prose, { complete: true });
    },
  });
  // The SAME original composer is now usable beside the chapter. No detour
  // into chat, shadow textarea or duplicate author-request state.
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  await composer.waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-composer-seat]').count(), 1);
  assert.equal(await page.getByRole('button', { name: '编辑要求', exact: true }).count(), 0);
  await composer.fill(write.marker);
  const sessionId = await page
    .locator('[data-conversation-session]')
    .getAttribute('data-conversation-session');
  await page.getByRole('button', { name: '写作', exact: true }).click();
  await waitFor(
    () => write.holds.some((hold) => hold.stage === 'tool-arguments'),
    'partially streamed candidate tool arguments',
  );
  assert.equal((await get(chapterURL)).hash, original.hash);
  assert.equal(
    (await get('document?path=' + encodeURIComponent(write.draft.slice(book.root.length + 1)))).text,
    '',
    'Visible streamed arguments are not yet a committed candidate.',
  );
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const generating = page.locator('.novel-proposal-tool').filter({ hasText: '正在写作…' }).last();
  await generating.getByRole('button', { name: '正在写作…', exact: true }).click();
  await waitFor(
    async () =>
      (await page.locator('.novel-desk-assistant').textContent()).includes(write.argumentPreviewText),
    'original native diff card showing candidate text before submit completes',
  );
  const livePreview = page.getByRole('textbox', { name: '候选流式预览', exact: true });
  await livePreview.waitFor({ state: 'visible' });
  assert.equal(await livePreview.getAttribute('contenteditable'), 'false');
  assert.ok(
    await livePreview.evaluate(
      (node) => node.closest('.novel-prose-editor').getBoundingClientRect().height <= 301,
    ),
  );
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-proposal-stream-preview-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-proposal-stream-preview-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  assert.equal(write.holds.at(-1).closed, false, 'Browsing cannot close the argument stream.');
  model.release(write);
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await waitFor(() => write.completedSteps === 2, 'outline-bound chapter generation');
  await activity.filter({ hasText: 'AI 已结束' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('button', { name: '接受改稿', exact: true }).count(), 0);
  assert.equal((await get(chapterURL)).text, original.text + prose);
  const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
  await waitEditor(editor, (original.text + prose).replace(/\r\n/g, '\n'));
  // Same editor survives assistant browsing; local draft survives reload. No
  // accidental model call, no publication of unsaved text.
  const local = original.text + prose + '\n未提交的作者修改。';
  await fillEditor(editor, local);
  await page.locator('.novel-ms-status').filter({ hasText: '本机草稿已保留' }).waitFor();
  const calls = model.requests.length;
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  await composer.fill('尚未发送的作者要求，切换页面不能丢失。');
  const inputNode = await composer.elementHandle();
  assert.equal(
    await page.locator('[data-conversation-session]').getAttribute('data-conversation-session'),
    sessionId,
  );
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  assert.equal(await composer.evaluate((node, original) => node === original, inputNode), true);
  assert.equal(await page.locator('[data-composer-seat]').count(), 1);
  assert.equal(await composer.textContent(), '尚未发送的作者要求，切换页面不能丢失。');
  await inputNode.dispose();
  assert.equal(await readEditor(editor), local);
  await page.reload();
  await waitEditor(editor, local);
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  assert.equal(await composer.textContent(), '尚未发送的作者要求，切换页面不能丢失。');
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  assert.equal((await get(chapterURL)).text, original.text + prose);
  assert.equal(model.requests.length, calls);
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
  const persistentInput = await composer.elementHandle();
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  assert.equal(await composer.isVisible(), false);
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.evaluate((node, original) => node === original, persistentInput), true);
  assert.equal(await composer.textContent(), '尚未发送的作者要求，切换页面不能丢失。');
  await persistentInput.dispose();
  for (const [width, height, name] of [
    [1440, 960, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await waitEditor(editor, local);
    await waitFor(
      async () => !(await page.getByRole('button', { name: '大纲', exact: true }).isDisabled()),
      'settled manuscript controls',
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.getByRole('button', { name: '大纲', exact: true }).isVisible(), true);
    const inputBox = await composer.boundingBox();
    assert.ok(inputBox && inputBox.y >= 0 && inputBox.y + inputBox.height <= height);
    assert.equal(await page.locator('[data-composer-seat]').count(), 1);
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-novel-studio-' + name + '.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '大纲', exact: true }).click();
    assert.ok((await page.locator('.novel-outline-editor').textContent()).includes(summary));
    await page.getByRole('button', { name: '正文', exact: true }).click();
  }
  await clickSidebarEntry(page, 'link', '小说库');
  await page.getByRole('button', { name: '＋ 新建小说', exact: true }).waitFor();
  assert.equal(await page.locator('#create-guide').isVisible(), false);
  assert.equal(await page.locator('#seed').isVisible(), false);
  await page.getByRole('button', { name: '＋ 新建小说', exact: true }).click();
  await page.getByRole('button', { name: '取消建书', exact: true }).click();
  assert.equal(await page.locator('#create-guide').isVisible(), false);
  await page
    .getByRole('status')
    .filter({ hasText: /本小说/ })
    .waitFor();
  const libraryCard = page.locator('.book[data-book-id="' + book.id + '"]');
  assert.ok(
    !(await libraryCard.innerText()).includes('[novel-task:'),
    'Protocol envelopes are not book-card copy.',
  );
  await libraryCard.getByRole('button', { name: '改名', exact: true }).click();
  await libraryCard.getByRole('textbox', { name: '小说新书名', exact: true }).fill('取消不能改变书名');
  await libraryCard.getByRole('button', { name: '取消改名', exact: true }).click();
  await libraryCard.getByRole('heading', { name: book.title, exact: true }).waitFor();
  await libraryCard.getByRole('button', { name: '改名', exact: true }).click();
  await libraryCard.getByRole('textbox', { name: '小说新书名', exact: true }).fill('铜钥匙 · 改名验证');
  await libraryCard.getByRole('button', { name: '保存书名', exact: true }).click();
  await libraryCard.getByRole('heading', { name: '铜钥匙 · 改名验证', exact: true }).waitFor();
  assert.deepEqual(await get('identity'), {
    version: 1,
    id: book.id,
    root: book.root,
    title: '铜钥匙 · 改名验证',
    titleSource: 'workspace',
  });
  const backupReady = page.waitForEvent('download');
  await libraryCard.getByRole('button', { name: '备份', exact: true }).click();
  const backupFile = await backupReady;
  assert.ok(backupFile.suggestedFilename().startsWith('铜钥匙 · 改名验证'));
  const backupStream = await backupFile.createReadStream(),
    backupChunks = [];
  for await (const chunk of backupStream) backupChunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(backupChunks).toString('utf8'));
  assert.equal(backup.title, '铜钥匙 · 改名验证');
  assert.equal(
    JSON.parse(
      Buffer.from(backup.files.find((file) => file.path === 'book.json').data, 'base64').toString('utf8'),
    ).title,
    book.title,
  );
  assert.equal(
    await page.evaluate(
      async (input) => (await (await import('/novel-assets/backup.mjs')).restoreBackup(input)).manifest.title,
      backup,
    ),
    '铜钥匙 · 改名验证（恢复副本）',
  );
  assert.equal((await get(chapterURL)).text, local);
  assert.equal(
    (
      await page.evaluate(
        async () => (await (await import('/novel-assets/workspace.mjs')).makeWorkspaceClient().list())[0],
      )
    ).title,
    book.title,
    'Native Workspace owns renaming; import receipt remains unchanged.',
  );
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-novel-studio-library-mobile.png'),
    fullPage: true,
  });
  // In-app book switches reuse the shell but must bind the input to each
  // native session, including an empty book. Neither draft crosses books.
  await createGuidedBook(page, { title: '第二本 · 独立输入验收' });
  await page.getByRole('region', { name: '章节大纲', exact: true }).waitFor();
  const secondId = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  assert.notEqual(secondId, book.id);
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-composer-seat]').count(), 1);
  assert.equal((await composer.textContent()).trim(), '');
  await composer.fill('只属于第二本书的未发送要求。');
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + book.id + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id="' + book.id + '"]').waitFor();
  await page.locator('.novel-ms-heading > strong').filter({ hasText: '铜钥匙 · 改名验证' }).waitFor();
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.textContent(), '尚未发送的作者要求，切换页面不能丢失。');
  const exportArea = page.locator('.novel-reading-export');
  await exportArea.locator(':scope > summary').click();
  const readingReady = page.waitForEvent('download');
  await exportArea.getByRole('button', { name: '下载成稿', exact: true }).click();
  assert.equal((await readingReady).suggestedFilename(), '铜钥匙 · 改名验证.txt');
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + secondId + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id="' + secondId + '"]').waitFor();
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.textContent(), '只属于第二本书的未发送要求。');
  assert.equal(model.requests.length, calls);
  console.log(
    'Novel studio passed: dedicated/cancellable book wizard, manuscript-first shell, native outline → full preview → direct save → by-outline chapter, editable frozen prompts, one persistent conversation, optional tool details, streaming navigation, unsent drafts, reload and 1440/768/390 layouts; native book rename agrees with identity, manuscript, backup, restored-copy title and reading filename while original receipt bytes remain unchanged. Local synthetic provider only.',
  );
}

export async function verifyStudioEngine({ page, context, origin, model, waitFor, root }) {
  // Independent synthetic book, imported through the same native VFS protocol.
  // This seeds formal prose so stop/resume and exported readings can be checked
  // without paying a model or weakening the existing continuity assertions.
  const book = await page.evaluate(async () => {
    const { makeBookBundle } = await import('/novel-assets/bundle.mjs');
    const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
    const bundle = await makeBookBundle({
      state: {
        project: { title: '原件与登记簿 · 独立回归样本' },
        seed: '邮差在井边核对退回的信。',
        outline: [
          {
            chapter: 1,
            title: '原件',
            summary: '邮差保存退回的信，不能再改写昨日。',
            plotPoints: ['保存原件'],
          },
          {
            chapter: 2,
            title: '登记簿',
            summary: '邮差核对登记簿中的日期，拒绝销毁证据。',
            plotPoints: ['核对日期', '保留信件'],
          },
        ],
        chapters: [{ chapter: 1, content: '# 原件\n\n邮差把原件收进铁匣，井边的绳子已经断了。' }],
      },
    });
    return (await makeWorkspaceClient().import(bundle)).book;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin + '/?novel=' + book.id);
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  await page.locator('.novel-ms-status').filter({ hasText: '已读取' }).waitFor();
  const currentTitle = '原件与登记簿 · 当前对话 {{model}}';
  await renameAndOpenBook(page, book.id, currentTitle);
  const get = async (suffix) => {
    const response = await context.request.get(origin + '/api/novels/' + book.id + '/' + suffix, {
      maxRetries: 2,
    });
    assert.equal(response.status(), 200);
    const value = await response.json();
    await response.dispose();
    return value;
  };
  const first = (await get('documents')).documents.find((item) => item.category === 'chapter');
  const before = await get('document?path=' + encodeURIComponent(first.path));
  const activity = page.getByLabel('当前对话执行状态', { exact: true });
  const composer = page.locator('.novel-author-input [contenteditable="true"]:not(.cm-content)');
  assert.equal(await page.locator('.novel-desk-assistant').isVisible(), false);
  const chat = model.register({ finalText: '合成普通对话：可以先讨论这本书，再决定是否修改正文。' });
  const targets = [];
  page.on('request', (request) => {
    if (/\/api\/session[./]prompt$/.test(new URL(request.url()).pathname)) {
      const body = request.postDataJSON();
      const req = body.payload?.args?.request ?? body;
      targets.push({ keys: Object.keys(req), sessionId: req.sessionId ?? req.id });
    }
  });
  await composer.fill(chat.marker);
  await composer.press('Enter');
  await waitFor(() => chat.observed, 'ordinary native chat');
  assert.ok(
    effectiveRequestText(chat.bodies[0]).includes(
      JSON.stringify({ id: book.id, root: book.root, title: currentTitle }),
    ),
  );
  await page.getByRole('button', { name: '返回书稿', exact: true }).waitFor();
  assert.equal(await page.locator('.novel-desk-assistant').isVisible(), true);
  const scope = await page.evaluate(() => ({
    manuscript: document.querySelector('.novel-manuscript')?.dataset.sessionId,
    conversations: [...document.querySelectorAll('[data-conversation-session]')].map(
      (node) => node.dataset.conversationSession,
    ),
  }));
  assert.equal(targets[0].sessionId, scope.manuscript);
  assert.deepEqual(scope.conversations, [scope.manuscript]);
  await page.getByText(chat.finalText, { exact: false }).waitFor();
  await activity.filter({ hasText: 'AI 已结束' }).waitFor({ state: 'attached' });
  const renamedTitle = '原件与登记簿 · 同一对话改名后';
  const originalSessionId = scope.manuscript;
  await renameAndOpenBook(page, book.id, renamedTitle);
  assert.equal(await page.locator('.novel-manuscript').getAttribute('data-session-id'), originalSessionId);
  const renamedChat = model.register({ finalText: '同一原生对话已读取新的作品身份。' });
  await composer.fill(renamedChat.marker);
  await composer.press('Enter');
  await waitFor(() => renamedChat.observed, 'current identity after same-session rename');
  assert.ok(
    effectiveRequestText(renamedChat.bodies[0]).includes(
      JSON.stringify({ id: book.id, root: book.root, title: renamedTitle }),
    ),
  );
  try {
    await page.getByText(renamedChat.finalText, { exact: false }).waitFor();
  } catch (error) {
    console.error(
      'Local renamed-chat diagnostic:',
      JSON.stringify(
        await page.evaluate(() => ({
          assistant: document.querySelector('.novel-desk')?.dataset.assistant,
          nativeText: document.querySelector('.novel-desk-assistant')?.textContent?.slice(-2500),
          status: document.querySelector('.novel-native-activity')?.textContent,
          url: location.pathname + location.search,
        })),
      ),
    );
    throw error;
  }
  await activity.filter({ hasText: 'AI 已结束' }).waitFor({ state: 'attached' });
  for (const [width, height, name] of [
    [1280, 900, 'desktop'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByText(renamedChat.finalText, { exact: false }).scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-studio-context-chat-' + name + '.png'),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const failed = model.register({ httpStatus: 402, errorMessage: 'Synthetic balance failure.' });
  await composer.fill(failed.marker);
  await composer.press('Enter');
  await waitFor(() => failed.observed, 'native 402 propagation');
  await activity.filter({ hasText: 'AI 执行失败' }).waitFor({ state: 'attached' });
  assert.equal((await get('document?path=' + encodeURIComponent(first.path))).hash, before.hash);
  // Prepare another independent book/idle native session. Its candidate must
  // remain editable/acceptable while this book has a live model stream.
  const other = await page.evaluate(async () => {
    const bundle = await (
      await import('/novel-assets/bundle.mjs')
    ).makeBookBundle({
      state: {
        project: { title: '另一部作品 · 并行审稿验收' },
        chapters: [{ chapter: 1, content: '# 雨伞\n\n她留住雨伞。' }],
      },
    });
    return (await (await import('/novel-assets/workspace.mjs')).makeWorkspaceClient().import(bundle)).book;
  });
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + other.id + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id="' + other.id + '"]').waitFor();
  await page.locator('.novel-ms-status').filter({ hasText: '已读取' }).waitFor();
  const otherAPI = origin + '/api/novels/' + other.id + '/';
  const request = async (method, url, data, expected = 200) => {
    const response = await context.request[method](url, data ? { data } : {});
    assert.equal(response.status(), expected);
    const value = await response.json();
    await response.dispose();
    return value;
  };
  const otherBody = await request('get', otherAPI + 'document?path=chapters/00001.md');
  const otherProposal = await request('post', otherAPI + 'proposals', {
    path: otherBody.path,
    expectedHash: otherBody.hash,
  });
  const initialOtherDraft = await request(
    'get',
    otherAPI + 'document?path=' + encodeURIComponent(otherProposal.draft),
  );
  let otherDraft = await request('put', otherAPI + 'document', {
    path: otherProposal.draft,
    expectedHash: initialOtherDraft.hash,
    text: '# 雨伞\n\n她把雨伞还给了邮差。',
  });
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + book.id + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id="' + book.id + '"]').waitFor();
  await page.locator('.novel-ms-status').filter({ hasText: '已读取' }).waitFor();
  const localProposal = await request('post', origin + '/api/novels/' + book.id + '/proposals', {
    path: first.path,
    expectedHash: before.hash,
  });
  const initialLocalDraft = await get('document?path=' + encodeURIComponent(localProposal.draft));
  const localDraft = await request('put', origin + '/api/novels/' + book.id + '/document', {
    path: localProposal.draft,
    expectedHash: initialLocalDraft.hash,
    text: '这份本书候选必须等本书 AI 停止后处理。',
  });
  const stopped = model.register({
    holdBeforeStep: 0,
    steps: [{ name: 'read', input: { file_path: book.root + '/seed.md' } }],
  });
  await composer.fill(stopped.marker);
  await composer.press('Enter');
  await waitFor(() => stopped.holds.length > 0, 'held native stream');
  await activity.filter({ hasText: 'AI 执行中' }).waitFor({ state: 'attached' });
  await request(
    'post',
    origin + '/api/novels/' + book.id + '/accept',
    { id: localProposal.id, draftHash: localDraft.hash },
    409,
  );
  await request(
    'put',
    origin + '/api/novels/' + book.id + '/document',
    { path: localProposal.draft, expectedHash: localDraft.hash, text: '不应在本书运行中保存。' },
    409,
  );
  assert.equal(
    (await get('document?path=' + encodeURIComponent(localProposal.draft))).candidate.running,
    true,
  );
  assert.equal(
    (await request('get', otherAPI + 'document?path=' + encodeURIComponent(otherProposal.draft))).candidate
      .running,
    false,
  );
  otherDraft = await request('put', otherAPI + 'document', {
    path: otherProposal.draft,
    expectedHash: otherDraft.hash,
    text: '# 雨伞\n\n她把雨伞还给邮差，自己走进了雨里。',
  });
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + other.id + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id="' + other.id + '"]').waitFor();
  await openGenerationRecords(page);
  await page.getByRole('button', { name: '接受改稿', exact: true }).click();
  await page.locator('.novel-ms-status').filter({ hasText: '已接受改稿' }).waitFor();
  assert.equal(
    (await request('get', otherAPI + 'document?path=' + encodeURIComponent(otherBody.path))).text,
    otherDraft.text,
  );
  assert.equal(stopped.holds[0].closed, false, 'Another book acceptance must not stop this native stream.');
  await clickSidebarEntry(page, 'link', '小说库');
  await page
    .locator('.book[data-book-id="' + book.id + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript[data-book-id="' + book.id + '"]').waitFor();
  await activity.filter({ hasText: 'AI 执行中' }).waitFor({ state: 'attached' });
  const calls = stopped.bodies.length;
  const sessionId = await page.locator('.novel-manuscript').getAttribute('data-session-id');
  if (await page.getByRole('button', { name: '返回书稿', exact: true }).isVisible())
    await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  await page.reload();
  await activity.filter({ hasText: 'AI 执行中' }).waitFor({ state: 'attached' });
  assert.equal(stopped.bodies.length, calls, 'Reload must not resend the native prompt.');
  await clickSidebarEntry(page, 'link', '小说库');
  const card = page.locator('.book[data-book-id="' + book.id + '"]');
  const run = card.locator('.book-session[data-session-id="' + sessionId + '"]');
  await run.waitFor();
  const cancel = /\/api\/session[./]cancel$/;
  await page.route(cancel, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic stop transport failure.' }),
    }),
  );
  await run.getByRole('button', { name: '停止 AI', exact: true }).click();
  await card.getByRole('alert').waitFor();
  assert.equal(stopped.holds[0].closed, false);
  await page.unroute(cancel);
  await run.getByRole('button', { name: '停止 AI', exact: true }).click();
  await waitFor(() => stopped.holds[0].closed, 'native cancellation closes upstream');
  model.release(stopped);
  assert.equal(stopped.issuedSteps.length, 0);
  await card.getByRole('button', { name: '进入创作', exact: true }).click();
  await activity.filter({ hasText: 'AI 已停止' }).waitFor({ state: 'attached' });
  await request('post', origin + '/api/novels/' + book.id + '/reject', {
    id: localProposal.id,
    draftHash: localDraft.hash,
  });
  assert.equal((await get('document?path=' + encodeURIComponent(first.path))).hash, before.hash);
  const outline = await get('document?path=outline.json');
  const rows = JSON.parse(outline.text);
  rows[0].chapterPath = first.path;
  const bind = await context.request.put(origin + '/api/novels/' + book.id + '/document', {
    data: { path: 'outline.json', expectedHash: outline.hash, text: JSON.stringify(rows) },
  });
  assert.equal(bind.status(), 200);
  await bind.dispose();
  console.log(
    'Unified studio engine passed: same-session dynamic book identity after rename with literal template braces, visible ordinary replies; own-book candidate save/accept blocked during its stream while another book can save and accept through the actual manuscript UI without interrupting that stream; native 402, no false publication, reload without resend, stop failure stays running and explicit cancel prevents late tools.',
  );
  return book;
}
