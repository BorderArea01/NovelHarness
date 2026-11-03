// Separate owner-authorized rounds, each TWO attempts, <=2000 output tokens.
// Prompt-level A/B only: no Agent, story API, book writes, retries or deployment.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { privateDirectory } from './private-directory.mjs';
import { verificationTransport } from './verification-transport.mjs';
import { resolveInjectText } from '../official/node_modules/dsh-purge/lib/rules.js';

const home = resolve('data/official-validation/integration/lan-staging/home');
const dialogueRound = process.argv.includes('--owner-approved-dialogue-20261030');
const directory = resolve('data/official-validation/integration/' + (dialogueRound ? 'dialogue-compare-20261030' : 'prose-compare-20261029'));
const ledgerPath = join(directory, 'ledger.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const requireOfficial = createRequire(new URL('../official/package.json', import.meta.url));
const { parse } = requireOfficial('yaml');
let apiKey = '', transport, ledger, phase = 'authorization';
const persist = async () => {
  await writeFile(ledgerPath + '.pending', JSON.stringify(ledger, null, 2), { mode: 0o600 });
  await rename(ledgerPath + '.pending', ledgerPath);
};
export function proseStats(text) {
  // Descriptive counts only, NOT a production quality gate or paragraph quota.
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n+/)
    .map((line) => line.trim()).filter((line) => line && !/^#{1,6}\s/.test(line));
  const lengths = paragraphs.map((p) => [...p.replace(/\s/g, '')].length).sort((a, b) => a - b);
  return {
    characters: [...text.replace(/\s/g, '')].length,
    hanCharacters: (text.match(/\p{Script=Han}/gu) ?? []).length,
    paragraphs: paragraphs.length,
    medianParagraphCharacters: lengths[Math.floor(lengths.length / 2)] ?? 0,
    shortParagraphsAtMost40Characters: lengths.filter((n) => n <= 40).length,
    paragraphsAtLeast100Characters: lengths.filter((n) => n >= 100).length,
    singleSentenceParagraphs: paragraphs.filter((p) => (p.match(/[。！？!?]+/g) ?? []).length <= 1).length,
  };
}

async function cappedCompletion({ model, messages, reserve, progress }) {
  await reserve(); // A persisted reservation precedes this single HTTPS call.
  const started = Date.now();
  const response = await transport.request('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, system: messages[0].content, messages: messages.slice(1),
      max_tokens: 2000, stream: true, thinking: { type: 'disabled' }, temperature: 0.8,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('模型请求 HTTP ' + response.status + '；已计入次数，不自动重试。');
  }
  let text = '', buffer = '', bytes = 0, firstContentMs = null,
    finishReason = null, usage = {}, reasoningChars = 0, done = false;
  const decoder = new TextDecoder();
  const line = (value) => {
    if (!value.startsWith('data:')) return;
    const event = JSON.parse(value.slice(5));
    if (event.type === 'error') throw new Error('Provider stream failed.');
    if (event.type === 'message_start') usage = { ...usage, ...event.message?.usage };
    if (event.type === 'content_block_delta') {
      reasoningChars += event.delta?.thinking?.length ?? 0;
      if (event.delta?.type === 'text_delta') {
        text += event.delta.text;
        firstContentMs ??= Date.now() - started;
        progress({ characters: text.length, elapsedMs: Date.now() - started });
      }
    }
    if (event.type === 'message_delta') {
      finishReason = event.delta?.stop_reason ?? finishReason;
      usage = { ...usage, ...event.usage };
    }
    if (event.type === 'message_stop') done = true;
  };
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('Response byte limit.');
      buffer += decoder.decode(part.value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, i).replace(/\r$/, ''));
        buffer = buffer.slice(i + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer.trim());
    assert(done && finishReason && text.trim(), 'Incomplete model stream.');
    assert(usage.output_tokens === undefined || usage.output_tokens <= 2000, 'Provider exceeded output cap.');
    return { text, firstContentMs, elapsedMs: Date.now() - started, finishReason, usage, reasoningChars };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

try {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  assert(dialogueRound ? date === '2026-10-30' : process.argv.includes('--owner-approved-20261029') && date === '2026-10-29',
    'Current one-shot owner authorization is required.');
  phase = 'read-existing-configuration';
  const profile = parse(await readFile(join(home, 'profiles/novel-lab-persistent/cordis.patch.yml'), 'utf8'));
  const selection = profile.find((r) => r.id === 'agent-default-model')?.config;
  assert(selection?.provider === 'deepseek-official' && /^deepseek-[a-z0-9.-]+$/.test(selection.model),
    'Existing DeepSeek model selection is required; no substitute model.');
  const credentials = parse(await readFile(join(home, '.credentials.yaml'), 'utf8'));
  assert.equal(credentials.version, 1);
  apiKey = credentials.refs?.DEEPSEEK_API_KEY;
  assert(typeof apiKey === 'string' && apiKey.length >= 16, 'Stored credential unavailable.');
  const operator = resolveInjectText(home);
  assert.equal(operator.source, 'default', 'Do not send private custom operator text in this test.');
  phase = 'verify-template-baselines';
  const oldPath = resolve(dialogueRound ? 'data/official-validation/integration/baseline/worker' : 'data/official-validation/integration/lan-updates/2026-10-29T13-20-51-764Z/backup/baseline/worker');
  const newPath = resolve(dialogueRound ? 'cloud/worker' : 'data/official-validation/integration/baseline/worker');
  const old = await import(pathToFileURL(join(oldPath, 'prompt-templates.mjs')));
  const current = await import(pathToFileURL(join(newPath, 'prompt-templates.mjs')));
  assert.notEqual(old.LEGACY_DEFAULT_PROMPTS.write, current.LEGACY_DEFAULT_PROMPTS.write);
  for (const key of dialogueRound ? ['outline', 'outlineContinue', 'ending'] : ['outline', 'outlineContinue', 'deai', 'ending'])
    assert.equal(old.LEGACY_DEFAULT_PROMPTS[key], current.LEGACY_DEFAULT_PROMPTS[key]);
  const root = '/workspace/novels/b-' + '0'.repeat(32);
  const instruction = dialogueRound
    ? '写一个约700—900字的连续小说片段，从修车铺临近关门、陈衡来取车开始，到两人商定先试车再付款并把车推出门为止。主要写两人的交谈与现场互动，不增加事故、追兵或身世揭秘。只返回小说正文。'
    : '写一个约800—1000字的连续小说片段：从苏青准备关掉旧戏院的总电闸写起，到她决定暂缓断电、留下查声音的来源为止。场景内有她和同事梁叔的交涉。不要揭晓母亲下落或声音的真正来源。本次仅交付片段正文，不写创作说明。';
  const material = dialogueRound ? {
    'seed.md': '陈衡在城里最后一晚来修车铺取旧摩托。车费还差一百八，修车师傅叶岚知道他手头紧，却不愿明说给他优惠。',
    'setting.md': '当代小城。叶岚和陈衡是从小认识的邻居，三年前为车摔坏的事吵过架，此后疏远。两人都知道这段旧事与他母亲最近住院的事，不需要重新介绍。叶岚嘴硬、做事细，刚换好刹车线；她忙了一天，不是永远冷静的神秘人。陈衡要赶明早的班车，在意尊严，也真担心车还会熄火。两人没有仇恨或隐瞒身世。今晚下小雨，铺门半拉，门口排水沟堵着落叶，修车铺里有工具和旧零件。',
    'memory.json': JSON.stringify({ facts: ['刹车线已换，车费尚差一百八。'], guesses: [] }),
    'outline.json': JSON.stringify([{ chapter: 1, title: '取车', summary: '陈衡取车，对修理费与车况各有顾虑；叶岚不明说照顾他，两人交涉，最后商定先试车、车费下月结，合力把车推过门槛。' }]),
    'rules.json': JSON.stringify({ savedPrompts: {}, project: {} }),
    'canon.json': JSON.stringify({ characters: [], locations: [], relations: [] }),
  } : {
    'seed.md': '旧戏院明早拆除。灯光师苏青在最后一次清场时，听见失踪八年的母亲从废弃扩音器里叫她的小名。',
    'setting.md': '当晚下雨，舞台与观众席间尚有拆卸设备。苏青二十九岁，曾跟母亲在此生活。梁叔是和她一起检修的老同事，承诺今晚交钥匙，他有自己的疲惫和顾虑，不能当成反派。那声呼唤是否真来自母亲尚未证实。',
    'memory.json': JSON.stringify({ facts: [], guesses: [] }),
    'outline.json': JSON.stringify([{ chapter: 1, title: '最后一盏灯', summary: '苏青准备断电，听见扩音器叫她的小名；与梁叔交涉后决定留下追查。' }]),
    'rules.json': JSON.stringify({ savedPrompts: {}, project: {} }),
    'canon.json': JSON.stringify({ characters: [], locations: [], relations: [] }),
  };
  const input = {
    key: 'write', book: { title: dialogueRound ? '取车' : '最后一盏灯', root }, mode: 'write',
    rulesText: material['rules.json'],
    outline: { chapter: 1, title: dialogueRound ? '取车' : '最后一盏灯', summary: JSON.parse(material['outline.json'])[0].summary },
  };
  const common = {
    authorRequest: instruction,
    materials: Object.fromEntries(Object.entries(material).map(([p, text]) => [root + '/' + p, text])),
  };
  const cases = [
    { name: 'before', template: old.prepareTemplate(input) },
    { name: 'after', template: current.prepareTemplate(input) },
  ];
  const system = operator.text + '\n\n本次是独立小说片段评测，全部资料已内联，不提供工具；只返回作品正文，不声称读取或保存了文件，不返回工具调用、路径或执行汇报。';
  phase = 'create-one-shot-ledger';
  await privateDirectory(directory);
  ledger = {
    format: dialogueRound ? 'dialogue-template-comparison-20261030-v1' : 'prose-template-comparison-20261029-v1', limit: 2, outputTokens: 2000,
    model: selection.model, thinking: 'disabled', temperature: 0.8,
    scope: 'controlled-prompt-level-not-full-agent-or-long-form-quality-acceptance',
    productionStoryWrites: false, productionSettingsWrites: false,
    commonContextHash: hash(JSON.stringify(common)), commonSystemHash: hash(system),
    oldTemplateHash: hash(cases[0].template.body), newTemplateHash: hash(cases[1].template.body),
    attempts: [], completed: false,
  };
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'synthetic-input.json'), JSON.stringify(common, null, 2), { mode: 0o600 });
  phase = 'existing-network-transport';
  transport = await verificationTransport();
  for (const item of cases) {
    phase = item.name;
    let attempt, lastNotice = 0;
    await writeFile(join(directory, item.name + '-template.json'), JSON.stringify(item.template, null, 2), { flag: 'wx', mode: 0o600 });
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ ...common, task: { kind: 'prose', template: item.template } }) },
    ];
    try {
      const result = await cappedCompletion({
        model: selection.model, messages,
        reserve: async () => {
          assert.equal(ledger.limit, 2);
          assert.equal(ledger.outputTokens, 2000);
          assert(ledger.attempts.length < 2 && !ledger.attempts.some((a) => a.name === item.name));
          attempt = { name: item.name, reservedAt: new Date().toISOString(), status: 'reserved', promptHash: hash(JSON.stringify(messages)) };
          ledger.attempts.push(attempt);
          await persist();
          console.log(JSON.stringify({ stage: 'request-reserved', name: item.name, number: ledger.attempts.length, limit: 2, outputTokenCap: 2000 }));
        },
        progress: ({ characters, elapsedMs }) => {
          if (elapsedMs - lastNotice >= 10000) {
            lastNotice = elapsedMs;
            console.log(JSON.stringify({ stage: 'streaming', name: item.name, characters, elapsedMs }));
          }
        },
      });
      const stats = proseStats(result.text);
      await writeFile(join(directory, item.name + '.txt'), result.text, { mode: 0o600 });
      await writeFile(join(directory, item.name + '.json'), JSON.stringify({ ...result, stats }, null, 2), { mode: 0o600 });
      Object.assign(attempt, { status: 'finished', finishReason: result.finishReason, usage: result.usage,
        firstContentMs: result.firstContentMs, elapsedMs: result.elapsedMs, stats });
      await persist();
      console.log(JSON.stringify({ stage: 'finished', ...attempt }));
    } catch (error) {
      if (attempt) { attempt.status = 'failed-no-retry'; await persist(); }
      throw error;
    }
  }
  ledger.completed = true;
  await persist();
  console.log(JSON.stringify({ completed: true, attempts: ledger.attempts.length, furtherRequests: false }));
} catch (error) {
  // Never print YAML parse source, the endpoint response body or a secret-bearing stack.
  console.error(JSON.stringify({ failed: true, phase, code: error.code ?? null, reason: /^模型请求 HTTP \d+/.test(error.message) ? error.message : 'Comparison stopped; no automatic retry.', attempts: ledger?.attempts?.length ?? 0 }));
  process.exitCode = 1;
} finally {
  apiKey = '';
  await transport?.close();
}
