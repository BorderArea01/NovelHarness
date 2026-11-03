// Isolated native extension-contract check, not a second writing engine.
// Only localhost and explicit synthetic credentials. No deployment/key reads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';
import { stageRuntime } from '../scripts/stage-runtime.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const work = resolve(root, 'test-results/cloud-tool-scope-' + Date.now());
const origin = 'http://127.0.0.1:8795';
const fixtureKey = 'fixture-only-owner-key-not-for-production-0123456789abcdef';
const bookRoot = '/workspace/novels/b-' + '8'.repeat(32);
const bookId = bookRoot.slice('/workspace/novels/'.length);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const children = [];
let model,
  cookie = '',
  registry = resolve(work, 'dev-registry');
function launch() {
  const child = spawn(
    process.execPath,
    [
      '--max-old-space-size=384',
      resolve(root, 'cloud/tools/node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--config',
      resolve(work, 'worker.toml'),
      '--ip',
      '127.0.0.1',
      '--port',
      '8795',
      '--persist-to',
      resolve(work, 'worker-state'),
    ],
    {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_CF_FETCH_ENABLED: 'false',
        WRANGLER_REGISTRY_PATH: registry,
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const record = { child, output: '' };
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      record.output = (record.output + chunk).slice(-8000);
    });
  child.on('error', (e) => {
    record.error = e;
  });
  children.push(record);
  return record;
}
async function close(record) {
  if (record.child.exitCode !== null) return;
  if (process.platform === 'win32')
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(record.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  else record.child.kill('SIGTERM');
  if (record.child.exitCode === null) await new Promise((resolve) => record.child.once('exit', resolve));
}
async function ready(record) {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (record.error || record.child.exitCode !== null)
      throw new Error('Owned probe runtime exited: ' + (record.error?.message ?? record.output));
    try {
      if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })).status < 500) return;
    } catch {
      /* same live process, no replacement */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Owned probe readiness timed out: ' + record.output);
}
async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, {
    method,
    headers: { cookie, origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(45000),
    redirect: 'manual',
  });
  if (!response.ok)
    throw new Error(
      'Synthetic request failed ' +
        response.status +
        ' ' +
        path +
        ': ' +
        (await response.text()).replaceAll(fixtureKey, '[synthetic-owner]').slice(0, 1000),
    );
  return response;
}
async function createSession(cwd) {
  const response = await request('/api/session/create', {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    payload: { args: { request: { cwd } } },
  });
  const wire = await response.json();
  const value = wire.result?.value ?? wire;
  const id = typeof value === 'string' ? value : (value.sessionId ?? value.id ?? value.session?.id);
  assert.equal(
    typeof id,
    'string',
    'Unexpected native Session creation response keys: ' + Object.keys(value),
  );
  return id;
}
async function putFile(path, text) {
  const response = await fetch(origin + '/api/workspace/file?path=' + encodeURIComponent(path), {
    method: 'PUT',
    headers: { cookie, origin, 'content-type': 'text/plain;charset=utf-8' },
    body: text,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  await response.text();
}
const toolsOf = (body) => (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name).sort();
async function turn(sessionId, task) {
  const response = await request('/api/sessions/' + sessionId + '/turn', { message: task.marker });
  const wire = await response.text();
  assert.ok(task.bodies.length, 'Original Agent never reached localhost provider.');
  assert.equal(
    task.completedSteps,
    task.steps.length,
    JSON.stringify({ tools: toolsOf(task.bodies[0]), protocolErrors: model.errors, tail: wire.slice(-2000) }),
  );
  return task;
}
try {
  await new Promise((resolve, reject) => {
    const probe = createPortProbe();
    probe.once('error', reject);
    probe.listen(8795, '127.0.0.1', () => probe.close((error) => (error ? reject(error) : resolve())));
  });
  await mkdir(work, { recursive: true });
  model = await startModelFixture();
  assert.equal(new URL(model.url).hostname, '127.0.0.1');
  await stageRuntime(resolve(work, 'worker'));
  await cp(
    resolve(root, 'cloud/tests/fixtures/tool-scope-entry.mjs'),
    resolve(work, 'worker/probe-entry.mjs'),
  );
  const config =
    (await readFile(resolve(root, 'cloud/tests/runtime/wrangler.toml'), 'utf8'))
      .replaceAll('novel-harness-local-verification', 'novel-harness-tool-scope-verification')
      .replace(
        /^main = .*$/m,
        'main = ' + JSON.stringify(resolve(work, 'worker/probe-entry.mjs').replaceAll('\\', '/')),
      )
      .replace(
        /^directory = .*$/m,
        'directory = ' +
          JSON.stringify(resolve(root, 'cloud/tools/node_modules/dsh-edge/dist').replaceAll('\\', '/')),
      ) +
    '\nDEEPSEEK_BASE_URL = ' +
    JSON.stringify(model.url) +
    '\n';
  assert.ok(config.includes('DEEPSEEK_BASE_URL = "http://127.0.0.1:'));
  await writeFile(resolve(work, 'worker.toml'), config);
  const worker = launch();
  await ready(worker);
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ accessKey: fixtureKey }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(login.status, 303);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  const madeDirectory = await (
    await request('/api/workspace/exec', { command: 'mkdir -p ' + bookRoot, cwd: '/workspace' })
  ).json();
  assert.equal(madeDirectory.exitCode, 0);
  await putFile(
    bookRoot + '/book.json',
    JSON.stringify({
      format: 'novel-harness-book-v1',
      id: bookId,
      root: bookRoot,
      title: 'Isolated native scope fixture',
      files: [],
    }),
  );
  const sentinel = '已有正式正文，不允许探测工具覆盖。';
  await putFile(bookRoot + '/chapters/existing.md', sentinel);
  const sessionId = await createSession(bookRoot);
  const probe = model.register({
    steps: [{ name: 'novel_scope_probe', input: { message: 'novel-scope-ok' }, expected: 'novel-scope-ok' }],
  });
  await turn(sessionId, probe);
  const novelTools = toolsOf(probe.bodies[0]);
  assert.ok(novelTools.includes('novel_scope_probe'));
  const resultWire = JSON.stringify(probe.bodies.at(-1).messages);
  assert.ok(resultWire.includes(bookRoot));
  assert.ok(resultWire.includes('ownAgent'));
  const firstCandidate = '只在隔离测试目录创建的第一版候选。';
  const nextCandidate = '在同一原生事务中更新的第二版候选。';
  const commit = model.register({
    steps: [
      {
        name: 'novel_candidate_commit_probe',
        input: { expectedHash: 'missing', content: firstCandidate },
        expected: hash(firstCandidate),
      },
      {
        name: 'novel_candidate_commit_probe',
        input: { expectedHash: 'missing', content: firstCandidate },
        expected: hash(firstCandidate),
      },
      {
        name: 'novel_candidate_commit_probe',
        input: { expectedHash: '0'.repeat(64), content: '冲突写入不得落盘' },
        expectedError: true,
        expected: '原文已更新',
      },
      {
        name: 'novel_candidate_commit_probe',
        input: { expectedHash: hash(firstCandidate), content: nextCandidate },
        expected: hash(nextCandidate),
      },
    ],
  });
  await turn(sessionId, commit);
  const candidateURL = '/api/novels/' + bookId + '/document?path=drafts%2Fscope-probe.md';
  assert.equal((await (await request(candidateURL)).json()).text, nextCandidate);
  const history = await (
    await request('/api/novels/' + bookId + '/history?path=drafts%2Fscope-probe.md')
  ).json();
  assert.equal(history.versions.filter((version) => version.hash === hash(firstCandidate)).length, 1);
  const secondBookRoot = '/workspace/novels/b-' + '9'.repeat(32);
  assert.equal(
    (
      await (
        await request('/api/workspace/exec', { command: 'mkdir -p ' + secondBookRoot, cwd: '/workspace' })
      ).json()
    ).exitCode,
    0,
  );
  const denied = model.register({});
  const outside = '/workspace/' + denied.marker;
  const another = secondBookRoot + '/' + denied.marker;
  const restored = bookRoot + '/' + denied.marker;
  assert.equal(
    (
      await (
        await request('/api/workspace/exec', {
          command: 'mkdir -p ' + [outside, another, restored].join(' '),
          cwd: '/workspace',
        })
      ).json()
    ).exitCode,
    0,
  );
  // Keep the explicit synthetic marker in the changing runtime context so the
  // fixture's strict latest-user routing cannot mistake it for a new chat.
  denied.steps = [
    { name: 'working_directory', input: { cd: outside }, expected: outside },
    {
      name: 'novel_scope_probe',
      input: { message: 'must-not-run-outside-book' },
      expectedError: true,
      expected: 'original Agent or novel workspace has changed',
    },
    {
      name: 'novel_candidate_commit_probe',
      input: { expectedHash: hash(nextCandidate), content: '书外调用不得落盘' },
      expectedError: true,
      expected: 'original Agent or novel workspace has changed',
    },
    { name: 'working_directory', input: { cd: another }, expected: another },
    {
      name: 'novel_scope_probe',
      input: { message: 'must-not-run-in-other-book' },
      expectedError: true,
      expected: 'original Agent or novel workspace has changed',
    },
    { name: 'working_directory', input: { cd: restored }, expected: restored },
    {
      name: 'novel_scope_probe',
      input: { message: 23 },
      expectedError: true,
      expected: 'exactly one message string',
    },
    {
      name: 'novel_scope_probe',
      input: { message: 'original-book-scope-restored' },
      expected: 'original-book-scope-restored',
    },
  ];
  const escapeSessionId = await createSession(bookRoot);
  assert.notEqual(escapeSessionId, sessionId);
  await turn(escapeSessionId, denied);
  const ordinaryId = await createSession('/workspace');
  const ordinary = model.register({ finalText: 'Ordinary synthetic scope check.' });
  await turn(ordinaryId, ordinary);
  const ordinaryTools = toolsOf(ordinary.bodies[0]);
  assert.ok(!ordinaryTools.includes('novel_scope_probe'), 'Scoped tool leaked into the ordinary Agent.');
  assert.deepEqual(
    novelTools.filter(
      (name) =>
        ![
          'novel_scope_probe',
          'novel_candidate_commit_probe',
          'novel_run_next',
          'novel_run_submit',
          'novel_proposal_inspect',
          'novel_proposal_prepare',
          'novel_proposal_submit',
          'novel_outline_update',
        ].includes(name),
    ),
    ordinaryTools,
  );
  const proposalBase = '独立候选工具样本的原文。';
  const proposalPath = 'chapters/native-proposal.md';
  await putFile(bookRoot + '/' + proposalPath, proposalBase);
  const proposalAPI = '/api/novels/' + bookId + '/';
  const preparedProposal = await (
    await request(proposalAPI + 'proposals', {
      path: proposalPath,
      expectedHash: hash(proposalBase),
      originSessionId: sessionId,
    })
  ).json();
  assert.ok(preparedProposal.id);
  const candidateOne = '仅进入待审候选，正式原文不变。';
  const candidateTwo = candidateOne + '\n保留完整的第二版候选。';
  const nativeProposal = model.register({
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: { proposal_id: preparedProposal.id },
        expected: '"published":false',
      },
      {
        name: 'novel_proposal_submit',
        input: { proposal_id: preparedProposal.id, expected_hash: hash(''), content: candidateOne },
        expected: '"saved":true',
      },
      {
        name: 'novel_proposal_submit',
        input: { proposal_id: preparedProposal.id, expected_hash: hash(''), content: '旧版本不能覆盖' },
        expectedError: true,
      },
      {
        name: 'novel_proposal_submit',
        input: { proposal_id: preparedProposal.id, expected_hash: hash(candidateOne), content: candidateTwo },
        expected: '"published":false',
      },
      {
        name: 'novel_proposal_submit',
        input: {
          proposal_id: preparedProposal.id,
          expected_hash: hash(candidateTwo),
          content: '不能注入路径',
          path: proposalPath,
        },
        expectedError: true,
      },
    ],
  });
  await turn(sessionId, nativeProposal);
  const wrongProposalActor = model.register({
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: { proposal_id: preparedProposal.id },
        expectedError: true,
        expected: '不属于本次发起对话',
      },
    ],
  });
  await turn(escapeSessionId, wrongProposalActor);
  const reassigned = await (
    await request(proposalAPI + 'proposals', {
      resumeId: preparedProposal.id,
      originSessionId: escapeSessionId,
      expectedDraftHash: hash(candidateTwo),
    })
  ).json();
  assert.equal(reassigned.originSessionId, sessionId);
  assert.equal(reassigned.writerSessionId, escapeSessionId);
  const authorizedResume = model.register({
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: { proposal_id: preparedProposal.id },
        expected: hash(candidateTwo),
      },
    ],
  });
  await turn(escapeSessionId, authorizedResume);
  const forbiddenWriter = model.register({
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: { proposal_id: preparedProposal.id },
        expectedError: true,
        expected: '不属于本次发起对话',
      },
    ],
  });
  await turn(sessionId, forbiddenWriter);
  const reassignedBack = await (
    await request(proposalAPI + 'proposals', {
      resumeId: preparedProposal.id,
      originSessionId: sessionId,
      expectedDraftHash: hash(candidateTwo),
    })
  ).json();
  assert.equal(reassignedBack.writerSessionId, sessionId);
  const proposalReview = await (await request(proposalAPI + 'review?id=' + preparedProposal.id)).json();
  assert.equal(proposalReview.draft.text, candidateTwo);
  assert.equal(proposalReview.current.text, proposalBase);
  const canonOriginal = JSON.stringify({
    characters: [{ id: 'manual', name: '作者角色', trust: 'manual', notes: '不得更改' }],
  });
  await putFile(bookRoot + '/canon.json', canonOriginal);
  await putFile(bookRoot + '/seed.md', '林风站在钟楼门口。');
  const canonProposal = await (
    await request(proposalAPI + 'proposals', {
      path: 'canon.json',
      expectedHash: hash(canonOriginal),
      originSessionId: sessionId,
      sources: ['seed.md'],
    })
  ).json();
  const canonPartial = '{unfinished';
  const canonComplete = JSON.stringify({
    characters: [
      JSON.parse(canonOriginal).characters[0],
      {
        id: 'person-lin',
        name: '林风',
        trust: 'auto',
        evidenceSources: [{ path: 'seed.md', quote: '林风站在钟楼门口。' }],
      },
    ],
  });
  const canonTask = model.register({
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: { proposal_id: canonProposal.id },
        expected: '"kind":"canon"',
      },
      {
        name: 'novel_proposal_submit',
        input: { proposal_id: canonProposal.id, expected_hash: hash(''), content: canonPartial },
        expected: '候选 JSON 尚未完整',
      },
      {
        name: 'novel_proposal_submit',
        input: { proposal_id: canonProposal.id, expected_hash: hash(canonPartial), content: canonComplete },
        expected: '"usableSuggestions":1',
      },
    ],
  });
  await turn(sessionId, canonTask);
  const canonReview = await (await request(proposalAPI + 'review?id=' + canonProposal.id)).json();
  assert.equal(canonReview.current.text, canonOriginal);
  assert.equal(canonReview.draft.text, canonComplete);
  assert.equal(canonReview.canon.validCount, 1);
  await putFile(
    bookRoot + '/outline.json',
    JSON.stringify([
      {
        chapter: 1,
        title: '既有章',
        chapterPath: 'chapters/existing.md',
        summary: '作者正文',
        plotPoints: ['已有事件'],
      },
      { chapter: 2, title: '新章二', summary: '找到原始账簿', plotPoints: ['取得账簿'] },
      { chapter: 3, title: '新章三', summary: '保留证据承担代价', plotPoints: ['承担代价'] },
    ]),
  );
  await putFile(
    bookRoot + '/rules.json',
    JSON.stringify({ savedPrompts: { write: '按 {chapterNumber} 章写完整剧情，保留行动与代价。' } }),
  );
  const runAPI = '/api/novels/' + bookId + '/writing-run';
  const outline = await (await request('/api/novels/' + bookId + '/document?path=outline.json')).json();
  const runId = crypto.randomUUID();
  const runRequest = {
    action: 'create',
    id: runId,
    range: { start: 1, end: 3 },
    originSessionId: sessionId,
    publication: 'review',
    instruction: '分章写完整，保留作者原文。',
    expectedHash: outline.hash,
  };
  const createdRun = await (await request(runAPI, runRequest)).json();
  assert.equal(createdRun.total, 2);
  assert.equal(createdRun.skipped, 1);
  const forbidden = await fetch(origin + runAPI, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'next', id: runId }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(forbidden.status, 403);
  await forbidden.text();
  const foreign = model.register({
    steps: [
      {
        name: 'novel_run_next',
        input: { run_id: runId },
        expectedError: true,
        expected: '发起它的原生小说会话',
      },
    ],
  });
  await turn(escapeSessionId, foreign);
  const partial = '连写中途已保存的部分候选。';
  const interrupted = model.register({
    holdFinish: true,
    steps: [
      { name: 'novel_run_next', input: { run_id: runId }, expected: '"chapter":2' },
      {
        name: 'novel_run_submit',
        input: { run_id: runId, chapter: 2, expected_hash: hash(''), content: partial, complete: false },
        expected: '"kind":"partial"',
      },
    ],
  });
  const interruptedBody = request('/api/sessions/' + sessionId + '/turn', {
    message: interrupted.marker,
  }).then((response) => response.text());
  interruptedBody.catch(() => {}); // Cleanup owns the same in-flight request on failure.
  const deadline = Date.now() + 30000;
  while (interrupted.completedSteps !== 2 || !interrupted.holds.length) {
    if (Date.now() > deadline) throw new Error('Native partial run never reached its held checkpoint.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const beforeStop = await (await request(runAPI + '?id=' + runId)).json();
  const stoppedCandidateId = beforeStop.items.find((m) => m.chapter === 2).proposalId;
  assert.equal(beforeStop.generated, 0);
  assert.equal(beforeStop.items[1].partial, true);
  await (
    await request('/api/session/cancel', {
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      payload: { args: { request: { sessionId } } },
    })
  ).text();
  const abortedWire = await interruptedBody;
  assert.ok(
    abortedWire.includes('"kind":"aborted"'),
    'Original native cancellation did not record an aborted turn.',
  );
  assert.equal(interrupted.issuedSteps.length, 2);
  model.release(interrupted);
  await close(worker);
  registry = resolve(work, 'dev-registry-after-restart');
  await ready(launch());
  const resumed = model.register({
    steps: [
      {
        name: 'novel_scope_probe',
        input: { message: 'same-session-cold-resume-ok' },
        expected: 'same-session-cold-resume-ok',
      },
      {
        name: 'novel_candidate_commit_probe',
        input: { expectedHash: hash(nextCandidate), content: nextCandidate },
        expected: hash(nextCandidate),
      },
    ],
  });
  await turn(sessionId, resumed);
  assert.ok(toolsOf(resumed.bodies[0]).includes('novel_scope_probe'));
  const proposalAfterColdResume = model.register({
    steps: [
      {
        name: 'novel_proposal_inspect',
        input: { proposal_id: preparedProposal.id },
        expected: hash(candidateTwo),
      },
      {
        name: 'novel_proposal_submit',
        input: {
          proposal_id: preparedProposal.id,
          expected_hash: hash(candidateTwo),
          content: candidateTwo + '\n冷恢复后的修改仍只进候选。',
        },
        expected: '"saved":true',
      },
    ],
  });
  await turn(sessionId, proposalAfterColdResume);
  assert.equal(
    (await (await request(proposalAPI + 'document?path=' + encodeURIComponent(proposalPath))).json()).text,
    proposalBase,
  );
  const fullTwo = partial + '\n第二章完成，取得账簿并留下记录。';
  const fullThree = '第三章完成，为保留记录承担停职的代价。';
  const continueRun = model.register({
    steps: [
      { name: 'novel_run_next', input: { run_id: runId }, expected: '"hasText":true' },
      {
        name: 'novel_run_submit',
        input: { run_id: runId, chapter: 2, expected_hash: hash(partial), content: fullTwo, complete: true },
        expected: '"generated":1',
      },
      { name: 'novel_run_next', input: { run_id: runId }, expected: '"chapter":3' },
      {
        name: 'novel_run_submit',
        input: { run_id: runId, chapter: 3, expected_hash: hash(''), content: fullThree, complete: true },
        expected: '"generated":2',
      },
      { name: 'novel_run_next', input: { run_id: runId }, expected: '"kind":"completed"' },
    ],
  });
  await turn(sessionId, continueRun);
  const completedRun = await (await request(runAPI + '?id=' + runId)).json();
  assert.equal(completedRun.completed, true);
  assert.equal(completedRun.items[1].proposalId, stoppedCandidateId);
  assert.ok(completedRun.items.filter((m) => !m.skipped).every((m) => !m.published));
  for (const member of completedRun.items.filter((m) => !m.skipped)) {
    const review = await (await request('/api/novels/' + bookId + '/review?id=' + member.proposalId)).json();
    assert.ok(!review.current.text.includes('完成'));
    await (
      await request('/api/novels/' + bookId + '/accept', {
        id: member.proposalId,
        draftHash: review.draft.hash,
      })
    ).text();
  }
  const currentOutline = await (
    await request('/api/novels/' + bookId + '/document?path=outline.json')
  ).json();
  const expandedRows = JSON.parse(currentOutline.text);
  expandedRows.push(
    { chapter: 4, title: '自动新章四', summary: '新的行动', plotPoints: ['新选择'] },
    { chapter: 5, title: '自动新章五', summary: '新的代价', plotPoints: ['后果'] },
  );
  await putFile(bookRoot + '/outline.json', JSON.stringify(expandedRows));
  const autoOutline = await (await request('/api/novels/' + bookId + '/document?path=outline.json')).json();
  const autoId = crypto.randomUUID();
  await (
    await request(runAPI, {
      ...runRequest,
      id: autoId,
      publication: 'new-chapters',
      range: { start: 4, end: 5 },
      expectedHash: autoOutline.hash,
    })
  ).text();
  const auto = model.register({
    steps: [
      { name: 'novel_run_next', input: { run_id: autoId }, expected: '"chapter":4' },
      {
        name: 'novel_run_submit',
        input: {
          run_id: autoId,
          chapter: 4,
          expected_hash: hash(''),
          content: '第四章合成正文，新的行动。',
          complete: true,
        },
        expected: '"committed"',
      },
      { name: 'novel_run_next', input: { run_id: autoId }, expected: '"chapter":5' },
      {
        name: 'novel_run_submit',
        input: {
          run_id: autoId,
          chapter: 5,
          expected_hash: hash(''),
          content: '第五章合成正文，承担后果。',
          complete: true,
        },
        expected: '"committed"',
      },
      { name: 'novel_run_next', input: { run_id: autoId }, expected: '"kind":"completed"' },
    ],
  });
  await turn(sessionId, auto);
  const autoRun = await (await request(runAPI + '?id=' + autoId)).json();
  assert.equal(autoRun.completed, true);
  assert.ok(autoRun.items.every((m) => m.published));
  assert.equal((await (await request(candidateURL)).json()).text, nextCandidate);
  const protectedFile = await request(
    '/api/workspace/file?path=' + encodeURIComponent(bookRoot + '/chapters/existing.md'),
  );
  assert.equal(await protectedFile.text(), sentinel);
  assert.ok(model.requests.every((entry) => entry.keysSynthetic));
  assert.deepEqual(model.errors, []);
  const result = {
    scope: 'local-native-writing-run-backend',
    sessionPreservedOnColdResume: true,
    bookScopedToolExecuted: true,
    ordinaryWorkspaceUnchanged: true,
    originalToolCatalogPreserved: true,
    scopedCandidateInspectSubmitCasAndCrossSessionRefusalVerified: true,
    scopedCandidateCommitSurvivesColdResume: true,
    explicitAuthorHandoffPreservesFirstProvenanceAndRevokesOldWriter: true,
    incompleteCanonRepairUsesSameCandidateAndAuthorRecordsRemainUnchanged: true,
    scopeEscapesAndInvalidInputRefused: true,
    originalNativeVfsCasAndIdempotentRetryVerified: true,
    originalHistoryAndFormalProsePreserved: true,
    nativeMultiChapterRunPartialStopColdResumeAndExplicitAcceptance: true,
    authorOptInNewChapterAutoPublicationVerified: true,
    novelTools,
    ordinaryTools,
    realProviderRequests: 0,
    productionChanged: false,
  };
  await writeFile(resolve(work, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  for (const record of children)
    console.error(record.output.replaceAll(fixtureKey, '[synthetic-owner]').slice(-4500));
  throw error;
} finally {
  for (const record of children.reverse()) await close(record);
  await model?.close();
}
