// UI actions send the author's request plus a task handle. They do not
// manufacture another creative workflow or inline the same template twice.
import { materialSources } from './writing-context.mjs';
export const DIRECTION_PATH = 'notes/story-plan.md';
const validId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
function handle(book, proposal, request, kind) {
  if (!validId(proposal.id)) throw new Error('写作任务编号无效，未发送。');
  return JSON.stringify({
    request: request.trim(),
    kind,
    book: book.root,
    proposal_id: proposal.id,
    target: book.root + '/' + proposal.target,
    draft: book.root + '/' + proposal.draft,
  });
}
export function proposalPrompt(book, document, proposal, instruction = '', mode) {
  if (
    proposal.writing?.version === 1 &&
    (proposal.writing.mode !== mode || proposal.writing.instruction !== instruction)
  )
    throw new Error('写作要求与冻结任务不一致，未发送。');
  if (
    proposal.contextOutlineHash !== undefined &&
    proposal.writing?.version === 1 &&
    proposal.writingContext?.outlineHash !== proposal.contextOutlineHash
  )
    throw new Error('章纲版本与冻结任务不一致，未发送。');
  return handle(
    book,
    { ...proposal, target: proposal.target ?? document.path },
    instruction || '撰写当前章节',
    'prose',
  );
}
export function outlinePrompt(book, proposal, instruction = '') {
  if (proposal.status !== 'pending') throw new Error('提案已处理或状态未知，未发送补全任务。');
  return handle(book, { ...proposal, target: 'outline.json' }, instruction || '规划所选章节', 'outline');
}
export function canonProposalPrompt(book, proposal, instruction = '') {
  return handle(book, { ...proposal, target: 'canon.json' }, instruction || '从所选原文整理资料', 'canon');
}
// Structured tool result: task identity, author intent, frozen template,
// material directory and storage parameters. No prose executionPrompt.
export function taskContext(book, document, proposal, documents = []) {
  return {
    version: 1,
    kind:
      proposal.target === 'outline.json' ? 'outline' : proposal.target === 'canon.json' ? 'canon' : 'prose',
    book: { id: book.id, root: book.root, title: book.title },
    target: {
      path: book.root + '/' + proposal.target,
      hash: proposal.baseHash,
      ...(document.parts?.length ? { parts: document.parts.map((path) => book.root + '/' + path) } : {}),
    },
    draft: book.root + '/' + proposal.draft,
    ...(proposal.writing ? { authorRequest: proposal.writing.instruction } : {}),
    ...(proposal.writing
      ? {
          writing: {
            mode: proposal.writing.mode,
            purpose: proposal.writing.purpose,
            flexible: proposal.writing.flexible === true,
          },
        }
      : {}),
    ...(proposal.edit ? { selection: proposal.edit } : {}),
    ...(proposal.plan ? { plan: proposal.plan } : {}),
    ...(proposal.sources ? { sources: proposal.sources } : {}),
    ...(proposal.promptTemplate ? { template: proposal.promptTemplate } : {}),
    ...(document.outline ? { chapterOutline: document.outline } : {}),
    materials: materialSources(book, documents),
    publication: proposal.publication ?? { mode: 'review' },
    withoutOutline: proposal.agentRequest?.withoutOutline === true,
    contentFormat: proposal.target.endsWith('.json') ? 'json' : 'markdown',
  };
}
