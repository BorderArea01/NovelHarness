// Operate only the deployment this project owns. No story import, prompt
// submission, provider key, or user draft modification in the deployed instance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { verificationTransport } from '../scripts/verification-transport.mjs';
import { clickSidebarEntry } from './editor-client.mjs';
import { visibleViewportFixture } from './visible-viewport-fixture.mjs';
import { contrast } from './control-contrast.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const state = JSON.parse(await readFile(resolve(root, 'data/cloud-platform/deployment.json'), 'utf8'));
if (state.currentUi?.revision) state.uploadedRevision = state.currentUi.revision;
if (
  state.format !== 'novel-harness-deployment-v1' ||
  state.status !== 'verified' ||
  state.url !== `https://${state.pagesProject}.pages.dev`
)
  throw new Error('No verified, owned deployment is available.');
const ownerKey = (await readFile(resolve(root, 'data/cloud-platform/owner-key.txt'), 'utf8')).trim();
const redact = (value) =>
  String(value)
    .replaceAll(ownerKey, '[owner-key-redacted]')
    .replace(/(cookie:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(
      /((?:__Host-dsh_edge_owner|__Host-novel_pin|dsh_edge_owner|novel_pin)=)[^;\s"']+/g,
      '$1[redacted]',
    );
let browser, transport;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--js-flags=--max-old-space-size=192'],
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    globalThis.__privacyTitleViolations = 0;
    new MutationObserver(() => {
      if (location.pathname === '/' && document.title && document.title !== '小说工作台')
        globalThis.__privacyTitleViolations++;
    }).observe(document, { subtree: true, childList: true, characterData: true });
    globalThis.__publicSettingsLifecycle = [];
    const transitions = (globalThis.__publicStartupTransitions = []);
    const replace = history.replaceState;
    history.replaceState = function (...args) {
      const next = new URL(args[2] ?? location.href, location.href);
      if (transitions.length < 50)
        transitions.push({
          at: Math.round(performance.now()),
          kind: 'address',
          view: next.searchParams.get('view'),
          settings: next.searchParams.has('settings'),
          caller: new Error().stack?.split('\n').slice(2, 5).join('\n'),
        });
      return Reflect.apply(replace, this, args);
    };
    let previous;
    const observer = new MutationObserver(() => {
      const snapshot = {
        settings: !!document.querySelector('[data-shortcut-modal="settings"]'),
        manuscript: !!document.querySelector('.novel-manuscript[data-book-id]'),
        library: !!document.querySelector('#new-book'),
        drawer: document.querySelector('.novel-native-sidebar-column')?.getAttribute('aria-modal'),
        later: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '稍后配置'),
        addProvider: [...document.querySelectorAll('button')].some(
          (b) => b.textContent.trim() === '添加模型提供商',
        ),
        view: new URL(location.href).searchParams.get('view'),
        settingsQuery: new URL(location.href).searchParams.has('settings'),
        lastView: sessionStorage.getItem('novel-last-view'),
      };
      const key = JSON.stringify(snapshot);
      if (key !== previous && globalThis.__publicSettingsLifecycle.length < 50) {
        globalThis.__publicSettingsLifecycle.push({ at: Math.round(performance.now()), ...snapshot });
        previous = key;
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true });
  });
  const page = await context.newPage();
  const errors = [],
    modelPosts = [],
    sockets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/(?:session[./]prompt|sessions\/[^/]+\/turn)$/.test(new URL(request.url()).pathname)
    )
      modelPosts.push(request.url());
  });
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto(state.url + '/novels/', { timeout: 60000 });
  assert.equal(new URL(page.url()).pathname, '/login');
  await page.locator('#loading').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: /^(欢迎回来|首次使用)$/ }).waitFor();
  assert.ok(await page.locator('#login-form:visible,#bootstrap:visible').count());
  const firstUseFlowAssetsAvailable = await page.evaluate(
    () =>
      !!document.querySelector('#setup-form') &&
      document.querySelectorAll('[data-step]').length === 2 &&
      !!document.querySelector('[data-reveal="bootstrap-key"]') &&
      document.querySelector('#bootstrap-hint')?.textContent.includes('不是 PIN'),
  );
  assert.equal(firstUseFlowAssetsAvailable, true);
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-pin-login-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-pin-login-mobile.png'),
    fullPage: true,
  });
  // Recovery login authenticates this audit without selecting/changing the
  // owner's personal PIN. Neither the key nor response cookies are logged.
  // Playwright's APIRequestContext does not inherit Windows' system proxy like
  // the browser does. Reuse the bounded, TLS-verified deployment transport.
  transport = await verificationTransport();
  const login = await transport.request(state.url + '/api/auth/recover', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { origin: state.url, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: ownerKey }),
  });
  assert.equal(login.status, 200);
  await login.arrayBuffer();
  const signedCookies = login.headers.getSetCookie().map((header) => {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim());
    const equals = pair.indexOf('='),
      name = pair.slice(0, equals),
      value = pair.slice(equals + 1);
    assert.ok(['__Host-dsh_edge_owner', '__Host-novel_pin'].includes(name));
    for (const expected of ['httponly', 'secure', 'samesite=strict', 'path=/'])
      assert.ok(attributes.some((item) => item.toLowerCase() === expected));
    const maxAge = Number(attributes.find((item) => /^max-age=/i.test(item))?.split('=')[1]);
    assert.ok(maxAge > 0 && maxAge <= 30 * 24 * 60 * 60);
    return {
      name,
      value,
      url: state.url,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      expires: Date.now() / 1000 + maxAge,
    };
  });
  assert.equal(signedCookies.length, 2);
  await context.addCookies(signedCookies);
  await page.goto(state.url + '/account/');
  await page.locator('#pin-form').waitFor();
  const accountPreview = page.getByRole('button', { name: '继续', exact: true });
  if (await accountPreview.isVisible()) await accountPreview.click();
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-pin-account-mobile.png'),
    fullPage: true,
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const pinState = await page.evaluate(async () => (await fetch('/api/auth/pin')).json());
  assert.equal(pinState.authenticated, true);
  await page.evaluate(() => {
    window.novelFrameAudit = 'shared-public-frame';
  });
  await page.getByRole('link', { name: '← 小说库', exact: true }).click();
  await page.locator('#new-book').waitFor();
  assert.equal(await page.evaluate(() => window.novelFrameAudit), 'shared-public-frame');
  await page.getByText('导入 / 恢复', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(async () => (await import('/novel-assets/backup.mjs')).BACKUP_FORMAT),
    'novel-harness-workspace-backup-v1',
  );
  await page
    .getByRole('status')
    .filter({ hasText: /本小说|还没有小说/ })
    .waitFor();
  // Normal reload, no request interception or model call. Check actual browser
  // resource timing, not merely Cache-Control headers or a mocked cache.
  const reloadStarted = Date.now();
  await page.reload();
  await page.locator('#new-book').waitFor();
  await page
    .getByRole('status')
    .filter({ hasText: /本小说|还没有小说/ })
    .waitFor();
  const publicWarmReloadMs = Date.now() - reloadStarted;
  const releaseCache = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource').filter((r) => r.name.includes('/studio/'));
    return {
      resources: resources.length,
      hits: resources.filter((r) => r.transferSize === 0 && r.decodedBodySize > 0).length,
    };
  });
  assert.ok(releaseCache.resources >= 30);
  assert.equal(
    releaseCache.hits,
    releaseCache.resources,
    'Warm public reload must actually reuse the release module graph.',
  );
  const signed = (await context.cookies()).find((cookie) => cookie.name === '__Host-dsh_edge_owner');
  assert.equal(signed?.httpOnly, true);
  assert.equal(signed?.secure, true);
  assert.equal(signed?.sameSite, 'Strict');
  let mobileOverlayDismissalVerified = false,
    mobileFullWidthVerified = false;
  let publicControlAffordancesVerified = false;
  for (const [width, height, name] of [
    [1280, 900, 'desktop'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (name === 'mobile') {
      await page.locator('.novel-native-frame[data-novel-narrow]').waitFor();
      const before = await page.locator('.novel-library').boundingBox();
      assert.ok(Math.abs(before.width - width) < 1 && Math.abs(before.x) < 1);
      mobileFullWidthVerified = true;
      for (const label of ['展开导航', '＋ 新建小说']) {
        const appearance = await page
          .getByRole('button', { name: label, exact: true })
          .evaluate((element) => {
            const s = getComputedStyle(element),
              r = element.getBoundingClientRect();
            return {
              width: r.width,
              height: r.height,
              border: parseFloat(s.borderTopWidth),
              text: s.color,
              background: s.backgroundColor,
            };
          });
        assert.ok(appearance.width >= 44 && appearance.height >= 44 && appearance.border >= 1);
        assert.ok(
          contrast(appearance.text, appearance.background) >= 4.5,
          'Public phone control contrast: ' + label,
        );
      }
      publicControlAffordancesVerified = true;
      await page.getByRole('button', { name: '展开导航', exact: true }).click();
      const scrim = page.getByRole('button', { name: '关闭导航', exact: true });
      await scrim.waitFor();
      const after = await page.locator('.novel-library').boundingBox();
      assert.ok(Math.abs(before.width - after.width) < 2);
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-public-mobile-navigation.png'),
        fullPage: true,
      });
      await scrim.click();
      await scrim.waitFor({ state: 'hidden' });
      mobileOverlayDismissalVerified = true;
    }
    await page.screenshot({
      path: resolve(root, `test-results/cloud-public-library-${name}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Switch only this isolated verification tab's local view preference. No book
  // or paid prompt is created; the native restoration policy owns the session.
  await page.evaluate(() => sessionStorage.setItem('novel-last-view', 'book'));
  await page.goto(state.url + '/');
  await page.waitForURL((url) => url.pathname === '/');
  await page.waitForFunction(() => getComputedStyle(document.body).colorScheme.includes('dark'), null, {
    timeout: 30000,
  });
  const previewContinue = page.getByRole('button', { name: '继续', exact: true });
  if (await previewContinue.isVisible()) {
    await previewContinue.click();
    await previewContinue.waitFor({ state: 'hidden' });
  }
  await page.getByRole('main', { name: '小说创作工作台', exact: true }).waitFor();
  assert.ok(sockets.some((url) => url.includes('/api/remote.mux')));
  assert.equal(modelPosts.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-native-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-native-mobile.png'),
    fullPage: true,
  });
  // The upstream no-key onboarding can arrive after its composer is ready.
  // Dismiss only its explicit "later" action while reaching the launcher; never
  // fill credentials, save settings or force-click through an unknown overlay.
  const later = page.getByRole('button', { name: '稍后配置', exact: true });
  await page.addLocatorHandler(previewContinue, async () => {
    await previewContinue.click();
  });
  await page.addLocatorHandler(later, async () => {
    await later.click();
  });
  await clickSidebarEntry(page, 'button', '模型设置', { trial: true });
  await page.removeLocatorHandler(later);
  await page.removeLocatorHandler(previewContinue);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const modelSettings = page.getByRole('dialog', { name: '设置', exact: true });
  await modelSettings.waitFor();
  assert.equal(
    await modelSettings.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
    'true',
  );
  await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-models-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-models-desktop.png'),
    fullPage: true,
  });
  await modelSettings.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('main', { name: '小说创作工作台', exact: true }).waitFor();
  // Geometry only: never read or edit the personal manuscript/input contents.
  const publicReadingLayout = [];
  if (await page.locator('.novel-manuscript').count()) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.novel-desk-heading-host .novel-ms-heading').waitFor();
      const geometry = await page.evaluate(() => {
        const desk = document.querySelector('.novel-desk'),
          header = document.querySelector('.novel-desk-bar').getBoundingClientRect(),
          body = document.querySelector('.novel-ms-body').getBoundingClientRect();
        return {
          width: innerWidth,
          headerHeight: header.height,
          bodyRatio: body.height / innerHeight,
          headingCount: document.querySelectorAll('.novel-ms-heading').length,
          running: desk.dataset.running === 'true',
          pending: document.querySelector('.novel-author-dock')?.dataset.pendingInteraction === 'true',
        };
      });
      assert.ok(geometry.headerHeight <= 60);
      assert.equal(geometry.headingCount, 1);
      if (!geometry.running && !geometry.pending) assert.ok(geometry.bodyRatio >= 0.6);
      publicReadingLayout.push(geometry);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await clickSidebarEntry(page, 'button', '设置');
  await page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
  const addProvider = await page.getByRole('button', { name: '添加模型提供商', exact: true }).boundingBox();
  assert.ok(
    addProvider && addProvider.width > 240 && addProvider.x + addProvider.width <= 390,
    'Mobile model controls must be fully readable, not merely clipped inside an overflow container.',
  );
  await page.screenshot({
    path: resolve(root, 'test-results/cloud-public-settings-mobile.png'),
    fullPage: true,
  });
  const { visibleViewport, restoreViewport } = visibleViewportFixture(page);
  let mobileSettingsVisibleBoundsVerified = false;
  try {
    await visibleViewport(320, 18);
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-shortcut-modal="settings"]')?.getBoundingClientRect();
      return panel && panel.top >= 18 && panel.bottom <= 338;
    });
    const close = await page
      .getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .boundingBox();
    assert.ok(
      close && close.width >= 44 && close.height >= 44 && close.y >= 18 && close.y + close.height <= 338,
    );
    await page.screenshot({ path: resolve(root, 'test-results/cloud-public-settings-visible-viewport.png') });
    mobileSettingsVisibleBoundsVerified = true;
  } finally {
    await restoreViewport();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await clickSidebarEntry(page, 'link', '小说库');
  await page.goto(state.url + '/?settings=models');
  await modelSettings.waitFor();
  assert.equal(
    await modelSettings.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'),
    'true',
  );
  await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor();
  await page.waitForURL((url) => !url.searchParams.has('settings'));
  await modelSettings.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('#new-book').waitFor();
  assert.equal(modelPosts.length, 0);
  assert.deepEqual(errors, []);
  const restoredPromptTemplatesAvailable = await page.evaluate(async () => {
    const response = await fetch('/api/novel-prompt-templates', { credentials: 'same-origin' });
    if (!response.ok) return false;
    const data = await response.json();
    return (
      data.version === 1 &&
      ['outline', 'write', 'outlineContinue', 'deai', 'ending'].every(
        (key) => typeof data.defaults?.[key] === 'string' && data.defaults[key].length > 100,
      )
    );
  });
  assert.equal(restoredPromptTemplatesAvailable, true);
  const studioShellAssets = await page.evaluate(async () => {
    const modules = await Promise.all([
      fetch('/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js').then((r) => r.text()),
      fetch('/plugins/@deepseek-ai/dsh-client-ui-sidebar/client.js').then((r) => r.text()),
    ]);
    return (
      modules[0].includes('conversation: renderSlot("main.conversation", {})') &&
      modules[0].includes('"novel.workspace"') &&
      modules[0].includes('this.rootCtx.emit("novel/input-submitted"') &&
      modules[0].includes(
        'renderSlot("novel.composer", { composer: composerSeat }, { fallback: composerSeat })',
      ) &&
      modules[0].includes('"input.send": "发送并讨论"') &&
      modules[1].includes('"novel.navigation"') &&
      modules.every((source) => source.includes('Copyright (c) 2026 DeepSeek')) &&
      document.querySelectorAll('.novel-studio-sidebar').length === 1
    );
  });
  assert.equal(studioShellAssets, true);
  const nativeComposerDockAssetsAvailable = await page.evaluate(async () => {
    const [application, bridge] = await Promise.all([
      fetch('/novel-assets/application.mjs').then((response) => response.text()),
      fetch('/novel-assets/harness-bridge.mjs').then((response) => response.text()),
    ]);
    return (
      application.includes("createPortal(composer, host, 'native-novel-composer')") &&
      application.includes("ctx.on('novel/input-submitted'") &&
      application.includes("'创作要求与操作'") &&
      bridge.includes("require('react-dom').createPortal")
    );
  });
  assert.equal(nativeComposerDockAssetsAvailable, true);
  const legacyEntries = [];
  const auditCookie = (await context.cookies(state.url))
    .map(({ name, value }) => name + '=' + value)
    .join('; ');
  for (const path of ['/index.html', '/novels/index.html', '/account/index.html']) {
    let current = state.url + path,
      complete = false;
    const statuses = [];
    for (let hop = 0; hop < 5; hop++) {
      const response = await transport.request(current, {
        redirect: 'manual',
        headers: { cookie: auditCookie },
        signal: AbortSignal.timeout(20000),
      });
      const status = response.status;
      statuses.push(status);
      if ([301, 302, 303, 307, 308].includes(status)) {
        // Cloudflare may canonicalize /index.html before our 302. Check the
        // entire same-origin chain, not one assumed redirect status code.
        const next = new URL(response.headers.get('location'), current);
        assert.equal(next.origin, state.url);
        assert.ok(['/', '/novels', '/novels/', '/account', '/account/'].includes(next.pathname));
        current = next.href;
      } else {
        assert.ok([200, 404].includes(status), 'Unexpected legacy response: ' + path + ' ' + status);
        if (status === 200) {
          const html = await response.text();
          assert.ok(
            html.includes('/novel-assets/harness-boot.mjs') && html.includes(state.uploadedRevision),
            'Legacy path exposed an unadapted HTML shell: ' + path,
          );
        }
        complete = true;
      }
      if (!response.bodyUsed) await response.arrayBuffer();
      if (complete) break;
    }
    assert.equal(complete, true, 'Legacy canonicalization must be bounded.');
    legacyEntries.push({ path, statuses, unified: true });
  }
  const verifiedUiSourceHashes = {};
  for (const name of [
    'manuscript.mjs',
    'chapter-navigation.mjs',
    'outline-editor.mjs',
    'manuscript.css',
    'application.css',
    'application.mjs',
    'conversation-reset.mjs',
    'studio-theme.mjs',
    'proposal-tool-view.mjs',
    'task-message.mjs',
    'writing-run-panel.mjs',
    'writing-run-core.mjs',
    'canon-review.mjs',
    'prose-editor.mjs',
    'editor-text.mjs',
    'native-shell/layout.js',
    'harness-navigation.css',
    'visual-viewport.mjs',
    'harness-navigation.mjs',
    'harness-boot.mjs',
    'harness-bridge.mjs',
    'workspace.mjs',
    'studio.mjs',
    'bridge-core.mjs',
    'manuscript-core.mjs',
    'book-sync.mjs',
    'backup.mjs',
    'outline-editor.mjs',
    'auth-assets/auth.css',
    'native-shell/settings.js',
  ]) {
    const relative = /^(native-shell|auth-assets)\//.test(name) ? name : 'novel-assets/' + name;
    const route = name.startsWith('native-shell/')
      ? '/plugins/@deepseek-ai/dsh-client-ui-' +
        (name === 'native-shell/settings.js' ? 'settings-general' : 'layout') +
        '/client.js'
      : '/' + relative;
    const actual = await page.evaluate(async (route) => {
      const response = await fetch(route, { cache: 'no-store' });
      if (!response.ok) throw new Error('Public UI source could not be verified.');
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    }, route);
    assert.equal(
      actual,
      createHash('sha256')
        .update(await readFile(resolve(root, 'cloud/pages/public', relative)))
        .digest('hex'),
    );
    verifiedUiSourceHashes[name] = actual;
  }
  const manuscriptSourceHash = verifiedUiSourceHashes['manuscript.mjs'];
  assert.equal(await page.title(), '小说工作台');
  assert.equal(await page.evaluate(() => globalThis.__privacyTitleViolations), 0);
  const lightweightRevisionRouteVerified = await page.evaluate(async () => {
    // Use a real catalog identity, but never request its manuscript contents.
    // Worker and singleton DO code may propagate at different times. Retry only
    // the known old-operation response, bounded, without uploads or restarts.
    const catalogResponse = await fetch('/api/novels');
    if (!catalogResponse.ok) return false;
    const catalog = await catalogResponse.json();
    if (!catalog.books?.length) return false;
    const deadline = Date.now() + 180000;
    while (true) {
      const response = await fetch('/api/novels/' + catalog.books[0].id + '/changes');
      const value = await response.json();
      if (response.ok) return typeof value.revision === 'string' && /^vfs:\d+:/.test(value.revision);
      if (response.status !== 400 || value.error !== '未知书稿操作。' || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  });
  assert.equal(lightweightRevisionRouteVerified, true);
  const result = {
    browserTitlePrivacyVerified: true,
    lightweightRevisionRouteVerified,
    revisionSyncAndBackupUiSourcesVerified: true,
    publicReadingLayout,
    publicControlAffordancesVerified,
    publicWarmReloadMs,
    releaseCache,
    manuscriptSourceHash,
    manuscriptSourceMatchesVerifiedTree: true,
    manuscriptUiSourcesMatchVerifiedTree: true,
    mobileFullWidthVerified,
    mobileSettingsVisibleBoundsVerified,
    modelEntriesAndDeepLinkUseSameNativeSettings: true,
    verifiedUiSourceHashes,
    url: state.url,
    revision: state.uploadedRevision,
    restoredPromptTemplatesAvailable,
    httpsOwnerCookie: true,
    firstUseFlowAssetsAvailable,
    loginLandsInLibrary: true,
    nativeWebSocketObserved: true,
    nativeConversationMounted: (await page.locator('[data-conversation-content]').count()) > 0,
    nativeComposerVisible: await page
      .locator('[contenteditable="true"]:not(.cm-content)')
      .first()
      .isVisible(),
    studioShellAssets,
    nativeComposerDockAssetsAvailable,
    visualViewportLayoutAssetsAvailable: await page.evaluate(async () => {
      const { visibleViewport, bindVisibleViewport } = await import('/novel-assets/visual-viewport.mjs');
      const window = {
        innerWidth: 390,
        innerHeight: 844,
        visualViewport: { height: 320, offsetTop: 18, scale: 1 },
      };
      const box = visibleViewport(window);
      window.visualViewport.scale = 2;
      return (
        box.height === 320 &&
        box.top === 18 &&
        visibleViewport(window) === null &&
        typeof bindVisibleViewport === 'function'
      );
    }),
    mobileOverlayDismissalVerified,
    documentHistoryAssetsAvailable: await page.evaluate(async () => {
      const { historyFrameMatches, createDocumentHistory } =
        await import('/novel-assets/document-history.mjs');
      const document = { path: 'chapters/public-asset-check.md', hash: 'a'.repeat(64) };
      return (
        typeof createDocumentHistory === 'function' &&
        historyFrameMatches(document, 'synthetic', { ...document, text: 'synthetic' }) &&
        !historyFrameMatches(document, 'new input', { ...document, text: 'synthetic' })
      );
    }),
    historyPaginationAssetsAvailable: await page.evaluate(async () => {
      const { mergeHistoryPage } = await import('/novel-assets/document-history.mjs');
      const first = mergeHistoryPage(
        { version: { text: 'synthetic read-only preview' } },
        {
          versions: [{ hash: '2'.repeat(64), updatedAt: 2 }],
          hasMore: true,
          nextCursor: 'synthetic-cursor',
        },
      );
      const last = mergeHistoryPage(
        first,
        {
          versions: [{ hash: '1'.repeat(64), updatedAt: 1 }],
          hasMore: false,
          nextCursor: null,
        },
        first.nextCursor,
      );
      return (
        last.versions.length === 2 &&
        last.version === first.version &&
        last.nextCursor === null &&
        !last.hasMore
      );
    }),
    legacyEntries,
    nativeModelSettings: true,
    libraryReturnAndModelDeepLink: true,
    backupAssetAvailable: true,
    productionBackupWritesTested: false,
    unifiedApplicationFrame: true,
    manuscriptAssetAvailable: await page.evaluate(
      async () => (await import('/novel-assets/manuscript-core.mjs')).changedLines('a', 'b').after[0] === 'b',
    ),
    importRecordsAvailable: await page.evaluate(async () => {
      const { makeBookBundle } = await import('/novel-assets/bundle.mjs');
      const { loadImportRecords, recordText, importReference } =
        await import('/novel-assets/import-records.mjs');
      const { createImportRecords } = await import('/novel-assets/import-records-view.mjs');
      const { manifest, files } = await makeBookBundle({
        state: {
          project: { title: 'Read-only synthetic archive check' },
          outline: [],
          chapters: [],
          chatWindows: [
            {
              name: 'Synthetic prior discussion',
              messages: [{ role: 'user', content: 'Historical material, not canon.' }],
            },
          ],
          chapterSnapshots: [{ chapter: 1, content: 'Synthetic old draft.' }],
          operationLogs: [{ message: 'Synthetic save.' }],
          agentEditHistory: [{ patches: [{ before: 'A', after: 'B' }] }],
        },
      });
      const encoder = new TextEncoder();
      const memory = new Map(
        files.map((file) => [manifest.root + '/' + file.path, encoder.encode(file.content)]),
      );
      memory.set(manifest.root + '/book.json', encoder.encode(JSON.stringify(manifest)));
      const archive = await loadImportRecords(manifest.id, async (path) => memory.get(path));
      return (
        typeof createImportRecords === 'function' &&
        archive.records.length === 4 &&
        recordText(archive.records[0]).includes('Historical material, not canon.') &&
        importReference(archive, archive.records[0]).includes('/state/chatWindows/0')
      );
    }),
    scopedProposalDeliveryAvailable: await page.evaluate(async () => {
      const { proposalPrompt } = await import('/novel-assets/manuscript-core.mjs');
      const { installProposalToolViews, proposalToolModel } =
        await import('/novel-assets/proposal-tool-view.mjs');
      const make = (id) =>
        proposalPrompt(
          { root: '/workspace/novels/b-' + 'a'.repeat(32) },
          { path: 'chapters/1.md' },
          { id, draft: 'drafts/test.md' },
          '修改当前章节',
          'write',
        );
      const prompt = JSON.parse(make('12345678-1234-1234-1234-123456789abc'));
      let rejectsInvalidId = false;
      try {
        make('../other-book');
      } catch {
        rejectsInvalidId = true;
      }
      return (
        typeof installProposalToolViews === 'function' &&
        proposalToolModel('novel_proposal_submit', {
          phase: 'preparing',
          args: { text: () => '合成的流式文字' },
        }).content === '合成的流式文字' &&
        rejectsInvalidId &&
        prompt.request === '修改当前章节' &&
        prompt.proposal_id === '12345678-1234-1234-1234-123456789abc' &&
        !Object.hasOwn(prompt, 'executionPrompt')
      );
    }),
    sharedNativeWritingContractAvailable: await page.evaluate(async () => {
      const canonical = await import('/worker/shared/writing-prompts.mjs');
      const browser = await import('/novel-assets/manuscript-core.mjs');
      const outline = await import('/novel-assets/outline-core.mjs');
      const { proposalToolModel } = await import('/novel-assets/proposal-tool-view.mjs');
      return (
        canonical.proposalPrompt === browser.proposalPrompt &&
        canonical.outlinePrompt === outline.outlinePrompt &&
        proposalToolModel('novel_proposal_submit', {
          kind: 'tool-result',
          content: [{ type: 'text', text: '{"saved":true,"published":true}' }],
        }).label === '已保存到书稿'
      );
    }),
    unifiedAuthoringAssetsAvailable: await page.evaluate(async () => {
      const { studioTokens, installStudioTheme } = await import('/novel-assets/studio-theme.mjs');
      const { resetBookConversation } = await import('/novel-assets/conversation-reset.mjs');
      return (
        typeof installStudioTheme === 'function' &&
        typeof resetBookConversation === 'function' &&
        studioTokens()['--dsw-alias-bg-base'].dark === '#151619' &&
        studioTokens()['--dsw-alias-bg-base'].light === '#f5f5f7'
      );
    }),
    nativeConversationPreviewRecoveryAssetsAvailable: await page.evaluate(async () => {
      const { currentProposalCalls, observeProposalPresentation } =
        await import('/novel-assets/proposal-presentation.mjs');
      const block = {
        callId: 'synthetic-public-observer',
        name: 'novel_proposal_submit',
        phase: 'preparing',
        args: { text: () => '合成预览' },
      };
      const calls = currentProposalCalls({
        timeline: { turnOrder: [8] },
        locations: { getTurn: () => ['current'] },
        nodes: { get: () => ({ kind: 'tool-call', data: { root: block } }) },
      });
      return (
        typeof observeProposalPresentation === 'function' &&
        calls.length === 1 &&
        calls[0].block === block &&
        calls[0].turn === 8
      );
    }),
    availableWorkspaceContainerLayoutVerified: await page.evaluate(async () => {
      const desk = document.createElement('main');
      desk.className = 'novel-desk';
      desk.dataset.assistant = 'open';
      desk.dataset.hasBook = 'true';
      desk.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:300px;';
      const panes = document.createElement('div');
      panes.className = 'novel-desk-panes';
      const writing = document.createElement('div');
      writing.className = 'novel-desk-writing';
      const assistant = document.createElement('aside');
      assistant.className = 'novel-desk-assistant';
      panes.append(writing, assistant);
      desk.append(panes);
      document.body.append(desk);
      try {
        await new Promise(requestAnimationFrame);
        const narrow =
          getComputedStyle(writing).display === 'none' && assistant.getBoundingClientRect().width >= 798;
        desk.style.width = '1200px';
        await new Promise(requestAnimationFrame);
        return (
          narrow &&
          getComputedStyle(writing).display !== 'none' &&
          writing.getBoundingClientRect().width >= 650
        );
      } finally {
        desk.remove();
      }
    }),
    continuationAppendScopeAvailable: await page.evaluate(async () => {
      const { writingEdit, proposalPrompt } = await import('/novel-assets/manuscript-core.mjs');
      const scope = writingEdit({ text: '原稿' }, 'continue');
      const prompt = proposalPrompt(
        { root: '/workspace/synthetic' },
        { path: 'chapters/test.md' },
        {
          baseHash: 'a'.repeat(64),
          id: '12345678-1234-1234-1234-123456789abc',
          draft: 'drafts/test.md',
          edit: scope,
        },
        '只追加',
        'continue',
      );
      return (
        scope.start === 2 &&
        scope.end === 2 &&
        prompt.includes('本次仅追加') &&
        prompt.includes('除非作者明确要求精确计数')
      );
    }),
    chapterNavigationAssetsAvailable: await page.evaluate(
      async () =>
        typeof (await import('/novel-assets/chapter-navigation.mjs')).createChapterNavigation === 'function',
    ),
    chapterOrderAssetsAvailable: await page.evaluate(async () => {
      const core = await import('/novel-assets/chapter-order-core.mjs');
      const ui = await import('/novel-assets/chapter-order-editor.mjs');
      return (
        typeof ui.createChapterOrderEditor === 'function' &&
        core.moveChapter(['a', 'b'], 'b', 0).join(',') === 'b,a' &&
        core.orderReviewOf('{}') === null
      );
    }),
    chapterOrderRouteVerified: await page.evaluate(async () => {
      const response = await fetch('/api/novels/b-' + '0'.repeat(32) + '/chapter-order', {
        credentials: 'same-origin',
      });
      const value = await response.json();
      return (
        response.status === 404 && typeof value.error === 'string' && !value.error.includes('/workspace')
      );
    }),
    bookIdentityRouteVerified: await page.evaluate(async () => {
      const response = await fetch('/api/novels/b-' + '0'.repeat(32) + '/identity', {
        credentials: 'same-origin',
      });
      const value = await response.json();
      return (
        response.status === 404 && typeof value.error === 'string' && !value.error.includes('/workspace')
      );
    }),
    referenceEditorAssetsAvailable: await page.evaluate(async () => {
      const core = await import('/novel-assets/reference-core.mjs'),
        ui = await import('/novel-assets/reference-editor.mjs');
      return (
        core.COLLECTIONS.length === 5 &&
        typeof ui.createReferenceEditor === 'function' &&
        core.trustOf({ trust: 'auto' }) === 'pending'
      );
    }),
    canonProposalAssetsAvailable: await page.evaluate(
      async () =>
        typeof (await import('/novel-assets/canon-review.mjs')).createCanonReview === 'function' &&
        typeof (await import('/novel-assets/manuscript-core.mjs')).canonProposalPrompt === 'function',
    ),
    canonReviewPolicyAssetsAvailable: await page.evaluate(async () => {
      const review = await import('/novel-assets/canon-review.mjs');
      return (
        review
          .selectableCanonKeys({
            changes: [
              { key: 'direct', valid: true, requiresIndividualReview: false },
              { key: 'needs-author', valid: true, requiresIndividualReview: true },
              { key: 'invalid', valid: false },
            ],
          })
          .join(',') === 'direct'
      );
    }),
    canonCandidateEditorAssetsAvailable: await page.evaluate(async () => {
      const { editCanonCandidate } = await import('/novel-assets/reference-core.mjs');
      const { createMergePlan, resolveMerge } = await import('/novel-assets/merge-core.mjs');
      const base = { characters: [{ id: 'author', name: 'Synthetic author', trust: 'manual' }] };
      const next = editCanonCandidate(
        base,
        { kind: 'add', collection: 'items', name: 'Synthetic candidate' },
        base,
      );
      const plan = createMergePlan({
        path: 'drafts/synthetic.md',
        json: true,
        base: '{"a":1,"b":1}',
        local: '{"a":2,"b":1}',
        remote: '{"a":1,"b":2}',
      });
      return (
        plan.json &&
        JSON.parse(resolveMerge(plan)).b === 2 &&
        next.items[0].trust === 'auto' &&
        next.items[0].evidenceSources.length === 0 &&
        next.characters[0].name === base.characters[0].name &&
        !base.items
      );
    }),
    outlineAssetsAvailable: await page.evaluate(
      async () =>
        typeof (await import('/novel-assets/outline-editor.mjs')).createOutlineEditor === 'function' &&
        typeof (await import('/novel-assets/outline-core.mjs')).outlinePrompt === 'function',
    ),
    nativeExecutionAssetsAvailable: await page.evaluate(async () => {
      const { nativeActivity, createNativeActivity } = await import('/novel-assets/native-activity.mjs');
      return typeof createNativeActivity === 'function' && nativeActivity({ running: true }).canStop;
    }),
    continuousWritingAssetsAvailable: await page.evaluate(async () => {
      const { createWritingRunPanel } = await import('/novel-assets/writing-run-panel.mjs');
      const { writingRunPrompt } = await import('/novel-assets/writing-run-core.mjs');
      const { taskMessage, parseTaskMessage } = await import('/novel-assets/task-message.mjs');
      const run = {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        range: { start: 1, end: 2 },
        phase: 'open',
        completed: false,
        publication: 'review',
      };
      const book = { id: 'b-' + 'a'.repeat(32), root: '/workspace/novels/b-' + 'a'.repeat(32) };
      const prompt = writingRunPrompt(book, run);
      const wire = taskMessage(prompt, {
        kind: 'writing-run',
        runId: run.id,
        bookId: book.id,
        instruction: 'Synthetic read-only asset verification.',
      });
      return (
        typeof createWritingRunPanel === 'function' &&
        parseTaskMessage(wire)?.runId === run.id &&
        prompt.includes('novel_run_submit')
      );
    }),
    focusedReviewAndReadingEditionAssetsAvailable: await page.evaluate(async () => {
      const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
      const { createReadingExport } = await import('/novel-assets/reading-export.mjs');
      const { renderReadingEdition } = await import('/novel-assets/reading-edition.mjs');
      const { createChapterFocus, reviewPrompt } = await import('/novel-assets/chapter-focus.mjs');
      const output = renderReadingEdition(
        {
          title: 'Synthetic',
          chapters: [{ title: 'Chapter', body: '<script>not executable</script>【PP1】', chapter: 1 }],
        },
        'html',
      );
      return (
        typeof createReadingExport === 'function' &&
        typeof makeWorkspaceClient().readFile === 'function' &&
        typeof createChapterFocus === 'function' &&
        typeof reviewPrompt === 'function' &&
        output.text.includes('&lt;script&gt;') &&
        !output.text.includes('<script>') &&
        output.text.includes('【PP1】')
      );
    }),
    writingBasisAssetsAvailable: await page.evaluate(async () => {
      const core = await import('/novel-assets/writing-review.mjs');
      const request = { version: 1, mode: 'continue', instruction: 'Synthetic read-only author request.' };
      const value = core.writingBasis({
        proposal: { writing: request, contextOutlineHash: null },
        writingContext: { outlineHash: null },
      });
      return (
        value.instruction === request.instruction &&
        !value.warning &&
        typeof core.createWritingBasis === 'function'
      );
    }),
    bookActivityAssetsAvailable: await page.evaluate(async () => {
      const core = await import('/novel-assets/native-activity.mjs');
      const book = { root: '/workspace/novels/b-' + '0'.repeat(32) };
      const ctx = {
        sessions: {
          list: {
            getSnapshot: () => ({
              phase: 'ready',
              byId: { synthetic: { id: 'synthetic', cwd: book.root, running: true } },
            }),
          },
          binding: () => undefined,
        },
        workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [] }) } },
        uiSession: { sessionStatus: { getSnapshot: () => new Map() } },
      };
      return (
        core.bookActivities(ctx, book).rows[0].kind === 'running' &&
        core.requireBookSession(ctx, book, 'synthetic').id === 'synthetic' &&
        typeof core.stopBookActivity === 'function' &&
        typeof core.subscribeBookActivities === 'function'
      );
    }),
    taskMessageAssetsAvailable: await page.evaluate(async () => {
      const core = await import('/novel-assets/task-message.mjs');
      const wire = core.taskMessage('Synthetic read-only verification.', {
        kind: 'review',
        bookId: 'b-' + '0'.repeat(32),
        instruction: '',
      });
      return (
        typeof core.installTaskMessages === 'function' &&
        core.parseTaskMessage(wire).prompt === 'Synthetic read-only verification.'
      );
    }),
    proposalConversationNavigationAvailable: await page.evaluate(async () => {
      const nav = await import('/novel-assets/proposal-navigation.mjs');
      const tasks = await import('/novel-assets/task-message.mjs');
      const book = { id: 'b-' + '0'.repeat(32), root: '/workspace/novels/b-' + '0'.repeat(32) };
      const proposalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const calls = [];
      const ctx = {
        sessions: {
          list: {
            getSnapshot: () => ({ phase: 'ready', byId: { synthetic: { id: 'synthetic', cwd: book.root } } }),
          },
        },
        workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [] }) } },
        sidebarRight: {
          mounted: { getSnapshot: () => 'synthetic' },
          openResource: (...args) => calls.push(args),
        },
      };
      const wire = tasks.taskMessage('Synthetic no-provider navigation verification.', {
        kind: 'continue',
        bookId: book.id,
        instruction: '',
        proposalId,
      });
      nav.openTaskProposal(ctx, tasks.parseTaskMessage(wire));
      return (
        wire.startsWith('[novel-task:v2]') &&
        calls.length === 1 &&
        calls[0][0] === nav.MANUSCRIPT_ADDRESS + book.id &&
        calls[0][1].params.proposalId === proposalId &&
        nav.proposalConversation(ctx, book, { originSessionId: 'synthetic' }).kind === 'available'
      );
    }),
    proseSharedInputAvailable: await page.evaluate(async () => {
      const { nativeTask } = await import('/novel-assets/manuscript-core.mjs');
      const book = {
        format: 'novel-harness-book-v1',
        id: 'b-' + '0'.repeat(32),
        root: '/workspace/novels/b-' + '0'.repeat(32),
      };
      const binding = { ctx: {} };
      const fake = {
        sessions: {
          binding: () => binding,
          list: { getSnapshot: () => ({ byId: { synthetic: { cwd: book.root } } }) },
        },
        conversation: {
          input: {
            for: () => ({
              state: {
                getSnapshot: () => ({ draft: 'Read-only synthetic input verification.', phase: 'plain' }),
              },
            }),
          },
        },
      };
      return (
        nativeTask(fake, 'synthetic', book, { fromComposer: true }).instruction ===
        'Read-only synthetic input verification.'
      );
    }),
    rulesEditorAssetsAvailable: await page.evaluate(async () => {
      const core = await import('/novel-assets/rules-core.mjs');
      const ui = await import('/novel-assets/rules-editor.mjs');
      const value = core.editRules(
        { extension: { keep: true } },
        { kind: 'prompt', key: 'write', value: 'Read-only synthetic verification.' },
      );
      return (
        typeof ui.createRulesEditor === 'function' &&
        value.extension.keep === true &&
        value.savedPrompts.write === 'Read-only synthetic verification.' &&
        !Object.hasOwn(core, 'rulesUsage')
      );
    }),
    mergeAssetsAvailable: await page.evaluate(async () => {
      const { createMergePlan, resolveMerge } = await import('/novel-assets/merge-core.mjs');
      const { createConflictEditor } = await import('/novel-assets/merge-editor.mjs');
      const fixture = {
        path: 'synthetic.md',
        base: 'a\nb\nc\n',
        local: 'A\nb\nc\n',
        remote: 'a\nb\nC\n',
      };
      for (const key of ['base', 'remote']) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fixture[key]));
        fixture[key + 'Hash'] = [...new Uint8Array(digest)]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
      }
      const workerPlan = await new Promise((resolve, reject) => {
        const worker = new Worker('/novel-assets/merge-worker.mjs', { type: 'module' });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error('Synthetic merge Worker timed out.'));
        }, 6000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          worker.terminate();
          if (data.error) reject(new Error(data.error));
          else resolve(data.plan);
        };
        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error('Synthetic merge Worker failed.'));
        };
        worker.postMessage(fixture);
      });
      const plan = createMergePlan(fixture);
      return (
        typeof createConflictEditor === 'function' &&
        plan.conflicts.length === 0 &&
        resolveMerge(plan) === 'A\nb\nC\n' &&
        resolveMerge(workerPlan) === 'A\nb\nC\n'
      );
    }),
    virtualEditorAssetsAvailable: await page.evaluate(async () => {
      const { EditorState, EditorView, drawSelection } = await import('/novel-assets/editor-vendor.mjs');
      const { createProseEditor } = await import('/novel-assets/prose-editor.mjs');
      const parent = document.createElement('div');
      parent.className = 'novel-prose-editor';
      parent.style.cssText = 'height:100px;width:320px;overflow:hidden;position:fixed;left:0;top:0';
      document.body.append(parent);
      let view;
      try {
        view = new EditorView({
          parent,
          state: EditorState.create({
            doc: 'Synthetic read-only deployment verification.',
            extensions: [drawSelection()],
          }),
        });
        view.dispatch({ changes: { from: 0, to: 9, insert: 'Verified' } });
        view.focus();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const cursor = view.dom.querySelector('.cm-cursor');
        globalThis.__novelEditorProbe = {
          display: getComputedStyle(view.dom).display,
          cursor: !!cursor,
          cursorColor: cursor ? getComputedStyle(cursor).borderLeftColor : null,
          textColor: getComputedStyle(view.contentDOM).color,
        };
        return (
          typeof createProseEditor === 'function' &&
          getComputedStyle(view.dom).display === 'flex' &&
          !!cursor &&
          getComputedStyle(cursor).borderLeftColor === getComputedStyle(view.contentDOM).color &&
          EditorView.findFromDOM(view.contentDOM) === view &&
          view.state.doc.toString() === 'Verified read-only deployment verification.'
        );
      } finally {
        view?.destroy();
        parent.remove();
      }
    }),
    draftCacheAssetsAvailable: await page.evaluate(async () => {
      const cache = await import('/novel-assets/draft-cache.mjs');
      return (
        typeof cache.readDraft === 'function' &&
        typeof cache.writeDraft === 'function' &&
        typeof cache.settleDraft === 'function'
      );
    }),
    pinAccountUI: true,
    personalPinConfigured: pinState.configured,
    pinChangedByVerification: false,
    darkTheme: true,
    modelPromptSubmissions: modelPosts.length,
    storyImports: 0,
  };
  assert.equal(result.nativeExecutionAssetsAvailable, true);
  assert.equal(result.continuousWritingAssetsAvailable, true);
  assert.equal(result.focusedReviewAndReadingEditionAssetsAvailable, true);
  assert.equal(result.writingBasisAssetsAvailable, true);
  assert.equal(result.canonReviewPolicyAssetsAvailable, true);
  assert.equal(result.canonCandidateEditorAssetsAvailable, true);
  assert.equal(result.bookActivityAssetsAvailable, true);
  assert.equal(result.taskMessageAssetsAvailable, true);
  assert.equal(result.proposalConversationNavigationAvailable, true);
  assert.equal(result.proseSharedInputAvailable, true);
  assert.equal(result.importRecordsAvailable, true);
  assert.equal(result.scopedProposalDeliveryAvailable, true);
  assert.equal(result.sharedNativeWritingContractAvailable, true);
  assert.equal(result.nativeConversationPreviewRecoveryAssetsAvailable, true);
  assert.equal(result.visualViewportLayoutAssetsAvailable, true);
  assert.equal(result.documentHistoryAssetsAvailable, true);
  assert.equal(result.historyPaginationAssetsAvailable, true);
  assert.equal(result.availableWorkspaceContainerLayoutVerified, true);
  assert.equal(result.continuationAppendScopeAvailable, true);
  assert.equal(result.rulesEditorAssetsAvailable, true);
  assert.equal(result.mergeAssetsAvailable, true);
  if (!result.virtualEditorAssetsAvailable)
    console.error(
      'Synthetic editor probe:',
      JSON.stringify(await page.evaluate(() => globalThis.__novelEditorProbe)),
    );
  assert.equal(result.virtualEditorAssetsAvailable, true);
  assert.equal(result.draftCacheAssetsAvailable, true);
  assert.equal(result.chapterNavigationAssetsAvailable, true);
  assert.equal(result.unifiedAuthoringAssetsAvailable, true);
  assert.equal(result.chapterOrderAssetsAvailable, true);
  assert.equal(result.chapterOrderRouteVerified, true);
  assert.equal(result.bookIdentityRouteVerified, true);
  await writeFile(
    resolve(root, 'test-results/cloud-public-verification.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        if (new URL(page.url()).pathname !== '/') continue;
        await page
          .screenshot({ path: resolve(root, 'test-results/cloud-public-failure.png'), fullPage: true })
          .catch(() => {});
        console.error(
          'Visible native dialogs:',
          redact(JSON.stringify(await page.getByRole('dialog').allTextContents())),
        );
        console.error(
          'Settings lifecycle (no text or credentials):',
          JSON.stringify(await page.evaluate(() => globalThis.__publicSettingsLifecycle ?? [])),
        );
        console.error(
          'Startup transitions:',
          JSON.stringify(await page.evaluate(() => globalThis.__publicStartupTransitions ?? [])),
        );
      }
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await transport?.close();
}
