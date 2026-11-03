import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT,
  FILE_LIMIT,
  makeBookBundle,
  removeCredentials,
  splitText,
  writingPrompt,
} from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';

const sample = () => ({
  type: 'novel-writer-server-project',
  version: 1,
  exportedAt: 'first-export',
  project: { id: 'old-project-id', title: '原始书名' },
  state: {
    project: { title: '测试小说', setting: '雨夜\n不要改写', characters: '主角有一个秘密' },
    outline: [{ chapter: 1, title: '第一章', beats: ['伏笔'] }],
    chapters: [
      { chapter: 1, content: '第一行\n\n第二行。🌠', bridge: { original: '保留' } },
      { chapter: 2, content: '' },
    ],
    memory: { characters: [{ name: '主角', secret: '不能删除的剧情秘密' }] },
    chatWindows: [{ id: 'chat', messages: [{ role: 'user', content: '讨论不等于正文' }] }],
    chapterSnapshots: [{ id: 'snap', content: '旧稿' }],
    operationLogs: [{ id: 'log' }],
    agentEditHistory: [{ id: 'edit' }],
    creativeRules: { pov: '第三人称限知' },
    unknownFutureField: { nested: ['保留'] },
    apiKey: 'secret-key',
    apiConfigs: [{ apiKey: 'another-secret' }],
  },
  characters: [{ name: '主角', confirmed: true, secret: '真相' }],
  locations: [{ name: '旧城' }],
});

function mockFiles() {
  const files = new Map();
  let writes = 0,
    failOnWrite = 0,
    corrupt = false;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url, 'https://novel.example').searchParams.get('path');
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (init.method === 'PUT') {
      writes++;
      if (writes === failOnWrite) return new Response('failed', { status: 500 });
      files.set(
        path,
        corrupt
          ? 'unexpected text'
          : typeof init.body === 'string'
            ? init.body
            : new TextDecoder().decode(init.body),
      );
      return Response.json({ ok: true });
    }
    if (url === '/api/novels')
      return Response.json({
        books: [...files].filter(([path]) => path.endsWith('/book.json')).map(([, text]) => JSON.parse(text)),
      });
    if (url === '/api/workspace/exec') {
      assert.doesNotMatch(JSON.parse(init.body).command, /测试小说|old-project-id/);
      return Response.json({
        exitCode: 0,
        stdout: [...files.keys()].filter((p) => p.endsWith('/book.json')).join('\n'),
        outputTruncated: false,
      });
    }
    return files.has(path) ? new Response(files.get(path)) : new Response('missing', { status: 404 });
  };
  return {
    files,
    fetcher,
    get writes() {
      return writes;
    },
    failAt(n) {
      failOnWrite = n;
    },
    corruptWrites() {
      corrupt = true;
    },
  };
}

test('export preserves chapters, unknown fields, chat, snapshots and histories without model calls', async () => {
  const input = sample();
  const original = JSON.stringify(input);
  const { manifest, files } = await makeBookBundle(input);
  assert.equal(JSON.stringify(input), original);
  assert.equal(manifest.format, FORMAT);
  assert.deepEqual(manifest.stats, {
    chapters: 2,
    chats: 1,
    snapshots: 1,
    operationLogs: 1,
    agentHistory: 1,
  });
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const restored = JSON.parse(manifest.archive.map((path) => byPath.get(path)).join(''));
  assert.deepEqual(restored.state.chapters, input.state.chapters);
  assert.deepEqual(restored.state.chatWindows, input.state.chatWindows);
  assert.deepEqual(restored.state.chapterSnapshots, input.state.chapterSnapshots);
  assert.deepEqual(restored.state.agentEditHistory, input.state.agentEditHistory);
  assert.deepEqual(restored.state.unknownFutureField, input.state.unknownFutureField);
  assert.equal(byPath.get('chapters/00001.md'), input.state.chapters[0].content);
  assert.doesNotMatch(JSON.stringify(restored), /secret-key|another-secret/);
  assert.equal(restored.characters[0].secret, '真相');
});

test('same content is fingerprinted deterministically, ignoring export time and object key order', async () => {
  const a = sample(),
    b = sample();
  b.exportedAt = 'new-export';
  b.state.project = {
    characters: b.state.project.characters,
    setting: b.state.project.setting,
    title: b.state.project.title,
  };
  assert.equal((await makeBookBundle(a)).manifest.id, (await makeBookBundle(b)).manifest.id);
  b.state.chapters[0].content += '新句子';
  assert.notEqual((await makeBookBundle(a)).manifest.id, (await makeBookBundle(b)).manifest.id);
});

test('UTF-8 chunks rejoin exactly, including emoji and surrogate pairs', () => {
  const text = '甲🌠乙\n'.repeat(200);
  const parts = splitText(text, 17);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => new TextEncoder().encode(part).length <= 17));
  assert.deepEqual(splitText(''), ['']);
  assert.throws(() => splitText('x', 0));
});

test('large chapter and migration archive split below the upstream 1 MiB file limit', async () => {
  const data = sample();
  data.state.chapters[0].content = '汉🌠'.repeat(90000);
  const { manifest, files } = await makeBookBundle(data);
  assert.ok(files.every((file) => file.bytes <= FILE_LIMIT));
  assert.ok(manifest.archive.length > 1);
  const index = JSON.parse(files.find((file) => file.path === 'chapter-index.json').content);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  assert.equal(index[0].paths.map((path) => byPath.get(path)).join(''), data.state.chapters[0].content);
});

test('invalid projects and duplicate chapters fail before upload', async () => {
  await assert.rejects(makeBookBundle([]));
  await assert.rejects(makeBookBundle({ anything: true }));
  const data = sample();
  data.state.chapters.push({ chapter: 1, content: 'duplicate' });
  await assert.rejects(makeBookBundle(data), /重复/);
  data.state.chapters = 'not chapters';
  await assert.rejects(makeBookBundle(data), /章节格式/);
});

test('fragment-only book requires no setting forms and retains all original inspiration', async () => {
  const bundle = await makeBookBundle(null, { seed: '会听见求救声的修士' });
  assert.equal(bundle.manifest.stats.chapters, 0);
  assert.equal(bundle.files.find((file) => file.path === 'seed.md').content, '会听见求救声的修士');
  assert.deepEqual(JSON.parse(writingPrompt(bundle.manifest)), { book: bundle.manifest.root });
  assert.throws(() => writingPrompt({ format: FORMAT, id: '../../etc' }));
  await assert.rejects(makeBookBundle(null, { seed: '  ' }));
});

test('credentials are removed without deleting story secret fields or modifying input', () => {
  const input = {
    api_key: 'key',
    Authorization: 'bearer',
    nested: { refreshToken: 'token', secret: '剧情', password: 'pwd' },
  };
  assert.deepEqual(removeCredentials(input), { nested: { secret: '剧情' } });
  assert.equal(input.api_key, 'key');
});

test('book marker publishes LAST and duplicate import never overwrites authored changes', async () => {
  const bundle = await makeBookBundle(sample());
  const store = mockFiles(),
    client = makeWorkspaceClient(store.fetcher);
  const result = await client.import(bundle);
  assert.equal(result.alreadyImported, false);
  assert.equal([...store.files.keys()].at(-1), bundle.manifest.root + '/book.json');
  const chapterPath = bundle.manifest.root + '/chapters/00001.md';
  store.files.set(chapterPath, '作者在 DSH 中修改过');
  const writes = store.writes;
  assert.equal((await client.import(bundle)).alreadyImported, true);
  assert.equal(store.writes, writes);
  assert.equal(store.files.get(chapterPath), '作者在 DSH 中修改过');
  assert.equal((await client.list()).length, 1);
});

test('failed upload leaves no marker and explicit retry resumes verified files', async () => {
  const bundle = await makeBookBundle(sample());
  const store = mockFiles(),
    client = makeWorkspaceClient(store.fetcher);
  store.failAt(3);
  await assert.rejects(client.import(bundle), /写入工作区失败/);
  assert.equal(store.files.has(bundle.manifest.root + '/book.json'), false);
  assert.equal((await client.list()).length, 0);
  const firstWrites = store.writes;
  store.failAt(0);
  await client.import(bundle);
  assert.equal(store.writes - firstWrites, bundle.files.length - 2 + 1);
});

test('unexpected existing text, read failures and corrupt receipts are never treated as empty', async () => {
  const bundle = await makeBookBundle(sample());
  const store = mockFiles(),
    client = makeWorkspaceClient(store.fetcher);
  store.files.set(bundle.manifest.root + '/setting.md', 'manual change');
  await assert.rejects(client.import(bundle), /已有改动/);
  assert.equal(store.writes, 0);
  store.files.set(bundle.manifest.root + '/book.json', '{invalid');
  await assert.rejects(client.import(bundle), /收据损坏/);
  await assert.rejects(
    makeWorkspaceClient(async () => new Response('provider text', { status: 500 })).import(bundle),
    /读取工作区失败/,
  );
});

test('successful HTTP response with wrong persisted text does not publish a marker', async () => {
  const bundle = await makeBookBundle(sample());
  const store = mockFiles();
  store.corruptWrites();
  await assert.rejects(makeWorkspaceClient(store.fetcher).import(bundle), /校验不一致/);
  assert.equal(store.files.has(bundle.manifest.root + '/book.json'), false);
});

test('unsafe paths and tampered content fail before ANY writes', async () => {
  const bundle = await makeBookBundle(sample());
  const store = mockFiles(),
    client = makeWorkspaceClient(store.fetcher);
  bundle.files[0].path = '../outside';
  await assert.rejects(client.import(bundle), /路径不安全/);
  assert.equal(store.writes, 0);
  const second = await makeBookBundle(sample());
  second.files[0].content += 'tampered';
  await assert.rejects(client.import(second), /校验失败/);
  assert.equal(store.writes, 0);
});

test('aborted uploads do not publish a visible book', async () => {
  const bundle = await makeBookBundle(sample());
  const store = mockFiles(),
    client = makeWorkspaceClient(store.fetcher),
    controller = new AbortController();
  await assert.rejects(
    client.import(bundle, {
      signal: controller.signal,
      onProgress() {
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(store.files.has(bundle.manifest.root + '/book.json'), false);
});
