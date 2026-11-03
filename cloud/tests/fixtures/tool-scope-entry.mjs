// LOCAL TEST ENTRY ONLY. stageRuntime copies the production wrapper unchanged,
// then this probe is staged beside it. It is never imported by a release entry.
import main, { DshEdgeInstance as CurrentInstance } from './entry.mjs';
import { installNovelTools } from './novel-tools.mjs';
import { nativeWorkspace } from './native-workspace.mjs';
import { makeDocumentService } from './novel-documents.mjs';
export { PinAuth } from './entry.mjs';
const NAME = 'novel_scope_probe';
export class DshEdgeInstance extends CurrentInstance {
  constructor(ctx, env) {
    super(ctx, env);
    if (env.NOVEL_EDITOR_DIAGNOSTICS !== 'local-fixture') throw new Error('Scope probe is local only.');
    const host = this.sessions.context;
    const instance = this;
    installNovelTools(host, ({ root: directory, agent, assertScope }) => [
      {
        name: NAME,
        description: 'Local synthetic read-only scope verification. Never production writing.',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          exec.signal.throwIfAborted();
          if (!args || typeof args.message !== 'string' || Object.keys(args).length !== 1)
            throw new Error('Scope probe accepts exactly one message string.');
          const liveDirectory = host.get('workingDirectory').get(exec.agent.session);
          return JSON.stringify({
            message: args.message,
            directory: liveDirectory,
            scopeRoot: directory,
            ownAgent: true,
            sessionKeys: Object.keys(agent.session.header),
          });
        },
      },
      {
        name: 'novel_candidate_commit_probe',
        description:
          'Local fixture only: CAS-save one fixed candidate file through the original native document transaction. Never accepts arbitrary paths.',
        parameters: {
          type: 'object',
          properties: { expectedHash: { type: 'string' }, content: { type: 'string' } },
          required: ['expectedHash', 'content'],
          additionalProperties: false,
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (
            !args ||
            Object.keys(args).length !== 2 ||
            typeof args.content !== 'string' ||
            new TextEncoder().encode(args.content).length > 4096 ||
            typeof args.expectedHash !== 'string' ||
            !/^(missing|[a-f0-9]{64})$/.test(args.expectedHash)
          )
            throw new Error('Invalid local candidate probe arguments.');
          const { fs, db } = await nativeWorkspace(instance);
          assertScope(exec);
          const result = makeDocumentService(fs, db, directory.slice('/workspace/novels/'.length)).run({
            kind: 'save',
            path: 'drafts/scope-probe.md',
            expectedHash: args.expectedHash === 'missing' ? null : args.expectedHash,
            text: args.content,
          });
          return JSON.stringify({ path: result.path, hash: result.hash, characters: result.text.length });
        },
      },
    ]);
  }
}
export default main;
