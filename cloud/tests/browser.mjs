// UI-only fixture. This does NOT launch, impersonate or validate a real DSH Agent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { handleRequest } from '../pages/src/gateway.mjs';
import { verifyAuthUI } from './auth-ui-scenario.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'cloud/pages/public');
const files = new Map();
const env = {
  ASSETS: {
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path.endsWith('/')) path += 'index.html';
      const absolute = resolve(publicRoot, '.' + path);
      assert.ok(absolute.startsWith(publicRoot + sep));
      try {
        const contents = await readFile(absolute);
        const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css' };
        return new Response(contents, { headers: { 'content-type': types[extname(path)] ?? 'text/plain' } });
      } catch {
        return new Response('fixture asset missing', { status: 404 });
      }
    },
  },
  HARNESS: {
    async fetch(req) {
      const url = new URL(req.url);
      const authenticated = req.headers.get('cookie')?.includes('fixture_owner=1') ?? false;
      if (url.pathname === '/api/auth/session') return Response.json({ authenticated });
      if (url.pathname === '/login')
        return new Response('<h1>Fixture login</h1>', { headers: { 'content-type': 'text/html' } });
      if (!authenticated) return new Response('fixture unauthorized', { status: 401 });
      // UI-only migration-controller fixture, not a mock native shell. The real
      // native integration verifies the production shared-frame routing.
      if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/novels/', url)));
      const identity = /^\/api\/novels\/(b-[a-f0-9]{32})\/identity$/.exec(url.pathname);
      if (identity) {
        const root = '/workspace/novels/' + identity[1];
        const book = JSON.parse(files.get(root + '/book.json') ?? '{}');
        return Response.json({ version: 1, id: book.id, root, title: book.title, titleSource: 'receipt' });
      }
      if (url.pathname === '/api/workspace/file') {
        const path = url.searchParams.get('path');
        if (req.method === 'PUT') {
          files.set(path, await req.text());
          return Response.json({ ok: true });
        }
        return files.has(path) ? new Response(files.get(path)) : new Response('missing', { status: 404 });
      }
      if (url.pathname === '/api/workspace/exec') {
        const command = JSON.parse(await req.text()).command;
        const match =
          /^find (\/workspace\/novels\/b-[a-f0-9]{32}) (-type f|! -type f ! -type d) -print0$/.exec(command);
        return Response.json({
          exitCode: 0,
          outputTruncated: false,
          stdout: match
            ? match[2].startsWith('!')
              ? ''
              : [...files.keys()].filter((path) => path.startsWith(match[1] + '/')).join('\0') + '\0'
            : [...files.keys()].filter((path) => path.endsWith('/book.json')).join('\n'),
        });
      }
      return new Response('DSH fixture only; no actual Agent is running.');
    },
  },
};

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const method = req.method ?? 'GET';
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method,
      headers: req.headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    });
    const result = await handleRequest({ request, env, rewriteHtml: (response) => response });
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end('fixture failure');
  }
});

let browser;
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath =
    process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!existsSync(executablePath))
    throw new Error('Existing Edge executable not found; no browser will be downloaded.');
  browser = await chromium.launch({ headless: true, executablePath });
  await verifyAuthUI(browser, root);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.addCookies([{ name: 'fixture_owner', value: '1', url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/novels/');
  await page.getByRole('status').filter({ hasText: '还没有小说' }).waitFor();
  await page.getByLabel('零碎的灵感').fill('一个能听见飞升者求救声的修士');
  await page.getByRole('button', { name: '准备创作' }).click();
  await page.waitForURL((url) => url.pathname === '/' && url.searchParams.has('novel'));
  await page.goto(origin + '/novels/');
  await page.getByRole('heading', { name: '一个能听见飞升者求救声的修士', exact: true }).waitFor();
  const legacy = {
    state: {
      project: { title: '雨城旧稿', setting: '雨夜的旧城' },
      outline: [],
      chapters: [{ chapter: 1, content: '没有被改写的原文。\n第二行。' }],
      chatWindows: [{ messages: [{ content: '旧聊天' }] }],
      chapterSnapshots: [{ content: '旧快照' }],
      agentEditHistory: [{ content: '旧修改' }],
    },
  };
  const input = {
    name: 'old-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  };
  await page.locator('#project-file').setInputFiles(input);
  await page.getByRole('heading', { name: '导入预览' }).waitFor();
  assert.match(await page.locator('#preview-counts').textContent(), /1 章.*1 个聊天窗口.*1 个快照/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('#import-preview').isVisible(), false);
  assert.equal([...files.keys()].filter((path) => path.endsWith('/book.json')).length, 1);
  await page.locator('#project-file').setInputFiles(input);
  await page.getByRole('heading', { name: '导入预览' }).waitFor();
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.getByRole('heading', { name: '雨城旧稿', exact: true }).waitFor();
  assert.equal(await page.locator('.book').count(), 2);
  const receipts = [...files]
    .filter(([path]) => path.endsWith('/book.json'))
    .map(([, text]) => JSON.parse(text));
  const book = receipts.find((item) => item.title === '雨城旧稿');
  assert.equal(files.get(book.root + '/chapters/00001.md'), legacy.state.chapters[0].content);
  const archived = JSON.parse(book.archive.map((path) => files.get(book.root + '/' + path)).join(''));
  assert.deepEqual(archived.state.chatWindows, legacy.state.chatWindows);
  files.set(book.root + '/drafts/后来写的草稿.md', '这是导入以后才写的新稿。');
  let releaseRead, observeRead;
  const heldRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const readStarted = new Promise((resolve) => {
    observeRead = resolve;
  });
  const holdBackupRead = async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.searchParams.get('path') === book.root + '/AGENTS.md') {
      observeRead();
      await heldRead;
    }
    await route.continue().catch(() => {}); // A deliberately cancelled request.
  };
  await page.route('**/api/workspace/file**', holdBackupRead);
  const beforeCancel = files.size;
  await page
    .locator('.book')
    .filter({ has: page.getByRole('heading', { name: '雨城旧稿', exact: true }) })
    .getByRole('button', { name: '备份', exact: true })
    .click();
  await readStarted;
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '备份已停止' }).waitFor();
  releaseRead();
  await page.unroute('**/api/workspace/file**', holdBackupRead);
  assert.equal(files.size, beforeCancel);
  const downloading = page.waitForEvent('download');
  await page
    .locator('.book')
    .filter({ has: page.getByRole('heading', { name: '雨城旧稿', exact: true }) })
    .getByRole('button', { name: '备份', exact: true })
    .click();
  const download = await downloading;
  const backup = await readFile(await download.path(), 'utf8');
  assert.ok(JSON.parse(backup).files.some((file) => file.path === 'drafts/后来写的草稿.md'));
  await page
    .locator('#project-file')
    .setInputFiles({ name: '备份.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await page.getByRole('heading', { name: '恢复预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '恢复为副本', exact: true }).click();
  await page.getByRole('heading', { name: '雨城旧稿（恢复副本）', exact: true }).waitFor();
  assert.equal(await page.locator('.book').count(), 3);
  for (const [width, height, name] of [
    [1280, 900, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${name} horizontal overflow`,
    );
    await page.screenshot({ path: resolve(root, `test-results/cloud-pages-${name}.png`), fullPage: true });
  }
  await page.reload();
  await page.getByRole('heading', { name: '雨城旧稿', exact: true }).waitFor();
  assert.equal(await page.locator('.book').count(), 3);
  assert.deepEqual(errors, []);
  const privateContext = await browser.newContext();
  const unauthenticated = await privateContext.newPage();
  await unauthenticated.goto(origin + '/novels/');
  assert.equal(new URL(unauthenticated.url()).pathname, '/login');
  await privateContext.close();
  console.log(
    'Cloud UI fixture passed: seed, import preview/cancel, upload/readback, backup cancellation/download/restore, refresh, owner redirect and 1280/768/390px layouts. No actual DSH or provider calls.',
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
