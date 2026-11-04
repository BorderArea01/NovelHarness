import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNativeShell } from './native-shell.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function stageRuntime(destination, { pagesPublic = resolve(root, 'cloud/pages/public') } = {}) {
  const runtime = resolve(root, 'cloud/tools/node_modules/dsh-edge');
  if (JSON.parse(await readFile(resolve(runtime, 'package.json'), 'utf8')).version !== '0.30.0')
    throw new Error('Unexpected native runtime.');
  await stageNativeShell(pagesPublic);
  // Browser and Worker consume the SAME pure task renderers. Copies are build
  // artifacts only; cloud/worker/shared is the single maintained source and
  // remains INSIDE the no-bundle Worker module root.
  for (const directory of [resolve(pagesPublic, 'worker/shared')]) {
    await mkdir(directory, { recursive: true });
    for (const name of ['writing-context.mjs', 'writing-prompts.mjs', 'illustrations.mjs'])
      await cp(resolve(root, 'cloud/worker/shared', name), resolve(directory, name), { force: true });
  }
  await mkdir(destination, { recursive: true });
  await cp(resolve(root, 'cloud/worker'), destination, { recursive: true, errorOnExist: true });
  await cp(resolve(runtime, 'worker/direct'), resolve(destination, 'native'), {
    recursive: true,
    errorOnExist: true,
  });
}
