import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  externalizeClientMedia,
  clientMediaFile,
  stageClientMedia,
} from '../official/novel/client-media.mjs';

test('large built-in illustrations become exact content-addressed files, small icons and dynamic attachments stay unchanged', () => {
  const image = Buffer.alloc(18000, 97),
    uri = 'data:image/webp;base64,' + image.toString('base64');
  const source =
    'const a="' +
    uri +
    '", b="' +
    uri +
    '";\nconst icon="data:image/png;base64,YQ=="; const upload=`data:${type};base64,${data}`;';
  const result = externalizeClientMedia(source);
  assert.equal(result.media.size, 1);
  const [name, bytes] = [...result.media][0];
  assert.deepEqual(bytes, image);
  assert.equal(result.source, source.replaceAll(uri, '/__host-assets/client-media/' + name));
  assert.deepEqual(externalizeClientMedia(result.source).media.size, 0);
  for (const path of [
    '/__host-assets/client-media/../owner-key.txt',
    '/__host-assets/client-media/' + 'a'.repeat(64) + '.js',
  ])
    assert.equal(clientMediaFile(path), null);
  assert.equal(clientMediaFile('/__host-assets/client-media/' + name).type, 'image/webp');
});
test('staging preserves plugin-owned modules and checks extracted files survive a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-client-media-'));
  try {
    const modules = join(root, 'modules'),
      assets = join(root, 'assets');
    const dir = join(modules, '@deepseek-ai/dsh-client-ui-settings-account/lib');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'client.js'),
      source = 'const guide="data:image/webp;base64,' + Buffer.alloc(18000, 98).toString('base64') + '";';
    await writeFile(file, source);
    await writeFile(file + '.dshpurge.bak', source);
    await stageClientMedia(modules, assets);
    assert.equal(await readFile(file, 'utf8'), source);
    await rm(file + '.dshpurge.bak');
    await stageClientMedia(modules, assets);
    const staged = await readFile(file, 'utf8');
    assert.notEqual(staged, source);
    await stageClientMedia(modules, assets);
    assert.equal(await readFile(file, 'utf8'), staged);
    await rm(assets, { recursive: true });
    await assert.rejects(stageClientMedia(modules, assets), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
