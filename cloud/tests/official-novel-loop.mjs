// Deterministic requests through the real official Agent, not direct execute().
// Only synthetic books and a loopback HTTP provider are used here.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check, label, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(30);
  }
  throw new Error('Timed out: ' + label);
}

async function runCase(ctx, agent, model, task, whileRunning, expectedReason = 'completed') {
  const from = agent.session.log.length;
  try {
    await ctx.get('sessionController').prompt(
      {
        sessionId: agent.id,
        requestId: 'official-fixture-' + task.id,
        mode: 'followup',
        content: [{ type: 'text', text: task.marker + ' 本轮仅处理独立测试书稿。' }],
      },
      new AbortController().signal,
    );
    await whileRunning?.();
    const ending = await until(
      () => agent.session.log.slice(from).findLast((event) => event.type === 'turn/end'),
      'official Agent turn settlement',
    );
    assert.deepEqual(model.errors, []);
    assert.equal(ending.data.reason.kind, expectedReason, JSON.stringify(ending.data.reason));
    if (expectedReason === 'completed') assert.equal(task.completedSteps, task.steps.length);
    return ending;
  } catch (error) {
    if (agent.status === 'running') agent.cancel({ kind: 'user' });
    throw error;
  } finally {
    model.release(task);
  }
}

export async function verifyOfficialNovelLoop({ ctx, model, agent, file, service }) {
  const previous = ({ results, task, step }) =>
    JSON.parse(results.get('fixture_' + task.id + '_' + (step - 1)).text);
  const mixed = '# 雨夜\n\n她把钥匙推回门缝，等着门内的人先开口。\n\n一封湿透的信从门下滑了出来。\n';
  const task = model.register({
    finalText: '改写和续写已一起保存。',
    steps: [
      {
        name: 'novel_proposal_prepare',
        input: { path: file, instruction: '改写开头，并续写一段。' },
        expected: '"contentScope":"document"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: mixed.slice(0, -8),
            complete: false,
          };
        },
        expected: '"published":false',
      },
      {
        name: 'novel_proposal_inspect',
        input: (scope) => ({ proposal_id: previous(scope).proposalId }),
        expected: '"contentScope":"document"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: mixed,
            complete: true,
          };
        },
        expected: '"published":true',
      },
      { name: 'read', input: { file_path: file }, expected: '一封湿透的信' },
      {
        name: 'bash',
        input: { description: '核对虚拟书稿内容', command: 'cat chapters/1.md' },
        expected: '一封湿透的信',
      },
      { name: 'grep', input: { pattern: '一封湿透的信', path: 'chapters' }, expected: '一封湿透的信' },
      { name: 'glob', input: { pattern: '*.md', path: 'chapters' }, expected: '1.md' },
    ],
  });
  await runCase(ctx, agent, model, task);
  assert.equal(service.run({ kind: 'read', path: 'chapters/1.md' }).text, mixed);

  const plan = {
    storyPlan: '她为了辨认真正的寄信人，带着钥匙走入雨中的钟楼。',
    chapters: [
      {
        chapter: 2,
        title: '雨中来信',
        summary: '她从湿信上认出自己的笔迹，循着钥匙编号找到钟楼。',
        plotPoints: ['辨认湿信笔迹', '按钥匙编号进入钟楼'],
      },
    ],
  };
  const prose =
    '# 雨中来信\n\n信纸湿透了，她却一眼认出了自己的笔迹。\n\n钥匙上的编号和钟楼侧门一致。她推门进去，雨声在身后断了。\n';
  let newPath;
  const outline = model.register({
    finalText: '章纲与第二章正文已保存。',
    steps: [
      {
        name: 'novel_proposal_prepare',
        input: { mode: 'new-chapter', chapter: 2, instruction: '先纲后文，完成第二章。' },
        expected: '"prerequisite":"outline"',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: JSON.stringify(plan),
            complete: true,
          };
        },
        expected: '"published":true',
      },
      {
        name: 'novel_proposal_prepare',
        input: { mode: 'new-chapter', chapter: 2, instruction: '按已保存章纲完成第二章。' },
        expected: '"prerequisite":null',
      },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          newPath = p.target;
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: prose,
            complete: true,
          };
        },
        expected: '"published":true',
      },
      { name: 'read', input: () => ({ file_path: newPath }), expected: '雨声在身后断了' },
      {
        name: 'bash',
        input: () => ({ description: '核对已入书的新章', command: 'cat ' + JSON.stringify(newPath) }),
        expected: '雨声在身后断了',
      },
    ],
  });
  await runCase(ctx, agent, model, outline);
  const bookRoot = file.slice(0, file.indexOf('/chapters/'));
  const relativeNewPath = newPath.slice(bookRoot.length + 1);
  assert.equal(service.run({ kind: 'read', path: relativeNewPath }).text, prose);
  const savedOutline = service.run({ kind: 'read', path: 'outline.json' });
  assert(JSON.parse(savedOutline.text).some((row) => row.chapter === 2 && row.title === '雨中来信'));

  // Pause an actual streamed tool argument, prove browsing/read access stays
  // available, cancel the real Agent and ensure uncompleted text never commits.
  const cancel = model.register({
    argumentPreviewAtStep: 1,
    argumentPreviewText: '这段未完成文本不能覆盖',
    steps: [
      { name: 'novel_proposal_prepare', input: { path: newPath, instruction: '改写第二章' } },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: '# 取消测试\n\n这段未完成文本不能覆盖正式正文。\n',
            complete: true,
          };
        },
      },
    ],
  });
  await runCase(
    ctx,
    agent,
    model,
    cancel,
    async () => {
      await until(
        () => cancel.holds.some((hold) => hold.stage === 'tool-arguments'),
        'streamed tool arguments',
      );
      assert.equal(agent.status, 'running');
      assert(service.run({ kind: 'list' }).documents.length > 0);
      const target = await ctx.get('fs').resolve(newPath);
      assert.equal(await ctx.get('fs').readText(target), prose);
      ctx.get('sessionController').cancel({ sessionId: agent.id });
    },
    'aborted',
  );
  assert.equal(service.run({ kind: 'read', path: relativeNewPath }).text, prose);

  // Another device writes between prepare and submit. The completed candidate
  // must remain available without silently replacing the newer author text.
  const concurrent = '# 雨中来信\n\n这是另一台设备刚保存的版本，必须保留。\n';
  const candidate = '# 雨中来信\n\n这是基于旧版生成的候选，不能抢占新稿。\n';
  let conflictProposal;
  const conflict = model.register({
    holdBeforeStep: 1,
    finalText: '新稿保留，冲突候选可比较。',
    steps: [
      { name: 'novel_proposal_prepare', input: { path: newPath, instruction: '改写第二章' } },
      {
        name: 'novel_proposal_submit',
        input: (scope) => {
          const p = previous(scope);
          conflictProposal = p.proposalId;
          return {
            proposal_id: p.proposalId,
            expected_hash: p.expectedHash,
            content: candidate,
            complete: true,
          };
        },
        expected: '"published":false',
      },
    ],
  });
  await runCase(ctx, agent, model, conflict, async () => {
    await until(() => conflict.holds.some((hold) => hold.stage === 'before-step'), 'concurrent author edit');
    const before = service.run({ kind: 'read', path: relativeNewPath });
    service.run({ kind: 'save', path: relativeNewPath, text: concurrent, expectedHash: before.hash });
    model.release(conflict);
  });
  assert.equal(service.run({ kind: 'read', path: relativeNewPath }).text, concurrent);
  const retained = service.run({ kind: 'review', id: conflictProposal });
  assert.equal(retained.draft.text, candidate);
  assert.equal(retained.current.text, concurrent);
  assert.equal(
    service.run({ kind: 'history', path: relativeNewPath, hash: retained.proposal.baseHash }).text,
    prose,
  );

  const clear = model.register({
    finalText: '章纲已清空，正文与历史保留。',
    steps: [
      { name: 'novel_outline_update', input: { action: 'inspect' } },
      {
        name: 'novel_outline_update',
        input: (scope) => {
          const p = previous(scope);
          return {
            action: 'apply',
            clear: true,
            expected_outline_hash: p.outlineHash,
            expected_direction_hash: p.directionHash,
            reason: '作者明确要求清空测试章纲，保留正文。',
          };
        },
        expected: '"applied":true',
      },
    ],
  });
  await runCase(ctx, agent, model, clear);
  assert.equal(JSON.parse(service.run({ kind: 'read', path: 'outline.json' }).text).length, 0);
  assert.equal(service.run({ kind: 'read', path: relativeNewPath }).text, concurrent);
  assert.equal(
    service.run({ kind: 'history', path: 'outline.json', hash: savedOutline.hash }).text,
    savedOutline.text,
  );
  for (const body of [task, outline, cancel, conflict, clear].flatMap((item) => item.bodies)) {
    const names = body.tools.map((tool) => tool.name ?? tool.function?.name);
    for (const name of [
      'read',
      'bash',
      'novel_proposal_prepare',
      'novel_proposal_submit',
      'novel_outline_update',
    ])
      assert(names.includes(name), 'Native tool unavailable during generation: ' + name);
    // Native DSH deliberately carries dynamic contexts as in-history request
    // snapshots, not necessarily in the stable system prompt.
    const payload = JSON.stringify({ system: body.system, messages: body.messages });
    assert(
      !payload.includes('novel:authoring-workflow'),
      'Retired dynamic instructions leaked into model request.',
    );
    assert(
      payload.includes('官方宿主隔离集成测试') &&
        payload.includes(file.slice(0, file.lastIndexOf('/chapters/'))),
      'Current book identity absent at model boundary.',
    );
    assert(
      payload.includes('NOVEL_VFS_INSTRUCTIONS_VERIFIED'),
      'Virtual AGENTS.md absent at model boundary.',
    );
  }
  assert(
    model.requests.every((request) => request.keysSynthetic),
    'Non-fixture credential used.',
  );
  return {
    originalAgentLoop: true,
    originalToolsExecuted: [task, outline, cancel, conflict, clear].reduce(
      (sum, item) => sum + item.completedSteps,
      0,
    ),
    streamedPartialThenFullReplacement: true,
    genericReadSeesPublishedText: true,
    outlineThenChapterPublished: true,
    cancelRetainsOriginalText: true,
    readsAvailableDuringGeneration: true,
    concurrentEditRetainedWithCandidateAndHistory: true,
    clearOutlinePreservesProseAndHistory: true,
    originalPurgeEnabled: true,
    retiredDynamicInstructionsAbsentAtModelBoundary: true,
    currentBookIdentityRetainedAtModelBoundary: true,
    originalInstructionsLoadFromVirtualFilesystem: true,
    localProviderRequests: model.requests.length,
    realProviderRequests: 0,
  };
}
