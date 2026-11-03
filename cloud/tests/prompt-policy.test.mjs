import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBookBundle, writingPrompt } from '../pages/public/novel-assets/bundle.mjs';
import {
  LEGACY_BOOK_INSTRUCTIONS,
  LEGACY_PLUGIN_PROMPT,
  legacyStartGuide,
  planBookPromptRepair,
  repairManagedBookPrompts,
} from '../shared/managed-prompt-repair.mjs';
import { proposalPrompt, taskContext } from '../worker/shared/writing-prompts.mjs';
const id = 'b-' + 'a'.repeat(32),
  root = '/workspace/novels/' + id;

test('new/imported books have no standalone guide or assistant-rule source; custom requirements merge into existing author material', async () => {
  const input = {
    state: {
      project: { title: '旧书' },
      outline: [],
      chapters: [],
      assistantPrompt: '作者自定义 {{model}}',
      savedPrompts: { write: '作者正文模板' },
      creativeRules: { style: '退役' },
    },
  };
  for (const source of [null, input]) {
    const bundle = await makeBookBundle(source, { seed: '雨夜来信' });
    assert(!bundle.files.some((file) => ['START.md', 'AGENTS.md'].includes(file.path)));
    const rules = JSON.parse(bundle.files.find((file) => file.path === 'rules.json').content);
    assert.equal(rules.assistantPrompt, undefined);
    assert.equal(rules.creativeRules, undefined);
    assert.equal(bundle.files.length, 8);
    assert.deepEqual(JSON.parse(writingPrompt(bundle.manifest)), { book: bundle.manifest.root });
    if (source) {
      assert.equal(rules.savedPrompts.write, '作者正文模板');
      assert(
        bundle.files.find((file) => file.path === 'setting.md').content.includes('作者自定义 {{model}}'),
      );
      assert(bundle.files.find((file) => file.path === 'archive/source.json').content.includes('退役'));
    }
  }
});

test('offline retirement previews, backs up exact bytes, merges custom notes, deletes generated guides and NEVER edits purge', () => {
  const f = fixture(),
    originalPlugin = Buffer.from(
      f.fs.readFileSync('/workspace/.novel-plugins/dsh-purge/config.json'),
    ).toString();
  f.fs.writeFileSync(root + '/setting.md', '作者已有设定\n');
  f.fs.writeFileSync(root + '/START.md', legacyStartGuide('旧书') + '\n作者额外要求');
  const rules =
    '\uFEFF' +
    JSON.stringify({
      assistantPrompt: '只属于本书的自定义 {{literal}}',
      savedPrompts: { write: '保留模板' },
      project: { genre: '奇幻' },
      unknown: { keep: true },
      creativeRules: { pov: '退役' },
      methodologyCards: [{ name: '旧卡' }],
      referenceText: '旧参考',
    }) +
    '\n';
  f.fs.writeFileSync(root + '/rules.json', rules);
  const before = f.rows(),
    preview = repairManagedBookPrompts(f.fs, f.db);
  assert.equal(preview.changed, 4);
  assert.equal(preview.pluginChanged, false);
  assert.deepEqual(f.rows(), before);
  assert.throws(() => repairManagedBookPrompts(f.fs, f.db, { apply: true }), /idle verification/);
  f.fail(root + '/rules.json');
  assert.throws(() => repairManagedBookPrompts(f.fs, f.db, { apply: true, ensureIdle() {} }), /disk full/);
  assert.deepEqual(f.rows(), before);
  f.fail(undefined);
  repairManagedBookPrompts(f.fs, f.db, { apply: true, ensureIdle() {} });
  assert(!f.rows().has(root + '/START.md') && !f.rows().has(root + '/AGENTS.md'));
  const setting = Buffer.from(f.fs.readFileSync(root + '/setting.md')).toString();
  assert(setting.startsWith('作者已有设定\n'));
  assert(setting.includes('作者额外要求') && setting.includes('只属于本书的自定义 {{literal}}'));
  assert(!setting.includes('修改已有正文先给 drafts/ 提案'));
  const cleaned = JSON.parse(
    Buffer.from(f.fs.readFileSync(root + '/rules.json'))
      .toString()
      .replace(/^\uFEFF/, ''),
  );
  assert.deepEqual(cleaned, {
    savedPrompts: { write: '保留模板' },
    project: { genre: '奇幻' },
    unknown: { keep: true },
  });
  assert(
    [...f.rows()].some(
      ([path, value]) =>
        path.startsWith('/workspace/.novel-prompt-repair/history/') &&
        value.data &&
        Buffer.from(value.data).toString() === rules,
    ),
  );
  assert.equal(
    Buffer.from(f.fs.readFileSync('/workspace/.novel-plugins/dsh-purge/config.json')).toString(),
    originalPlugin,
  );
  assert.equal(repairManagedBookPrompts(f.fs, f.db, { apply: true }).changed, 0);
});

test('custom standalone guides become existing book materials; invalid rule shapes and paths fail without dropping content', () => {
  const planned = planBookPromptRepair({
    root,
    title: '旧书',
    start: '作者自写的入口',
    instructions: '作者自写的要求',
    setting: '旧设定',
  });
  assert(planned.find((file) => file.path.endsWith('/setting.md')).after.includes('作者自写的入口'));
  assert(planned.filter((file) => file.after === null).length === 2);
  assert.throws(() => planBookPromptRepair({ root: root + '/../other', title: 'x' }));
  const f = fixture();
  f.fs.writeFileSync(root + '/rules.json', '{"assistantPrompt":[]}');
  const before = f.rows();
  assert.throws(() => repairManagedBookPrompts(f.fs, f.db, { apply: true, ensureIdle() {} }), /不是文本/);
  assert.deepEqual(f.rows(), before);
});

test('UI task handle and tool result contain author/data/template fields, not a long generated execution policy', () => {
  const book = { id, root, title: '旧书' };
  const proposal = {
    id: '12345678-1234-1234-1234-123456789abc',
    target: 'chapters/1.md',
    draft: 'drafts/task.md',
    baseHash: 'a'.repeat(64),
    writing: { version: 1, mode: 'write', instruction: '把开头改成雨天，再继续' },
    promptTemplate: { version: 1, key: 'write', source: 'custom', body: '作者任务模板' },
  };
  const handle = JSON.parse(
    proposalPrompt(book, { path: proposal.target }, proposal, proposal.writing.instruction, 'write'),
  );
  assert.equal(handle.request, proposal.writing.instruction);
  assert.equal(handle.proposal_id, proposal.id);
  assert(!Object.hasOwn(handle, 'template'));
  const task = taskContext(book, { parts: ['chapters/1.md.part-0001'] }, proposal, [{ path: 'setting.md' }]);
  assert.equal(task.template.body, '作者任务模板');
  assert.equal(task.materials[0].role, 'author-setting');
  assert.equal(task.target.parts.length, 1);
  assert(!Object.hasOwn(task, 'executionPrompt'));
});

test('oversized consolidated author notes fail atomically before removing any standalone source', () => {
  const f = fixture();
  f.fs.writeFileSync(root + '/setting.md', 'x'.repeat(1024 * 1024 - 100));
  f.fs.writeFileSync(root + '/START.md', '作者补充'.repeat(100));
  const before = f.rows();
  assert.throws(() => repairManagedBookPrompts(f.fs, f.db, { apply: true, ensureIdle() {} }), /读取上限/);
  assert.deepEqual(f.rows(), before);
});

test('consolidation refuses multipart author settings rather than creating a second competing source', () => {
  const f = fixture();
  f.fs.writeFileSync(root + '/START.md', '作者补充要求');
  f.fs.writeFileSync(root + '/setting.md.part-0001', '原设定的第一片');
  const before = f.rows();
  assert.throws(() => repairManagedBookPrompts(f.fs, f.db, { apply: true, ensureIdle() {} }), /分片作者设定/);
  assert.deepEqual(f.rows(), before);
});

function fixture() {
  let rows = new Map(),
    fail;
  const missing = () => {
    const e = new Error('missing');
    e.code = 'ENOENT';
    throw e;
  };
  const fs = {
    mkdirSync(path) {
      let p = '';
      for (const part of path.split('/').filter(Boolean)) {
        p += '/' + part;
        if (!rows.has(p)) rows.set(p, { dir: true });
      }
    },
    writeFileSync(path, data) {
      if (path === fail) throw new Error('disk full');
      rows.set(path, { data: Buffer.from(data) });
    },
    unlinkSync(path) {
      if (path === fail) throw new Error('disk full');
      if (!rows.delete(path)) missing();
    },
    readFileSync(path) {
      return rows.get(path)?.data ?? missing();
    },
    lstatSync(path) {
      const row = rows.get(path) ?? missing();
      return {
        size: row.data?.length ?? 0,
        nlink: 1,
        isFile: () => !row.dir,
        isDirectory: () => !!row.dir,
        isSymbolicLink: () => !!row.link,
      };
    },
    readdirSync(path) {
      return [...rows.keys()]
        .filter((p) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'))
        .map((p) => p.slice(path.length + 1));
    },
  };
  const db = {
    transactionSync(fn) {
      const old = structuredClone(rows);
      try {
        return fn();
      } catch (e) {
        rows = old;
        throw e;
      }
    },
  };
  fs.mkdirSync(root);
  fs.mkdirSync('/workspace/.novel-plugins/dsh-purge');
  for (const [path, text] of Object.entries({
    'book.json': JSON.stringify({ id, root, title: '旧书', format: 'novel-harness-book-v1' }),
    'AGENTS.md': LEGACY_BOOK_INSTRUCTIONS,
    'START.md': legacyStartGuide('旧书'),
    'rules.json': '{"savedPrompts":{"write":"作者模板"}}',
  }))
    fs.writeFileSync(root + '/' + path, text);
  fs.writeFileSync(
    '/workspace/.novel-plugins/dsh-purge/config.json',
    JSON.stringify({
      format: 'novel-dsh-purge-v1',
      prompt: LEGACY_PLUGIN_PROMPT,
      enabled: false,
      updatedAt: 1,
    }),
  );
  return {
    fs,
    db,
    fail: (path) => {
      fail = path;
    },
    rows: () => structuredClone(rows),
  };
}
