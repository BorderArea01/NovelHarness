// Deterministic generated browser asset, no CDN/runtime network dependency.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from '../../node_modules/esbuild/lib/main.js';
const pkg = new URL('../tools/node_modules/node-diff3/', import.meta.url);
if (JSON.parse(await readFile(new URL('package.json', pkg), 'utf8')).version !== '3.2.1')
  throw new Error('Unexpected diff3 version.');
const license = await readFile(new URL('LICENSE.md', pkg), 'utf8');
const entry = fileURLToPath(new URL('src/diff3.mjs', pkg));
const result = await build({
  stdin: {
    contents: `export {diff3Merge} from ${JSON.stringify(entry.replaceAll('\\', '/'))};`,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
  },
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: ['es2022'],
  banner: {
    js: '/* node-diff3 3.2.1 — generated, do not edit.\n' + license.replaceAll('*/', '* /') + '\n*/',
  },
});
const output = result.outputFiles[0].contents;
await writeFile(new URL('../pages/public/novel-assets/diff3-vendor.mjs', import.meta.url), output);
console.log(
  'Generated pinned diff3 browser asset; SHA-256 ' + createHash('sha256').update(output).digest('hex'),
);
