// Explicit owner budget 2026-10-30: CNY 5 total across ALL batches and failures.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from './private-directory.mjs';
import { verificationTransport } from './verification-transport.mjs';
import { resolveInjectText } from '../official/node_modules/dsh-purge/lib/rules.js';
import {
  reserveBeforeRequest,
  usageUpperCost,
  readCompletion,
  CNY_LIMIT_MICRO,
  PEAK_RATES,
  chargedOrReservedMicro,
} from './quality-cny-budget.mjs';
import {
  SCENES,
  LEAN_PROSE,
  LIVED_PROSE,
  SCENE_PROSE,
  NOVEL_PROSE,
  CRAFT_PROSE,
  FOCUSED_PROSE,
  COMPACT_PROSE,
} from './dialogue-eval-fixtures.mjs';
import { prepareTemplate, compileTemplate } from '../worker/prompt-templates.mjs';

const directory = resolve('data/official-validation/integration/dialogue-quality-5cny-20261030');
const home = resolve('data/official-validation/integration/lan-staging/home');
const require = createRequire(new URL('../official/package.json', import.meta.url));
const { parse } = require('yaml');
let ledger,
  transport,
  locked = false,
  apiKey = '',
  phase = 'authorization';
const ledgerPath = join(directory, 'ledger.json');
const persist = async () => {
  await writeFile(ledgerPath + '.pending', JSON.stringify(ledger, null, 2), { mode: 0o600 });
  await rename(ledgerPath + '.pending', ledgerPath);
};
try {
  assert(process.argv.includes('--owner-approved-5cny-20261030'));
  assert.equal(
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    '2026-10-30',
  );
  await privateDirectory(directory);
  await writeFile(join(directory, 'runner.lock'), String(process.pid), { flag: 'wx', mode: 0o600 });
  locked = true;
  try {
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    ledger = {
      format: 'owner-prose-quality-cny-20261030-v1',
      limitMicro: CNY_LIMIT_MICRO,
      pricingSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      pricing: 'peak, all input uncached; full byte/framing/output reservation; failures retain reservations',
      rates: PEAK_RATES,
      attempts: [],
    };
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 });
  }
  assert.equal(ledger.format, 'owner-prose-quality-cny-20261030-v1');
  assert.equal(ledger.limitMicro, CNY_LIMIT_MICRO);
  assert.deepEqual(ledger.rates, PEAK_RATES);
  if (process.argv.includes('--resume-owner-approved-20261030')) {
    assert(ledger.closed === true, 'Only the existing closed round can resume.');
    assert(chargedOrReservedMicro(ledger) < CNY_LIMIT_MICRO);
    ledger.resumptions ??= [];
    ledger.resumptions.push({
      at: new Date().toISOString(),
      reason: 'Owner requested further validation within the same CNY 5 total.',
      attempts: ledger.attempts.length,
      heldMicro: chargedOrReservedMicro(ledger),
    });
    ledger.closed = false;
    await persist();
  }
  if (process.argv.includes('--close')) {
    ledger.closed = true;
    await persist();
  } else if (!process.argv.includes('--resume-owner-approved-20261030')) {
    phase = 'configuration';
    const profile = parse(
      await readFile(join(home, 'profiles/novel-lab-persistent/cordis.patch.yml'), 'utf8'),
    );
    const selection = profile.find((r) => r.id === 'agent-default-model')?.config;
    assert.equal(selection?.provider, 'deepseek-official');
    assert(PEAK_RATES[selection.model]);
    const credentials = parse(await readFile(join(home, '.credentials.yaml'), 'utf8'));
    apiKey = credentials.refs?.DEEPSEEK_API_KEY;
    assert(typeof apiKey === 'string' && apiKey.length >= 16);
    const operator = resolveInjectText(home);
    assert.equal(operator.source, 'default');
    const deployed = await import(
      pathToFileURL(resolve('data/official-validation/integration/baseline/worker/prompt-templates.mjs'))
    );
    const batch = process.env.NOVEL_QUALITY_BATCH ?? '01';
    assert(/^\d{2}$/.test(batch));
    const jobs = JSON.parse(await readFile(join(directory, 'batch-' + batch + '.json'), 'utf8'));
    assert(Array.isArray(jobs) && jobs.length > 0 && jobs.length <= 12);
    transport = await verificationTransport();
    for (const job of jobs) {
      assert(/^[a-z0-9-]{1,64}$/.test(job.label));
      assert(
        ['baseline', 'local', 'lean', 'lived', 'scene', 'novel', 'craft', 'focused', 'compact'].includes(
          job.variant,
        ) && SCENES[job.scene],
      );
      assert(['none', 'low', 'high', 'max'].includes(job.effort ?? 'none'));
      assert(job.model === undefined || PEAK_RATES[job.model]);
      assert(job.operator === undefined || job.operator === 'off');
      assert(job.wire === undefined || job.wire === 'plain');
      const existing = ledger.attempts.find((a) => a.label === job.label);
      if (existing) {
        assert.equal(
          existing.status,
          'finished',
          'A previous incomplete/failed request is counted, not retried.',
        );
        continue;
      }
      const scene = SCENES[job.scene],
        root = '/workspace/novels/b-' + '0'.repeat(32);
      const rulesText = JSON.stringify({ savedPrompts: {}, project: {} });
      const input = {
        key: 'write',
        book: { title: scene.title, root },
        mode: 'write',
        rulesText,
        outline: { chapter: 1, title: scene.title, summary: scene.summary },
      };
      const template =
        job.variant === 'baseline'
          ? deployed.prepareTemplate(input)
          : job.variant === 'local'
            ? prepareTemplate(input)
            : prepareTemplate({
                ...input,
                rulesText: JSON.stringify({
                  savedPrompts: {
                    write:
                      job.variant === 'compact'
                        ? COMPACT_PROSE
                        : job.variant === 'focused'
                          ? FOCUSED_PROSE
                          : job.variant === 'craft'
                            ? CRAFT_PROSE
                            : job.variant === 'novel'
                              ? NOVEL_PROSE
                              : job.variant === 'scene'
                                ? SCENE_PROSE
                                : job.variant === 'lived'
                                  ? LIVED_PROSE
                                  : LEAN_PROSE,
                  },
                  project: {},
                }),
              });
      // All variants expose the same template metadata and material format.
      template.source = 'default';
      const common = {
        authorRequest: scene.request,
        materials: {
          [root + '/seed.md']: scene.seed,
          [root + '/setting.md']: scene.setting,
          [root + '/outline.json']: JSON.stringify([input.outline]),
          [root + '/memory.json']: '{"facts":[],"guesses":[]}',
          [root + '/rules.json']: rulesText,
          [root + '/canon.json']: '{"characters":[],"locations":[],"relations":[]}',
        },
      };
      if (job.revise) {
        assert(/^[a-z0-9-]{1,64}$/.test(job.revise));
        const old = ledger.attempts.find((a) => a.label === job.revise && a.status === 'finished');
        assert(old, 'Revision must identify a finished synthetic sample.');
        common.draftToRevise = await readFile(join(directory, job.revise + '.txt'), 'utf8');
        common.authorRequest +=
          ' 本次对已有草稿作实质修订：保留事件与结局，通读后重写不可信的应答、宣读设定的句子和断裂的动作，删掉无信息的往返，核对道具只能证明其实际观察到的事；不要逐句换同义词或加解释圆场，也不删成剧情梗概。直接交付完整修订正文。';
      }
      if (job.long === true) common.authorRequest = common.authorRequest.replace('700—900', '1800—2200');
      if (job.audit === true) {
        assert(/^native-draft-\d{2}\.txt$/.test(job.source));
        common.draftToReview = await readFile(join(directory, job.source), 'utf8');
        common.authorRequest = '审读给定小说草稿，只找实际存在的叙事问题，不写新正文。';
        template.body =
          '通读草稿及本书资料，检查人物与动作主体是否一致，人物的身体状态、位置和所持物是否允许完成动作，物件状态与因果是否衔接，哪些对白或叙述只是在宣读设定、空转或换词。每个确切问题给出原句、为什么有问题、应怎样调整；没有证据就不要猜作者意图，不把有作用的短答或沉默一概算问题，不给分数，不列泛泛禁词，不擅自改变情节。只输出有原文依据的问题清单，未发现的问题不要凑。';
      }
      const body = {
        model: job.model ?? selection.model,
        max_tokens: ['low', 'high', 'max'].includes(job.effort) ? 8192 : 3600,
        stream: true,
        system:
          (job.operator === 'off' ? '你是一位中文小说作者。按作者要求和给定资料写正文。' : operator.text) +
          '\n\n本次是独立小说片段评测，全部资料已内联，不提供工具；只返回作品正文，不声称读取或保存文件，不返回路径或执行汇报。',
        thinking: { type: ['low', 'high', 'max'].includes(job.effort) ? 'enabled' : 'disabled' },
        ...(['low', 'high', 'max'].includes(job.effort)
          ? { output_config: { effort: job.effort } }
          : { temperature: 0.8 }),
        messages: [
          {
            role: 'user',
            content:
              job.wire === 'plain'
                ? common.authorRequest +
                  '\n\n' +
                  Object.entries(common.materials)
                    .map(([p, t]) => '【资料 ' + p + '】\n' + t)
                    .join('\n\n') +
                  '\n\n【所选正文模板】\n' +
                  template.body
                : JSON.stringify({ ...common, task: { kind: 'prose', template } }),
          },
        ],
      };
      await writeFile(
        join(directory, job.label + '-input.json'),
        JSON.stringify({ job, ...common, template }, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      phase = job.label;
      const attempt = await reserveBeforeRequest({ ledger, body, persist, label: job.label });
      console.log(
        JSON.stringify({
          stage: 'reserved',
          label: job.label,
          model: body.model,
          number: attempt.number,
          budgetHeldUpperCny: chargedOrReservedMicro(ledger) / 1e6,
        }),
      );
      try {
        const started = Date.now();
        let last = 0;
        const response = await transport.request('https://api.deepseek.com/anthropic/v1/messages', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(180000),
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('HTTP ' + response.status);
        }
        const result = await readCompletion(response, {
          started,
          progress: (p) => {
            if (p.elapsedMs - last > 10000) {
              last = p.elapsedMs;
              console.log(JSON.stringify({ stage: 'streaming', label: job.label, ...p }));
            }
          },
        });
        assert(result.usage.output_tokens <= body.max_tokens);
        const upperMicro = usageUpperCost(result.usage, body.model);
        assert(upperMicro <= attempt.reserveMicro, 'Observed cost exceeds reservation; stop.');
        await writeFile(join(directory, job.label + '.txt'), result.text, { flag: 'wx', mode: 0o600 });
        await writeFile(
          join(directory, job.label + '.json'),
          JSON.stringify({ ...result, text: undefined }, null, 2),
          { flag: 'wx', mode: 0o600 },
        );
        Object.assign(attempt, {
          status: 'finished',
          usage: result.usage,
          upperMicro,
          elapsedMs: result.elapsedMs,
          finishReason: result.finishReason,
        });
        await persist();
        console.log(
          JSON.stringify({
            stage: 'finished',
            label: job.label,
            outputTokens: result.usage.output_tokens,
            upperCny: upperMicro / 1e6,
          }),
        );
      } catch (e) {
        attempt.status = 'failed-counted-no-retry';
        await persist();
        throw e;
      }
    }
  }
  console.log(
    JSON.stringify({
      attempts: ledger.attempts.length,
      budgetHeldUpperCny: chargedOrReservedMicro(ledger) / 1e6,
      usageUpperCny: ledger.attempts.reduce((n, a) => n + (a.upperMicro ?? a.reserveMicro), 0) / 1e6,
      closed: ledger.closed === true,
      bookWrites: 0,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      failed: true,
      phase,
      code: e.code ?? null,
      message: /^HTTP \d+$/.test(e.message)
        ? e.message
        : 'Stopped without automatic retry; budget and originals retained.',
    }),
  );
  process.exitCode = 1;
} finally {
  apiKey = '';
  await transport?.close();
  if (locked) await unlink(join(directory, 'runner.lock'));
}
