// Read-only live migration acceptance. Never prints story text, keys or cookies.
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { verificationTransport } from './verification-transport.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { waitForDeploymentRevision } from './deployment-readiness.mjs';
import { collapsedSidebarGeometry, assertCollapsedSidebar } from '../tests/sidebar-layout-scenario.mjs';
import { waitResponsiveLayout } from '../tests/editor-client.mjs';
const active = JSON.parse(await readFile('data/local-host/active.json', 'utf8'));
const cutover = JSON.parse(await readFile('data/local-host/cutover.json', 'utf8'));
const running = JSON.parse(await readFile('data/local-host/running.json', 'utf8'));
const owner = (await readFile('data/cloud-platform/owner-key.txt', 'utf8')).trim();
const transport = await verificationTransport();
let browser, stage = 'start';
const report = { at: new Date().toISOString(), publicUrl: cutover.source, complete: false, storyWrites: 0, modelCalls: 0, endpoints: [] };
const currentRelease = active.release ? JSON.parse(await readFile(resolve(active.release, 'ui-release.json'), 'utf8')) : null;
const beforeUpdate = active.release ? JSON.parse(await readFile('data/local-host/last-ui-backup.json', 'utf8')) : null;
function assertPreserved(before, after) {
  for (const kind of ['books', 'sessions']) {
    const current = new Set(after[kind]);
    assert.equal(current.size, after[kind].length, 'Native identities are unique.');
    for (const id of before[kind]) assert.ok(current.has(id), 'Pre-update native identity must still exist.');
  }
}
try {
  const origins = [cutover.source, 'http://127.0.0.1:3211', ...running.lanHosts.filter(ip => ip.startsWith('192.168.')).slice(0, 1).map(ip => 'http://' + ip + ':3211')];
  const identities = [];
  for (const origin of origins) {
    stage = origin === cutover.source ? 'public-api' : 'local-api';
    const fetcher = origin.startsWith('https:') ? transport.request : fetch;
    const health = await fetcher(origin + '/api/health', { signal: AbortSignal.timeout(20000) });
    assert.equal(health.status, 200); await health.arrayBuffer();
    if (active.release) await waitForDeploymentRevision(origin, active.revision, fetcher);
    const login = await fetcher(origin + '/api/auth/recover', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey: owner }), signal: AbortSignal.timeout(20000) });
    assert.equal(login.status, 200); await login.arrayBuffer();
    const setCookies = login.headers.getSetCookie(), cookie = setCookies.map(item => item.split(';')[0]).join('; ');
    const get = async path => {
      const response = await fetcher(origin + path, { headers: { cookie }, signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200); return response.json();
    };
    const pin = await get('/api/auth/pin'); assert.equal(pin.authenticated, true); assert.equal(pin.configured, true);
    if (currentRelease?.feature === 'dsh-purge-novel') {
      const plugin = await get('/api/novel-plugins/dsh-purge');
      assert.equal(plugin.installed, true); assert.equal(plugin.enabled, true); assert.equal(plugin.adapter, 'novel-1');
      assert.equal(plugin.warning, undefined);
      report.livePurgeInstalled = true;
    }
    const books = (await get('/api/novels')).books;
    const sessions = await get('/api/sessions?limit=100');
    assert.equal(sessions.hasMore, false);
    assert.ok(books.length >= active.books); assert.ok(sessions.sessions.length >= active.sessions);
    const ids = { books: books.map(b => b.id).sort(), sessions: sessions.sessions.map(s => s.id ?? s.sessionId).sort() };
    if (identities.length) assertPreserved(identities[0], ids); identities.push(ids);
    if (active.release) {
      const backup = JSON.parse(await readFile('data/local-host/last-ui-backup.json', 'utf8'));
      assertPreserved(backup.identities, ids);
      const release = JSON.parse(await readFile(resolve(active.release, 'ui-release.json'), 'utf8'));
      for (const name of ['title-editor.mjs', 'application.mjs', 'application.css', 'manuscript.mjs', 'manuscript.css', 'manuscript-core.mjs', 'chapter-navigation.mjs', 'outline-editor.mjs', ...(['manual-content', 'dsh-purge-novel'].includes(release.feature) ? ['content-management.mjs'] : []), ...(release.feature === 'dsh-purge-novel' ? ['harness-bridge.mjs', 'purge-settings.mjs'] : [])]) {
        const path = 'pages/public/novel-assets/' + name;
        const expected = release.manifest.find(entry => entry.path === path);
        const asset = await fetcher(origin + '/studio/' + active.revision + '/' + path, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
        assert.equal(asset.status, 200);
        assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'), expected.sha256);
      }
    }
    report.endpoints.push({ origin, books: books.length, sessions: sessions.sessions.length, originalPinConfigured: true });
    if (origin === cutover.source) {
      browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: ['--js-flags=--max-old-space-size=192'] });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      await context.addCookies(setCookies.map(header => { const pair = header.split(';')[0], i = pair.indexOf('=');
        return { name: pair.slice(0, i), value: pair.slice(i + 1), url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }; }));
      const page = await context.newPage();
      let frames = 0, errors = 0, modelCalls = 0;
      page.on('pageerror', () => errors++);
      page.on('websocket', socket => { if (socket.url().includes('/api/remote.mux')) socket.on('framereceived', () => frames++); });
      await page.route('**/api/**', route => {
        if (route.request().method() === 'POST' && /\/api\/(?:session[./]prompt|sessions\/[^/]+\/turn)$/.test(new URL(route.request().url()).pathname)) { modelCalls++; return route.abort(); }
        return route.continue();
      });
      stage = 'public-desktop-browser';
      await page.goto(origin + '/?view=library', { timeout: 60000 });
      await page.locator('.novel-library').waitFor({ timeout: 30000 });
      await page.locator('.book .open-book').first().waitFor({ timeout: 30000 });
      assert.equal(await page.title(), '小说工作台');
      assert.equal(await page.locator('.book .open-book').count(), books.length);
      if (active.release) {
        await waitResponsiveLayout(page);
        const nav = page.locator('.novel-studio-sidebar');
        if (await nav.getAttribute('data-wide') === 'true')
          await nav.getByRole('button', { name: '收起导航', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.novel-studio-sidebar')?.dataset.wide === 'false');
        assertCollapsedSidebar(await collapsedSidebarGeometry(page));
        await nav.getByRole('button', { name: '展开导航', exact: true }).click();
        report.liveCollapsedSidebar = true;
      }
      stage = 'public-mobile-browser';
      await page.setViewportSize({ width: 390, height: 844 });
      await waitResponsiveLayout(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      let chapterBook;
      if (['manual-content', 'dsh-purge-novel'].includes(currentRelease?.feature)) {
        // Choose a real book which actually contains prose, using metadata
        // only. Opening an empty first card cannot prove chapter controls.
        for (const book of books) {
          const catalog = await get('/api/novels/' + book.id + '/documents');
          if (catalog.documents.some(doc => doc.category === 'chapter')) { chapterBook = book.id; break; }
        }
        report.chapterBookAvailable = !!chapterBook;
      }
      await (chapterBook ? page.locator('.book[data-book-id="' + chapterBook + '"] .open-book') : page.locator('.book .open-book').first()).click();
      await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.title(), '小说工作台');
      if (['unified-writing', 'manual-content', 'dsh-purge-novel'].includes(currentRelease?.feature)) {
        // The region mounts before its catalog; a tab click before catalog
        // readiness is not an actual navigation. This control shares that owner.
        await page.getByRole('button', { name: '修改书名', exact: true }).waitFor({ timeout: 30000 });
        await page.getByRole('button', { name: '正文', exact: true }).click();
        // Reading intentionally folds the entire author dock. Open its real
        // assistant entry before checking a control inside that hidden dock.
        await page.getByRole('button', { name: '创作助手', exact: true }).click();
        const shortcuts = page.locator('.novel-author-shortcuts');
        if (await shortcuts.isVisible() && !(await shortcuts.evaluate(node => node.open)))
          await shortcuts.locator(':scope > summary').click();
        assert.equal(await page.getByRole('button', { name: '按想法改写', exact: true }).count(), 0);
        const writingEntry = page.getByRole('button', { name: '写作', exact: true });
        try { await writingEntry.waitFor({ state: 'visible', timeout: 30000 }); }
        catch {
          const state = await page.evaluate(() => ({
            dockHidden: document.querySelector('.novel-author-dock')?.hidden,
            assistant: document.querySelector('.novel-desk')?.dataset.assistant,
            shortcutsOpen: document.querySelector('.novel-author-shortcuts')?.open,
            actionGroups: document.querySelectorAll('.novel-ms-ai').length,
            actionButtons: [...document.querySelectorAll('.novel-ms-ai button')].map(node => ({ label: node.textContent.trim(), visible: !!node.getClientRects().length })),
            outlinePanels: document.querySelectorAll('.novel-outline-editor').length,
          }));
          throw new Error('Writing entry UI state: ' + JSON.stringify(state));
        }
        report.liveUnifiedWritingEntry = true;
        assert.equal(active.bookStorageFingerprintVerified, true);
        report.allBookFilesUnchangedAtRestart = true;
        await page.getByRole('button', { name: '返回书稿', exact: true }).click();
      }
      if (['manual-content', 'dsh-purge-novel'].includes(currentRelease?.feature)) {
        stage = 'live-manual-content-controls';
        await page.getByRole('button', { name: '大纲', exact: true }).click();
        await page.getByRole('button', { name: '清空章节大纲', exact: true }).waitFor();
        // Navigation and metadata-only list reads; never confirm a destructive
        // action or restore any version in the user's actual books.
        await page.getByRole('button', { name: '回收与恢复', exact: true }).click();
        const recovery = page.getByRole('region', { name: '回收与恢复', exact: true });
        await recovery.waitFor();
        await recovery.getByRole('button', { name: '返回书稿', exact: true }).click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: '正文', exact: true }).click();
        const options = page.getByRole('button', { name: '文稿选项', exact: true });
        if (report.chapterBookAvailable) await options.waitFor({ state: 'visible', timeout: 30000 });
        if (await options.isVisible()) {
          await options.click();
          const chapterDelete = page.getByRole('button', { name: '删除本章', exact: true });
          if (report.chapterBookAvailable) await chapterDelete.waitFor({ state: 'visible', timeout: 30000 });
          if (await chapterDelete.count()) {
            assert.equal(await chapterDelete.isVisible(), true);
            assert.equal(await page.getByRole('button', { name: '清空正文', exact: true }).isVisible(), true);
            report.liveChapterManagementControls = true;
          }
          await options.click();
        }
        report.liveManualContentControls = true;
        if (report.chapterBookAvailable) assert.equal(report.liveChapterManagementControls, true, 'Actual chapter management controls must be visible.');
      }
      if (active.release) {
        await page.getByRole('button', { name: '修改书名', exact: true }).click();
        const form = page.getByRole('form', { name: '修改书名', exact: true });
        await form.waitFor();
        const field = form.getByRole('textbox', { name: '书名', exact: true });
        const bounds = await field.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        await form.getByRole('button', { name: '取消', exact: true }).click();
        await page.getByRole('button', { name: '展开导航', exact: true }).click();
        const navigation = page.getByRole('complementary', { name: '创作导航', exact: true });
        assert.ok(await navigation.getByRole('button', { name: '修改对话标题', exact: true }).count());
        const rename = navigation.getByRole('button', { name: '修改对话标题', exact: true }).first();
        if (await rename.isEnabled()) {
          await rename.click();
          await navigation.getByRole('textbox', { name: '对话标题', exact: true }).waitFor();
          assert.equal(await navigation.isVisible(), true);
          await navigation.getByRole('textbox', { name: '对话标题', exact: true }).press('Escape');
        }
        const center = await page.locator('.novel-native-center-column').boundingBox();
        assert.equal(center.width, 390);
        await page.locator('.novel-navigation-scrim').click({ position: { x: 10, y: 200 } });
        assert.equal(await navigation.isVisible(), false);
        report.liveMobileNavigationOverlay = true;
        report.liveManualTitleControls = true;
      }
      if (currentRelease?.feature === 'dsh-purge-novel') {
        await page.getByRole('button', { name: '展开导航', exact: true }).click();
        await page.locator('.novel-studio-settings').getByRole('button', { name: '设置', exact: true }).click();
        const plugin = page.getByRole('region', { name: 'dsh-purge 插件设置', exact: true });
        await plugin.getByRole('button', { name: '立即停用', exact: true }).waitFor({ timeout: 30000 });
        assert.equal(await plugin.getByRole('checkbox', { name: '启用 dsh-purge 小说提示词', exact: true }).isChecked(), true);
        await page.keyboard.press('Escape');
        await plugin.waitFor({ state: 'hidden' });
        report.livePurgeControls = true;
      }
      await page.reload();
      await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor({ timeout: 30000 });
      assert.equal(modelCalls, 0); assert.equal(errors, 0); assert.ok(frames > 0, 'Native WebSocket must receive data across the live relay.');
      report.publicDesktopAndMobile = true; report.publicRefresh = true; report.liveNativeWebSocket = true; report.browserErrors = errors;
      await browser.close(); browser = null;
    }
  }
  report.baselineBookAndSessionIdsPreserved = true; report.complete = true;
  cutover.verifiedAt ??= new Date().toISOString(); cutover.lastVerifiedAt = new Date().toISOString(); cutover.publicVerified = true; cutover.localIsSoleOwner = true;
  if (active.release) {
    report.uiRevision = active.revision; report.beforeNativeIdentitiesPreserved = true; report.liveUiAssetHashesMatched = true;
    const latest = identities.at(-1);
    report.newBooksSinceBackup = latest.books.length - beforeUpdate.identities.books.length;
    report.newSessionsSinceBackup = latest.sessions.length - beforeUpdate.identities.sessions.length;
    report.beforeAfterNativeIdentitiesUnchanged = report.newBooksSinceBackup === 0 && report.newSessionsSinceBackup === 0;
  }
  await writeFile('data/local-host/cutover.json', JSON.stringify(cutover, null, 2), { mode: 0o600 });
} catch (error) { report.failedStage = stage; report.errorType = error.name; report.diagnostic = String(error.message).replaceAll(owner, '[redacted]').slice(0, 300); process.exitCode = 1; }
finally {
  await browser?.close(); await transport.close();
  await writeFile('data/local-host/live-verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
