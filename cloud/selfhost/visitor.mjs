import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { createEmptyNovelStorage } from '../official/novel/storage.mjs';
import { startNovelWeb } from '../official/novel/web.mjs';

const id = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(id) || !process.send)
  throw new Error('Visitor runtime requires the anonymous gateway.');
const root = resolve('data/official-validation/integration/visitors', id);
const home = join(root, 'home');
await mkdir(home, { recursive: true, mode: 0o700 });
await createEmptyNovelStorage(join(root, 'main.sqlite'));
const app = await startOfficialNovel({
  home,
  sqlite: join(root, 'main.sqlite'),
  anonymous: true,
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
    request.namespace === 'terminal' ||
    ['commands/execute', 'settings/openSettingsDocument', 'session/openWorkspacePath'].includes(endpoint)
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
let web;
process.on('message', async (message) => {
  if (message?.type === 'start' && !web) {
    web = await startNovelWeb(app, { ownerKey: message.key, home });
    process.send({ type: 'ready', origin: web.origin });
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
process.on('disconnect', async () => {
  await web?.close();
  await app.shutdown.shutdown(0);
  process.exit(0);
});
process.send({ type: 'booted' });
