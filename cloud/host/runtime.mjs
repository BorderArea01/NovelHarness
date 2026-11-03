import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from '../tools/node_modules/miniflare/dist/src/index.js';
const repository = fileURLToPath(new URL('../../', import.meta.url));
async function modules(directory, entry) {
  const found = [];
  async function visit(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const name = resolve(path, item.name);
      if (item.isDirectory()) await visit(name);
      else if (/\.(mjs|js)$/.test(name)) found.push({ type: 'ESModule', path: name });
    }
  }
  await visit(directory);
  const main = resolve(entry);
  return [{ type: 'ESModule', path: main }, ...found.filter((item) => item.path !== main)];
}
export async function hostRuntime({ release, persist, ownerKey, namespaceKey, bootstrap = false, port = 0, revision = 'local-host-verification', diagnostics = false, host = '127.0.0.1', publicOrigin = '', lanHosts = [], storageRole = 'host', providerBindings = {} }) {
  if (typeof ownerKey !== 'string' || ownerKey.length < 32 || !/^[a-zA-Z0-9_-]{16,128}$/.test(namespaceKey ?? ''))
    throw new Error('Explicit existing owner key and stable local namespace identity required.');
  if (Object.keys(providerBindings).some(key => !['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REASONING_EFFORT', 'DEEPSEEK_MAX_OUTPUT_TOKENS'].includes(key)))
    throw new Error('Unknown explicit provider binding.');
  const durableObjects = {
    DSH_EDGE_INSTANCE: { className: 'DshEdgeInstance', useSQLite: true, unsafeUniqueKey: namespaceKey + '-main' },
    PIN_AUTH: { className: 'PinAuth', useSQLite: true, unsafeUniqueKey: namespaceKey + '-pin' },
  };
  const common = { compatibilityDate: '2026-08-14', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'] };
  let workers;
  if (bootstrap) workers = [{
    name: 'novel-host-harness', ...common, modulesRoot: repository,
    modules: ['cloud/host/bootstrap.mjs', 'cloud/worker/storage-snapshot.mjs', 'cloud/worker/storage-pages.mjs', 'cloud/worker/storage-value.mjs'].map((path) => ({ type: 'ESModule', path: resolve(repository, path) })),
    bindings: { DSH_EDGE_ACCESS_KEY: ownerKey }, durableObjects,
  }];
  else workers = [{
    name: 'novel-host-harness', ...common, modulesRoot: release,
    modules: [
      { type: 'ESModule', path: resolve(release, 'host/gateway-entry.mjs') },
      { type: 'ESModule', path: resolve(release, 'host/host-wire.mjs') },
      { type: 'ESModule', path: resolve(release, 'pages/src/gateway.mjs') },
      ...(await modules(resolve(release, 'worker'), resolve(release, 'worker/entry.mjs'))),
    ],
    bindings: { PLATFORM_REVISION: revision, DSH_EDGE_ACCESS_KEY: ownerKey, DSH_EDGE_ATTACHMENT_STORAGE: 'temporary-do', NOVEL_STORAGE_ROLE: storageRole,
      NOVEL_PUBLIC_ORIGIN: publicOrigin, NOVEL_LAN_HOSTS: lanHosts.join(','), ...providerBindings }, durableObjects,
    assets: { directory: resolve(release, 'assets'), binding: 'ASSETS', run_worker_first: true,
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { not_found_handling: 'single-page-application' } },
  }];
  const options = convertV4MiniflareOptions({ host: bootstrap ? '127.0.0.1' : host, port, cf: false, workers });
  return new Miniflare({ ...options, resourcePersistencePath: persist, logRequests: false, unsafeLocalExplorer: false,
    handleStructuredLogs: diagnostics ? (entry) => console.log(entry.level, entry.message) : () => {},
    handleUncaughtError: diagnostics ? (error) => console.error(error.message) : () => {} });
}
