// Pinned native uiConversation.binding(owner).target('chat') contract. Read the
// SAME original blocks independently of tool-row mounting, detail mode, scroll
// virtualization or React effect order. No event replay/parser, copied text,
// retained Session/Agent, provider stream or persisted presentation cache.
export function currentProposalCalls(snapshot) {
  const turn = snapshot?.timeline?.turnOrder?.at(-1);
  if (turn === undefined) return [];
  if (typeof snapshot.locations?.getTurn !== 'function' || typeof snapshot.nodes?.get !== 'function')
    throw new Error('原生书稿预览接口不兼容；正式稿和候选未改动。');
  const calls = [],
    visited = new Set();
  const visit = (block) => {
    if (!block || visited.has(block)) return;
    visited.add(block);
    const toolName = 'kind' in block ? (block.call?.name ?? block.name) : block.name;
    if (
      ['novel_proposal_submit', 'novel_outline_update'].includes(toolName) &&
      typeof block.callId === 'string'
    )
      calls.push({ toolName, block, turn });
    for (const child of block.subCalls ?? []) visit(child);
  };
  for (const key of snapshot.locations.getTurn(turn)) {
    const node = snapshot.nodes.get(key);
    if (node?.kind === 'tool-call' && node.visibility !== 'hidden') visit(node.data?.root);
  }
  return calls;
}

export function observeProposalPresentation(ctx, { sessionId, root }, listener, onError = () => {}) {
  let disposed = false,
    binding,
    source,
    stopChat = () => {};
  // Only native block REFERENCES from the loaded latest turn, for transition
  // detection. Historical completed calls never redirect the author on open.
  let seen = new Map();
  const update = () => {
    if (disposed || !source) return;
    try {
      const next = new Map();
      for (const call of currentProposalCalls(source.getSnapshot())) {
        const previous = seen.get(call.block.callId);
        next.set(call.block.callId, call.block);
        if (
          !('kind' in call.block) ||
          (previous && !('kind' in previous)) ||
          (call.toolName === 'novel_outline_update' && !previous)
        )
          listener({ ...call, binding });
      }
      seen = next;
    } catch (error) {
      onError(error);
    }
  };
  const reconcile = () => {
    if (disposed) return;
    const row = ctx.sessions.list.getSnapshot().byId[sessionId];
    const next = row?.cwd === root ? ctx.sessions.binding(sessionId) : undefined;
    if (next === binding) return;
    stopChat();
    stopChat = () => {};
    source = undefined;
    seen.clear();
    if (binding) listener({ reset: true });
    binding = next;
    if (!next) return;
    try {
      source = ctx.uiConversation.binding(next).target('chat');
      if (typeof source?.subscribe !== 'function' || typeof source?.getSnapshot !== 'function')
        throw new Error('原生书稿预览接口不可用；可继续浏览正式稿。');
      stopChat = source.subscribe(update);
      update(); // Includes an already-running call after reload/re-subscription.
    } catch (error) {
      source = undefined;
      onError(error);
    }
  };
  const stopCatalog = ctx.sessions.list.subscribe(reconcile);
  reconcile();
  return () => {
    disposed = true;
    stopCatalog();
    stopChat();
    seen.clear();
    source = undefined;
    binding = undefined;
  };
}
