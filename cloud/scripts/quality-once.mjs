// User-authorized 2026-10-24: <=3 requests, <=2000 output tokens/request.
// Offline synthetic story ONLY. Never calls production Harness or story APIs.
import Database from 'better-sqlite3';
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decryptJson } from '../../apps/server/dist/crypto.js';
import { verificationTransport } from './verification-transport.mjs';
import { cappedCompletion, reserveQualityAttempt } from './quality-core.mjs';
import { qualityFixture } from './quality-fixture.mjs';
const directory = resolve('test-results/cloud-quality-20261024'),
  ledgerPath = resolve(directory, 'ledger.json');
let transport,
  apiKey = '',
  ledger;
async function save() {
  await writeFile(ledgerPath + '.pending', JSON.stringify(ledger, null, 2));
  await rename(ledgerPath + '.pending', ledgerPath);
}
try {
  if (new Date().toISOString().slice(0, 10) !== '2026-10-24')
    throw new Error('一次性授权日期已过；未调用模型。');
  if (
    await stat(ledgerPath).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw new Error('本轮评测账本已存在，拒绝自动重跑或继续收费请求。');
  const db = new Database('data/novel-writer.sqlite', { readonly: true, fileMustExist: true });
  let config;
  try {
    const row = db.prepare('SELECT encrypted_data FROM global_settings WHERE id=1').get();
    const settings = row ? decryptJson(row.encrypted_data, await readFile('data/server.key')) : {};
    config =
      settings.apiConfigs?.find((item) => item.id === settings.activeConfigId) ?? settings.apiConfigs?.[0];
  } finally {
    db.close();
  }
  const endpoint = new URL(config?.baseURL);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname !== 'api.deepseek.com' ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('本轮仅获准使用已配置的 DeepSeek 官方直连，拒绝改用其他供应商或携密钥重定向。');
  if (!['', '/', '/v1', '/v1/'].includes(endpoint.pathname))
    throw new Error('未识别的直连接口路径，拒绝猜测或改配置。');
  endpoint.pathname = '/chat/completions';
  apiKey = String(config.apiKey ?? '').trim();
  if (!apiKey || !/^deepseek-[a-z0-9.-]+$/.test(config.model))
    throw new Error('未找到可用的已配置 DeepSeek Key / 模型。');
  const fixture = qualityFixture(await readFile('novel-writer-V4.4.3.html', 'utf8'));
  await mkdir(directory, { recursive: true });
  ledger = {
    format: 'novel-quality-20261024-v1',
    limit: 3,
    outputTokens: 2000,
    model: config.model,
    scope: 'direct-offline-prompt-level-sample-not-production-Harness-or-old-app-end-to-end',
    credentialSource: 'existing-local-encrypted-settings-read-only',
    attempts: [],
    productionStoryWrites: false,
    realApiCallsAuthorized: true,
  };
  // Exclusive one-shot marker. An interrupted reserved request is never retried.
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx' });
  await writeFile(resolve(directory, 'source.json'), JSON.stringify(fixture.source, null, 2));
  transport = await verificationTransport();
  for (const item of fixture.cases) {
    let attempt,
      lastNotice = 0;
    console.log('开始限量评测：' + item.name + '（不自动重试）');
    try {
      const result = await cappedCompletion({
        request: transport.request,
        endpoint: endpoint.href,
        apiKey,
        model: config.model,
        messages: item.messages,
        reserve: async () => {
          attempt = reserveQualityAttempt(ledger, item.name);
          attempt.promptHash = createHash('sha256').update(JSON.stringify(item.messages)).digest('hex');
          await save();
        },
        progress: ({ characters, elapsedMs }) => {
          if (elapsedMs - lastNotice > 10000) {
            lastNotice = elapsedMs;
            console.log(item.name + '：流式收到 ' + characters + ' 字符');
          }
        },
      });
      const assessment = item.name === 'grounded-canon' ? fixture.assess(result.text) : null;
      await writeFile(
        resolve(directory, item.name + '.json'),
        JSON.stringify({ ...result, assessment }, null, 2),
      );
      attempt.status = 'finished';
      attempt.finishReason = result.finishReason;
      attempt.usage = result.usage;
      attempt.elapsedMs = result.elapsedMs;
      await save();
      console.log(
        item.name +
          ' 已结束：' +
          JSON.stringify({
            finishReason: result.finishReason,
            outputCharacters: result.text.length,
            firstContentMs: result.firstContentMs,
            elapsedMs: result.elapsedMs,
            usage: result.usage,
            assessment,
          }),
      );
    } catch (error) {
      if (attempt) {
        attempt.status = 'failed-no-retry';
        attempt.failure = String(error.message).replaceAll(apiKey, '[redacted]');
        await save();
      }
      throw error;
    }
  }
  console.log('本轮请求已用完：' + ledger.attempts.length + ' / 3；不会自动追加请求。');
} catch (error) {
  console.error(apiKey ? String(error.message).replaceAll(apiKey, '[redacted]') : error.message);
  process.exitCode = 1;
} finally {
  apiKey = '';
  await transport?.close();
}
