// Stage the EXISTING immutable novel UI as the official host's client build,
// then let the ORIGINAL module registry/HMR own its graph. No second graph.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, unlink, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

export async function installNovelClientBase() {
  const modules = resolve('cloud/official/node_modules');
  const base = resolve('data/official-validation/integration/baseline');
  for (const [name, asset] of [
    ['conversation', 'conversation'],
    ['sidebar', 'sidebar'],
    ['layout', 'layout'],
    ['settings-general', 'settings'],
  ]) {
    const target = join(modules, '@deepseek-ai/dsh-client-ui-' + name, 'lib/client.js');
    assert(!relative(modules, target).startsWith('..'));
    const before = await readFile(target);
    const next = await readFile(join(base, 'native-shell', asset + '.js'));
    if (before.equals(next)) continue;
    const upstream = target + '.novel-upstream.bak';
    if (!existsSync(upstream)) await copyFile(target, upstream);
    // A no-op original Restore may retain an identical backup. Once the base
    // artifact changes, rebase that backup through the plugin's backupAll so
    // removing dsh-purge retains the novel UI rather than reverting to stock UI.
    const backup = target + '.dshpurge.bak';
    if (existsSync(backup)) {
      assert(
        (await readFile(backup)).equals(before),
        'Unexpected purge backup differs from restored baseline.',
      );
      await unlink(backup);
    }
    await writeFile(target, next);
  }
  const plugin = resolve('data/official-validation/integration/client-plugin');
  const { novelAssetsRevision } = JSON.parse(
    await readFile(resolve('data/official-validation/integration/baseline.json'), 'utf8'),
  );
  assert(/^official-novel-[a-f0-9]{16}$/.test(novelAssetsRevision));
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify(
      {
        name: 'novel-harness-bridge',
        version: '0.0.0',
        private: true,
        type: 'module',
        exports: { '.': './index.mjs', './client': './client.js' },
        dsh: {
          client: {
            platform: 'web',
            inject: [
              '@deepseek-ai/dsh-client-ui-workspace',
              '@deepseek-ai/dsh-api-session-controller',
              '@deepseek-ai/dsh-api-workspace-controller',
              '@deepseek-ai/dsh-client-ui-theme',
              '@deepseek-ai/dsh-client-ui-sidebar',
              '@deepseek-ai/dsh-client-ui-settings-models',
              '@deepseek-ai/dsh-client-ui-settings-general',
              '@deepseek-ai/dsh-client-ui-sidebar-right',
              '@deepseek-ai/dsh-client-ui-conversation',
              '@deepseek-ai/dsh-client-ui-session',
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(plugin, 'index.mjs'),
    "export const name = 'novel-harness-bridge';\nexport function apply() {}\n",
  );
  await writeFile(
    join(plugin, 'client.js'),
    'globalThis.__NOVEL_ASSET_BASE__ = ' +
      JSON.stringify('/studio/' + novelAssetsRevision + '/pages/public/novel-assets/') +
      ';\n' +
      (await readFile(join(base, 'assets/harness-bridge.mjs'), 'utf8')),
  );
  const link = join(modules, 'novel-harness-bridge');
  if (!existsSync(link)) await symlink(plugin, link, 'junction');
}
