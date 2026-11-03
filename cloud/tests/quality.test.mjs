import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cappedCompletion, reserveQualityAttempt } from '../scripts/quality-core.mjs';
import { qualityFixture } from '../scripts/quality-fixture.mjs';
test('real-model diagnostic reserves before sending, requests at most 2000 output tokens and parses fragmented streaming without retaining reasoning', async () => {
  let reserved = false,
    requests = 0;
  const raw = [
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '不保存的测试推理' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '钟声。🌧️' } }] }),
    'data: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 7 } }),
    'data: [DONE]',
    '',
  ].join('\n\n');
  const bytes = new TextEncoder().encode(raw);
  const result = await cappedCompletion({
    endpoint: 'https://example.invalid',
    apiKey: 'synthetic-only',
    model: 'fixture',
    messages: [],
    reserve: async () => {
      reserved = true;
    },
    request: async (_, init) => {
      assert.equal(reserved, true);
      requests++;
      const body = JSON.parse(init.body);
      assert.equal(body.max_tokens, 2000);
      assert.equal(body.stream, true);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
            controller.close();
          },
        }),
      );
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.text, '钟声。🌧️');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.completion_tokens, 7);
  assert.ok(result.reasoningChars > 0);
  assert.equal(result.reasoning, undefined);
});
test('strict one-shot request budget counts reservations and refuses duplicate trials or a fourth call', () => {
  const ledger = { limit: 3, outputTokens: 2000, attempts: [] };
  for (const name of ['baseline', 'current', 'canon']) reserveQualityAttempt(ledger, name);
  assert.throws(() => reserveQualityAttempt(ledger, 'retry'), /额度已用完/);
  assert.throws(
    () => reserveQualityAttempt({ limit: 3, outputTokens: 2000, attempts: [{ name: 'same' }] }, 'same'),
    /已尝试/,
  );
});
test('no network call follows a failed durable reservation and model failures or truncated streams never retry or pretend success', async () => {
  let count = 0;
  const options = {
    endpoint: 'https://example.invalid',
    apiKey: 'synthetic',
    model: 'fixture',
    messages: [],
    reserve: async () => {},
    request: async () => {
      count++;
      return new Response('denied', { status: 402 });
    },
  };
  await assert.rejects(
    cappedCompletion({
      ...options,
      reserve: async () => {
        throw new Error('disk-full');
      },
    }),
    /disk-full/,
  );
  assert.equal(count, 0);
  await assert.rejects(cappedCompletion(options), /HTTP 402/);
  assert.equal(count, 1);
  await assert.rejects(
    cappedCompletion({
      ...options,
      request: async () => new Response('data: {"choices":[{"delta":{"content":"半份正文"}}]}\n\n'),
    }),
    /未完整结束/,
  );
});
test('quality comparison uses the actual legacy template and current prompt with identical synthetic facts, never user stories', async () => {
  const fixture = qualityFixture(
    await readFile(new URL('../../novel-writer-V4.4.3.html', import.meta.url), 'utf8'),
  );
  assert.equal(fixture.cases.length, 3);
  assert.match(fixture.cases[0].messages[1].content, /关键点标记提醒/);
  assert.match(fixture.cases[1].messages[1].content, /"template":\{"version":1,"key":"write"/);
  assert.match(fixture.cases[1].messages[1].content, /只追加新增续文/);
  assert.doesNotMatch(fixture.cases[1].messages[1].content, /executionPrompt|creativeRules/);
  for (const trial of fixture.cases.slice(0, 2)) {
    assert.match(trial.messages[1].content, /沈澄左手受伤/);
    assert.match(trial.messages[1].content, /未来备选规划/);
    assert.match(trial.messages[1].content, /组织身份未知/);
  }
  assert.throws(() => qualityFixture('not the legacy HTML'), /拒绝捏造对比基线/);
});
