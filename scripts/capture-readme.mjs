// Reproducible documentation screenshots, using only a disposable demo store.
// No real novels, production configuration or paid model calls are accessed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startSelfHostedServer } from '../cloud/selfhost/server.mjs';
import { makeBookBundle } from '../cloud/pages/public/novel-assets/bundle.mjs';
import {
  clickSidebarEntry,
  openChapter,
  waitResponsiveLayout,
  waitEditor,
} from '../cloud/tests/editor-client.mjs';

const directory = await mkdtemp(join(tmpdir(), 'novelharness-readme-'));
const output = resolve('docs/images');
const prose = `# 第一章 迟到的信

　　渡船靠岸时，雨刚停。林遥抱着一箱旧书走下跳板，先看见了码头边那把红伞。撑伞的人穿着邮局的蓝色制服，鞋面沾了厚厚一层泥，不像刚从镇上过来。

　　“找林遥。”邮差从挎包里取出一个信封，“书店的林遥。”

　　她把纸箱放在栏杆旁，接信时才发现，信封上的字是母亲写的。母亲去世已经七年。右下角那个收笔时带出来的小钩，她在旧账本上见过无数次，不会认错。

　　“谁寄的？”她抬头问。

　　邮差已经往回走了两步，听见她问，又停下来：“北岸收的。我只管送过河。”

　　林遥翻到背面。封口的浆糊发黄，邮戳却是昨天。她用指甲挑开信封，里面只有一张渡口的旧照片。照片上，母亲站在茶馆门前，身旁还有个穿白衬衫的年轻男人。

　　她从没见过那个人。

　　照片背面写着一句话：别把书店卖掉，周五有人来取东西。

　　今天就是周五。林遥把照片收进外套口袋，重新抱起纸箱。街对面的茶馆还亮着灯，有人推开二楼的窗，朝码头看了一眼。`;
const outline = [
  {
    chapter: 1,
    title: '迟到的信',
    summary: '林遥收到母亲寄来的旧照片。七年前去世的人，为什么会寄出一封盖着昨日邮戳的信？',
    beats: ['码头收信，认出母亲的笔迹。', '旧照片里出现陌生男人。', '茶馆二楼有人在等她。'],
  },
  {
    chapter: 2,
    title: '茶馆里的客人',
    summary: '陌生客人提出买走一整架旧书。林遥在书页夹层发现一张与照片日期相同的收据。',
    beats: ['客人只问书，不肯说明来历。', '翻找母亲留下的账本。', '收据指向北岸已停业的印刷厂。'],
  },
  {
    chapter: 3,
    title: '北岸的灯',
    summary: '林遥带着照片渡河，发现停业的印刷厂仍在夜里开工。她必须决定是否把调查交给别人。',
    beats: ['渡船停航前赶到北岸。', '在旧厂房找到新的印刷痕迹。', '有人认出照片上的年轻男人。'],
  },
];
const setting = `# 故事背景

雾港是一座靠渡船连接南北两岸的小城。故事发生在深秋，渡口、旧邮局、茶馆与临河书店构成人物日常生活的范围。

# 主要人物

林遥：二十七岁，接手母亲留下的书店。近期正为房租和卖店的决定发愁。她擅长修补旧书，不愿轻易谈及母亲。

陈泊：茶馆里的陌生客人，了解旧印刷厂的往事。他的目的是取回一套尚未完成的书，暂未向林遥说明原因。

# 关键地点

临河书店：一楼售书，二楼存放母亲留下的旧账本与杂物。

北岸印刷厂：对外宣称已经停业，近期夜里仍能看见灯光。

# 待解问题

信为何迟了七年？照片上的男人是谁？母亲让林遥保住书店，究竟是为了哪一样东西？`;
let app, browser, context;
const canon = {
  characters: [
    {
      id: 'demo-linyao',
      name: '林遥',
      role: '临河书店的主人',
      basicInfo: '二十七岁，接手母亲留下的旧书店。',
      personality: '细心、务实，遇到与母亲有关的事会格外执着。',
      motivation: '查清信件与旧照片的来历，决定是否留下书店。',
      currentStatus: '收到来信，准备去茶馆见客人。',
      tags: ['主角', '书店'],
      trust: 'manual',
    },
    {
      id: 'demo-chenbo',
      name: '陈泊',
      role: '茶馆里的陌生客人',
      background: '了解北岸印刷厂的往事，与照片中的人有联系。',
      goals: '找回一套尚未完成的书。',
      tags: ['关键人物', '旧事'],
      trust: 'manual',
    },
  ],
  locations: [
    {
      id: 'demo-bookshop',
      name: '临河书店',
      type: '书店',
      description: '一楼售书，二楼保存着旧账本和母亲的物品。',
      trust: 'manual',
    },
    {
      id: 'demo-factory',
      name: '北岸印刷厂',
      type: '旧厂房',
      description: '对外宣称已经停业，夜里却仍能看见灯光。',
      trust: 'manual',
    },
  ],
  items: [
    {
      id: 'demo-photo',
      name: '渡口旧照片',
      owner: '林遥',
      description: '母亲与一名陌生男人站在茶馆门前，背面留有提醒。',
      trust: 'manual',
    },
  ],
  organizations: [],
  relations: [
    {
      id: 'demo-owns',
      name: '经营',
      sourceType: 'character',
      sourceId: 'demo-linyao',
      targetType: 'location',
      targetId: 'demo-bookshop',
      trust: 'manual',
    },
  ],
};
let modelRequests = 0;
const captured = [];
try {
  app = await startSelfHostedServer({
    mode: 'shared',
    port: 0,
    dataDirectory: directory,
    initialPin: '864209',
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--disable-background-networking', '--disable-extensions', '--js-flags=--max-old-space-size=192'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (/\/api\/session\/prompt$/.test(url.pathname)) {
      modelRequests++;
      return route.abort();
    }
    return url.origin === app.origin ? route.continue() : route.abort();
  });
  const login = await context.request.post(app.origin + '/api/auth/login', {
    headers: { origin: app.origin },
    data: { pin: '864209' },
  });
  assert.equal(login.status(), 200);
  await login.dispose();
  let book;
  for (const [title, seed] of [
    ['雾港来信', '书店主人收到已故母亲寄来的信，沿着一张旧照片寻找往事。'],
    ['长街灯未熄', '旧街改造前的最后一个冬天，几位邻居一起经营一间夜间食堂。'],
    ['无声轨道', '航行中的观察站收到一段来自自身未来的求救信号。'],
  ]) {
    const bundle = await makeBookBundle(null, { title, seed });
    const response = await context.request.post(
      app.origin + '/api/novels/' + bundle.manifest.id + '/bootstrap',
      { headers: { origin: app.origin }, data: bundle },
    );
    assert.equal(response.status(), 200);
    await response.dispose();
    book ??= bundle.manifest;
  }
  for (const [path, text] of [
    ['chapters/00001.md', prose],
    ['outline.json', JSON.stringify(outline)],
    ['setting.md', setting],
    ['canon.json', JSON.stringify(canon)],
  ]) {
    const endpoint = app.origin + '/api/novels/' + book.id + '/document';
    const old = await context.request.get(endpoint + '?path=' + encodeURIComponent(path));
    const expectedHash = old.ok() ? (await old.json()).hash : null;
    await old.dispose();
    const saved = await context.request.put(endpoint, {
      headers: { origin: app.origin },
      data: { path, text, expectedHash },
    });
    assert.equal(saved.status(), 200);
    await saved.dispose();
  }
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  for (const name of ['继续', 'Continue', '稍后配置', 'Configure later'])
    await page.addLocatorHandler(
      page.getByRole('button', { name, exact: true }),
      () => page.getByRole('button', { name, exact: true }).click(),
      { times: 1 },
    );
  await page.addLocatorHandler(
    page.getByRole('button', { name: /我已知晓并继续|I understand/ }),
    async () => {
      await page.getByRole('checkbox').first().check();
      await page.getByRole('button', { name: /我已知晓并继续|I understand/ }).click();
    },
    { times: 1 },
  );
  await mkdir(output, { recursive: true });
  async function shot(name) {
    await waitResponsiveLayout(page);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    // Documentation never shows host paths, PIN input values or model secrets.
    assert.equal(await page.getByLabel('当前 PIN', { exact: true }).isVisible(), false);
    await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' });
    captured.push(name);
  }
  await page.goto(app.origin + '/?view=library', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '刷新', exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole('heading', { name: '我的小说', exact: true }).click();
  await expect(page.locator('.book:visible')).toHaveCount(3);
  await shot('library-desktop');
  await page
    .locator('.book[data-book-id="' + book.id + '"]')
    .getByRole('button', { name: '进入创作', exact: true })
    .click();
  await page.locator('.novel-manuscript').waitFor();
  await openChapter(page, 'chapters/00001.md');
  await waitEditor(page.locator('.novel-prose-editor .cm-content'), prose);
  await shot('writing-desktop');
  for (const [tab, name] of [
    ['大纲', 'outline-desktop'],
    ['设定', 'reference-desktop'],
    ['提示词', 'prompts-desktop'],
  ]) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.locator('.novel-ms-tabs[aria-busy="false"]').waitFor();
    if (tab === '设定') await page.getByText('林遥', { exact: true }).first().waitFor();
    await shot(name);
  }
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await waitEditor(page.locator('.novel-prose-editor .cm-content'), prose);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('writing-mobile');
  await clickSidebarEntry(page, 'link', '小说库');
  await page.getByRole('button', { name: '刷新', exact: true }).waitFor();
  await shot('library-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  await clickSidebarEntry(page, 'link', '数据与访问');
  await expect(page.getByRole('region', { name: '服务与存储', exact: true })).toContainText('主机 SQLite');
  assert.equal(
    await page.getByText('查看存储位置与连接', { exact: true }).locator('..').getAttribute('open'),
    null,
  );
  await shot('data-access');
  assert.equal(modelRequests, 0);
  console.log(JSON.stringify({ screenshots: captured, syntheticOnly: true, modelRequests }));
} finally {
  await context?.close();
  await browser?.close();
  await app?.close();
  assert(directory.startsWith(join(tmpdir(), 'novelharness-readme-')));
  await rm(directory, { recursive: true, force: true });
}
