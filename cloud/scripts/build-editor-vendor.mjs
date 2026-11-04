import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from '../../node_modules/esbuild/lib/main.js';
const versions = {
  '@codemirror/state': '6.7.6',
  '@codemirror/view': '6.43.15',
  '@codemirror/commands': '6.11.1',
};
const deps = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  '@marijn/find-cluster-break',
  'style-mod',
  'w3c-keyname',
  'crelt',
];
let notices = 'Generated CodeMirror browser bundle; do not edit.\n';
for (const name of deps) {
  const base = new URL('../tools/node_modules/' + name + '/', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  if (versions[name] && pkg.version !== versions[name]) throw new Error('Unexpected editor version.');
  if (pkg.license !== 'MIT') throw new Error('Review required for editor dependency license: ' + name);
  notices += '\n' + name + '@' + pkg.version + '\n' + (await readFile(new URL('LICENSE', base), 'utf8'));
}
const base = fileURLToPath(new URL('../tools/', import.meta.url));
const result = await build({
  stdin: {
    contents:
      'export {EditorState,Transaction,StateField,StateEffect} from "@codemirror/state"; export {EditorView,keymap,drawSelection,Decoration,WidgetType} from "@codemirror/view"; export {defaultKeymap,history,historyKeymap} from "@codemirror/commands";',
    resolveDir: base,
  },
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: ['es2022'],
  banner: { js: '/* ' + notices.replaceAll('*/', '* /') + '\n*/' },
});
const output = result.outputFiles[0].contents;
await writeFile(new URL('../pages/public/novel-assets/editor-vendor.mjs', import.meta.url), output);
console.log(
  'Generated pinned CodeMirror asset; SHA-256 ' + createHash('sha256').update(output).digest('hex'),
);
