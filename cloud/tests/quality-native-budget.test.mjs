import test from 'node:test';
import assert from 'node:assert/strict';
import { startQualityBoundary, boundedNativeRequest } from '../scripts/quality-native-budget.mjs';
test('native diagnostic caps output and fails closed on unknown protocol/limits', () => {
  const body = {
    max_tokens: 99999,
    messages: [],
    thinking: { type: 'enabled', budget_tokens: 3000 },
    tools: [],
  };
  assert.equal(boundedNativeRequest('/v1/messages', body, 'fixture').max_tokens, 4096);
  assert.equal(body.max_tokens, 99999);
  assert.equal(boundedNativeRequest('/v1/messages', body, 'fixture').thinking, body.thinking);
  for (const value of [null, 0, -1, 1.5])
    assert.throws(() => boundedNativeRequest('/v1/messages', { ...body, max_tokens: value }, 'fixture'));
  assert.throws(() => boundedNativeRequest('/chat/completions', body, 'fixture'));
  assert.throws(() => boundedNativeRequest('/v1/messages', { ...body, n: 2 }, 'fixture'));
});
test('native diagnostic durably counts concurrent auxiliary/failed attempts and never forwards a thirteenth call', async () => {
  let persisted = 0,
    forwarded = 0;
  const ledger = { limit: 12, outputTokens: 4096, attempts: [] };
  const boundary = await startQualityBoundary({
    ledger,
    model: 'fixture',
    apiKey: 'synthetic',
    persist: async () => {
      persisted = ledger.attempts.length;
    },
    completed: async () => {},
    request: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
      assert.ok(persisted >= ++forwarded);
      assert.equal(JSON.parse(init.body).max_tokens, 4096);
      assert.equal(init.redirect, 'error');
      return new Response('{}', { status: 402 });
    },
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        fetch(boundary.url + '/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': 'fixture-only-no-real-provider-key' },
          body: JSON.stringify({ max_tokens: 10000, messages: [] }),
        }).then(async (r) => {
          await r.text();
          return r.status;
        }),
      ),
    );
    assert.equal(forwarded, 12);
    assert.equal(results.filter((s) => s === 402).length, 12);
    assert.equal(ledger.attempts.length, 12);
  } finally {
    await boundary.close();
  }
});
test('failed budget persistence makes no upstream call', async () => {
  let forwarded = 0;
  const boundary = await startQualityBoundary({
    ledger: { limit: 12, outputTokens: 4096, attempts: [] },
    model: 'fixture',
    apiKey: 'synthetic',
    persist: async () => {
      throw new Error('disk');
    },
    completed: async () => {},
    request: async () => {
      forwarded++;
    },
  });
  try {
    await (
      await fetch(boundary.url + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'fixture-only-no-real-provider-key' },
        body: JSON.stringify({ max_tokens: 4096, messages: [] }),
      })
    ).text();
    assert.equal(forwarded, 0);
  } finally {
    await boundary.close();
  }
});
