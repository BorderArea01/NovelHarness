import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installNovelClientBase } from '../official/novel/client-base.mjs';

test('UI revision changes reach both linked and packaged physical bridge installations', async () => {
  const cwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'novel-client-base-'));
  const baseline = join(root, 'data/official-validation/integration');
  const modules = join(root, 'cloud/official/node_modules');
  try {
    for (const [name, asset] of [
      ['conversation', 'conversation'],
      ['sidebar', 'sidebar'],
      ['layout', 'layout'],
      ['settings-general', 'settings'],
    ]) {
      const dir = join(modules, '@deepseek-ai/dsh-client-ui-' + name, 'lib');
      await mkdir(dir, { recursive: true });
      await mkdir(join(baseline, 'baseline/native-shell'), { recursive: true });
      await writeFile(join(dir, 'client.js'), 'export const fixture = true;');
      await writeFile(join(baseline, 'baseline/native-shell', asset + '.js'), 'export const fixture = true;');
    }
    await mkdir(join(baseline, 'baseline/assets'), { recursive: true });
    await writeFile(join(baseline, 'baseline/assets/harness-bridge.mjs'), 'export const fixture = true;');
    const config = join(baseline, 'baseline.json');
    await writeFile(config, JSON.stringify({ novelAssetsRevision: 'official-novel-' + 'a'.repeat(16) }));
    process.chdir(root);
    await installNovelClientBase();
    const bridge = join(modules, 'novel-harness-bridge');
    assert((await lstat(bridge)).isSymbolicLink());
    assert.match(await readFile(join(bridge, 'client.js'), 'utf8'), /official-novel-aaaaaaaaaaaaaaaa/);
    // Reproduce package-official-production's dereference:true snapshot.
    await rm(bridge); // Unlink this fixture junction; never traverse its target.
    await cp(join(baseline, 'client-plugin'), bridge, { recursive: true, dereference: true });
    await writeFile(config, JSON.stringify({ novelAssetsRevision: 'official-novel-' + 'b'.repeat(16) }));
    await installNovelClientBase();
    assert.equal((await lstat(bridge)).isSymbolicLink(), false);
    assert.match(await readFile(join(bridge, 'client.js'), 'utf8'), /official-novel-bbbbbbbbbbbbbbbb/);
    // An unexpected plugin identity is never silently overwritten.
    await writeFile(join(bridge, 'package.json'), JSON.stringify({ name: 'custom-plugin' }));
    const before = await readFile(join(bridge, 'client.js'));
    await assert.rejects(installNovelClientBase(), /not the managed generated package/);
    assert.deepEqual(await readFile(join(bridge, 'client.js')), before);
  } finally {
    process.chdir(cwd);
    assert(root.startsWith(join(tmpdir(), 'novel-client-base-')));
    await rm(root, { recursive: true, force: true });
  }
});
