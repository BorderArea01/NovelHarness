import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageHostRelease } from '../host/stage.mjs';
import { prepareOfficialNovel } from '../scripts/prepare-official-novel.mjs';
import { createEmptyNovelStorage } from '../official/novel/storage.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';

const scope = resolve('data/official-validation/integration');
const source = join(scope, 'source');
await stageHostRelease(source);
// Version every emitted source, including CSS/icons. A stylesheet-only update
// must not reuse an immutable browser URL from a previous build.
const fingerprint = createHash('sha256');
async function fingerprintTree(path) {
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await fingerprintTree(file);
    else if (entry.isFile())
      fingerprint
        .update(file.replaceAll('\\', '/'))
        .update('\0')
        .update(await readFile(file));
  }
}
for (const path of ['cloud/pages/public', 'cloud/pages/src', 'cloud/worker', 'cloud/official/novel'])
  await fingerprintTree(path);
const revision = fingerprint.digest('hex');
await prepareOfficialNovel({ sourceRelease: { release: source, revision } });
const temp = join(scope, 'visitors', '0'.repeat(64));
await mkdir(join(temp, 'home'), { recursive: true });
await createEmptyNovelStorage(join(temp, 'main.sqlite'));
const app = await startOfficialNovel({
  home: join(temp, 'home'),
  sqlite: join(temp, 'main.sqlite'),
  anonymous: true,
});
await app.shutdown.shutdown(0);
app.storage.close();
const welcomePath = resolve(
  'cloud/official/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js',
);
const welcome = await readFile(welcomePath, 'utf8');
await writeFile(
  welcomePath,
  welcome.replace(
    '登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。',
    '添加你自己的 API Key 后即可使用 AI。作品保存在服务器的独立访客空间；请保留浏览器 Cookie 并定期导出备份。',
  ),
);
// Windows can hold native modules from this temporary home until process exit.
// The parent removes it only after this process has fully terminated.
// Source is reproducible; retain the single current baseline only.
await rm(source, { recursive: true, force: true });
await writeFile(
  '.anonymous-host.json',
  JSON.stringify({ format: 'novelharness-anonymous-v1', prepared: true, revision }),
);
