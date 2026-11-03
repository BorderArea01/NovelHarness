import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { createEmptyNovelStorage } from '../official/novel/storage.mjs';
import { startNovelWeb } from '../official/novel/web.mjs';

const mode = process.argv[2],
  id = process.argv[3];
const shared = mode === 'shared';
if (
  !['isolated', 'shared'].includes(mode) ||
  !(shared ? id === 'shared' : /^[a-f0-9]{64}$/.test(id)) ||
  !process.send
)
  throw new Error('Writing runtime requires the configured gateway.');
const root = shared ? resolve(process.argv[4]) : resolve(process.argv[4], id);
const home = join(root, 'home');
let app, web;
// Register before the first asynchronous boot step. If the gateway dies during
// initialization, a half-started worker must not outlive its data-directory lock.
process.once('disconnect', async () => {
  if (!app) process.exit(0);
  try {
    await web?.close();
    await app.shutdown.shutdown(0);
    app.storage.close();
  } finally {
    process.exit(0);
  }
});
await mkdir(home, { recursive: true, mode: 0o700 });
await createEmptyNovelStorage(join(root, 'main.sqlite'), { dataRoot: root });
app = await startOfficialNovel({
  home,
  sqlite: join(root, 'main.sqlite'),
  anonymous: !shared,
  shared,
  dataRoot: root,
  installationPrepared: true,
});
// Apply at the native dispatcher so HTTP and WebSocket RPC share the boundary.
// Novel tools keep their full authority inside this visitor's VFS.
const { RemoteError } =
  await import('../official/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js');
const gateway = app.ctx.get('typertGateway');
const prepareInvocation = gateway.prepareInvocation.bind(gateway);
gateway.prepareInvocation = function (request, ...args) {
  const endpoint = request.namespace + '/' + request.method;
  if (
    !shared &&
    (request.namespace === 'terminal' ||
      ['commands/execute', 'settings/openSettingsDocument', 'session/openWorkspacePath'].includes(endpoint))
  )
    throw new RemoteError(
      'remote-access/denied',
      'Anonymous visitors cannot execute host management actions.',
      {},
    );
  if (['session/create', 'workspace/create'].includes(endpoint)) {
    const value = request.args?.request ?? request.args;
    for (const name of ['cwd', 'path'])
      if (
        value?.[name] !== undefined &&
        !(
          value[name] === '/workspace' ||
          /^\/workspace\/(?!.*(?:\\|(?:^|\/)\.\.?(?:\/|$)))[^\0]*$/.test(value[name])
        )
      )
        throw new RemoteError(
          'remote-access/denied',
          'Workspace must be inside the visitor virtual filesystem.',
          {},
        );
  }
  return prepareInvocation(request, ...args);
};
process.on('message', async (message) => {
  if (message?.type === 'start' && !web) {
    try {
      web = await startNovelWeb(app, { ownerKey: message.key, home, initialPin: message.initialPin });
      process.send({ type: 'ready', origin: web.origin });
    } catch (error) {
      process.send({
        type: 'failed',
        code: error.code === 'PIN_SETUP_REQUIRED' ? error.code : 'START_FAILED',
      });
      await app.shutdown.shutdown(0);
      app.storage.close();
      process.exit(1);
    }
  } else if (message?.type === 'idle') {
    process.send({
      type: 'idle',
      id: message.id,
      idle: !app.ctx
        .get('agents')
        .list()
        .some((agent) => agent.status === 'running'),
    });
  } else if (message?.type === 'stop') {
    if (
      app.ctx
        .get('agents')
        .list()
        .some((agent) => agent.status === 'running')
    )
      return process.send({ type: 'busy' });
    await web?.close();
    await app.shutdown.shutdown(0);
    app.storage.close();
    process.exit(0);
  }
});
process.send({ type: 'booted' });
