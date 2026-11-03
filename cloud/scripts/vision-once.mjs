// Explicit 2026-10-28 vision test: same deployed engine, isolated DB, <=3 calls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { hostRuntime } from '../host/runtime.mjs';
import { decodeStorageValue } from '../worker/storage-value.mjs';
import { verificationTransport } from './verification-transport.mjs';
import { privateDirectory } from './private-directory.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import assert from 'node:assert/strict';
if (!process.argv.includes('--owner-requested') || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()) !== '2026-10-28') throw new Error('Explicit current-day test authorization required.');
const imagePath = process.env.NOVEL_VISION_IMAGE;
if (!imagePath) throw new Error('Explicit owner-provided image required.');
const image = await readFile(imagePath);
if (image.length > 4 * 1024 * 1024 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('This bounded test accepts a PNG under 4 MiB.');
const work = resolve('data/local-host/vision-test-20261028');
await privateDirectory(work);
const ledgerPath = resolve(work, 'ledger.json');
const ledger = { at: new Date().toISOString(), limit: 3, outputTokens: 1500, imageSha256: createHash('sha256').update(image).digest('hex'),
  model: 'deepseek-flash', productionStoryWrites: false, productionSettingsWrites: false, completed: false, attempts: [] };
try { await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const previous = JSON.parse(await readFile(ledgerPath, 'utf8'));
  if (previous.attempts.length || previous.completed || previous.imageSha256 !== ledger.imageSha256)
    throw new Error('One-shot paid ledger exists; no automatic resubmission.');
}
const persist = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
const active = JSON.parse(await readFile('data/local-host/active.json', 'utf8'));
const candidate = JSON.parse(await readFile(resolve(active.candidate, 'candidate.json'), 'utf8'));
const receipt = JSON.parse(await readFile(resolve(candidate.sourceSnapshot, 'storage-report.json'), 'utf8'));
let apiKey = '';
for (const page of receipt.stores.main.pages.slice(-20)) {
  const data = JSON.parse(await readFile(resolve(candidate.sourceSnapshot, page.file), 'utf8'));
  for (const record of data.records ?? []) if (record.type === 'kv' && record.key === 'dsh-edge:credential:DEEPSEEK_API_KEY') apiKey = decodeStorageValue(record.value);
}
if (typeof apiKey !== 'string' || apiKey.length < 16) throw new Error('Verified original DeepSeek credential unavailable.');
let runtime, browser, boundary;
const transport = await verificationTransport(), controllers = new Set();
let reservations = Promise.resolve(), stage = 'provider-boundary';
try {
  boundary = createServer(async (req, res) => {
    let attempt;
    try {
      if (req.method !== 'POST' || req.url !== '/v1/messages' || req.headers['x-api-key'] !== 'fixture-only-vision-key') throw new Error('Unexpected diagnostic request.');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 6 * 1024 * 1024) throw new Error('Request budget.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks));
      if (!Array.isArray(body.messages) || !Number.isSafeInteger(body.max_tokens) || !body.stream) throw new Error('Unexpected diagnostic wire.');
      const admitted = reservations.then(async () => {
        if (ledger.attempts.length >= 3) throw new Error('Paid request cap exhausted.');
        const images = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'image');
        attempt = { number: ledger.attempts.length + 1, reservedAt: new Date().toISOString(), imageBlocks: images.length, status: 'reserved' };
        ledger.attempts.push(attempt); await persist();
      });
      reservations = admitted.catch(() => {}); await admitted;
      body.model = ledger.model; body.max_tokens = Math.min(body.max_tokens, 1500);
      const controller = new AbortController(); controllers.add(controller);
      const started = Date.now(); let text = '', buffer = '', firstContentMs = null, stopReason = null;
      console.log(JSON.stringify({ stage: 'real-vision-request', attempt: attempt.number, imageBlocks: attempt.imageBlocks, outputCap: body.max_tokens }));
      const response = await transport.request('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      attempt.httpStatus = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error('Upstream HTTP ' + response.status); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const decoder = new TextDecoder(); let bytes = 0;
      const parse = line => {
        if (!line.startsWith('data:')) return;
        let event; try { event = JSON.parse(line.slice(5)); } catch { return; }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') { firstContentMs ??= Date.now() - started; text += event.delta.text; }
        if (event.type === 'message_delta') { stopReason = event.delta?.stop_reason; attempt.usage = event.usage; }
      };
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Response budget.');
        buffer += decoder.decode(chunk, { stream: true }); let i;
        while ((i = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
        if (!res.write(chunk)) await once(res, 'drain');
      }
      if (buffer.trim()) parse(buffer);
      res.end(); controllers.delete(controller);
      attempt.status = 'finished'; attempt.firstContentMs = firstContentMs; attempt.elapsedMs = Date.now() - started; attempt.stopReason = stopReason;
      await writeFile(resolve(work, 'response-' + attempt.number + '.txt'), text, { mode: 0o600 }); await persist();
      console.log(JSON.stringify({ stage: 'vision-response-finished', attempt: attempt.number, imageBlocks: attempt.imageBlocks, firstContentMs, elapsedMs: attempt.elapsedMs, stopReason, characters: text.length }));
    } catch (error) {
      if (attempt) { attempt.status = 'failed-counted'; await persist().catch(() => {}); }
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Isolated vision diagnostic stopped. No automatic retry budget.' } }));
      console.log(JSON.stringify({ stage: 'vision-boundary-refused', attempt: attempt?.number ?? 0, reason: /^Upstream HTTP \d+$/.test(error.message) ? error.message : 'diagnostic-guard' }));
    }
  });
  await new Promise((done, reject) => { boundary.once('error', reject); boundary.listen(0, '127.0.0.1', done); });
  stage = 'isolated-native-runtime';
  const ownerKey = 'fixture-only-vision-owner-' + randomUUID();
  const storage = resolve(work, 'storage-' + randomUUID()); await mkdir(storage);
  runtime = await hostRuntime({ release: resolve(active.candidate, 'release'), persist: storage, ownerKey,
    namespaceKey: 'vision-fixture-' + randomUUID(), providerBindings: {
      DEEPSEEK_API_KEY: 'fixture-only-vision-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + boundary.address().port,
      DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_REASONING_EFFORT: 'off', DEEPSEEK_MAX_OUTPUT_TOKENS: '1500',
    } });
  const address = await runtime.ready, origin = address.origin;
  const login = await fetch(origin + '/api/auth/recover', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: ownerKey }) });
  assert.equal(login.status, 200); await login.arrayBuffer();
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(v => v.split(';')[0]).join('; ');
  const bundle = await makeBookBundle(null, { title: '独立识图验收', seed: '只验证角色图理解，不创作正式作品。' });
  await makeWorkspaceClient((path, init = {}) => fetch(origin + path, { ...init, headers: { ...init.headers, cookie, origin } })).create(bundle);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: ['--js-flags=--max-old-space-size=192'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookies.map(c => { const pair = c.split(';')[0], i = pair.indexOf('='); return { name: pair.slice(0, i), value: pair.slice(i + 1), url: origin, httpOnly: true, sameSite: 'Strict' }; }));
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  for (const label of ['继续', '稍后配置']) await page.addLocatorHandler(page.getByRole('button', { name: label, exact: true }), () => page.getByRole('button', { name: label, exact: true }).click());
  stage = 'browser-open-composer';
  await page.goto(origin + '/?view=library');
  await page.locator('.book .open-book').first().click();
  await page.getByRole('region', { name: '小说书稿', exact: true }).waitFor();
  const showAssistant = page.getByRole('button', { name: '创作助手', exact: true });
  if (await showAssistant.isVisible()) await showAssistant.click();
  const composer = page.locator('[contenteditable="true"][role="textbox"]:visible').first();
  await composer.fill('只做这张图片的视觉分析，不写小说、不创建或修改任何文件。按【可见事实】【神态与状态推测】【情节可能性】【不能确定】四栏回答，总计400字以内。先说人数、发色、姿势、衣着大类和机械环境；情绪要给出眼睛、嘴部、姿态的可见依据。不要根据这张图断言姓名、作品、年龄、人物关系或具体遭遇；不扩写成人情节。不必提问，直接分析。');
  stage = 'browser-image-upload';
  const inputs = page.locator('input[type="file"]');
  const uploadCount = await inputs.count();
  ledger.fileInputs = await inputs.evaluateAll(nodes => nodes.map(n => ({ accept: n.accept, multiple: n.multiple })));
  await persist();
  if (!uploadCount) throw new Error('Original attachment picker is not mounted.');
  await inputs.last().setInputFiles({ name: '角色参考.png', mimeType: 'image/png', buffer: image });
  stage = 'browser-send-image';
  await composer.press('Enter');
  const rpc = async (method, request) => {
    const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), payload: { args: { request } } }) });
    const result = await response.json(); return result.result?.value;
  };
  stage = 'native-vision-turn';
  const until = Date.now() + 150000; let ended = false;
  while (Date.now() < until) {
    const sessions = await rpc('session/list', {});
    const sessionId = sessions?.items?.find(s => s.cwd === bundle.manifest.root)?.sessionId;
    if (sessionId) {
      const history = await rpc('session/history', { sessionId });
      if (history?.events?.some(e => e.event.type === 'turn/end')) { ended = true; break; }
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  if (!ended) throw new Error('Native vision turn did not finish within the test window.');
  ledger.nativeTurnEnded = true;
  await page.screenshot({ path: resolve(work, 'browser-result.png'), fullPage: false });
  await writeFile(resolve(work, 'browser-text.txt'), await page.locator('body').innerText(), { mode: 0o600 });
  ledger.completed = ledger.attempts.some(a => a.imageBlocks > 0 && a.status === 'finished' && a.stopReason === 'end_turn');
  if (!ledger.completed) throw new Error('No complete image-bearing native response was observed.');
} catch (error) {
  ledger.failedStage = stage; ledger.diagnostic = String(error.message).replaceAll(apiKey, '[redacted]').slice(0, 250); process.exitCode = 1;
} finally {
  await browser?.close(); await runtime?.dispose(); for (const c of controllers) c.abort();
  boundary?.closeAllConnections(); if (boundary?.listening) await new Promise(done => boundary.close(done));
  await transport.close(); await persist();
  console.log(JSON.stringify({ complete: ledger.completed, attempts: ledger.attempts.length, imageRequests: ledger.attempts.filter(a => a.imageBlocks > 0).length,
    ...(ledger.failedStage ? { failedStage: ledger.failedStage, diagnostic: ledger.diagnostic } : {}), evidence: work, productionStoryWrites: false, productionSettingsWrites: false }));
}
