// Durable author-scoped checkpoints in the ORIGINAL native VFS. This module
// never drives an Agent or a provider. All callbacks execute inside the original
// document service's single synchronous transaction.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
const FORMAT = 'novel-writing-run-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const sessionId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const hashRunText = (v) => createHash('sha256').update(v).digest('hex');
export const hasProse = (v) => !!v.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim();
export const validRunRange = (v) =>
  object(v) &&
  Number.isSafeInteger(v.start) &&
  Number.isSafeInteger(v.end) &&
  v.start >= 1 &&
  v.end >= v.start &&
  v.end <= 10000 &&
  v.end - v.start < 1000;

export function makeWritingRuns(c) {
  const fail = c.fail;
  const path = (id) => {
    if (!UUID.test(id ?? '')) fail(400, '连写任务标识无效。');
    return c.root + '/notes/writing-runs/' + id + '.json';
  };
  const sign = (value) => {
    if (typeof c.key !== 'string' || c.key.length < 32) fail(503, '连写授权服务尚未就绪，未写入任务。');
    return createHmac('sha256', c.key)
      .update(FORMAT + '\n' + JSON.stringify(value))
      .digest('hex');
  };
  function load(id) {
    const file = c.raw(path(id));
    if (!file) fail(404, '连写任务不存在。');
    let envelope;
    try {
      envelope = JSON.parse(file.text);
    } catch {
      fail(409, '连写检查点损坏，原文件保留。');
    }
    const value = envelope?.payload;
    if (
      !object(value) ||
      !HASH.test(envelope.signature ?? '') ||
      !timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(sign(value), 'hex'))
    )
      fail(409, '连写授权校验失败，未执行；备份副本需重新发起任务。');
    if (
      value.format !== FORMAT ||
      value.id !== id ||
      value.bookId !== c.bookId ||
      value.root !== c.root ||
      !sessionId(value.originSessionId) ||
      !validRunRange(value.range) ||
      !HASH.test(value.outlineHash ?? '') ||
      !(value.rulesHash === null || HASH.test(value.rulesHash ?? '')) ||
      !['review', 'new-chapters'].includes(value.publication) ||
      !['open', 'blocked', 'closed'].includes(value.phase) ||
      typeof value.instruction !== 'string' ||
      !Array.isArray(value.members) ||
      value.members.length !== value.range.end - value.range.start + 1 ||
      value.members.some(
        (m, i) =>
          !object(m) ||
          m.chapter !== value.range.start + i ||
          !c.validPath(m.path) ||
          !m.path.startsWith('chapters/') ||
          !HASH.test(m.baseHash ?? '') ||
          typeof m.skip !== 'boolean' ||
          !(m.proposalId === null || UUID.test(m.proposalId ?? '')) ||
          !(m.submittedHash === null || HASH.test(m.submittedHash ?? '')) ||
          !(m.publishedHash === null || HASH.test(m.publishedHash ?? '')),
      )
    )
      fail(409, '连写检查点格式不兼容，未猜测或清空进度。');
    return value;
  }
  function save(value) {
    const text = JSON.stringify({ payload: value, signature: sign(value) });
    if (new TextEncoder().encode(text).length > 512 * 1024)
      fail(413, '连写检查点超过 512 KiB，未保存半份进度。');
    c.write(path(value.id), text);
  }
  function summary(value) {
    const queued = value.members.filter((m) => !m.skip);
    const generated = queued.filter((m) => m.submittedHash).length;
    return {
      id: value.id,
      createdAt: value.createdAt,
      originSessionId: value.originSessionId,
      range: value.range,
      publication: value.publication,
      instruction: value.instruction,
      phase: value.phase,
      notice: value.notice ?? '',
      generated,
      total: queued.length,
      skipped: value.members.length - queued.length,
      completed: generated === queued.length,
      items: value.members.map((m) => ({
        chapter: m.chapter,
        path: m.path,
        skipped: m.skip,
        proposalId: m.prepared ? m.proposalId : null,
        generated: !!m.submittedHash,
        partial: !!m.partialHash && !m.submittedHash,
        published: !!m.publishedHash,
      })),
    };
  }
  function checkSources(value) {
    if (c.read('outline.json').hash !== value.outlineHash)
      fail(409, '连写依据的大纲已变化，请核对后重新发起剩余章节；旧候选保留。');
    if ((c.raw(c.root + '/rules.json')?.hash ?? null) !== value.rulesHash)
      fail(409, '连写规则或提示词已变化，请重新发起剩余章节；旧候选保留。');
  }
  function memberProposal(value, member) {
    const p = c.proposal(member.proposalId, false);
    if (
      p.target !== member.path ||
      p.baseHash !== member.baseHash ||
      p.originSessionId !== value.originSessionId ||
      p.contextOutlineHash !== value.outlineHash ||
      p.nativeWritingRun?.version !== 1 ||
      p.nativeWritingRun?.id !== value.id ||
      p.writing?.purpose !== 'chapter' ||
      p.writing?.mode !== 'begin' ||
      p.writing?.instruction !== value.instruction ||
      !p.edit ||
      p.edit.start !== member.baseLength ||
      p.edit.end !== member.baseLength
    )
      fail(409, '连写候选与授权范围不一致，未写入正式正文。');
    return p;
  }
  function checkCarry(value, member) {
    const carry = member.carry;
    if (!carry) return;
    if (carry.proposalId) {
      const previous = value.members.find((m) => m.proposalId === carry.proposalId);
      if (!previous || !previous.submittedHash || previous.submittedHash !== carry.hash)
        fail(409, '前章连写检查点不一致，未使用旧接力。');
      const p = memberProposal(value, previous);
      if (p.status === 'rejected') fail(409, '前章候选已被放弃，请重新发起剩余章节。');
      if (p.status === 'accepted') {
        if (
          p.resolvedDraftHash !== carry.hash ||
          !previous.publishedHash ||
          c.read(previous.path).hash !== previous.publishedHash
        )
          fail(409, '前章接受后又有调整，旧接力失效；请重新发起剩余章节。');
      } else if (c.read(previous.path).hash !== previous.baseHash)
        fail(409, '前章正式正文已另行修改，请重新核对接力。');
    }
    if (c.read(carry.path).hash !== carry.hash)
      fail(409, '前章内容或候选有更新，旧接力失效；请重新发起剩余章节。');
  }
  function actor(value, sources = true) {
    if (!c.actor || c.actor.sessionId !== value.originSessionId)
      fail(403, '连写只能由发起它的原生小说会话执行。');
    if (value.phase !== 'open') fail(409, value.notice || '连写任务已关闭或需要处理冲突，未自动重启。');
    if (sources) checkSources(value);
  }
  function carryFor(value, member) {
    const index = value.members.indexOf(member);
    const previous = value.members[index - 1];
    if (previous) {
      if (previous.skip) return { path: previous.path, hash: previous.baseHash, proposalId: null };
      if (!previous.submittedHash) fail(409, '请先完成前一章候选，不跳章生成。');
      const p = memberProposal(value, previous);
      return { path: p.draft, hash: previous.submittedHash, proposalId: previous.proposalId };
    }
    return c.previousChapter(member.chapter);
  }
  function create(input) {
    path(input.id);
    if (
      !validRunRange(input.range) ||
      !sessionId(input.originSessionId) ||
      typeof input.instruction !== 'string' ||
      input.instruction.length > 6000 ||
      !['review', 'new-chapters'].includes(input.publication) ||
      !HASH.test(input.expectedHash ?? '')
    )
      fail(400, '请选择有效章纲范围、发布方式和原生对话；每次最多 1000 章。');
    const requestHash = hashRunText(
      JSON.stringify({
        range: input.range,
        originSessionId: input.originSessionId,
        instruction: input.instruction,
        publication: input.publication,
        expectedHash: input.expectedHash,
      }),
    );
    if (c.raw(path(input.id))) {
      const previous = load(input.id);
      if (previous.requestHash !== requestHash) fail(409, '这个连写标识已用于其他范围，未覆盖原任务。');
      return { ...summary(previous), alreadyCreated: true };
    }
    // Establish key availability before any chapter/outline writes.
    sign({});
    const prepared = c.prepare(input.range, input.expectedHash);
    const value = {
      format: FORMAT,
      id: input.id,
      bookId: c.bookId,
      root: c.root,
      originSessionId: input.originSessionId,
      range: input.range,
      publication: input.publication,
      instruction: input.instruction,
      requestHash,
      outlineHash: prepared.outlineHash,
      rulesHash: c.raw(c.root + '/rules.json')?.hash ?? null,
      phase: 'open',
      createdAt: c.now(),
      members: prepared.members.map((m) => ({
        ...m,
        prepared: false,
        proposalId: m.skip ? null : c.uuid(),
        submittedHash: null,
        publishedHash: m.skip ? m.baseHash : null,
        carry: null,
      })),
    };
    save(value);
    return { ...summary(value), alreadyCreated: false };
  }
  function next(input) {
    const value = load(input.id);
    actor(value, false);
    const member = value.members.find((m) => !m.skip && !m.submittedHash);
    if (!member) return { kind: 'completed', run: summary(value) };
    try {
      return nextChapter(value, member);
    } catch (error) {
      if (![404, 409].includes(error.status)) throw error;
      value.phase = 'blocked';
      value.notice = error.message;
      save(value);
      return { kind: 'conflict', run: summary(value) };
    }
  }
  function nextChapter(value, member) {
    checkSources(value);
    if (c.read(member.path).hash !== member.baseHash)
      fail(409, '待写章节已有人编辑，未覆盖已有正文；请重新发起剩余章节。');
    if (!c.hasProposal(member.proposalId)) {
      member.carry = carryFor(value, member);
      checkCarry(value, member);
      c.createProposal(
        member.proposalId,
        {
          kind: 'propose',
          path: member.path,
          expectedHash: member.baseHash,
          outlineHash: value.outlineHash,
          originSessionId: value.originSessionId,
          writing: {
            version: 1,
            mode: 'begin',
            purpose: 'chapter',
            templateKey: 'write',
            instruction: value.instruction,
          },
          edit: { start: member.baseLength, end: member.baseLength },
        },
        value.id,
      );
      member.prepared = true;
      save(value);
    }
    const p = memberProposal(value, member);
    if (p.status !== 'pending') fail(409, '当前连写候选已处理，未擅自重建或覆盖。');
    checkCarry(value, member);
    const review = c.doc({ kind: 'review', id: p.id });
    return {
      kind: 'chapter',
      run: summary(value),
      chapter: member.chapter,
      outline:
        new TextEncoder().encode(JSON.stringify(review.writingContext.outline)).length <= 16384
          ? review.writingContext.outline
          : {
              chapter: member.chapter,
              source: c.root + '/outline.json',
              guidance: '通过原生文件工具完整读取本章章纲；未截短或省略原文件。',
            },
      instruction: value.instruction,
      template: p.promptTemplate,
      previous: member.carry,
      target: member.path,
      draft: { path: p.draft, hash: review.draft.hash, hasText: !!review.draft.text.trim() },
      sources: ['seed.md', 'setting.md', 'rules.json', 'canon.json', 'memory.json'].map(
        (p) => c.root + '/' + p,
      ),
      output: {
        tool: 'novel_run_submit',
        run_id: value.id,
        chapter: member.chapter,
        expected_hash: review.draft.hash,
      },
      guidance:
        '读取 previous.path 和本章相关原文/资料，写完整本章，不只试写开场；前章若为候选尚不是正史。使用已展开模板，但本任务范围优先。不要修改正式正文、章纲或检查点，也不用 write 更新候选；将候选正文（不重复标题）通过 novel_run_submit 的 content 提交。未完成本章时 complete=false，保存部分候选后可继续。发现矛盾或冲突如实报告，不伪报已完成。',
    };
  }
  function submit(input) {
    const value = load(input.id);
    actor(value, false);
    if (
      !Number.isSafeInteger(input.chapter) ||
      typeof input.content !== 'string' ||
      !input.content.trim() ||
      new TextEncoder().encode(input.content).length > 512 * 1024 ||
      typeof input.complete !== 'boolean' ||
      !HASH.test(input.expectedHash ?? '')
    )
      fail(400, '正文、完成标记或候选版本无效；单次候选上限 512 KiB，未截短。');
    const member = value.members.find((m) => m.chapter === input.chapter && !m.skip);
    if (!member) fail(403, '该章不在本次可写范围，或已有正文已跳过。');
    if (member.submittedHash) {
      if (member.submittedHash !== hashRunText(input.content))
        fail(409, '本章候选已完成，未用不同文本重复提交。');
      const p = memberProposal(value, member);
      if (c.read(p.draft).hash !== member.submittedHash)
        fail(409, '候选已另行修改，未将重试伪装为同一结果。');
      return { kind: 'committed', alreadySubmitted: true, proposalId: p.id, run: summary(value) };
    }
    if (value.members.find((m) => !m.skip && !m.submittedHash) !== member)
      fail(409, '请按章节顺序提交，不跳过前章。');
    const p = memberProposal(value, member);
    if (p.status !== 'pending') fail(409, '当前候选已被处理，未重新生成。');
    const draft = c.saveCandidate(p, input.content, input.expectedHash);
    try {
      checkSources(value);
      checkCarry(value, member);
      if (c.read(member.path).hash !== member.baseHash) fail(409, '正式正文已更新，原正文与本次候选均保留。');
    } catch (error) {
      value.phase = 'blocked';
      value.notice = error.message;
      save(value);
      return { kind: 'conflict', proposalId: p.id, draftHash: draft.hash, run: summary(value) };
    }
    if (input.complete) member.submittedHash = draft.hash;
    else member.partialHash = draft.hash;
    save(value);
    if (input.complete) {
      if (value.publication === 'new-chapters') c.doc({ kind: 'accept', id: p.id, draftHash: draft.hash });
    }
    return {
      kind: input.complete ? 'committed' : 'partial',
      proposalId: p.id,
      draftHash: draft.hash,
      run: summary(load(value.id)),
    };
  }
  function beforeAccept(p) {
    const value = load(p.nativeWritingRun.id);
    checkSources(value);
    const m = value.members.find((m) => m.proposalId === p.id);
    if (!m || !m.submittedHash) fail(409, '连写本章尚未声明完成，请先继续或另建手工提案。');
    memberProposal(value, m);
    checkCarry(value, m);
    const previous = value.members[value.members.indexOf(m) - 1];
    if (previous && !previous.skip && memberProposal(value, previous).status !== 'accepted')
      fail(409, '请先接受前章候选，再接受依赖它的下一章。');
  }
  function afterResolve(p, accepted, document) {
    const value = load(p.nativeWritingRun.id);
    const member = value.members.find((m) => m.proposalId === p.id);
    if (!member) fail(409, '连写候选归属不匹配，未更新检查点。');
    if (accepted) {
      member.publishedHash = document.hash;
    } else {
      value.phase = 'blocked';
      value.notice = '连写候选已被放弃；请重新发起剩余章节。';
    }
    save(value);
  }
  function handle(input) {
    if (input.action === 'list') {
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2048) fail(400, '连写列表页码无效。');
      const files = c.checkpoints();
      return {
        items: files.slice(offset, offset + 20).map(({ id }) => {
          try {
            const value = summary(load(id));
            delete value.items;
            delete value.instruction;
            return value;
          } catch (error) {
            if (![404, 409].includes(error.status)) throw error;
            return { id, error: error.message };
          }
        }),
        nextOffset: offset + 20 < files.length ? offset + 20 : null,
      };
    }
    if (input.action === 'create') {
      if (c.actor) fail(403, '模型工具不能创建或扩大作者连写授权。');
      return create(input);
    }
    if (input.action === 'get') return summary(load(input.id));
    if (input.action === 'next') return next(input);
    if (input.action === 'submit') return submit(input);
    if (input.action === 'close') {
      if (c.actor) fail(403, '关闭连写由作者操作，不能改变其他任务授权。');
      const value = load(input.id);
      value.phase = 'closed';
      value.notice = '作者已关闭本次连写；候选与正文均保留。';
      save(value);
      return summary(value);
    }
    fail(400, '未知连写操作。');
  }
  return { handle, beforeAccept, afterResolve };
}
