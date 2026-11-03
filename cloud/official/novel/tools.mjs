// Reuse the exact running novel tool definitions against the same SQLite owner.
// No new agent loop, shadow transcript, proposal engine or permission modes.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'novel-authoring-tools';
export const inject = ['novelStorage', 'workingDirectory', 'systemPrompt', 'agents', 'workspaceRegistry'];
export async function apply(ctx, config) {
  const worker = resolve('data/official-validation/integration/baseline/worker');
  const load = (name) => import(pathToFileURL(resolve(worker, name + '.mjs')));
  const [{ installProposalTools }, { installWritingRunTools }, { novelRoot }] = await Promise.all([
    load('proposal-tools'),
    load('writing-run-tools'),
    load('novel-role'),
  ]);
  const storage = ctx.get('novelStorage');
  const instance = {
    sessions: { context: ctx },
    activeTurns: new Map(),
    ctx: { storage: storage.db },
    env: { DSH_EDGE_ACCESS_KEY: config.runKey },
    async listWorkspaces() {
      return {
        items: ctx
          .get('workspaceRegistry')
          .list()
          .map((item) => ({ path: item.path, title: item.title })),
      };
    },
  };
  instance[Symbol('workspace')] = { ready: async () => {}, provider: () => storage.fs, db: storage.db };
  installProposalTools(instance);
  installWritingRunTools(instance);
  // Like the existing Edge role, read CURRENT registry metadata per assembly.
  // It is not a cached system identity, inferred from old messages, or another
  // book catalog. A synchronous registry read keeps directory/title coherent.
  ctx.get('systemPrompt').context({
    name: 'novel:book-identity',
    order: -90,
    required: true,
    interpolate: false,
    text: ({ agent }) => {
      if (!agent) return '';
      const root = novelRoot(ctx.get('workingDirectory').get(agent.session));
      if (!root) return '';
      const matches = ctx
        .get('workspaceRegistry')
        .list()
        .filter((item) => item.path === root);
      if (matches.length > 1) throw new Error('Ambiguous native book identity.');
      const title = matches[0]?.title;
      return JSON.stringify({
        id: root.slice('/workspace/novels/'.length),
        root,
        ...(typeof title === 'string' && title.trim() ? { title } : {}),
      });
    },
  });
  ctx.provide('novelHost', instance);
}
