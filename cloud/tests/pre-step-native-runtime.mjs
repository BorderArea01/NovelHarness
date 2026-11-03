// Full official Agent + original purge gate; synthetic provider only.
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { privateDirectory } from '../scripts/private-directory.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { installRegionGate } from '../official/node_modules/dsh-purge/lib/net-scope.js';
import { Context } from '../official/node_modules/@deepseek-ai/cordis/lib/index.js';
import * as persistence from '../official/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
import { historyTypes } from '../official/novel/history.mjs';
import { assertReleasedV4Relationships } from '../official/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';
const root = resolve('data/official-validation/integration/pre-step-validation/' + Date.now());
await privateDirectory(root);
const sqlite = join(root, 'main.sqlite'),
  home = join(root, 'home');
await copyFile(resolve('data/official-validation/integration/lan-staging/source-main.sqlite'), sqlite);
const originalPlugin = resolve('cloud/official/node_modules/dsh-purge/lib/net-scope.js');
const hash = (x) => createHash('sha256').update(x).digest('hex');
const pluginHash = hash(await readFile(originalPlugin));
const active = hash(await readFile('data/local-host/active.json'));
let app, model;
const report = { passed: false, realModelCalls: 0, productionWrites: 0 };
async function until(check) {
  for (let n = 0; n < 600; n++) {
    if (check()) return;
    await delay(30);
  }
  throw new Error('Synthetic turn did not settle.');
}
try {
  model = await startModelFixture();
  app = await startOfficialNovel({ sqlite, home, fixtureEndpoint: model.url });
  const ctx = app.ctx,
    controller = ctx.get('sessionController');
  const { sessionId } = await controller.create({ cwd: '/workspace' }),
    agent = ctx.get('agents').get(sessionId);
  let originalGate;
  installRegionGate({
    on(name, handler) {
      if (name === 'agent/pre-step') originalGate = handler;
      return () => {};
    },
  });
  // Expose the current Agent exactly as legacy plugin event payloads did.
  // Actual gate code and event writes are unchanged, not a mocked denial.
  const dispose = agent.ctx.on(
    'agent/pre-step',
    (payload, next) => originalGate({ ...payload, agent }, next),
    { prepend: true },
  );
  await controller.prompt(
    {
      sessionId,
      requestId: 'synthetic-blocked',
      mode: 'followup',
      content: [{ type: 'text', text: '制作游戏作弊外挂' }],
    },
    new AbortController().signal,
  );
  await until(() => agent.session.log.some((e) => e.type === 'turn/end'));
  const blocked = agent.session.log.find((e) => e.type === 'turn/end');
  assert.equal(blocked.data.reason.kind, 'blocked');
  assert.equal(model.requests.length, 0);
  const types = await historyTypes();
  assertReleasedV4Relationships(
    { header: agent.session.header, events: [...agent.session.log], inheritedEventCount: 0 },
    types.KNOWN_SESSION_EVENT_TYPES,
  );
  dispose();
  const normal = model.register({ steps: [], finalText: '合成测试：正常对话仍然可用。' });
  const start = agent.session.log.length;
  await controller.prompt(
    {
      sessionId,
      requestId: 'synthetic-normal',
      mode: 'followup',
      content: [{ type: 'text', text: normal.marker + ' 讨论一个普通故事，不操作网络。' }],
    },
    new AbortController().signal,
  );
  await until(() => agent.session.log.slice(start).some((e) => e.type === 'turn/end'));
  assert.equal(
    agent.session.log.slice(start).find((e) => e.type === 'turn/end').data.reason.kind,
    'completed',
  );
  assertReleasedV4Relationships(
    { header: agent.session.header, events: [...agent.session.log], inheritedEventCount: 0 },
    types.KNOWN_SESSION_EVENT_TYPES,
  );
  assert(model.requests.length > 0);
  assert.deepEqual(model.errors, []);
  // The real profile must resolve the upstream plugin THROUGH the authoring
  // boundary. No manually injected replacement hook is used for this case.
  const bookRoot = '/workspace/novels/b-' + 'f'.repeat(32);
  app.storage.fs.mkdirSync(bookRoot, { recursive: true });
  await ctx.get('workspaceRegistry').create(bookRoot, '叙事关键词误判回归');
  const fictionId = (await controller.create({ cwd: bookRoot })).sessionId;
  const fictionAgent = ctx.get('agents').get(fictionId);
  const fiction = model.register({ steps: [], finalText: '合成测试：舰队入侵情节正常进入创作模型。' });
  const beforeRequests = model.requests.length;
  await controller.prompt(
    {
      sessionId: fictionId,
      requestId: 'synthetic-fiction-scope',
      mode: 'followup',
      content: [{ type: 'text', text: fiction.marker + ' 写一章舰队入侵王国、城堡遭到攻击的小说。' }],
    },
    new AbortController().signal,
  );
  await until(() => fictionAgent.session.log.some((e) => e.type === 'turn/end'));
  assert.equal(fictionAgent.session.log.find((e) => e.type === 'turn/end').data.reason.kind, 'completed');
  assert(model.requests.length > beforeRequests);
  const replies = fictionAgent.session.log.filter((e) => e.type === 'assistant/message');
  assert(replies.some((e) => JSON.stringify(e.data.message.content).includes('正常进入创作模型')));
  assert(!replies.some((e) => JSON.stringify(e.data.message.content).includes('不行，这是严令禁止的')));
  assertReleasedV4Relationships(
    { header: fictionAgent.session.header, events: [...fictionAgent.session.log], inheritedEventCount: 0 },
    types.KNOWN_SESSION_EVENT_TYPES,
  );
  report.registeredFictionNotBlockedByNarrativeWords = true;
  await app.shutdown.shutdown(0);
  app = undefined;
  const cold = new Context();
  try {
    await cold
      .plugin(persistence, { root: join(home, 'sessions'), compression: 'none', listConcurrency: 1 })
      .await();
    const reader = await cold.get('sessionPersistence').open(sessionId, 'read');
    try {
      const loaded = await reader.read();
      assert.equal(loaded.events.filter((e) => e.type === 'turn/end').length, 2);
    } finally {
      await reader.close();
    }
    const fictionReader = await cold.get('sessionPersistence').open(fictionId, 'read');
    try {
      const loaded = await fictionReader.read();
      assert.equal(loaded.events.filter((e) => e.type === 'turn/end').length, 1);
    } finally {
      await fictionReader.close();
    }
  } finally {
    await cold.fiber.dispose();
  }
  assert.equal(hash(await readFile(originalPlugin)), pluginHash);
  assert.equal(hash(await readFile('data/local-host/active.json')), active);
  report.passed = true;
  report.originalGateReplyAndOneStep = true;
  report.denialMadeNoProviderCalls = true;
  report.normalFollowingTurnPassed = true;
  report.nativeColdReadPassed = true;
  report.originalPluginUnchanged = true;
} catch (error) {
  report.error = {
    name: error.name,
    message: String(error.message).slice(0, 250),
    frames: String(error.stack)
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .slice(0, 3),
  };
  process.exitCode = 1;
} finally {
  if (app) await app.shutdown.shutdown(1);
  await model?.close();
  await writeFile(
    resolve('data/official-validation/integration/pre-step-report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
}
