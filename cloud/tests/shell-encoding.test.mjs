import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InMemoryFs } from '../official/node_modules/just-bash/dist/bundle/index.js';
import { createShellFilesystem, createNovelBash } from '../official/novel/subprocess.mjs';
import { createHash } from 'node:crypto';
const sha = (value) => createHash('sha256').update(value).digest('hex');

// The pinned upstream adapter is exercised, not a mock of its encoding behavior.
const upstream = await readFile(
  new URL(
    '../official/node_modules/@cloudflare/computer/dist/backends/worker-shell/index.js',
    import.meta.url,
  ),
  'utf8',
);
const region = upstream.match(
  /\/\/#region src\/backends\/worker-shell\/adapter\.ts\r?\n([\s\S]*?)\/\/#endregion/,
);
assert(region?.[1].includes('var WorkspaceFsAdapter = class'), 'Pinned upstream adapter seam changed.');
const { WorkspaceFsAdapter } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(region[1] + '\nexport { WorkspaceFsAdapter };').toString('base64')
);
function fixture(text) {
  const memory = new InMemoryFs({ '/workspace/in.md': text, '/workspace/out.md': '原稿不能损坏' });
  const facade = {
    async readFile(path, options) {
      return options === 'utf8'
        ? memory.readFile(path, 'utf8')
        : new Blob([await memory.readFileBuffer(path)]).stream();
    },
    writeFile: (path, content) => memory.writeFile(path, content),
    exists: (path) => memory.exists(path),
    stat: (path) => memory.stat(path),
    async statOrNull(path) {
      try {
        return await memory.stat(path);
      } catch {
        return null;
      }
    },
    async lstatOrNull(path) {
      try {
        return await memory.lstat(path);
      } catch {
        return null;
      }
    },
    readdir: (path) => memory.readdirWithFileTypes(path),
    mkdir: (path, options) => memory.mkdir(path, options),
    rm: (path, options) => memory.rm(path, options),
    chmod: (path, mode) => memory.chmod(path, mode),
    readlink: (path) => memory.readlink(path),
    symlink: (target, path) => memory.symlink(target, path),
    rename: (src, dest) => memory.mv(src, dest),
    realpath: (path) => memory.realpath(path),
  };
  const fs = createShellFilesystem(WorkspaceFsAdapter, facade);
  const shell = createNovelBash({ fs, cwd: '/workspace', executionLimitProfile: 'hardened' });
  return { memory, fs, shell };
}
const original = '\ufeff# 第一章 雨夜\r\n\r\n她抬头，看见来人。🌧️ café\r\n';

for (const [name, command, expected] of [
  ['cat redirection', 'cat in.md > out.md', original],
  ['copy', 'cp in.md out.md', original],
  ['pipeline and tee', 'cat in.md | tee out.md > /dev/null', original],
  ['byte append', 'cat in.md > out.md; cat in.md >> out.md', original + original],
  ['heredoc', "cat > out.md <<'EOF'\n中文正文🌧️\nEOF", '中文正文🌧️\n'],
  ['octal printf', "printf '\\347\\254\\254\\344\\270\\200\\347\\253\\240\\n' > out.md", '第一章\n'],
  ['octal printf argument', "printf '%b' '\\0347\\0254\\0254\\0344\\0270\\0200' > out.md", '第一'],
  ['literal printf argument', "printf '%s' '\\347\\254\\254' > out.md", '\\347\\254\\254'],
  ['mixed printf', "printf '中文 %b %s' '\\347\\254\\254' 'é🌧️' > out.md", '中文 第 é🌧️'],
  [
    'base64 decode',
    `printf '%s' '${Buffer.from(original).toString('base64')}' | base64 -d > out.md`,
    original,
  ],
])
  test('shell encoding: ' + name + ' preserves exact UTF-8 bytes', async () => {
    const f = fixture(original);
    const result = await f.shell.exec(command);
    assert.equal(result.exitCode, 0, result.stderr);
    const actual = await f.memory.readFileBuffer('/workspace/out.md');
    assert.equal(
      sha(actual),
      sha(expected),
      'output prefix bytes: ' + Buffer.from(actual).subarray(0, 40).toString('hex'),
    );
  });

test('shell encoding: 600 KiB Chinese rewrite remains byte-identical after repeated redirects', async () => {
  const large = original + '中文长篇，完整改写不应转码。🌧️\r\n'.repeat(14000);
  const f = fixture(large);
  const result = await f.shell.exec('cat in.md > out.md; cat out.md > in.md; cat in.md > out.md');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(sha(await f.memory.readFileBuffer('/workspace/out.md')), sha(large));
});

test('shell encoding: explicit read/write/append encodings are honored without guessing content', async () => {
  const f = fixture(original),
    bytes = Buffer.from(original);
  for (const encoding of ['utf8', 'latin1', 'binary', 'hex', 'base64']) {
    assert.equal(await f.fs.readFile('/workspace/in.md', { encoding }), bytes.toString(encoding));
    await f.fs.writeFile('/workspace/out.md', bytes.toString(encoding), { encoding });
    await f.fs.appendFile('/workspace/out.md', bytes.toString(encoding), encoding);
    assert.deepEqual(
      Buffer.from(await f.memory.readFileBuffer('/workspace/out.md')),
      Buffer.concat([bytes, bytes]),
    );
  }
});
