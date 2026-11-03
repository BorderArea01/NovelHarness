// Test-only budget owner. No production model route or account setting changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CNY_LIMIT_MICRO = 5_000_000;
export const PEAK_RATES = Object.freeze({
  'deepseek-flash': Object.freeze({ input: 2, output: 8 }),
  'deepseek-v4-pro': Object.freeze({ input: 9, output: 27 }),
});
// Official 2026-10-30 peak cached-input prices, CNY / million tokens.
// Existing sealed rounds retain their original full-uncached accounting.
export const CACHE_READ_PEAK_RATES = Object.freeze({
  'deepseek-flash': 0.04,
  'deepseek-v4-pro': 0.3,
});
export function chargedOrReservedMicro(ledger) {
  return ledger.attempts.reduce((n, a) => {
    assert(Number.isSafeInteger(a.reserveMicro) && a.reserveMicro > 0);
    if (a.status === 'finished') {
      assert(Number.isSafeInteger(a.upperMicro) && a.upperMicro >= 0 && a.upperMicro <= a.reserveMicro);
      return n + a.upperMicro;
    }
    return n + a.reserveMicro; // Failed/interrupted requests are never refunded.
  }, 0);
}
export function costReservation(ledger, body, approvedLimitMicro = CNY_LIMIT_MICRO) {
  assert(
    [CNY_LIMIT_MICRO, 2_000_000, 3_000_000].includes(approvedLimitMicro),
    'Unknown approved round limit.',
  );
  assert.equal(ledger.limitMicro, approvedLimitMicro, 'Ledger and explicit round authorization differ.');
  assert(!ledger.closed, 'Budget is closed.');
  const rates = PEAK_RATES[body.model];
  assert(rates && Array.isArray(body.messages), 'Unknown model or protocol.');
  assert(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= 8192);
  assert(!body.n || body.n === 1);
  assert(!body.max_output_tokens && !body.max_completion_tokens);
  const raw = JSON.stringify(body);
  assert(Buffer.byteLength(raw) <= 256 * 1024, 'Diagnostic request too large.');
  // Text/tool JSON only: no image, file, server-search or remote-content costs.
  function textOnly(v) {
    if (!v || typeof v !== 'object') return;
    if (['image', 'document', 'file', 'server_tool_use'].includes(v.type))
      throw new Error('Non-text request refused.');
    for (const child of Object.values(v)) textOnly(child);
  }
  textOnly(body);
  assert(!(body.tools ?? []).some((t) => /web_search|web_fetch|server_/.test(t.type ?? '')));
  const inputTokenBound = Buffer.byteLength(raw) + 8192;
  const reserveMicro = inputTokenBound * rates.input + body.max_tokens * rates.output;
  const spent = chargedOrReservedMicro(ledger);
  assert(spent + reserveMicro <= approvedLimitMicro, 'Insufficient reserved CNY budget; not forwarded.');
  return { reserveMicro, inputTokenBound, requestHash: createHash('sha256').update(raw).digest('hex') };
}
export async function reserveBeforeRequest({
  ledger,
  body,
  persist,
  label,
  approvedLimitMicro = CNY_LIMIT_MICRO,
}) {
  const estimate = costReservation(ledger, body, approvedLimitMicro);
  const attempt = {
    number: ledger.attempts.length + 1,
    label,
    model: body.model,
    maxTokens: body.max_tokens,
    ...estimate,
    status: 'reserved',
    at: new Date().toISOString(),
  };
  ledger.attempts.push(attempt);
  await persist(); // A failed write must prevent the network request.
  return attempt;
}
export function usageUpperCost(usage, model) {
  const rates = PEAK_RATES[model];
  assert(rates);
  assert(
    Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens),
    'Incomplete usage cannot release a reservation.',
  );
  for (const field of [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens',
  ])
    assert(Number.isSafeInteger(usage[field] ?? 0) && (usage[field] ?? 0) >= 0);
  return (
    ((usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)) *
      rates.input +
    (usage.output_tokens ?? 0) * rates.output
  );
}

export function usageCacheUpperCost(usage, model) {
  const uncached = usageUpperCost(usage, model);
  const read = usage.cache_read_input_tokens ?? 0;
  return Math.ceil(uncached - read * PEAK_RATES[model].input + read * CACHE_READ_PEAK_RATES[model]);
}

export async function queryDeepSeekBalance(transport, key) {
  assert(typeof key === 'string' && key.length >= 16);
  const r = await transport.request('https://api.deepseek.com/user/balance', {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + key },
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error('Balance query HTTP ' + r.status);
  }
  const b = await r.json();
  assert(typeof b.is_available === 'boolean' && Array.isArray(b.balance_infos));
  return {
    checkedAt: new Date().toISOString(),
    available: b.is_available,
    balances: b.balance_infos.map((v) => {
      assert(['CNY', 'USD'].includes(v.currency));
      const row = { currency: v.currency };
      for (const field of ['total_balance', 'granted_balance', 'topped_up_balance']) {
        assert(typeof v[field] === 'string' && /^-?[0-9]+(?:\.[0-9]+)?$/.test(v[field]));
        row[field] = v[field];
      }
      return row;
    }),
  };
}

export async function readCompletion(response, { progress = () => {}, started = Date.now() } = {}) {
  assert(response.ok, 'Diagnostic HTTP ' + response.status);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    text = '',
    bytes = 0,
    done = false,
    finishReason = null,
    reasoningCharacters = 0;
  const usage = {};
  function line(value) {
    if (!value.startsWith('data:')) return;
    const e = JSON.parse(value.slice(5));
    if (e.type === 'error') throw new Error('Provider stream failed.');
    if (e.type === 'message_start') Object.assign(usage, e.message?.usage);
    if (e.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta') text += e.delta.text;
      if (e.delta?.type === 'thinking_delta') reasoningCharacters += e.delta.thinking?.length ?? 0;
      progress({ characters: text.length, elapsedMs: Date.now() - started });
    }
    if (e.type === 'message_delta') {
      Object.assign(usage, e.usage);
      finishReason = e.delta?.stop_reason;
    }
    if (e.type === 'message_stop') done = true;
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert(bytes <= 4 * 1024 * 1024, 'Response bound exceeded.');
      buffer += decoder.decode(chunk.value, { stream: true });
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, n).replace(/\r$/, ''));
        buffer = buffer.slice(n + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer.trim());
    assert(done && text.trim() && finishReason === 'end_turn', 'Incomplete/truncated prose.');
    assert(Number.isSafeInteger(usage.output_tokens), 'Missing usage.');
    return { text, usage, finishReason, reasoningCharacters, elapsedMs: Date.now() - started };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
