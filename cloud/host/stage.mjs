import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildLanCrypto } from './build-lan-crypto.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageRuntime } from '../scripts/stage-runtime.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function stageHostRelease(release) {
  await cp(resolve(root, 'cloud/pages'), resolve(release, 'pages'), { recursive: true });
  await mkdir(resolve(release, 'host'), { recursive: true });
  await cp(resolve(root, 'cloud/host/gateway-entry.mjs'), resolve(release, 'host/gateway-entry.mjs'));
  await cp(resolve(root, 'cloud/host/host-wire.mjs'), resolve(release, 'host/host-wire.mjs'));
  await stageRuntime(resolve(release, 'worker'), { pagesPublic: resolve(release, 'pages/public') });
  const nativeAssets = resolve(root, 'cloud/tools/node_modules/dsh-edge/dist');
  await cp(nativeAssets, resolve(release, 'assets'), { recursive: true });
  await cp(resolve(release, 'pages/public'), resolve(release, 'assets'), { recursive: true });
  // Root is always the native boot document, decorated by the SAME Pages router.
  // Login/library/account resources remain under their original explicit paths.
  await cp(resolve(nativeAssets, 'index.html'), resolve(release, 'assets/index.html'));
  await buildLanCrypto(resolve(release, 'assets/__host-assets'));
  const mergeWorker = resolve(release, 'assets/novel-assets/merge-worker.mjs');
  await writeFile(mergeWorker, "import '/__host-assets/crypto-runtime.mjs';\n" + await readFile(mergeWorker, 'utf8'));
}
