import test from 'node:test';
import assert from 'node:assert/strict';
import {
  costReservation,
  reserveBeforeRequest,
  usageUpperCost,
  chargedOrReservedMicro,
  usageCacheUpperCost,
  queryDeepSeekBalance,
} from '../scripts/quality-cny-budget.mjs';
const body = { model: 'deepseek-flash', max_tokens: 4096, messages: [{ role: 'user', content: '独立场景' }] };
test('CNY budget reserves full peak/noncache input plus capped output, refuses overspend and keeps failed requests reserved', async () => {
  const ledger = { limitMicro: 5_000_000, attempts: [] };
  const r = costReservation(ledger, body);
  assert(r.inputTokenBound > Buffer.byteLength(JSON.stringify(body)));
  assert.equal(r.reserveMicro, r.inputTokenBound * 2 + 4096 * 8);
  let persisted = 0;
  await reserveBeforeRequest({
    ledger,
    body,
    persist: async () => {
      persisted++;
    },
    label: 'fixture',
  });
  assert.equal(persisted, 1);
  assert.equal(ledger.attempts[0].status, 'reserved');
  const insufficient = {
    limitMicro: 5_000_000,
    attempts: [{ reserveMicro: 5_000_000 - r.reserveMicro + 1 }],
  };
  assert.throws(() => costReservation(insufficient, body));
  await assert.rejects(() =>
    reserveBeforeRequest({
      ledger,
      body,
      persist: async () => {
        throw new Error('disk');
      },
      label: 'failed',
    }),
  );
  assert.equal(ledger.attempts.length, 2);
  assert.equal(
    usageUpperCost({ input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 200 }, body.model),
    3800,
  );
});

test('separate CNY 3 round reserves misses in full and settles only provider-confirmed cache reads at peak cache prices', () => {
  const ledger = { limitMicro: 3_000_000, attempts: [] };
  assert.throws(() => costReservation(ledger, body));
  const reserve = costReservation(ledger, body, 3_000_000);
  assert.equal(reserve.reserveMicro, reserve.inputTokenBound * 2 + 4096 * 8);
  const usage = {
    input_tokens: 100,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 1000,
    output_tokens: 200,
  };
  assert.equal(usageUpperCost(usage, body.model), 3900);
  assert.equal(usageCacheUpperCost(usage, body.model), 1940);
  assert.equal(
    usageCacheUpperCost({ input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 0 }, body.model),
    3,
  );
  assert.equal(usageCacheUpperCost({ input_tokens: 100, output_tokens: 200 }, body.model), 1800);
  assert.throws(() => usageCacheUpperCost({ output_tokens: 5 }, body.model));
  assert.throws(() => usageCacheUpperCost({ ...usage, cache_read_input_tokens: -1 }, body.model));
  assert.throws(() => usageCacheUpperCost(usage, 'unknown'));
});

test('balance query uses fixed official origin and returns only validated public balance fields, never credentials', async () => {
  const secret = 'fixture-only-key-for-balance';
  const transport = {
    request: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer ' + secret);
      return Response.json({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '40.07',
            granted_balance: '0.00',
            topped_up_balance: '40.07',
            secret,
          },
        ],
      });
    },
  };
  const b = await queryDeepSeekBalance(transport, secret);
  assert.equal(b.balances[0].total_balance, '40.07');
  assert(!JSON.stringify(b).includes(secret));
  await assert.rejects(() =>
    queryDeepSeekBalance(
      {
        request: async () =>
          Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'bad' }] }),
      },
      secret,
    ),
  );
  await assert.rejects(
    () => queryDeepSeekBalance({ request: async () => new Response('do-not-leak', { status: 401 }) }, secret),
    /Balance query HTTP 401/,
  );
});
test('CNY budget fails closed on altered authorization, model, output limits, hidden paid tools and nontext requests', () => {
  for (const ledger of [
    { limitMicro: 6_000_000, attempts: [] },
    { limitMicro: 5_000_000, attempts: [], closed: true },
  ])
    assert.throws(() => costReservation(ledger, body));
  for (const extra of [
    { model: 'unknown' },
    { max_tokens: 8193 },
    { max_tokens: 0 },
    { n: 2 },
    { max_output_tokens: 1 },
    { tools: [{ type: 'web_search_20250305' }] },
    { messages: [{ role: 'user', content: [{ type: 'image' }] }] },
  ])
    assert.throws(() => costReservation({ limitMicro: 5_000_000, attempts: [] }, { ...body, ...extra }));
});
test('only validated completed usage releases the unused reservation; unknown or failed charges retain their full bound', () => {
  assert.throws(() => usageUpperCost({ output_tokens: 10 }, 'deepseek-flash'));
  assert.throws(() => usageUpperCost({ input_tokens: 10 }, 'deepseek-flash'));
  const ledger = {
    limitMicro: 5_000_000,
    attempts: [
      { status: 'finished', reserveMicro: 100000, upperMicro: 20000 },
      { status: 'failed', reserveMicro: 100000 },
    ],
  };
  assert.equal(chargedOrReservedMicro(ledger), 120000);
  assert(costReservation(ledger, body));
  for (const upperMicro of [undefined, -1, 100001, 1.5])
    assert.throws(() =>
      chargedOrReservedMicro({ attempts: [{ status: 'finished', reserveMicro: 100000, upperMicro }] }),
    );
});

test('a separately authorized CNY 2 round cannot borrow from the old CNY 5 ceiling', async () => {
  const ledger = { limitMicro: 2_000_000, attempts: [] };
  assert.throws(() => costReservation(ledger, body));
  const r = costReservation(ledger, body, 2_000_000);
  assert.throws(() => costReservation({ limitMicro: 5_000_000, attempts: [] }, body, 2_000_000));
  assert.throws(() => costReservation(ledger, body, 7_000_000));
  assert.throws(() =>
    costReservation(
      { limitMicro: 2_000_000, attempts: [{ reserveMicro: 2_000_000 - r.reserveMicro + 1 }] },
      body,
      2_000_000,
    ),
  );
  await reserveBeforeRequest({
    ledger,
    body,
    approvedLimitMicro: 2_000_000,
    label: 'extra-only',
    persist: async () => {},
  });
  assert.equal(ledger.attempts.length, 1);
  ledger.closed = true;
  assert.throws(() => costReservation(ledger, body, 2_000_000));
});
