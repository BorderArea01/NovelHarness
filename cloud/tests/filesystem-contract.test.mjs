import test from 'node:test';
import assert from 'node:assert/strict';
import { NovelFileSystem } from '../official/novel/filesystem.mjs';
import {
  patchVirtualBashFacts,
  VIRTUAL_BASH_FACTS,
  patchFileMutationCounts,
} from '../official/novel/host-compat.mjs';

test('write/edit presentation exposes exact editor counts without adding fields to strict canonical outcomes', () => {
  const source =
    'const write = value => ({type:"text", text: formatWriteOutput(value.path, value)}); const edit = (args,value) => ({type:"text", text: formatEditOutput(value.path, args.replace_all ?? false)});';
  const patched = patchFileMutationCounts(source);
  const render = new Function('formatWriteOutput', 'formatEditOutput', patched + '; return {write,edit};')(
    () => 'Updated file',
    () => 'Edited file',
  );
  const value = Object.freeze({ path: '/workspace/test.md', after: '\ufeff甲\r\n\t乙 🌧️' });
  for (const out of [render.write(value), render.edit({}, value)]) {
    assert.deepEqual(Object.keys(out).sort(), ['text', 'type']);
    assert(
      out.text.endsWith(
        'characters (editor, excluding whitespace): ' + value.after.replace(/\s/g, '').length,
      ),
    );
  }
  assert.equal(patchFileMutationCounts(patched), patched);
  assert.throws(
    () => patchFileMutationCounts(source.replace('text: formatWriteOutput', 'other: formatWriteOutput')),
    /seam changed/,
  );
});

test('virtual bash advertises its actual interpreter and count lookup without changing tool arguments, execution or output schemas', () => {
  const original =
    'return defineTool({ name: "bash", description: bashDescription(), parameters: params, execute, output });';
  const patched = patchVirtualBashFacts(original);
  assert(patched.includes(JSON.stringify('\n' + VIRTUAL_BASH_FACTS)));
  assert(patched.includes('parameters: params, execute, output'));
  assert.equal(patchVirtualBashFacts(patched), patched);
  assert.throws(() => patchVirtualBashFacts(original.replace('description:', 'other:')), /seam changed/);
  assert.throws(() => patchVirtualBashFacts(original + original), /seam changed/);
});

// Small provider-contract harness; the actual SQLite/native Agent boundary is
// exercised separately in official-novel-web, not claimed by these unit tests.
function fixture(initial) {
  let value = initial,
    revision = 1,
    writes = 0;
  const fs = Object.create(NovelFileSystem.prototype);
  const target = { targetKey: 'novel-vfs:/workspace/contract.md', displayPath: '/workspace/contract.md' };
  fs.version = () => 'v:' + revision;
  fs.bytes = () => Buffer.from(value);
  fs.document = () => null;
  fs.storage = {
    db: {
      transactionSync(fn) {
        const snapshot = { value, revision, writes };
        try {
          return fn();
        } catch (error) {
          ({ value, revision, writes } = snapshot);
          throw error;
        }
      },
    },
    fs: {
      mkdirSync() {},
      writeFileSync(_path, text) {
        value = text;
        revision++;
        writes++;
      },
    },
  };
  return { fs, target, read: () => value, writes: () => writes, version: () => fs.version() };
}

test('native edit returns exactly FsEditOutcome while write retains FsWriteOutcome; replacements are literal', async () => {
  const f = fixture('旧文与价格。');
  const outcome = await f.fs.editText(f.target, {
    oldString: '旧文',
    newString: "$& $$ $` $' 新文",
    replaceAll: false,
  });
  assert.deepEqual(Object.keys(outcome).sort(), ['after', 'before', 'version']);
  assert.equal(outcome.before, '旧文与价格。');
  assert.equal(outcome.after, "$& $$ $` $' 新文与价格。");
  assert.equal(f.read(), outcome.after);
  assert.equal(f.writes(), 1);
  const version = f.version();
  await assert.rejects(
    () => f.fs.editText(f.target, { oldString: '旧文', newString: '不要追加', replaceAll: false }),
    (error) => error.code === 'FS_EDIT_NOT_FOUND' && /no change was made/.test(error.message),
  );
  assert.equal(f.read(), outcome.after);
  assert.equal(f.version(), version);
  assert.equal(f.writes(), 1);
  const written = await f.fs.writeText(f.target, '整篇替换');
  assert.deepEqual(Object.keys(written).sort(), ['after', 'before', 'operation', 'version']);
  assert.equal(written.operation, 'update');
});

test('literal editing normalizes CRLF only, preserves storage line style and returns LF diff bases', async () => {
  for (const storedEol of ['\n', '\r\n'])
    for (const argEol of ['\n', '\r\n']) {
      const f = fixture(['甲', '乙', '丙', ''].join(storedEol));
      const out = await f.fs.editText(f.target, {
        oldString: ['甲', '乙'].join(argEol),
        newString: ['丁', '戊'].join(argEol),
      });
      assert.equal(f.read(), ['丁', '戊', '丙', ''].join(storedEol));
      assert.equal(out.before, '甲\n乙\n丙\n');
      assert.equal(out.after, '丁\n戊\n丙\n');
      assert.deepEqual(Object.keys(out).sort(), ['after', 'before', 'version']);
    }
  const f = fixture('\uFEFF甲\r乙\n');
  await assert.rejects(() => f.fs.editText(f.target, { oldString: '甲 乙', newString: '不能模糊替换' }), {
    code: 'FS_EDIT_NOT_FOUND',
  });
  assert.equal(f.read(), '\uFEFF甲\r乙\n');
  assert.equal(f.writes(), 0);
});

test('ambiguous, stale, aborted and empty edits never write; explicit replace-all and deletion still work', async () => {
  const f = fixture('旧文，旧文。');
  await assert.rejects(() => f.fs.editText(f.target, { oldString: '旧文', newString: '新文' }), {
    code: 'FS_AMBIGUOUS_EDIT',
  });
  await assert.rejects(() => f.fs.editText(f.target, { oldString: '', newString: '新文' }), {
    code: 'FS_EDIT_NOT_FOUND',
  });
  await assert.rejects(
    () =>
      f.fs.editText(
        f.target,
        { oldString: '旧文', newString: '新文' },
        { kind: 'replaceIfVersion', version: 'stale' },
      ),
    { code: 'FS_STALE_VERSION' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => f.fs.editText(f.target, { oldString: '旧文', newString: '新文' }, undefined, controller.signal),
    { code: 'FS_ABORTED' },
  );
  assert.equal(f.writes(), 0);
  await f.fs.editText(f.target, { oldString: '旧文', newString: '', replaceAll: true });
  assert.equal(f.read(), '，。');
  assert.equal(f.writes(), 1);
});
