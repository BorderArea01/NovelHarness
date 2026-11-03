import { requireBookSession } from './native-activity.mjs';
import { revealWorkspace, revealDialogue } from './workspace-navigation.mjs';

// Navigation over native tabs/catalogs and original proposal receipts only.
// These IDs are provenance hints, never evidence of a successful model turn.
export const MANUSCRIPT_ADDRESS = 'dsh-resource://novel/';
export const validProposalId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
export function openTaskRun(ctx, data) {
  if (!/^b-[a-f0-9]{32}$/.test(data?.bookId ?? '') || !validProposalId(data?.runId))
    throw new Error('连写引用无效，未打开其他书稿。');
  requireBookSession(
    ctx,
    { root: '/workspace/novels/' + data.bookId },
    ctx.sidebarRight.mounted.getSnapshot(),
  );
  if (!revealWorkspace(data.bookId, { runId: data.runId }))
    ctx.sidebarRight.openResource(MANUSCRIPT_ADDRESS + data.bookId, { params: { runId: data.runId } });
}
export function openTaskProposal(ctx, data) {
  if (!/^b-[a-f0-9]{32}$/.test(data?.bookId ?? '') || !validProposalId(data?.proposalId))
    throw new Error('候选引用无效，未打开其他书稿。');
  const book = { root: '/workspace/novels/' + data.bookId };
  requireBookSession(ctx, book, ctx.sidebarRight.mounted.getSnapshot());
  // Native navigation parameters reveal the existing book tab, not another
  // resource identity, popup, editor or persisted selection store.
  if (!revealWorkspace(data.bookId, { proposalId: data.proposalId }))
    ctx.sidebarRight.openResource(MANUSCRIPT_ADDRESS + data.bookId, {
      params: { proposalId: data.proposalId },
    });
}
export function proposalConversation(ctx, book, proposal) {
  if (!proposal.originSessionId) return { kind: 'legacy' };
  try {
    const row = requireBookSession(ctx, book, proposal.originSessionId);
    return { kind: 'available', id: proposal.originSessionId, title: row.title?.trim() || '未命名对话' };
  } catch {
    return { kind: 'unavailable' };
  }
}
export function openProposalConversation(ctx, book, proposal) {
  if (!proposal.originSessionId) throw new Error('旧提案未记录发起对话，未猜测或新建对话。');
  requireBookSession(ctx, book, proposal.originSessionId);
  ctx.uiWorkspace.openSession(proposal.originSessionId);
  ctx.layout.selectPanel(null);
  revealDialogue();
}
export function createProposalOrigin(React, ctx) {
  const h = React.createElement;
  const catalogs = [ctx.sessions.list, ctx.workspaces.list].map((store) => ({
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
  }));
  return function ProposalOrigin({ book, proposal, busy, onOpen }) {
    React.useSyncExternalStore(catalogs[0].subscribe, catalogs[0].getSnapshot);
    React.useSyncExternalStore(catalogs[1].subscribe, catalogs[1].getSnapshot);
    const source = proposalConversation(ctx, book, proposal);
    if (source.kind === 'legacy') return null;
    return h(
      'div',
      { className: 'novel-proposal-origin', 'aria-label': '提案发起对话' },
      source.kind === 'available'
        ? h(
            'button',
            { type: 'button', disabled: busy, onClick: onOpen, title: source.title },
            '查看发起对话',
          )
        : h('span', null, '发起对话暂不可用'),
    );
  };
}
