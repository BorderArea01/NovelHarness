// Reproducible isolated worktree: copy the running novel implementation, never
// edit its release. Bundle only the public SQLite VFS provider for Node.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from '../tools/node_modules/esbuild/lib/main.js';
import { privateDirectory } from './private-directory.mjs';

export async function prepareOfficialNovel({ sourceRelease, destination } = {}) {
  const scope = resolve('data/official-validation/integration');
  const root = destination ? resolve(destination) : scope;
  if (destination) {
    const rel = relative(scope, root);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Baseline destination escapes isolated scope.');
  }
  await privateDirectory(root);
  const active = sourceRelease ?? JSON.parse(await readFile('data/local-host/active.json', 'utf8'));
  if (sourceRelease) {
    const rel = relative(scope, resolve(active.release));
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^[a-f0-9]{64}$/.test(active.revision ?? ''))
      throw new Error('Explicit source must be a fingerprinted isolated release.');
  }
  const worker = join(root, 'baseline/worker');
  const assets = join(root, 'baseline/assets');
  await mkdir(worker, { recursive: true });
  await cp(join(active.release, 'worker'), worker, {
    recursive: true,
    filter: (path) => !/[\\/]native(?:[\\/]|$)/.test(path),
  });
  await cp(join(active.release, 'pages/public/novel-assets'), assets, { recursive: true });
  for (const name of ['native-shell', 'login', 'auth-assets'])
    await cp(join(active.release, 'pages/public', name), join(root, 'baseline', name), { recursive: true });
  await cp(join(active.release, 'assets/__host-assets'), join(root, 'baseline/host-assets'), {
    recursive: true,
  });
  await cp(join(active.release, 'pages/src/gateway.mjs'), join(root, 'baseline/page-gateway.mjs'));
  // Keep the existing product UI. Only its obsolete prompt-only plugin panel
  // is removed: the original full plugin now owns its own single entry.
  const bridge = join(assets, 'harness-bridge.mjs');
  let bridgeSource = await readFile(bridge, 'utf8');
  for (const line of [
    "        import(assetBase + 'purge-settings.mjs'),\n",
    '            { installPurgeSettings },\n',
    "            installPurgeSettings(ctx, require('react'));\n",
  ]) {
    if (bridgeSource.split(line).length > 2) throw new Error('Original novel plugin-panel seam duplicated.');
    bridgeSource = bridgeSource.replace(line, '');
  }
  await writeFile(bridge, bridgeSource);
  const navigation = join(assets, 'harness-navigation.mjs');
  const navigationSource = await readFile(navigation, 'utf8');
  const launcher = "ctx.slots.register({ name: 'settings.launcher' }, SettingsLauncher)";
  if (navigationSource.split(launcher).length !== 2) throw new Error('Original settings slot seam changed.');
  await writeFile(
    navigation,
    navigationSource.replace(
      launcher,
      "ctx.slots.register({ name: 'settings.launcher', priority: -100 }, SettingsLauncher)",
    ),
  );
  const novelAssetsRevision =
    'official-novel-' +
    createHash('sha256')
      .update(active.revision)
      .update(bridgeSource)
      .update(await readFile(navigation))
      .digest('hex')
      .slice(0, 16);
  // Reuse the exact production editor HTTP dispatch, including body limits,
  // revision cache, history, conflict and busy checks. Do not build a reduced
  // parallel manuscript API for the official host.
  const entry = await readFile(join(worker, 'entry.mjs'), 'utf8');
  const start = entry.indexOf('    const url = new URL(request.url),\n      match = /^\\/__novel_editor');
  const end = entry.lastIndexOf('\n  }\n}\nconst extended =');
  if (start < 0 || end <= start) throw new Error('Original novel HTTP dispatch boundary changed.');
  const dispatch = entry.slice(start, end);
  if (dispatch.split('return super.fetch(request);').length !== 2)
    throw new Error('Original fallback seam changed.');
  await writeFile(
    join(worker, 'official-document-route.mjs'),
    [
      "import { nativeWorkspace, nativeBookTitle, bookIsGenerating } from './native-workspace.mjs';",
      "import { makeDocumentService, DocumentError } from './novel-documents.mjs';",
      "import { REQUEST_LIMIT } from './document-storage.mjs';",
      "import { bootstrapBook, listBooks, BOOTSTRAP_LIMIT } from './book-catalog.mjs';",
      "import { manageBook, listTrashedBooks } from './book-lifecycle.mjs';",
      "import { readWorkspaceRevision } from './read-snapshot.mjs';",
      "import { serviceFailure } from './service-failure.mjs';",
      "import { novelRoot } from './novel-role.mjs';",
      'export async function fetchNovelDocument(request) {',
      dispatch.replace('return super.fetch(request);', 'return this.nativeFetch(request);'),
      '}',
      '',
    ].join('\n'),
  );
  const role = join(worker, 'novel-role.mjs');
  const roleSource = await readFile(role, 'utf8');
  // Old immutable baselines had a private persona constant. New ones deliberately
  // have no separate assistant workflow; never regenerate one for compatibility.
  if (roleSource.includes('const NOVEL_PERSONA ='))
    await writeFile(role, roleSource + '\nexport { NOVEL_PERSONA };\n');
  else if (!roleSource.includes('export const NOVEL_IDENTITY'))
    throw new Error('Novel baseline identity seam changed.');
  const source = resolve('cloud/official/node_modules/@cloudflare/computer/dist/index.js');
  const shellSource = resolve(
    'cloud/official/node_modules/@cloudflare/computer/dist/backends/worker-shell/index.js',
  );
  const compiled = await build({
    stdin: {
      contents:
        'export { SQLiteWorkspaceProvider, WorkspaceFilesystem, initializeSchema } from ' +
        JSON.stringify(source.replaceAll('\\', '/')) +
        ';\n' +
        'export { WorkspaceFsAdapter } from ' +
        JSON.stringify(shellSource.replaceAll('\\', '/')) +
        ';',
      resolveDir: resolve('.'),
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    treeShaking: true,
    write: false,
    legalComments: 'inline',
    plugins: [
      {
        name: 'exclude-unused-cloudflare-transport',
        setup(build) {
          // Expose the pure upstream facade only in this private build; the
          // shell adapter is already an upstream export. Neither is rewritten.
          build.onLoad({ filter: /[\\/]@cloudflare[\\/]computer[\\/]dist[\\/]index\.js$/ }, async (args) => ({
            contents: (await readFile(args.path, 'utf8')) + '\nexport { WorkspaceFilesystem, initializeSchema };\n',
            loader: 'js',
          }));
          build.onLoad(
            { filter: /[\\/]computer[\\/]dist[\\/]backends[\\/]worker-shell[\\/]index\.js$/ },
            async (args) => {
              const source = await readFile(args.path, 'utf8');
              const region = source.match(
                /\/\/#region src\/backends\/worker-shell\/adapter\.ts\r?\n([\s\S]*?)\/\/#endregion/,
              );
              if (!region || !region[1].includes('var WorkspaceFsAdapter = class'))
                throw new Error('Upstream shell adapter boundary changed.');
              // The rest of this entry defines WorkerEntrypoint subclasses with
              // load-time effects. Extract its marked, unchanged pure adapter
              // region instead of loading or faking a Cloudflare Worker in Node.
              return { contents: region[1] + '\nexport { WorkspaceFsAdapter };\n', loader: 'js' };
            },
          );
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'unused-cloudflare-transport',
            namespace: 'novel-unused',
            sideEffects: false,
          }));
          build.onLoad({ filter: /.*/, namespace: 'novel-unused' }, () => ({
            contents:
              'export class RpcTarget { constructor(){throw new Error("Cloudflare RPC is unavailable in the Node VFS adapter")} } export class WorkerEntrypoint extends RpcTarget {}',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const output = compiled.outputFiles[0].text;
  if (output.includes('cloudflare:workers') || output.includes('Cloudflare RPC is unavailable'))
    throw new Error('Cloudflare transport was not removed from the SQLite-only build.');
  await writeFile(
    join(root, 'vfs.mjs'),
    '// Generated from @cloudflare/computer 0.3.1 (MIT), SQLiteWorkspaceProvider only.\n' + output,
  );
  const receipt = {
    format: 'novel-official-baseline-v1',
    at: new Date().toISOString(),
    sourceRelease: active.revision,
    novelAssetsRevision,
    sourceReleaseDirectory: active.release,
    vfsPackage: '@cloudflare/computer@0.3.1',
    vfsSourceHash: createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
    shellAdapterSourceHash: createHash('sha256')
      .update(await readFile(shellSource))
      .digest('hex'),
    vfsBundleHash: createHash('sha256').update(output).digest('hex'),
    cloudflareTransportIncluded: false,
    productionModified: false,
  };
  await writeFile(join(root, 'baseline.json'), JSON.stringify(receipt, null, 2));
  return { root, worker, assets, receipt };
}
