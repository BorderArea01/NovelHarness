import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EDGE_CODING_IDENTITY,
  NOVEL_IDENTITY,
  novelRoot,
  withNovelRole,
  installNovelRole,
} from '../worker/novel-role.mjs';
const root = '/workspace/novels/b-' + 'a'.repeat(32);
const original = () => ({
  sections: [
    {
      name: 'deployment:persona-prefix',
      text: EDGE_CODING_IDENTITY + 'Original shell limitations and MCP guidance.',
      interpolate: true,
    },
    { name: 'author:policy', text: 'Preserve author directions.' },
    { name: 'deployment:persona-suffix', text: 'Only files under /workspace persist across sessions.' },
  ],
  tools: [{ name: 'read' }, { name: 'write' }, { name: 'bash' }],
  contexts: [{ name: 'approval:policy', text: 'unchanged approval policy' }],
  variables: { model: 'synthetic' },
});
test('novel persona is identity only; no independent workflow is injected', () => {
  const text = withNovelRole(original(), root).sections[0].text;
  assert.ok(text.startsWith(NOVEL_IDENTITY));
  assert.doesNotMatch(text, /灵感定向|executionPrompt|先大纲再正文|novel_proposal_prepare/);
});

test('novel identity replaces only pinned deployment opener, keeping native runtime guidance, tools, author policy and assembly untouched', () => {
  const before = original(),
    old = structuredClone(before),
    after = withNovelRole(before, root);
  assert.ok(after.sections[0].text.startsWith(NOVEL_IDENTITY));
  assert.ok(after.sections[0].text.endsWith('Original shell limitations and MCP guidance.'));
  assert.ok(!after.sections[0].text.includes(EDGE_CODING_IDENTITY));
  assert.equal(after.sections[1], before.sections[1]);
  assert.equal(after.sections[2], before.sections[2]);
  assert.equal(after.tools, before.tools);
  assert.equal(after.contexts, before.contexts);
  assert.equal(after.variables, before.variables);
  assert.deepEqual(before, old);
});
test('ordinary directories, unrelated/custom personas and absent persona stay exactly native; book path matching is bounded by path segments', () => {
  for (const path of [
    '/workspace',
    root + '-other',
    root + '/../../outside',
    root + '/a//b',
    root + '/a\\b',
    root + '/a\0b',
  ]) {
    assert.equal(novelRoot(path), null);
    const a = original();
    assert.equal(withNovelRole(a, path), a);
  }
  for (const path of [root, root + '/', root + '/drafts']) assert.equal(novelRoot(path), root);
  const custom = original();
  custom.sections[0].text = 'Explicit custom persona';
  assert.equal(withNovelRole(custom, root), custom);
  const absent = original();
  absent.sections.shift();
  assert.equal(withNovelRole(absent, root), absent);
});
test('native waterfall uses live current directory on every assembly, observes downstream sections and never changes service readiness', async () => {
  let listener,
    cwd = root,
    eventName;
  const context = {
    get(name) {
      assert.equal(name, 'workingDirectory');
      return { get: () => cwd };
    },
    on(name, callback) {
      eventName = name;
      listener = callback;
      return () => {};
    },
  };
  assert.equal(typeof installNovelRole(context), 'function');
  assert.equal(eventName, 'system-prompt/assemble');
  const session = { header: { cwd: '/workspace' } };
  const details = {
    agent: {
      session,
      ctx: {
        get workingDirectory() {
          throw new Error('cannot get workingDirectory without inject');
        },
      },
    },
  };
  const a = original();
  assert.ok((await listener(a, details, async () => a)).sections[0].text.startsWith(NOVEL_IDENTITY));
  cwd = '/workspace';
  assert.equal(await listener(a, details, async () => a), a);
  assert.equal(await listener(a, {}, async () => a), a);
  const replacement = original();
  replacement.sections[0].text = 'author custom';
  cwd = root;
  assert.equal(await listener(a, details, async () => replacement), replacement);
  await assert.rejects(
    listener(a, details, async () => {
      throw new Error('native assembly failed');
    }),
    /native assembly failed/,
  );
});
test('pinned artifact still exposes the validated native context and identity seam; runtime upgrade must revalidate it', async () => {
  const native = await readFile(
    new URL('../tools/node_modules/dsh-edge/worker/direct/index.js', import.meta.url),
    'utf8',
  );
  assert.ok(native.includes(EDGE_CODING_IDENTITY));
  assert.ok(native.includes('context=new '));
  assert.ok(native.includes('system-prompt/assemble'));
});

test('ordinary novel context carries current native identity as non-interpolated data, not a fake active chapter or rewritten history', async () => {
  let listener,
    title = '新书名 {{model}}\n作者原文';
  const context = {
    get: () => ({ get: () => root }),
    on: (_name, callback) => {
      listener = callback;
      return () => {};
    },
  };
  installNovelRole(context, {
    readBookTitle: async (path) => {
      assert.equal(path, root);
      return title;
    },
  });
  const native = original(),
    details = { agent: { session: {} } };
  const first = await listener(native, details, async () => native);
  const identity = first.contexts.find((section) => section.name === 'novel:book-identity');
  assert.equal(identity.interpolate, false);
  assert.ok(identity.text.includes(JSON.stringify({ id: root.split('/').pop(), root, title })));
  assert.equal(JSON.parse(identity.text).title, title);
  title = '第二个当前书名';
  const second = await listener(native, details, async () => native);
  assert.ok(second.contexts.at(-1).text.includes(title));
  assert.ok(first.contexts.at(-1).text.includes('新书名'));
  assert.equal(withNovelRole(first, root), first, 'A decorated native assembly is not decorated twice.');
  assert.equal(native.sections.length, 3);
});

test('identity lookup failure or a changed book cannot prepare a mixed request; author custom personas bypass the lookup', async () => {
  let listener,
    cwd = root,
    fail = false,
    switchBook = false,
    reads = 0;
  const context = {
    get: () => ({ get: () => cwd }),
    on: (_name, callback) => {
      listener = callback;
      return () => {};
    },
  };
  installNovelRole(context, {
    readBookTitle: async () => {
      reads++;
      if (fail) throw new Error('identity unavailable');
      if (switchBook) cwd = '/workspace';
      return '本书名';
    },
  });
  const native = original(),
    details = { agent: { session: {} } };
  fail = true;
  await assert.rejects(
    listener(native, details, async () => native),
    /identity unavailable/,
  );
  fail = false;
  switchBook = true;
  await assert.rejects(
    listener(native, details, async () => native),
    /workspace changed/,
  );
  assert.equal(native.sections.length, 3);
  const custom = original();
  custom.sections[0].text = '作者自定义身份';
  cwd = root;
  assert.equal(await listener(native, details, async () => custom), custom);
  assert.equal(reads, 2);
});
