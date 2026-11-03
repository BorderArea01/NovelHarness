// Boot the original official host/plugin, on loopback and a temporary port.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
const lab = resolve(process.env.NOVEL_OFFICIAL_LAB ?? '');
assert(lab.endsWith('official-validation'));
const install = resolve(process.env.DSH_BASE, '../..');
const modules = join(install, 'node_modules');
const { loadLayeredEnv } = await import(
  pathToFileURL(join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js'))
);
const { runProfile } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh/lib/profile-boot.js')));
let app;
let browser;
const report = {
  passed: false,
  nativeHost: true,
  originalPlugin: true,
  providerConfigured: false,
  realModelCalls: 0,
};
try {
  app = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  });
  const server = app.ctx.get('webServer');
  assert(server);
  // Server implementation carries the actual bound port, never assume 3080.
  const listener = server.server;
  const address = listener?.address?.();
  if (address?.port) report.origin = 'http://127.0.0.1:' + address.port;
  report.services = {
    systemPrompt: !!app.ctx.get('systemPrompt'),
    tools: !!app.ctx.get('tools'),
    sessionPersistence: !!app.ctx.get('sessionPersistence'),
    redteam: !!app.ctx.get('redteam'),
  };
  assert(Object.values(report.services).every(Boolean));
  const assembly = await app.ctx.get('systemPrompt').assemble({});
  report.purgePromptAssembled = assembly.sections.some(
    (section) => section.name.startsWith('dsh-purge') && section.text,
  );
  report.purgeStatusToolRegistered = !!app.ctx.get('tools').get('purge_status');
  assert(report.purgePromptAssembled);
  assert(report.purgeStatusToolRegistered);
  assert(report.origin);
  report.unauthenticatedIndexStatus = (await fetch(report.origin)).status;
  report.unauthenticatedPluginStatus = (await fetch(report.origin + '/dsh-purge/status')).status;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-background-networking', '--disable-extensions'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: 'zh-CN' });
  const errors = [];
  const remote = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return route.continue();
    remote.push(url.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error.message)));
  await page.goto(app.ctx.get('connection').authenticatedUrl(report.origin), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => !!globalThis.__ModuleLoader__, undefined, { timeout: 20000 });
  await page
    .getByText(/用户须知|User notice/)
    .first()
    .waitFor({ timeout: 20000 });
  report.originalPluginClientLoaded = true;
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /我已知晓并继续|I understand/ }).click();
  // The original host has its own first-run introduction beneath the plugin's
  // notice. Dismiss it normally, without forcing clicks through an overlay.
  const introduction = page.getByRole('button', {
    name: /^(继续|Continue|开始使用|我知道了|知道了|Got it|Get started)$/i,
  });
  if (await introduction.count()) await introduction.first().click();
  const later = page.getByRole('button', { name: /^(稍后配置|Set up later)$/i });
  if (await later.count()) await later.first().click();
  // Only the harmless Clean UI; never authorize or run a drill/attack.
  const launcher = page.getByRole('button', { name: /dsh-purge/i }).first();
  await launcher.waitFor({ timeout: 10000 });
  await launcher.click();
  await page
    .getByText(/清洗|Clean/, { exact: true })
    .first()
    .waitFor({ timeout: 10000 });
  const status = await context.request.get(report.origin + '/dsh-purge/status');
  assert.equal(status.status(), 200);
  const payload = await status.json();
  assert.equal(payload.plugin_version, '1.1.82');
  assert.equal(resolve(payload.ai_base), resolve(process.env.DSH_BASE));
  report.pluginStatusVerified = true;
  report.defaultWorkspaceUsable = app.ctx.get('workspaceRegistry').list().length > 0;
  assert(report.defaultWorkspaceUsable);
  await page.screenshot({ path: join(lab, 'official-plugin-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(lab, 'official-plugin-mobile.png') });
  report.mobileHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  report.browserErrors = errors.length;
  report.blockedExternalBrowserRequests = remote.length;
  if (errors.length) await writeFile(join(lab, 'browser-errors.json'), JSON.stringify(errors));
  assert.equal(errors.length, 0, 'Original host/plugin browser errors occurred.');
  report.passed = true;
} catch (error) {
  report.failure = String(error.message).slice(0, 1500);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (app) await app.shutdown.shutdown(report.passed ? 0 : 1);
  await writeFile(join(lab, 'boot-report.json'), JSON.stringify(report, null, 2));
}
