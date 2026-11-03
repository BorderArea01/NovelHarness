// Pinned dsh-edge 0.30.0 native Agent-scoped registry seam.
// No Agent loop, provider, transcript store, tool restrictions or auth changes.
import { novelRoot } from './novel-role.mjs';

export function installNovelTools(host, definitionsForBook) {
  if (
    typeof host?.on !== 'function' ||
    typeof host?.get !== 'function' ||
    typeof definitionsForBook !== 'function'
  )
    throw new Error('Native novel-tool integration is unavailable.');
  return host.on('agent/created', ({ agent }) => {
    const directory = host.get('workingDirectory');
    const root = novelRoot(directory.get(agent.session));
    if (!root) return;
    // Agent.ctx.get avoids Cordis's undeclared-property access while preserving
    // the original Agent scope. Registration disposal belongs to that scope.
    const tools = agent.ctx.get('tools');
    if (typeof tools?.register !== 'function') throw new Error('Native scoped tool registry is unavailable.');
    const assertScope = (exec) => {
      exec.signal.throwIfAborted();
      if (exec.agent !== agent || novelRoot(directory.get(agent.session)) !== root)
        throw new Error('Novel tool refused: the original Agent or novel workspace has changed.');
    };
    // Async writing tools call assertScope again after awaiting nativeWorkspace
    // and immediately before their synchronous transaction. This guard does not
    // sandbox tool bodies or replace their own argument/CAS/authorization checks.
    const definitions = definitionsForBook({ root, agent, assertScope });
    if (!Array.isArray(definitions)) throw new Error('Novel tool definitions must be synchronous.');
    for (const definition of definitions) {
      if (!/^novel_[a-z0-9_]+$/.test(definition?.name ?? '') || typeof definition.execute !== 'function')
        throw new Error('Invalid native novel tool definition.');
      tools.register({
        ...definition,
        async execute(args, exec) {
          assertScope(exec);
          return definition.execute(args, exec);
        },
      });
    }
  });
}
