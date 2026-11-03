import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBookBundle, digest } from '../pages/public/novel-assets/bundle.mjs';
import {
  loadImportRecords,
  recordText,
  importReference,
  stageImportReference,
} from '../pages/public/novel-assets/import-records.mjs';

async function fixture(overrides = {}) {
  const source = {
    state: {
      project: { title: '导入记录样本' },
      chapters: [],
      outline: [],
      chatWindows: [
        {
          id: 'chat',
          name: '钟声讨论',
          messages: [
            { role: 'user', content: '谁在敲钟？\n不要把这个问句当作正文。' },
            { role: 'assistant', content: '也许是未来的她。', extra: { hypothesis: true } },
          ],
        },
      ],
      chapterSnapshots: [{ id: 'old', chapter: 9, content: '旧稿\r\n🌙', createdAt: '2026-01-01' }],
      operationLogs: [{ id: 'op', type: 'save', message: '保存时的说明' }],
      agentEditHistory: [{ id: 'ai', patches: [{ before: '甲', after: '乙' }], unknown: { future: 3 } }],
      ...overrides,
    },
  };
  const { manifest, files } = await makeBookBundle(source);
  const encode = (text) => new TextEncoder().encode(text);
  const stored = new Map(files.map((file) => [manifest.root + '/' + file.path, encode(file.content)]));
  stored.set(manifest.root + '/book.json', encode(JSON.stringify(manifest)));
  const reads = [];
  return {
    source,
    manifest,
    stored,
    reads,
    readFile: async (path) => {
      reads.push(path);
      return stored.get(path) ?? null;
    },
    publish() {
      stored.set('/workspace/novels/' + manifest.id + '/book.json', encode(JSON.stringify(manifest)));
    },
  };
}

test('import records read the original archive, preserve every historical field and never write', async () => {
  const f = await fixture();
  const archive = await loadImportRecords(f.manifest.id, f.readFile);
  assert.equal(archive.records.length, 4);
  for (const record of archive.records) assert.deepEqual(record.value, f.source.state[record.type][0]);
  const chat = archive.records[0];
  assert.equal(chat.pointer, '/state/chatWindows/0');
  assert.match(recordText(chat), /谁在敲钟？\n不要把这个问句当作正文。/);
  assert.match(recordText(chat), /hypothesis：true/);
  assert.match(recordText(archive.records[1]), /旧稿\r\n🌙/);
  assert.match(recordText(archive.records[3]), /修改前：甲/);
  assert.match(recordText(archive.records[3]), /future：3/);
  const reference = importReference(archive, chat);
  assert.match(reference, /不自动恢复或覆盖书稿/);
  assert.match(reference, /\/state\/chatWindows\/0/);
  assert.match(reference, new RegExp(archive.sha256));
  assert.ok(
    f.reads.every(
      (path) => path === f.manifest.root + '/book.json' || path.startsWith(f.manifest.root + '/archive/'),
    ),
  );
  assert.throws(() => importReference(archive, { ...chat }), /不属于/);
});

test('multipart archive is checked in order and indexed without dropping unusual keys or long text', async () => {
  const f = await fixture({
    chatWindows: {
      'a~/b': {
        name: '自定义键',
        messages: [{ role: 'assistant', content: '长文🌠'.repeat(70000) + '末尾不能丢' }],
      },
    },
  });
  assert.ok(f.manifest.archive.length > 1);
  const progress = [];
  const archive = await loadImportRecords(f.manifest.id, f.readFile, {
    onProgress: (p) => progress.push(p),
  });
  assert.equal(archive.records[0].pointer, '/state/chatWindows/a~0~1b');
  assert.match(recordText(archive.records[0]), /末尾不能丢/);
  assert.equal(progress.at(-1).done, f.manifest.archive.length);
  assert.deepEqual(archive.records[0].value, f.source.state.chatWindows['a~/b']);
});

test('missing, corrupt, duplicate, reordered or external archive parts fail closed', async () => {
  for (const kind of ['missing', 'corrupt', 'duplicate', 'external', 'gap', 'metadata', 'identity']) {
    const f = await fixture();
    const path = f.manifest.archive[0],
      absolute = f.manifest.root + '/' + path;
    if (kind === 'missing') f.stored.delete(absolute);
    if (kind === 'corrupt') f.stored.get(absolute)[0] ^= 1;
    if (kind === 'duplicate') f.manifest.files.push(f.manifest.files.find((file) => file.path === path));
    if (kind === 'external') f.manifest.archive[0] = '../another-book/source.json';
    if (kind === 'gap') f.manifest.archive = ['archive/source.json.part-0002'];
    if (kind === 'metadata') f.manifest.files.find((file) => file.path === path).sha256 = 'x';
    if (kind === 'identity') f.manifest.root = '/workspace/novels/b-' + '0'.repeat(32);
    f.publish();
    await assert.rejects(loadImportRecords(f.manifest.id, f.readFile), undefined, kind);
    assert.ok(f.reads.every((read) => read.startsWith('/workspace/novels/' + f.manifest.id + '/')));
  }
});

test('unrecognized collections, malformed UTF-8 and JSON do not appear as empty history', async () => {
  const f = await fixture({ chapterSnapshots: 'unexpected' });
  await assert.rejects(loadImportRecords(f.manifest.id, f.readFile), /格式无法识别/);
  for (const bytes of [new Uint8Array([255, 254]), new TextEncoder().encode('{unfinished')]) {
    const g = await fixture();
    const entry = g.manifest.files.find((file) => file.path === g.manifest.archive[0]);
    entry.bytes = bytes.length;
    entry.sha256 = await digest(bytes);
    g.stored.set(g.manifest.root + '/' + entry.path, bytes);
    g.publish();
    await assert.rejects(loadImportRecords(g.manifest.id, g.readFile), /完整的 UTF-8 JSON/);
  }
  const empty = await fixture({
    chatWindows: undefined,
    chapterSnapshots: [],
    operationLogs: {},
    agentEditHistory: null,
  });
  assert.equal((await loadImportRecords(empty.manifest.id, empty.readFile)).records.length, 0);
});

test('leaving a book or aborting a read cannot publish late import records', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await assert.rejects(loadImportRecords('../bad', f.readFile), /作品标识/);
  assert.equal(f.reads.length, 0);
  await assert.rejects(
    loadImportRecords(
      f.manifest.id,
      async (path) => {
        const bytes = await f.readFile(path);
        controller.abort();
        return bytes;
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(f.reads.length, 1);
});

test('historical custom keys are literal text and list labels identify the actual operation', async () => {
  const value = JSON.parse(
    '{"constructor":"作者自定义","__proto__":{"secret":"本书秘密"},"toString":"正常文本"}',
  );
  const text = recordText({ value });
  assert.match(text, /constructor：作者自定义/);
  assert.match(text, /__proto__/);
  assert.match(text, /secret：本书秘密/);
  assert.match(text, /toString：正常文本/);
  const f = await fixture();
  const { records } = await loadImportRecords(f.manifest.id, f.readFile);
  assert.match(records.find((r) => r.type === 'operationLogs').title, /保存时的说明/);
});

test('reference uses only original native draft initialization, preserves occupied input and never submits', () => {
  const root = '/workspace/novels/b-' + 'a'.repeat(32),
    binding = { ctx: {} };
  const state = { draft: '', phase: 'plain' };
  const calls = [];
  const ctx = {
    sessions: { binding: () => binding, list: { getSnapshot: () => ({ byId: { s: { cwd: root } } }) } },
    conversation: {
      input: {
        for: () => ({ state: { getSnapshot: () => state } }),
        requestDraftInitialization: (b, options) => {
          calls.push({ b, options });
          return 'applied';
        },
      },
    },
  };
  stageImportReference(ctx, 's', { root }, '历史引用');
  assert.deepEqual(calls, [{ b: binding, options: { prompt: '历史引用', clearPreviousDraft: false } }]);
  for (const occupied of [
    { draft: '作者草稿' },
    { phase: 'command' },
    { attachmentIds: ['file'] },
    { occurrences: [{}] },
  ]) {
    Object.assign(state, { draft: '', phase: 'plain', attachmentIds: [], occurrences: [] }, occupied);
    assert.throws(() => stageImportReference(ctx, 's', { root }, '新引用'), /已保留/);
  }
  assert.equal(calls.length, 1);
  assert.throws(() => stageImportReference(ctx, 's', { root: root + '/other' }, '新引用'), /不属于本书/);
});
