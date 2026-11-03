import { build } from '../../node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function buildLanCrypto(directory) {
  const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/@noble/hashes/package.json'), 'utf8'));
  if (pkg.version !== '1.8.0' || pkg.license !== 'MIT') throw new Error('Unreviewed LAN hashing dependency.');
  await mkdir(directory, { recursive: true });
  for (const [format, name] of [['esm', 'crypto-runtime.mjs'], ['iife', 'crypto-boot.js']]) {
    await build({ entryPoints: [resolve(root, 'cloud/host/lan-crypto.mjs')], bundle: true, platform: 'browser', format,
      minify: true, legalComments: 'inline', outfile: resolve(directory, name), logLevel: 'silent' });
  }
  await writeFile(resolve(directory, 'NOBLE-HASHES-LICENSE.txt'), await readFile(resolve(root, 'node_modules/@noble/hashes/LICENSE')));
}
