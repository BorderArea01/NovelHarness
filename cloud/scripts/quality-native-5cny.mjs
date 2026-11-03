// Real original Agent + tool loop; new empty SQLite and home, shared CNY 5 ledger.
// Only run with the existing shared-host resource guard after LAN is stopped.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { privateDirectory } from './private-directory.mjs';
import { verificationTransport } from './verification-transport.mjs';
import {
  reserveBeforeRequest,
  usageUpperCost,
  CNY_LIMIT_MICRO,
  PEAK_RATES,
  chargedOrReservedMicro,
  usageCacheUpperCost,
  queryDeepSeekBalance,
} from './quality-cny-budget.mjs';
import { startModelFixture } from '../tests/fixtures/model-server.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { openNovelStorage } from '../official/novel/storage.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import {
  SCENES,
  NOVEL_PROSE,
  CLARITY_PROSE,
  PLAIN_PROSE,
  NATURAL_PROSE,
  AUTONOMOUS_PROSE,
} from './dialogue-eval-fixtures.mjs';

const threeBudget = process.argv.includes('--owner-approved-extra3cny-20261030');
const twoBudget = process.argv.includes('--owner-approved-extra2cny-20261030');
const extraBudget = twoBudget || threeBudget;
const closeBudget = process.argv.includes('--close-budget');
const approvedLimitMicro = threeBudget ? 3_000_000 : twoBudget ? 2_000_000 : CNY_LIMIT_MICRO;
const roundName = threeBudget ? 'extra3cny' : 'extra2cny';
const directory = resolve(
  'data/official-validation/integration/' +
    (extraBudget ? 'dialogue-quality-' + roundName + '-20261030' : 'dialogue-quality-5cny-20261030'),
);
const round = process.env.NOVEL_NATIVE_ROUND ?? '01';
assert(/^\d{2}$/.test(round));
const sceneName = process.env.NOVEL_NATIVE_SCENE;
assert(sceneName === undefined || Object.hasOwn(SCENES, sceneName));
const testEffort = process.env.NOVEL_NATIVE_EFFORT;
assert(testEffort === undefined || testEffort === 'low');
const singlePass = process.env.NOVEL_NATIVE_TEMPLATE === 'single-pass';
const clarity = process.env.NOVEL_NATIVE_TEMPLATE === 'clarity';
const plain = process.env.NOVEL_NATIVE_TEMPLATE === 'plain';
const natural = process.env.NOVEL_NATIVE_TEMPLATE === 'natural';
const autonomous = process.env.NOVEL_NATIVE_TEMPLATE === 'autonomous';
assert(
  process.env.NOVEL_NATIVE_TEMPLATE === undefined || singlePass || clarity || plain || natural || autonomous,
);
const testModel = process.env.NOVEL_NATIVE_MODEL;
assert(testModel === undefined || testModel === 'deepseek-v4-pro');
const testTemperature = process.env.NOVEL_NATIVE_TEMPERATURE;
assert(testTemperature === undefined || (threeBudget && testTemperature === '0.45' && !testEffort));
const minimumLength = process.env.NOVEL_NATIVE_MINIMUM;
assert(minimumLength === undefined || (threeBudget && sceneName === 'fantasy' && minimumLength === '1600'));
const ledgerPath = join(directory, 'ledger.json'),
  marker = 'CNY_NATIVE_STORY_ONLY_20261030';
const homeSource = resolve('data/official-validation/integration/lan-staging/home');
const require = createRequire(new URL('../official/package.json', import.meta.url));
const { parse } = require('yaml');
let ledger,
  locked = false,
  transport,
  fixture,
  server,
  app,
  apiKey = '',
  expectedTemplate = '',
  agent;
function containsTemplate(value) {
  if (typeof value === 'string') {
    if (expectedTemplate && value === expectedTemplate) return true;
    if (/^[\[{]/.test(value)) {
      try {
        return containsTemplate(JSON.parse(value));
      } catch {
        return false;
      }
    }
    return false;
  }
  return !!value && typeof value === 'object' && Object.values(value).some(containsTemplate);
}
const report = { passed: false, productionWrites: 0, freshEmptyDatabase: true, bookWrites: 'synthetic-only' };
const persist = async () => {
  await writeFile(ledgerPath + '.pending', JSON.stringify(ledger, null, 2), { mode: 0o600 });
  await rename(ledgerPath + '.pending', ledgerPath);
};
let queue = Promise.resolve();
const serial = (fn) => {
  const r = queue.then(fn);
  queue = r.catch(() => {});
  return r;
};
try {
  assert(
    [threeBudget, twoBudget, process.argv.includes('--owner-approved-5cny-20261030')].filter(Boolean)
      .length === 1,
    'Exactly one round authorization is required.',
  );
  assert.equal(
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    '2026-10-30',
  );
  await privateDirectory(directory);
  await writeFile(join(directory, 'runner.lock'), String(process.pid), { flag: 'wx', mode: 0o600 });
  locked = true;
  let oldLedgerHash, priorExtraHash;
  if (extraBudget) {
    const previous = await readFile(
      resolve('data/official-validation/integration/dialogue-quality-5cny-20261030/ledger.json'),
    );
    const old = JSON.parse(previous);
    assert(old.closed === true && old.limitMicro === CNY_LIMIT_MICRO);
    oldLedgerHash = createHash('sha256').update(previous).digest('hex');
    if (threeBudget) {
      const prior = await readFile(
        resolve('data/official-validation/integration/dialogue-quality-extra2cny-20261030/ledger.json'),
      );
      assert(JSON.parse(prior).closed === true);
      priorExtraHash = createHash('sha256').update(prior).digest('hex');
    }
  }
  try {
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  } catch (e) {
    if (!extraBudget || e.code !== 'ENOENT') throw e;
    ledger = {
      format: 'owner-prose-quality-' + roundName + '-20261030-v1',
      limitMicro: approvedLimitMicro,
      rates: PEAK_RATES,
      oldLedgerHash,
      ...(threeBudget ? { priorExtraHash, accounting: 'cache-aware-peak-upper' } : {}),
      attempts: [],
      authorization:
        'Owner explicitly added CNY ' +
        approvedLimitMicro / 1e6 +
        ' for continued validation and tuning; previous rounds remain sealed.',
    };
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 });
  }
  assert.equal(ledger.limitMicro, approvedLimitMicro);
  assert.deepEqual(ledger.rates, PEAK_RATES);
  if (extraBudget) {
    assert.equal(ledger.format, 'owner-prose-quality-' + roundName + '-20261030-v1');
    assert.equal(ledger.oldLedgerHash, oldLedgerHash);
    if (threeBudget) {
      assert.equal(ledger.priorExtraHash, priorExtraHash);
      assert.equal(ledger.accounting, 'cache-aware-peak-upper');
    }
  }
  if (closeBudget) {
    ledger.closed = true;
    await persist();
    report.passed = true;
    report.budgetClosed = true;
    report.attempts = ledger.attempts.length;
    report.budgetHeldUpperCny = chargedOrReservedMicro(ledger) / 1e6;
    if (threeBudget) {
      apiKey = parse(await readFile(join(homeSource, '.credentials.yaml'), 'utf8')).refs?.DEEPSEEK_API_KEY;
      transport = await verificationTransport();
    }
  } else {
    assert(!ledger.closed);
    assert(
      !ledger.attempts.some(
        (a) =>
          a.label.startsWith('native-' + round + '-') || (round === '01' && /^native-\d+$/.test(a.label)),
      ),
      'Native test already attempted; no automatic repeat.',
    );
    const credentials = parse(await readFile(join(homeSource, '.credentials.yaml'), 'utf8'));
    apiKey = credentials.refs?.DEEPSEEK_API_KEY;
    assert(apiKey?.length >= 16);
    const profile = parse(
      await readFile(join(homeSource, 'profiles/novel-lab-persistent/cordis.patch.yml'), 'utf8'),
    );
    const selection = profile.find((r) => r.id === 'agent-default-model')?.config;
    assert.equal(selection?.model, 'deepseek-flash');
    assert.equal(selection.reasoningEffort, 'off');
    const work = join(directory, 'native-' + Date.now());
    await privateDirectory(work);
    const sqlite = join(work, 'main.sqlite');
    await assert.rejects(
      () => stat(sqlite),
      (e) => e.code === 'ENOENT',
    );
    // Copy schema only, never any original manuscript, credential or session rows.
    const source = new Database(resolve('data/official-validation/integration/lan-staging/main.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const blank = new Database(sqlite);
    try {
      for (const row of source
        .prepare(
          "SELECT sql FROM sqlite_master WHERE (tbl_name LIKE 'vfs_%' OR tbl_name LIKE '_vfs_%') AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name",
        )
        .all())
        blank.exec(row.sql);
      blank.prepare('INSERT INTO vfs_meta(k,v) VALUES(?,?)').run('schema_version', 8);
      blank.prepare('INSERT INTO vfs_meta(k,v) VALUES(?,?)').run('rev', 0);
      blank
        .prepare("INSERT INTO vfs_nodes(inode,type,mode,mtime,rev,size) VALUES(1,'dir',493,?,0,0)")
        .run(Date.now());
      assert.equal(blank.prepare('SELECT count(*) n FROM vfs_dirents').get().n, 0);
    } finally {
      source.close();
      blank.close();
    }
    const storage = await openNovelStorage(sqlite);
    try {
      storage.fs.mkdirSync('/workspace', { recursive: true });
      storage.fs.mkdirSync('/tmp', { recursive: true });
    } finally {
      storage.close();
    }
    transport = await verificationTransport();
    if (threeBudget) {
      const balance = await queryDeepSeekBalance(transport, apiKey);
      ledger.balances ??= [];
      ledger.balances.push({ round, phase: 'before', ...balance });
      await persist();
      report.balanceBefore = balance;
      console.log(JSON.stringify({ stage: 'balance-before', ...balance }));
    }
    fixture = await startModelFixture();
    let forwarded = 0;
    server = createServer(async (req, res) => {
      let attempt;
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers['x-api-key'], 'fixture-only-no-real-provider-key');
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          assert(Buffer.byteLength(raw) <= 256 * 1024);
        }
        const body = JSON.parse(raw),
          isMain = (body.tools ?? []).some((t) => t.name === 'novel_proposal_submit');
        let response;
        if (!isMain) {
          response = await fetch(fixture.url + '/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-only-no-real-provider-key' },
            body: raw,
          });
        } else {
          assert(JSON.stringify(body.messages).includes(marker));
          body.model = testModel ?? selection.model;
          report.model = body.model;
          report.virtualShellFactsReachedProvider =
            body.tools.find((t) => t.name === 'bash')?.description.includes('SQLite 虚拟 Bash') ?? false;
          // Explicit diagnostic comparison only. Never writes the owner's model
          // profile or silently changes a running author's generation settings.
          if (testEffort) {
            body.thinking = { type: 'enabled' };
            body.output_config = { effort: testEffort };
            delete body.temperature;
          }
          if (testTemperature) body.temperature = Number(testTemperature);
          report.temperature = body.temperature ?? 'provider-default';
          report.reasoningEffort = testEffort ?? 'off';
          // The loopback fixture's 2048-token ceiling is for synthetic tools,
          // not the configured real provider. A capped real prose run needs
          // room to return a full chapter in a single tool call. Test only;
          // no native profile, production provider, or ledger limit is changed.
          report.fixtureMaxTokens = body.max_tokens;
          body.max_tokens = 8192;
          report.forwardedMaxTokens = body.max_tokens;
          // No server-side Search/Fetch in this independent story test.
          body.tools = (body.tools ?? []).filter((t) => !/^web_search_|^web_fetch_/.test(t.type ?? ''));
          attempt = await serial(() =>
            reserveBeforeRequest({
              ledger,
              body,
              persist,
              approvedLimitMicro,
              label: 'native-' + round + '-' + ++forwarded,
            }),
          );
          report.templateReachedProvider ||= containsTemplate(body.messages);
          report.requestSizes ??= [];
          report.requestSizes.push({
            systemBytes: Buffer.byteLength(JSON.stringify(body.system ?? '')),
            toolsBytes: Buffer.byteLength(JSON.stringify(body.tools)),
            messagesBytes: Buffer.byteLength(JSON.stringify(body.messages)),
            totalBytes: Buffer.byteLength(JSON.stringify(body)),
          });
          console.log(JSON.stringify({ stage: 'native-request', number: forwarded }));
          response = await transport.request('https://api.deepseek.com/anthropic/v1/messages', {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(120000),
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
        }
        res.writeHead(response.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        let buffer = '',
          bytes = 0;
        const decoder = new TextDecoder(),
          usage = {};
        let stopReason;
        const line = (s) => {
          if (!s.startsWith('data:')) return;
          const e = JSON.parse(s.slice(5));
          if (e.type === 'message_start') Object.assign(usage, e.message?.usage);
          if (e.type === 'message_delta') {
            Object.assign(usage, e.usage);
            stopReason = e.delta?.stop_reason;
          }
        };
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          assert(bytes < 4 * 1024 * 1024);
          buffer += decoder.decode(chunk, { stream: true });
          let n;
          while ((n = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, n));
            buffer = buffer.slice(n + 1);
          }
          if (!res.write(chunk)) await once(res, 'drain');
        }
        if (attempt) {
          const fullUncachedUpperMicro = usageUpperCost(usage, attempt.model);
          const upperMicro = threeBudget ? usageCacheUpperCost(usage, attempt.model) : fullUncachedUpperMicro;
          assert(usage.output_tokens <= 8192 && upperMicro <= attempt.reserveMicro);
          Object.assign(attempt, {
            status: 'finished',
            upperMicro,
            ...(threeBudget ? { fullUncachedUpperMicro } : {}),
            usage,
            finishReason: stopReason,
          });
          await serial(persist);
        }
        res.end();
      } catch (e) {
        if (attempt) {
          attempt.status = 'failed-counted-no-retry';
          await serial(persist);
        }
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Isolated CNY diagnostic stopped; no automatic retry.',
            },
          }),
        );
        agent?.cancel({ kind: 'user' });
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    app = await startOfficialNovel({
      sqlite,
      home: join(work, 'home'),
      fixtureEndpoint: 'http://127.0.0.1:' + server.address().port,
    });
    const worker = resolve('data/official-validation/integration/baseline/worker');
    const { bootstrapBook } = await import(pathToFileURL(join(worker, 'book-catalog.mjs')));
    const { makeDocumentService } = await import(pathToFileURL(join(worker, 'novel-documents.mjs')));
    const scene = sceneName
        ? SCENES[sceneName]
        : round === '04'
          ? SCENES.handover
          : ['05', '06'].includes(round)
            ? SCENES.costume
            : round === '03'
              ? SCENES.repair
              : ['02', '07'].includes(round)
                ? SCENES.surgeon
                : SCENES.family,
      bundle = await makeBookBundle(null, { title: '独立真模型写作验收', seed: scene.seed });
    bootstrapBook(app.storage.fs, app.storage.db, bundle.manifest.id, bundle);
    const service = makeDocumentService(app.storage.fs, app.storage.db, bundle.manifest.id);
    for (const [path, text] of [
      ...(singlePass || clarity || plain || natural || autonomous
        ? [
            [
              'rules.json',
              JSON.stringify({
                savedPrompts: {
                  write: autonomous
                    ? AUTONOMOUS_PROSE
                    : natural
                      ? NATURAL_PROSE
                      : plain
                        ? PLAIN_PROSE
                        : clarity
                          ? CLARITY_PROSE
                          : NOVEL_PROSE,
                },
                project: {},
              }),
            ],
          ]
        : []),
      ['setting.md', scene.setting],
      [
        'outline.json',
        JSON.stringify([
          { chapter: 1, title: scene.title, summary: scene.summary, chapterPath: 'chapters/1.md' },
        ]),
      ],
      ['chapters/1.md', ''],
    ]) {
      let old;
      try {
        old = service.run({ kind: 'read', path });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      service.run({ kind: 'save', path, text, expectedHash: old?.hash ?? null });
    }
    const authorRequest = minimumLength
      ? scene.request.replace('写约1600—2000字', '写至少1600字，不设上限')
      : scene.request;
    if (minimumLength) {
      const previous = service.run({ kind: 'read', path: 'rules.json' });
      const rules = JSON.parse(previous.text);
      rules.project = { ...rules.project, wordsPerChapter: Number(minimumLength) };
      service.run({
        kind: 'save',
        path: 'rules.json',
        text: JSON.stringify(rules),
        expectedHash: previous.hash,
      });
      report.lengthPolicy = { minimumCharacters: Number(minimumLength), maximumCharacters: null };
    }
    const ctx = app.ctx,
      controller = ctx.get('sessionController');
    await ctx.get('workspaceRegistry').create(bundle.manifest.root, '独立真模型写作验收');
    const { sessionId } = await controller.create({ cwd: bundle.manifest.root });
    agent = ctx.get('agents').get(sessionId);
    const exec = { agent, signal: new AbortController().signal, callId: 'native-quality-prepare' };
    const prepared = JSON.parse(
      await agent.ctx
        .get('tools')
        .get('novel_proposal_prepare', agent)
        .execute({ path: bundle.manifest.root + '/chapters/1.md', instruction: authorRequest }, exec),
    );
    expectedTemplate = prepared.task.template.body;
    report.expandedTemplateBytes = Buffer.byteLength(expectedTemplate);
    report.templateHash = createHash('sha256').update(expectedTemplate).digest('hex');
    report.templateSource = prepared.task.template.source;
    const content =
      authorRequest +
      '\n' +
      JSON.stringify({
        diagnostic: marker,
        proposal_id: prepared.proposalId,
        book: bundle.manifest.root,
        target: prepared.target,
        draft: prepared.draft,
      });
    await controller.prompt(
      {
        sessionId,
        requestId: 'native-quality',
        mode: 'followup',
        content: [{ type: 'text', text: content }],
      },
      exec.signal,
    );
    const deadline = Date.now() + 240000;
    while (!agent.session.log.some((e) => e.type === 'turn/end')) {
      assert(Date.now() < deadline, 'Native turn timeout.');
      await delay(100);
    }
    const end = agent.session.log.findLast((e) => e.type === 'turn/end');
    assert.equal(end.data.reason.kind, 'completed');
    const read = service.run({ kind: 'read', path: 'chapters/1.md' });
    assert(read.text.trim().length > 400, 'Agent did not publish prose.');
    const calls = agent.session.log
      .filter((e) => e.type === 'tool/call')
      .map((e) => ({
        name: e.data.name,
        args: typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments,
      }));
    const first = calls.findIndex((c) => c.name === 'novel_proposal_submit' && c.args.complete === false);
    const last = calls.findLastIndex((c) => c.name === 'novel_proposal_submit' && c.args.complete === true);
    report.stagedWrite = first >= 0 && last > first;
    report.readBackBeforeFinal =
      report.stagedWrite &&
      calls.slice(first + 1, last).some((c) => c.name === 'read' && c.args.file_path?.includes('/drafts/'));
    report.calls = forwarded;
    report.publishedHash = read.hash;
    report.templateVariant = plain
      ? 'plain'
      : clarity
        ? 'clarity'
        : singlePass
          ? 'single-pass'
          : 'deployed-default';
    if (natural) report.templateVariant = 'natural';
    if (autonomous) report.templateVariant = 'autonomous';
    report.proseSubmissions = calls.filter((c) => c.name === 'novel_proposal_submit').length;
    await writeFile(join(directory, 'native-result-' + round + '.txt'), read.text, {
      flag: 'wx',
      mode: 0o600,
    });
    if (first >= 0)
      await writeFile(join(directory, 'native-draft-' + round + '.txt'), calls[first].args.content, {
        flag: 'wx',
        mode: 0o600,
      });
    assert(report.templateReachedProvider, 'Current selected template did not reach the actual provider.');
    if (prepared.task.template.body.includes('complete:false'))
      assert(
        report.stagedWrite && report.readBackBeforeFinal,
        'Native Agent did not follow the same-task revision process.',
      );
    else assert(last >= 0, 'A complete publication is required for the current selected template.');
    report.passed = true;
    report.calls = forwarded;
    report.publishedHash = read.hash;
    report.characters = read.text.length;
    report.editorCharacters = read.text.replace(/\s/g, '').length;
    if (minimumLength) {
      assert(report.editorCharacters >= Number(minimumLength), 'The requested minimum was not reached.');
      assert(
        !calls.some((c) => c.name === 'ask_user_question'),
        'Explicit minimum must not cause a length approval.',
      );
      report.minimumReachedWithoutApproval = true;
    }
    report.scene = sceneName ?? scene.title;
    report.budgetHeldUpperCny = chargedOrReservedMicro(ledger) / 1e6;
  }
} catch (e) {
  report.passed = false;
  report.failure = String(e.message).slice(0, 240);
  process.exitCode = 1;
} finally {
  if (agent) {
    report.nativeToolCounts = {};
    for (const e of agent.session.log.filter((e) => e.type === 'tool/call'))
      report.nativeToolCounts[e.data.name] = (report.nativeToolCounts[e.data.name] ?? 0) + 1;
    report.nativeToolErrors = agent.session.log.filter(
      (e) => e.type === 'tool/result' && e.data.message?.isError,
    ).length;
  }
  if (agent?.status === 'running') agent.cancel({ kind: 'user' });
  if (app) await app.shutdown.shutdown(process.exitCode ? 1 : 0);
  if (server) await new Promise((r) => server.close(r));
  await fixture?.close();
  if (threeBudget && transport && apiKey) {
    try {
      const balance = await queryDeepSeekBalance(transport, apiKey);
      ledger.balances.push({
        ...(closeBudget ? {} : { round }),
        phase: closeBudget ? 'close' : 'after',
        ...balance,
      });
      await persist();
      report.balanceAfter = balance;
    } catch (e) {
      report.balanceQueryFailure = e.message;
    }
    const attempts = closeBudget
      ? ledger.attempts
      : ledger.attempts.filter((a) => a.label.startsWith('native-' + round + '-'));
    const hit = attempts.reduce((n, a) => n + (a.usage?.cache_read_input_tokens ?? 0), 0);
    const miss = attempts.reduce(
      (n, a) => n + (a.usage?.input_tokens ?? 0) + (a.usage?.cache_creation_input_tokens ?? 0),
      0,
    );
    report.cache = { hitTokens: hit, missTokens: miss, hitRatio: hit / (hit + miss || 1) };
    report.budgetHeldUpperCny = chargedOrReservedMicro(ledger) / 1e6;
  }
  await transport?.close();
  apiKey = '';
  await writeFile(
    join(directory, closeBudget ? 'closed-report.json' : 'native-report-' + round + '.json'),
    JSON.stringify(report, null, 2),
    {
      mode: 0o600,
    },
  );
  if (locked) await unlink(join(directory, 'runner.lock'));
  console.log(JSON.stringify(report));
}
