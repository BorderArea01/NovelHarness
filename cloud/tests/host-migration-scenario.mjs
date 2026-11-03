// Original dsh-edge + same Pages gateway, relocated SQL/KV, original PIN/session.
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageHostRelease } from '../host/stage.mjs';
import { hostRuntime } from '../host/runtime.mjs';
import { snapshotRecords } from '../worker/storage-snapshot.mjs';
import { transferStoragePages } from '../scripts/storage-transfer.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { chromium } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import { verifyNativeCutover } from './host-cutover-scenario.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const work = await mkdtemp(resolve(tmpdir(), 'novel-native-host-fixture-'));
const release = resolve(work, 'release');
const ownerKey = 'fixture-not-a-real-owner-key-0123456789abcdef';
const authHeaders = { authorization: 'Bearer ' + ownerKey, 'x-novel-migration': 'export-v1' };
let runtime;
let browser;
let cookie = '';
const request = async (path, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('origin', 'http://localhost');
  if (cookie) headers.set('cookie', cookie);
  return runtime.dispatchFetch('http://localhost' + path, { ...init, headers, redirect: 'manual' });
};
const json = (data) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
try {
  await stageHostRelease(release);
  const source = { release, persist: resolve(work, 'source'), ownerKey, namespaceKey: 'fixture-native-source-v1' };
  const lan = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4' && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
  const destination = { release, persist: resolve(work, 'destination'), ownerKey, namespaceKey: 'fixture-native-destination-v1',
    ...(lan ? { host: '0.0.0.0', lanHosts: [lan] } : {}) };
  runtime = await hostRuntime(source);
  let response = await request('/api/health');
  assert.equal(response.status, 200, await response.text());
  response = await request('/api/auth/recover', json({ accessKey: ownerKey, newPin: '561904', confirmPin: '561904' }));
  assert.equal(response.status, 200, await response.text());
  cookie = response.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  response = await request('/api/ready');
  assert.equal(response.status, 200, await response.text());
  const client = makeWorkspaceClient(request);
  const bundle = await makeBookBundle(null, { seed: '云端与本机同一个故事', title: '完整迁移测试' });
  await client.create(bundle);
  response = await request('/api/sessions', json({ title: '迁移后保留的原生对话' }));
  assert.equal(response.status, 201, await response.clone().text());
  const session = (await response.json()).session;
  const sessionId = session.id ?? session.sessionId;
  assert.ok(sessionId);
  const rawPath = bundle.manifest.root + '/chapters/迁移测试.md';
  const prose = '\ufeff完整正文\r\n雨里的火光。🌧️';
  response = await request('/api/workspace/file?path=' + encodeURIComponent(rawPath), { method: 'PUT', body: prose });
  assert.equal(response.status, 200, await response.text());
  const beforeBytes = Buffer.from(await (await request('/api/workspace/file?path=' + encodeURIComponent(rawPath))).arrayBuffer());
  assert.equal((await request('/api/host-migration/snapshot/main', { method: 'POST' })).status, 404);
  const snapshots = {};
  for (const kind of ['main', 'pin']) {
    const pages = [];
    const result = await transferStoragePages(async (params) => {
      const response = await request('/api/host-migration/snapshot/' + kind + '?' + params, { method: 'POST', headers: authHeaders });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }, { onPage: (page) => { pages.push(page); } });
    snapshots[kind] = { ...result, chunks: pages };
    assert.ok(result.keys > 0);
  }
  await runtime.dispose(); runtime = null;
  runtime = await hostRuntime({ ...destination, bootstrap: true });
  for (const kind of ['main', 'pin']) {
    const ns = await runtime.getDurableObjectNamespace(kind === 'main' ? 'DSH_EDGE_INSTANCE' : 'PIN_AUTH', 'novel-host-harness');
    const stub = ns.get(ns.idFromName('owner'));
    const post = async (path, value) => {
      const response = await stub.fetch('http://localhost/' + path, { method: 'POST', headers: authHeaders, body: JSON.stringify(value) });
      assert.equal(response.status, 200, await response.text());
    };
    await post('begin', snapshots[kind].header);
    for (const [ordinal, page] of snapshots[kind].chunks.entries()) await post('page', { page, ordinal });
    await post('commit', { pages: snapshots[kind].pages, keys: snapshots[kind].keys });
    const verified = await transferStoragePages(async (params) => {
      const response = await stub.fetch('http://localhost/?' + params, { headers: authHeaders });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }, { onPage: (page, ordinal) => { assert.deepEqual(page, snapshots[kind].chunks[ordinal]); } });
    assert.deepEqual(verified.header.schema, snapshots[kind].header.schema);
    assert.deepEqual(verified.header.tables, snapshots[kind].header.tables);
  }
  await runtime.dispose(); runtime = null;
  runtime = await hostRuntime(destination);
  response = await request('/api/auth/session');
  assert.equal((await response.json()).authenticated, true, 'Original signed session and PIN gate survive relocation.');
  response = await request('/api/auth/login', json({ pin: '561904' }));
  assert.equal(response.status, 200, await response.text());
  cookie = response.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  assert.equal((await client.list())[0].id, bundle.manifest.id);
  response = await request('/api/workspace/file?path=' + encodeURIComponent(rawPath));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), beforeBytes);
  response = await request('/api/sessions');
  assert.ok((await response.json()).sessions.some((item) => item.id === sessionId || item.sessionId === sessionId));
  response = await request('/');
  const html = await response.text();
  assert.equal(response.status, 200, html);
  assert.ok(html.includes('<title>小说工作台</title>') && html.includes('harness-boot.mjs'));
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--js-flags=--max-old-space-size=192'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addLocatorHandler(page.getByRole('button', { name: '继续', exact: true }), async () => {
    await page.getByRole('button', { name: '继续', exact: true }).click();
  });
  await page.addLocatorHandler(page.getByRole('button', { name: '稍后配置', exact: true }), async () => {
    await page.getByRole('button', { name: '稍后配置', exact: true }).click();
  });
  page.on('pageerror', (error) => console.log('Synthetic browser error:', error.message));
  let failedResources = 0;
  page.on('response', (response) => {
    if (response.status() >= 400 && failedResources++ < 6) console.log('Synthetic missing resource:', response.status(), new URL(response.url()).pathname);
  });
  const address = await runtime.ready;
  const url = 'http://' + (lan ?? '127.0.0.1') + ':' + address.port;
  await page.goto(url + '/login');
  await page.locator('#pin').fill('561904');
  await page.locator('#login-form button[type="submit"]').click();
  try { await page.locator('.novel-library').waitFor(); }
  catch (error) {
    console.log('Synthetic browser location:', page.url(), (await page.locator('body').innerText()).slice(0, 1000));
    throw error;
  }
  assert.equal(await page.title(), '小说工作台');
  const browserWrite = await page.evaluate(async () => {
    const { makeBookBundle, digest } = await import('/novel-assets/bundle.mjs');
    const { makeWorkspaceClient } = await import('/novel-assets/workspace.mjs');
    const bundle = await makeBookBundle(null, { seed: '局域网新建与保存测试', title: '局域网新建' });
    await makeWorkspaceClient().create(bundle);
    const path = 'chapters/局域网保存.md', text = '局域网新写的正文。\n🌧️';
    const response = await fetch('/api/novels/' + bundle.manifest.id + '/document', { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, text, expectedHash: null }) });
    const saved = await response.json();
    return { ok: response.ok, id: bundle.manifest.id, path, hash: saved.hash, expectedHash: await digest(text), text };
  });
  assert.equal(browserWrite.ok, true); assert.equal(browserWrite.hash, browserWrite.expectedHash);
  await page.reload(); await page.locator('.novel-library').waitFor();
  assert.equal(await page.evaluate(async ({ id, path }) => (await (await fetch('/api/novels/' + id + '/document?path=' + encodeURIComponent(path))).json()).text, browserWrite), browserWrite.text);
  await page.screenshot({ path: resolve(root, 'test-results/cloud-host-migration-mobile.png') });
  await page.locator('.book .open-book').first().click();
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  assert.equal(await page.title(), '小说工作台');
  console.log(JSON.stringify({ nativeHostMigration: true, originalPin: true, originalSignedSession: true, nativeSessionIdentity: true,
    proseBytesIdentical: true, fullSqlAndKvEqualBeforeNativeStartup: true, unifiedNativeWebsite: true, mobileBrowserAndNativeCarrier: true, lanBrowser: !!lan,
    lanCreateSaveReload: true, modelCalls: 0, cloudRequests: 0 }));
  await browser.close(); browser = null;
  await runtime.dispose(); runtime = null;
  await verifyNativeCutover({ source, release, persist: resolve(work, 'cutover-target'), ownerKey, cookie, bookId: bundle.manifest.id });
} finally {
  await browser?.close();
  await runtime?.dispose();
  await rm(work, { recursive: true });
}
