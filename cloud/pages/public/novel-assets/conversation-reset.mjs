// Start a genuinely NEW native Session, not a visual hide, fork, compaction or
// copied transcript. Workspace/VFS keep the book; old context stays archived.
export async function resetBookConversation(
  ctx,
  session,
  { stopActivity = false, isCurrent = () => true } = {},
) {
  if (!/^\/workspace\/novels\/b-[a-f0-9]{32}$/.test(session?.cwd ?? ''))
    throw new Error('请先打开一本小说。');
  const workspace = ctx.workspaces.list.getSnapshot().items.find((w) => w.path === session.cwd);
  const current = ctx.sessions.list.getSnapshot().byId[session.id];
  if (!workspace || current?.cwd !== session.cwd || current.origin === 'subagent')
    throw new Error('作品对话已变化，未清空其他对话。');
  const navigation = ctx.layout.beginNavigation();
  const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
  if (id === session.id) throw new Error('未创建新的空白对话，原上下文保留。');
  try {
    // Creation failure cannot archive the author's only conversation. Refusal to
    // archive active work cannot be bypassed by a stale client running indicator.
    navigation.throwIfAborted();
    if (!isCurrent()) throw new DOMException('Navigation changed', 'AbortError');
    await ctx.workspaces.archiveSession(session.id, { stopActivity });
    // Archiving the selected Session legitimately invokes native selection
    // reconciliation and aborts its navigation token. Only an actual later app
    // navigation intent may supersede opening the freshly created conversation.
    if (!isCurrent()) throw new DOMException('Navigation changed', 'AbortError');
    ctx.uiWorkspace.openSession(id);
    return { sessionId: id, archivedSessionId: session.id };
  } catch (error) {
    // A failed/cancelled reset must not leave a newer unarchived blank for the
    // normal book-resume policy to select instead of the author's conversation.
    // Never delete it or force-stop any work another device may have started.
    try {
      await ctx.workspaces.archiveSession(id, { stopActivity: false });
    } catch {}
    throw error;
  }
}
