import { writingPrompt } from './bundle.mjs';

import { taskMessage, parseTaskMessage } from './task-message.mjs';
import { wakeBookChanges } from './book-sync.mjs';

export const documentContextRevision = (doc) =>
  JSON.stringify([doc?.outlineHash, doc?.parts ?? null, doc?.planningWarning ?? null]);
export function makeDocumentClient(id, fetcher = fetch) {
  if (!/^b-[a-f0-9]{32}$/.test(id)) throw new Error('小说标识无效。');
  async function request(url, route, data, query) {
    const response = await fetcher(url, {
      method: data ? (route === 'document' ? 'PUT' : 'POST') : 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: data ? { 'content-type': 'application/json' } : {},
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('书稿服务未返回有效结果。你的本地修改仍保留。');
    }
    if (!response.ok) {
      const error = new Error(result.error || '书稿操作未完成。');
      error.status = response.status;
      error.code = result.code;
      error.retryAt = result.retryAt;
      const retryAfter = Number(response.headers.get('retry-after'));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      error.current = result.current;
      error.path = result.current?.path ?? data?.path ?? query.path;
      throw error;
    }
    if (data) wakeBookChanges(client);
    return result;
  }
  const client = (route, data, query = {}) => {
    const params = new URLSearchParams(query),
      url = '/api/novels/' + id + '/' + route + (params.size ? '?' + params : '');
    // Independent author navigation must NOT join an older held poll: another
    // device may have saved since that poll began (A → B → A ownership).
    return request(url, route, data, query);
  };
  return client;
}
export function changedLines(before, after) {
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end++;
  return { before: a, after: b, start, beforeEnd: a.length - end, afterEnd: b.length - end };
}
export function nativeTask(ctx, sessionId, book, { fromComposer = false } = {}) {
  const binding = ctx.sessions.binding(sessionId);
  if (!binding || ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd !== book.root)
    throw new Error('当前对话不属于这本书，未发送。');
  const input = ctx.conversation.input.for(binding.ctx),
    state = input.state.getSnapshot();
  const initial = writingPrompt(book);
  if (state.phase && state.phase !== 'plain')
    throw new Error('对话正在处理输入或其他命令，草稿已保留；请先完成或取消它。');
  if (state.attachmentIds?.length || state.occurrences?.length)
    throw new Error('对话里有未发送附件或引用，已保留。请先处理它们再发起写作。');
  const ownedDefault = state.draft === initial;
  if (fromComposer && parseTaskMessage(state.draft))
    throw new Error('对话里保留着未发送成功的完整任务；请在对话中重试或处理它，未创建新任务。');
  if (!fromComposer && state.draft?.trim() && !ownedDefault)
    throw new Error('对话中有未发送草稿，已保留。请先处理它，再发起本次写作。');
  const previous = state.draft,
    revision = state.draftRev;
  const send = (prompt, presentation) => {
    if (
      ctx.sessions.binding(sessionId) !== binding ||
      ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd !== book.root
    )
      throw new Error('当前对话已变化，未发送，原草稿仍保留。');
    const latest = input.state.getSnapshot();
    if (
      latest.draft !== previous ||
      (revision !== undefined && latest.draftRev !== revision) ||
      latest.attachmentIds?.length ||
      latest.occurrences?.length
    )
      throw new Error('对话草稿刚发生变化，已保留，未自动发送。');
    const outcome = ctx.conversation.input.requestDraftInitialization(binding, {
      prompt: presentation ? taskMessage(prompt, { ...presentation, bookId: book.id }) : prompt,
      clearPreviousDraft: ownedDefault || (fromComposer && !!previous),
    });
    if (outcome !== 'applied') throw new Error('对话正忙或已有新草稿，未替换、未发送。');
    input.actions.submit();
  };
  // Only an explicit manuscript action reads the ORIGINAL draft as its intent.
  // Native submission/failure recovery still owns that text, not another store.
  send.instruction = fromComposer && !ownedDefault ? (previous ?? '') : '';
  return send;
}
export function writingEdit(document, mode, selection) {
  if (mode !== 'review' && selection?.text) return { start: selection.start, end: selection.end };
  // Entry intent is never an implicit append-only boundary. The author can
  // revise earlier prose and continue later prose in the same writing task.
  return null;
}
export { proposalPrompt, canonProposalPrompt } from '../../../worker/shared/writing-prompts.mjs';
