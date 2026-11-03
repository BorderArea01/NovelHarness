import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { newFixtureApi } from './fixture-api.mjs';
import { fillEditor, waitEditor, readEditor, openHistory } from './editor-client.mjs';
import { verifyManuscriptSpace } from './manuscript-space-scenario.mjs';
import { verifyMobileDrawer } from './mobile-drawer-scenario.mjs';

// Actual manuscript component and native file API; delays only response
// delivery in the synthetic browser. No provider or production state.
export async function verifySelectionNavigation({ page, context, origin, root, waitFor }) {
  assert.equal(
    new URL(origin).hostname,
    '127.0.0.1',
    'Navigation writes are confined to the localhost fixture.',
  );
  const client = await newFixtureApi(context);
  const id = await page.locator('.novel-manuscript').getAttribute('data-book-id');
  assert.equal(await page.title(), '小说工作台');
  const catalogResponse = await client.post(origin + '/api/session/list', {
    data: { type: 'client-request', rpcId: crypto.randomUUID(), payload: { args: { request: {} } } },
  });
  const sessions = (await catalogResponse.json()).result.value.items;
  await catalogResponse.dispose();
  const session = sessions.find((s) => s.cwd === '/workspace/novels/' + id);
  assert.ok(session, 'The synthetic book must retain its original conversation.');
  for (const title of ['私密对话标题 · 不应显示在标签页', '修改后的私密对话标题']) {
    const response = await client.post(origin + '/api/session/rename', {
      data: { type: 'client-request', rpcId: crypto.randomUUID(),
        payload: { args: { request: { sessionId: session.sessionId, title } } } },
    });
    assert.equal(response.status(), 200);
    const reply = await response.json();
    await response.dispose();
    assert.equal(reply.result.ok, true);
    assert.equal(reply.result.value.title, title, 'Actual conversation metadata is preserved.');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.title(), '小说工作台');
  }
  const api = origin + '/api/novels/' + id + '/';
  const path = 'chapters/navigation-fixture.md';
  let release = () => {},
    route,
    pendingRead;
  const holdRead = async (target) => {
    let held = false,
      claimed = false,
      finished;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const drained = new Promise((resolve) => {
      finished = resolve;
    });
    route = async (request) => {
      const url = new URL(request.request().url());
      if (claimed || request.request().method() !== 'GET' || url.searchParams.get('path') !== target)
        return request.continue();
      claimed = true;
      try {
        const response = await request.fetch();
        held = true;
        await gate;
        await request.fulfill({ response });
      } finally {
        finished();
      }
    };
    await page.route('**/api/novels/' + id + '/document?**', route);
    pendingRead = { ready: () => waitFor(() => held, 'held native document read'), drained };
    return pendingRead;
  };
  const clearHold = async (held) => {
    release();
    await held.drained;
    await page.unroute('**/api/novels/' + id + '/document?**', route);
    route = null;
    pendingRead = null;
  };
  try {
    const initial = '# 导航测试\n\n读文件不应锁住导航。';
    const response = await client.put(api + 'document', {
      data: { path, text: initial, expectedHash: null },
    });
    assert.equal(response.status(), 200);
    await response.dispose();
    await page.setViewportSize({ width: 390, height: 844 });
    const first = await holdRead(path);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await first.ready();
    assert.equal(await page.locator('.novel-ms-body').evaluate((element) => element.inert), true);
    const prompts = page.getByRole('button', { name: '提示词', exact: true });
    assert.equal(
      await prompts.isDisabled(),
      false,
      'A held initial read must not disable author navigation.',
    );
    await prompts.click();
    const prompt = page.getByRole('textbox', { name: '提示词 write', exact: true });
    await prompt.waitFor();
    assert.equal(await page.locator('.novel-ms-body').evaluate((element) => element.inert), false);
    await clearHold(first);
    assert.equal(await prompts.getAttribute('aria-pressed'), 'true');
    await prompt.waitFor();

    const referenceRead = await holdRead('rules.json');
    const reference = page.getByRole('button', { name: '设定', exact: true });
    await reference.click();
    await referenceRead.ready();
    assert.equal(
      await page.getByRole('button', { name: '创作规则', exact: true, includeHidden: true }).isDisabled(),
      true,
      'Old content controls must not cancel a pending top-level navigation.',
    );
    assert.equal(await prompts.isDisabled(), false);
    await clearHold(referenceRead);
    await waitFor(
      () => reference.getAttribute('aria-pressed').then((v) => v === 'true'),
      'reference panel committed after valid read',
    );
    await page.getByRole('button', { name: '创作规则', exact: true }).click();
    await page.getByLabel('创作规则编辑器', { exact: true }).waitFor();

    await page.getByRole('button', { name: '正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '书稿正文', exact: true });
    await waitEditor(editor, initial);
    const local = initial + '\n作者未保存的句子。';
    await fillEditor(editor, local);
    const slow = await holdRead('rules.json');
    await prompts.click();
    await slow.ready();
    const outline = page.getByRole('button', { name: '大纲', exact: true });
    assert.equal(
      await outline.isDisabled(),
      false,
      'A held panel read must remain cancellable through normal navigation.',
    );
    await outline.click();
    await waitFor(
      () => outline.getAttribute('aria-pressed').then((v) => v === 'true'),
      'author outline navigation',
    );
    await clearHold(slow);
    assert.equal(await outline.getAttribute('aria-pressed'), 'true');
    assert.equal(await prompt.count(), 0);
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await waitEditor(editor, local);
    assert.equal(await readEditor(editor), local);
    await page.getByRole('button', { name: '保存正文', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    await openHistory(page);
    await page.getByRole('region', { name: '历史版本', exact: true }).waitFor();
    // A real read error must leave the old page/draft visible and retryable.
    const rejectRules = async (request) => {
      if (new URL(request.request().url()).searchParams.get('path') === 'rules.json')
        return request.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '导航读取失败测试' }),
        });
      return request.continue();
    };
    await page.route('**/api/novels/' + id + '/document?**', rejectRules);
    try {
      await prompts.click();
      await page.locator('.novel-ms-status').filter({ hasText: '导航读取失败测试' }).waitFor();
      assert.equal(
        await page.getByRole('region', { name: '历史版本', exact: true }).count(),
        0,
        'Failed navigation must not leave a history view whose request ownership has already expired.',
      );
      await waitEditor(editor, local);
      assert.equal(
        await page.getByRole('button', { name: '正文', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(await prompts.getAttribute('aria-pressed'), 'false');
    } finally {
      await page.unroute('**/api/novels/' + id + '/document?**', rejectRules);
    }
    await prompts.click();
    await prompt.waitFor();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await waitEditor(editor, local);

    // ABA: an old poll for A arrives after the author browsed B then reopened
    // A with a newer formal revision. Path equality alone is not ownership.
    const beforeResponse = await client.get(api + 'document?path=' + encodeURIComponent(path));
    const before = await beforeResponse.json();
    await beforeResponse.dispose();
    const stale = await holdRead(path);
    await stale.ready(); // Original four-second poll, not a new test scheduler.
    await prompts.click();
    await prompt.waitFor();
    const remote = local + '\n另一个设备保存的新段落。';
    const newerResponse = await client.put(api + 'document', {
      data: { path, text: remote, expectedHash: before.hash },
    });
    assert.equal(newerResponse.status(), 200);
    await newerResponse.dispose();
    await page.getByRole('button', { name: '正文', exact: true }).click();
    await waitEditor(editor, remote);
    const oldDelivery = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/document') &&
        new URL(response.url()).searchParams.get('path') === path,
    );
    await clearHold(stale);
    await (await oldDelivery).finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await readEditor(editor),
      remote,
      'Old poll delivery must not overwrite the reopened newer revision.',
    );
    for (const width of [768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const pending = await holdRead('rules.json');
      await prompts.click();
      await pending.ready();
      await page.getByRole('button', { name: '正文', exact: true }).click();
      await waitEditor(editor, remote);
      await clearHold(pending);
      assert.equal(
        await page.getByRole('button', { name: '正文', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(await prompt.count(), 0);
    }
    // Read cancellation must not weaken the original write barrier.
    await fillEditor(editor, remote + '\n本次手动保存。');
    let writeHeld = false,
      releaseWrite;
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const holdWrite = async (request) => {
      if (request.request().method() !== 'PUT') return request.continue();
      writeHeld = true;
      await writeGate;
      return request.continue();
    };
    await page.route('**/api/novels/' + id + '/document', holdWrite);
    try {
      await page.getByRole('button', { name: '保存正文', exact: true }).click();
      await waitFor(() => writeHeld, 'original save admitted once');
      assert.equal(
        await prompts.isDisabled(),
        true,
        'Actual formal writes must still retain their original navigation barrier.',
      );
      releaseWrite();
      await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
      await waitFor(() => prompts.isEnabled(), 'original save cleanup restores navigation');
      const savedResponse = await client.get(api + 'document?path=' + encodeURIComponent(path));
      assert.equal((await savedResponse.json()).text, remote + '\n本次手动保存。');
      await savedResponse.dispose();
    } finally {
      releaseWrite();
      await page.unroute('**/api/novels/' + id + '/document', holdWrite);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: resolve(root, 'test-results/cloud-navigation-read-mobile.png'),
      fullPage: true,
    });
    await verifyManuscriptSpace({ page, client, api, path, root, waitFor });
    await verifyMobileDrawer({ page, context, origin, root, waitFor });
    assert.equal(await page.title(), '小说工作台');
    assert.equal(await page.evaluate(() => globalThis.__privacyTitleViolations), 0);
    console.log('Browser title privacy passed: real synthetic session rename, panel navigation, reload, mobile/desktop and modal transitions keep one generic title; original conversation metadata remains editable.');
    console.log(
      'Native selection navigation passed: held initial/panel reads stay navigable; latest author selection wins; original unsaved draft retained/saved; failed read keeps current page and explicit retry; stale ABA poll cannot replace reopened newer revision; actual save retains original write barrier; 390/768/1280 layouts. No provider or production writes.',
    );
  } finally {
    release();
    if (pendingRead) await pendingRead.drained;
    if (route) await page.unroute('**/api/novels/' + id + '/document?**', route);
    await client.dispose();
  }
}
