import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeDocumentService, documentPath } from '../worker/novel-documents.mjs';
import { nativeWorkspace, nativeBookTitle, bookIsGenerating } from '../worker/native-workspace.mjs';
import { novelGateway } from '../worker/novel-gateway.mjs';
import {
  nativeTask,
  changedLines,
  documentContextRevision,
} from '../pages/public/novel-assets/manuscript-core.mjs';
import { writingPrompt } from '../pages/public/novel-assets/bundle.mjs';
import { DOCUMENT_LIMIT, PART_LIMIT } from '../worker/document-storage.mjs';
import { makeBackup, restoreBackup } from '../pages/public/novel-assets/backup.mjs';
import { installProposalTools } from '../worker/proposal-tools.mjs';
import { imageAsset } from '../worker/shared/illustrations.mjs';
import {
  editorText,
  editorValue,
  editorRange,
  mixedEndings,
} from '../pages/public/novel-assets/editor-text.mjs';

const id = 'b-' + 'a'.repeat(32),
  root = '/workspace/novels/' + id;
function fixture(options = {}) {
  let rows = new Map(),
    clock = 1,
    failPath;
  const missing = () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  const fs = {
    db: null,
    statSync(path) {
      const value = rows.get(path);
      if (!value) missing();
      return {
        size: value.bytes?.length ?? 0,
        mtimeMs: value.at,
        nlink: value.link ? 2 : 1,
        isFile: () => value.type === 'file',
        isDirectory: () => value.type === 'dir',
        isSymbolicLink: () => value.type === 'symlink',
      };
    },
    lstatSync(path) {
      return this.statSync(path);
    },
    readFileSync(path) {
      const value = rows.get(path);
      if (!value) missing();
      return value.bytes;
    },
    writeFileSync(path, value) {
      if (path === failPath) throw new Error('storage full');
      rows.set(path, {
        type: 'file',
        bytes: typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value),
        at: clock++,
      });
    },
    unlinkSync(path) {
      if (path === failPath) throw new Error('storage full');
      if (!rows.delete(path)) missing();
    },
    mkdirSync(path) {
      let prefix = '';
      for (const part of path.split('/').filter(Boolean)) {
        prefix += '/' + part;
        if (!rows.has(prefix)) rows.set(prefix, { type: 'dir', at: clock++ });
      }
    },
    readdirSync(path) {
      if (!rows.has(path)) missing();
      return [...rows.keys()]
        .filter((name) => name.startsWith(path + '/') && !name.slice(path.length + 1).includes('/'))
        .map((name) => name.slice(path.length + 1));
    },
  };
  const db = {
    transactionSync(fn) {
      const before = structuredClone(rows);
      try {
        return fn();
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  };
  fs.db = db;
  fs.mkdirSync(root);
  fs.writeFileSync(
    root + '/book.json',
    JSON.stringify({ format: 'novel-harness-book-v1', id, root, title: 'fixture' }),
  );
  const service = makeDocumentService(fs, db, id, options);
  return {
    fs,
    service,
    run: (data) => service.run(data),
    setFailure: (path) => (failPath = path),
    setLink: (path) => {
      rows.get(path).link = true;
    },
    setSymlink: (path) => rows.set(path, { type: 'symlink' }),
  };
}
function create(f, path = 'chapters/1.md', text = '\ufeff雨夜。\r\n钟声。🌧️') {
  return f.run({ kind: 'save', path, text, expectedHash: null });
}
test('book illustrations upload idempotently; assistant placement uses CAS, history and original transaction', () => {
  const f = fixture();
  const content = JSON.stringify(
    imageAsset(
      JSON.stringify({
        format: 'novel-illustration-v1',
        width: 1,
        height: 1,
        label: '雨夜',
        data: 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
      }),
    ),
  );
  const image = f.run({ kind: 'illustrations', action: 'upload', content });
  assert.equal(f.run({ kind: 'illustrations', action: 'upload', content }).alreadyUploaded, true);
  assert.equal(f.run({ kind: 'illustrations' }).images[0].label, '雨夜');
  const before = create(f);
  const op = {
    kind: 'illustrations',
    action: 'place',
    path: before.path,
    imagePath: image.imagePath,
    expectedHash: before.hash,
    after: '雨夜。',
    caption: '雨夜',
  };
  const placed = f.run(op);
  assert.equal(placed.saved, true);
  const saved = f.run({ kind: 'read', path: before.path });
  assert(saved.text.includes(image.imagePath));
  assert.equal(f.run({ kind: 'history', path: before.path, hash: before.hash }).text, before.text);
  assert.throws(() => f.run(op), /正文已更新/);
  assert.throws(
    () => f.run({ ...op, expectedHash: saved.hash, imagePath: 'illustrations/' + 'f'.repeat(64) + '.json' }),
    /不存在/,
  );
  assert.equal(f.run({ kind: 'read', path: before.path }).text, saved.text);
  f.setFailure(root + '/' + before.path);
  assert.throws(() => f.run({ ...op, expectedHash: saved.hash, action: 'remove' }), /storage full/);
  assert.equal(f.run({ kind: 'read', path: before.path }).text, saved.text);
  f.setFailure(null);
  f.run({ ...op, expectedHash: saved.hash, action: 'remove' });
  assert(!f.run({ kind: 'read', path: before.path }).text.includes('!['));
  assert.throws(
    () => f.run({ kind: 'illustrations', action: 'read', imagePath: '../' + image.imagePath }),
    /路径无效/,
  );
});

function manual(f, action, extra = {}) {
  const preview = f.run({ kind: 'content', action: 'inspect', targetAction: action, ...extra });
  return f.run({ kind: 'content', action, ...extra, expected: preview.expected });
}
test('manual clearing retains chapter heading, original bytes and a recoverable receipt', () => {
  const f = fixture();
  const before = create(f, 'chapters/1.md', '\uFEFF# 第一章\r\n\r\n雨夜。🌧️\r\n');
  const result = manual(f, 'clearChapter', { path: before.path });
  assert.equal(f.run({ kind: 'read', path: before.path }).text, '\uFEFF# 第一章\r\n\r\n');
  const records = f.run({ kind: 'content' });
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0].id, result.recoveryId);
  assert.equal(records.items[0].status, 'available');
  assert(!f.run({ kind: 'list' }).documents.some((d) => d.path.includes('novel-trash')));
  f.run({ kind: 'content', action: 'restore', id: result.recoveryId });
  assert.equal(f.run({ kind: 'read', path: before.path }).text, before.text);
  assert.equal(f.run({ kind: 'read', path: before.path }).hash, before.hash);
});
test('manual delete unlinks imported outline associations, removes all multipart backing files and restores exactly', () => {
  const f = fixture();
  const text = '\uFEFF# 长章\r\n\r\n' + '场景🌧️\n'.repeat(70000);
  const before = create(f, 'chapters/1.md', text);
  f.fs.writeFileSync(root + '/chapter-index.json', JSON.stringify([{ chapter: 1, paths: before.parts }]));
  const outline = create(
    f,
    'outline.json',
    '\uFEFF' +
      JSON.stringify({
        title: '全书',
        chapters: [
          { chapter: 1, title: '长章' },
          { chapter: 2, title: '次章' },
        ],
      }) +
      '\n',
  );
  const result = manual(f, 'deleteChapter', { path: before.path });
  assert.equal(result.deleted, before.path);
  assert.throws(() => f.run({ kind: 'read', path: before.path }), /不存在/);
  assert(!f.fs.readdirSync(root + '/chapters').some((n) => n.startsWith('1.md')));
  const rows = JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text.replace(/^\uFEFF/, '')).chapters;
  assert.equal(rows[0].chapterPath, null);
  assert.equal(rows[1].chapter, 2);
  assert.equal(f.run({ kind: 'list' }).documents.filter((d) => d.category === 'chapter').length, 0);
  const restored = f.run({ kind: 'content', action: 'restore', id: result.recoveryId });
  assert.equal(restored.warning, undefined);
  assert.equal(f.run({ kind: 'read', path: before.path }).text, text);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, outline.text);
  assert.deepEqual(f.run({ kind: 'content', action: 'restore', id: result.recoveryId }).paths, []);
});
test('manual outline clearing and individual removal never remove prose; all operations are recoverable', () => {
  const f = fixture();
  const prose = create(f);
  const original = create(
    f,
    'outline.json',
    JSON.stringify({
      version: 7,
      chapters: [
        { chapter: 1, title: '一' },
        { chapter: 2, title: '二' },
      ],
    }),
  );
  const direction = create(f, 'notes/story-plan.md', '原全篇方向\r\n');
  const removed = manual(f, 'removeOutline', { index: 0 });
  assert.equal(JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text).chapters[0].chapter, 2);
  f.run({ kind: 'content', action: 'restore', id: removed.recoveryId });
  const cleared = manual(f, 'clearOutline');
  assert.deepEqual(JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text), {
    version: 7,
    chapters: [],
  });
  assert.equal(f.run({ kind: 'read', path: direction.path }).text, direction.text);
  assert.equal(f.run({ kind: 'read', path: prose.path }).text, prose.text);
  f.run({ kind: 'content', action: 'restore', id: cleared.recoveryId });
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, original.text);
  const both = manual(f, 'clearPlanning');
  assert.equal(f.run({ kind: 'read', path: direction.path }).text, '');
  f.run({ kind: 'content', action: 'restore', id: both.recoveryId });
  assert.equal(f.run({ kind: 'read', path: direction.path }).text, direction.text);
  assert.equal(f.run({ kind: 'read', path: prose.path }).text, prose.text);
  const only = manual(f, 'clearDirection');
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, original.text);
  f.run({ kind: 'content', action: 'restore', id: only.recoveryId });
});
test('manual CAS and recovery refuse newer edits, while restoring a deleted chapter does not roll back changed planning', () => {
  const f = fixture();
  const before = create(f, 'chapters/1.md', '# 一\n\n正文');
  const outline = create(f, 'outline.json', JSON.stringify([{ chapter: 1, chapterPath: before.path }]));
  const preview = f.run({
    kind: 'content',
    action: 'inspect',
    targetAction: 'deleteChapter',
    path: before.path,
  });
  f.run({ kind: 'save', path: before.path, expectedHash: before.hash, text: before.text + '新修改' });
  assert.throws(
    () => f.run({ kind: 'content', action: 'deleteChapter', path: before.path, expected: preview.expected }),
    /内容已更新/,
  );
  const deleted = manual(f, 'deleteChapter', { path: before.path });
  let current = f.run({ kind: 'read', path: 'outline.json' });
  const changed = f.run({
    kind: 'save',
    path: current.path,
    expectedHash: current.hash,
    text: '[{"chapter":5,"title":"新规划"}]',
  });
  assert.match(
    f.run({ kind: 'content', action: 'restore', id: deleted.recoveryId }).warning,
    /大纲之后有更新/,
  );
  assert.equal(f.run({ kind: 'read', path: outline.path }).text, changed.text);
  const cleared = manual(f, 'clearChapter', { path: before.path });
  current = f.run({ kind: 'read', path: before.path });
  f.run({ kind: 'save', path: before.path, expectedHash: current.hash, text: '# 一\n新的正文' });
  assert.throws(
    () => f.run({ kind: 'content', action: 'restore', id: cleared.recoveryId }),
    /目标已有新内容/,
  );
  const removed = manual(f, 'deleteChapter', { path: before.path });
  create(f, before.path, '# 同路径新文件\n不能覆盖');
  assert.throws(
    () => f.run({ kind: 'content', action: 'restore', id: removed.recoveryId }),
    /目标已有新内容/,
  );
});
test('manual deletion and clearing roll back all writes on VFS failures, reject links and respect active AI', () => {
  let generating = false;
  const f = fixture({ isGenerating: () => generating });
  const before = create(f, 'chapters/1.md', '# 一\n正文');
  const original = create(f, 'outline.json', '[{"chapter":1,"chapterPath":"chapters/1.md"}]');
  f.setFailure(root + '/outline.json');
  assert.throws(() => manual(f, 'deleteChapter', { path: before.path }), /storage full/);
  assert.equal(f.run({ kind: 'read', path: before.path }).text, before.text);
  assert.equal(f.run({ kind: 'read', path: original.path }).text, original.text);
  assert.equal(f.run({ kind: 'content' }).items.length, 0);
  f.setFailure(root + '/chapters/1.md');
  assert.throws(() => manual(f, 'deleteChapter', { path: before.path }), /storage full/);
  assert.equal(f.run({ kind: 'read', path: before.path }).text, before.text);
  f.setFailure(null);
  generating = true;
  assert.throws(() => manual(f, 'deleteChapter', { path: before.path }), /AI 正在生成/);
  generating = false;
  f.setLink(root + '/chapters/1.md');
  assert.throws(() => manual(f, 'deleteChapter', { path: before.path }), /链接/);
  assert.throws(() => manual(f, 'deleteChapter', { path: '../outside.md' }), /只能管理/);
});
test('explicit malformed outline clearing retains the original bytes for exact recovery, with metadata-only pagination', () => {
  const f = fixture();
  f.fs.writeFileSync(root + '/outline.json', '\uFEFF{broken\r\n');
  const cleared = manual(f, 'clearOutline');
  assert.deepEqual(JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text.replace(/^\uFEFF/, '')), []);
  f.run({ kind: 'content', action: 'restore', id: cleared.recoveryId });
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, '\uFEFF{broken\r\n');
  const c = create(f);
  for (let i = 0; i < 54; i++) {
    const result = manual(f, 'clearChapter', { path: c.path });
    f.run({ kind: 'content', action: 'restore', id: result.recoveryId });
  }
  const page = f.run({ kind: 'content' });
  assert.equal(page.items.length, 50);
  assert.equal(page.hasMore, true);
  assert(!JSON.stringify(page).includes('broken'));
  const older = f.run({ kind: 'content', after: page.nextCursor });
  assert.equal(older.items.length, 5);
  assert.equal(older.hasMore, false);
  assert.equal(new Set([...page.items, ...older.items].map((x) => x.id)).size, 55);
  assert.throws(() => f.run({ kind: 'content', action: 'restore', id: '../another-book' }), /标识无效/);
});

test('failure to persist the recovery receipt rolls back deleted chapter, all parts and outline links', () => {
  const key = '0000000000001-11111111-1111-4111-8111-111111111111';
  const f = fixture({ now: () => 1, uuid: () => '11111111-1111-4111-8111-111111111111' });
  const before = create(f, 'chapters/1.md', '# 一\n\n' + '场景。'.repeat(80000));
  const outline = create(f, 'outline.json', '[{"chapter":1,"chapterPath":"chapters/1.md"}]');
  f.setFailure(root + '/.novel-trash/' + key + '.json');
  assert.throws(() => manual(f, 'deleteChapter', { path: before.path }), /storage full/);
  assert.equal(f.run({ kind: 'read', path: before.path }).text, before.text);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, outline.text);
  assert.deepEqual(f.run({ kind: 'read', path: before.path }).parts, before.parts);
  assert.equal(f.run({ kind: 'content' }).items.length, 0);
  f.setFailure(null);
  const result = manual(f, 'deleteChapter', { path: before.path });
  let generating = true;
  const guarded = makeDocumentService(f.fs, f.fs.db, id, { isGenerating: () => generating });
  assert.throws(
    () => guarded.run({ kind: 'content', action: 'restore', id: result.recoveryId }),
    /AI 正在生成/,
  );
  generating = false;
  guarded.run({ kind: 'content', action: 'restore', id: result.recoveryId });
  assert.equal(f.run({ kind: 'read', path: before.path }).text, before.text);
});

test('a damaged recovery receipt remains visible but cannot block the list or overwrite a chapter', () => {
  const f = fixture();
  const before = create(f);
  const result = manual(f, 'clearChapter', { path: before.path });
  const path = root + '/.novel-trash/' + result.recoveryId + '.json';
  const receipt = JSON.parse(new TextDecoder().decode(f.fs.readFileSync(path)));
  f.fs.writeFileSync(path, JSON.stringify({ ...receipt, changes: [null] }));
  const list = f.run({ kind: 'content' });
  assert.equal(list.items[0].status, 'unavailable');
  assert.match(list.items[0].warning, /不兼容/);
  assert.throws(() => f.run({ kind: 'content', action: 'restore', id: result.recoveryId }), /不兼容/);
  assert.equal(f.run({ kind: 'read', path: before.path }).text, '');
});

test('directory reads validate each ancestor once per transaction, but never reuse validation after a new native write', () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) create(f, 'chapters/ancestor-' + i + '.md', '# 标题\n正文。');
  const original = f.fs.lstatSync.bind(f.fs),
    counts = new Map();
  f.fs.lstatSync = (path) => {
    counts.set(path, (counts.get(path) ?? 0) + 1);
    return original(path);
  };
  assert.equal(f.run({ kind: 'list' }).documents.filter((d) => d.category === 'chapter').length, 40);
  assert.equal(counts.get('/workspace'), 1);
  assert.equal(counts.get('/workspace/novels'), 1);
  f.setSymlink(root + '/chapters');
  assert.throws(() => f.run({ kind: 'read', path: 'chapters/ancestor-0.md' }), /链接/);
});

test('history keyset pages retain all original snapshots when newer saves arrive, including tied timestamps', () => {
  for (const tied of [false, true]) {
    const f = fixture(),
      path = 'chapters/paged-history.md';
    let current = create(f, path, '版本 0');
    for (let i = 1; i <= 123; i++)
      current = f.run({ kind: 'save', path, text: '版本 ' + i, expectedHash: current.hash });
    if (tied) {
      const stat = f.fs.statSync.bind(f.fs);
      f.fs.statSync = (p) => {
        const value = stat(p);
        return p.includes('/.novel-history/') ? { ...value, mtimeMs: 42 } : value;
      };
    }
    const first = f.run({ kind: 'history', path });
    assert.equal(first.versions.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, 'string');
    const original = new Set();
    let page = first;
    do {
      page.versions.forEach((v) => original.add(v.hash));
      page = page.nextCursor ? f.run({ kind: 'history', path, after: page.nextCursor }) : null;
    } while (page);
    assert.equal(original.size, 123);
    current = f.run({ kind: 'save', path, text: '分页期间的新版本', expectedHash: current.hash });
    const seen = [...first.versions];
    page = first;
    while (page.nextCursor) {
      page = f.run({ kind: 'history', path, after: page.nextCursor });
      seen.push(...page.versions);
    }
    assert.equal(new Set(seen.map((v) => v.hash)).size, seen.length);
    assert.equal(seen.filter((v) => original.has(v.hash)).length, 123);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    const oldest = seen.find((v) => v.hash === createHash('sha256').update('版本 0').digest('hex'));
    assert.equal(f.run({ kind: 'history', path, hash: oldest.hash }).text, '版本 0');
    assert.equal(f.run({ kind: 'read', path }).hash, current.hash);
  }
});

test('history cursor validation is read-only and rejects malformed, cross-file and stale anchors', () => {
  const f = fixture(),
    path = 'chapters/cursor.md';
  let current = create(f, path, '零');
  for (let i = 1; i <= 55; i++)
    current = f.run({ kind: 'save', path, text: String(i), expectedHash: current.hash });
  const first = f.run({ kind: 'history', path });
  const bad = (after, target = path) =>
    assert.throws(
      () => f.run({ kind: 'history', path: target, after }),
      (e) => e.status === 400 || e.status === 409,
    );
  for (const value of ['', '{', 'null', '[]', 'x'.repeat(513), 3]) bad(value);
  bad(first.nextCursor, 'chapters/other.md');
  const cursor = JSON.parse(first.nextCursor);
  bad(JSON.stringify({ ...cursor, at: cursor.at + 1 }));
  bad(JSON.stringify({ ...cursor, v: 2 }));
  bad(JSON.stringify({ ...cursor, extra: true }));
  assert.throws(
    () => f.run({ kind: 'history', path, hash: first.versions[0].hash, after: first.nextCursor }),
    (e) => e.status === 400,
  );
  assert.equal(f.run({ kind: 'read', path }).hash, current.hash);
  assert.equal(f.run({ kind: 'history', path }).versions.length, 50);
});

const RUN_KEY = 'test-only-author-scope-key-not-for-production-0123456789abcdef';

test('explicit native planning changes clear/delete with both-version CAS, original history, metadata and prose preservation, and rollback', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f);
  const plan = create(
    f,
    'outline.json',
    '\ufeff' +
      JSON.stringify({
        custom: '保留元数据',
        chapters: [
          { chapter: 1, title: '旧纲' },
          { chapter: 2, title: '另一章' },
        ],
      }) +
      '\n',
  );
  const direction = create(f, 'notes/story-plan.md', '原方向');
  const version = () => f.run({ kind: 'agentOutline', action: 'inspect' });
  const apply = (args, v = version()) =>
    f.run({
      kind: 'agentOutline',
      action: 'apply',
      reason: '作者明确要求',
      expected_outline_hash: v.outlineHash,
      expected_direction_hash: v.directionHash,
      ...args,
    });
  const old = version();
  apply({ remove_chapters: [2] });
  assert.equal(f.run({ kind: 'read', path: 'notes/story-plan.md' }).text, direction.text);
  assert.throws(() => apply({ clear: true }, old), { status: 409 });
  const current = version();
  f.setFailure(root + '/notes/story-plan.md');
  assert.throws(() => apply({ clear: true }), /storage full/);
  assert.deepEqual(version(), current, 'Both files and their histories roll back together.');
  f.setFailure(null);
  const result = apply({ clear: true });
  assert.equal(result.applied, true);
  assert.equal(result.chaptersRemaining, 0);
  const next = f.run({ kind: 'read', path: 'outline.json' }).text;
  assert.ok(next.startsWith('\ufeff') && next.endsWith('\n'));
  assert.deepEqual(JSON.parse(next.slice(1)), { custom: '保留元数据', chapters: [] });
  assert.equal(f.run({ kind: 'history', path: 'outline.json', hash: plan.hash }).text, plan.text);
  assert.equal(
    f.run({ kind: 'history', path: 'notes/story-plan.md', hash: direction.hash }).text,
    direction.text,
  );
  assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
  apply({ story_plan: '新的全篇方向' });
  assert.equal(f.run({ kind: 'read', path: 'notes/story-plan.md' }).text, '新的全篇方向');
  assert.throws(() => apply({ remove_chapters: [99] }), { status: 409 });
  const ordinary = makeDocumentService(f.fs, f.fs.db, id);
  assert.throws(() => ordinary.run({ kind: 'agentOutline', action: 'inspect' }), { status: 403 });
});

test('explicit without-outline writing preserves unrelated prose and directly saves requested continuation with history', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const old = create(f);
  const request = { mode: 'new-chapter', instruction: '不要大纲，直接写完整正文。', without_outline: true };
  const task = f.run({ kind: 'agentPrepare', request, requestKey: 'explicit-free-prose' });
  assert.equal(task.prerequisite, null);
  assert.ok(task.target.startsWith('chapters/free-'));
  assert.equal(task.task.withoutOutline, true);
  assert.equal(task.executionPrompt, undefined);
  const result = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: task.expectedHash,
    content: '# 自由正文\n\n她不再打开那封信。',
    complete: true,
  });
  assert.equal(result.published, true);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, '[]');
  assert.equal(f.run({ kind: 'read', path: old.path }).text, old.text);
  assert.equal(
    f.run({ kind: 'agentPrepare', request, requestKey: 'explicit-free-prose' }).proposalId,
    task.proposalId,
  );
  const edit = f.run({
    kind: 'agentPrepare',
    request: { mode: 'continue', path: old.path, instruction: '继续自由正文', without_outline: true },
    requestKey: 'free-old-body',
  });
  assert.equal(
    f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: edit.proposalId,
      expectedHash: edit.expectedHash,
      content: '新的段落。',
      contentScope: 'append',
      complete: true,
    }).published,
    true,
  );
  assert.equal(f.run({ kind: 'read', path: old.path }).text, old.text + '新的段落。');
  assert.ok(f.run({ kind: 'history', path: old.path }).versions.some((v) => v.hash === old.hash));
});

test('plain native writing prepares outline first, shares original templates and directly commits validated final writing including old prose', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' }, bookTitle: '当前书名' });
  create(f, 'seed.md', '钟楼里每天都会多出一封明天的信。');
  const request = {
    mode: 'new-chapter',
    chapter: 1,
    instruction: '先大纲，再写第一章，铜钥匙必须付出代价。',
  };
  const prepared = f.run({ kind: 'agentPrepare', request, requestKey: 'native-call-outline' });
  assert.equal(prepared.target, 'outline.json');
  assert.equal(prepared.prerequisite, 'outline');
  assert.equal(prepared.task.template.key, 'outline');
  assert.equal(prepared.authorRequest, request.instruction);
  assert.deepEqual(prepared.continuation.arguments.instruction, request.instruction);
  assert.equal(f.run({ kind: 'list' }).documents.filter((d) => d.category === 'chapter').length, 0);
  assert.equal(
    f.run({ kind: 'agentPrepare', request, requestKey: 'native-call-outline' }).proposalId,
    prepared.proposalId,
  );
  assert.throws(
    () =>
      f.run({
        kind: 'agentPrepare',
        request: { ...request, instruction: '参数变化' },
        requestKey: 'native-call-outline',
      }),
    /参数已变化/,
  );
  const partial = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: prepared.proposalId,
    expectedHash: prepared.expectedHash,
    content: '{unfinished',
    complete: true,
  });
  assert.equal(partial.published, false);
  assert.ok(partial.publicationIssue);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, '[]');
  const outline = {
    storyPlan: '为了确认姐姐的死因，他必须用一次未来交换真相。',
    chapters: [
      {
        chapter: 1,
        title: '第三声钟',
        summary: '沈澄持铜钥匙进入钟楼，取信时失去明日的记忆。',
        plotPoints: ['开启登记匣', '付出记忆代价'],
      },
    ],
  };
  const submitted = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: prepared.proposalId,
    expectedHash: partial.expectedHash,
    content: JSON.stringify(outline),
    complete: true,
  });
  assert.equal(submitted.published, true);
  const chapter = f.run({ kind: 'agentPrepare', request, requestKey: 'native-call-chapter' });
  assert.equal(chapter.prerequisite, null);
  assert.ok(chapter.target.startsWith('chapters/'));
  assert.match(chapter.task.template.body, /铜钥匙/);
  assert.equal(chapter.task.kind, 'prose');
  const draft = '# 第三声钟\n\n沈澄把铜钥匙抵进锁孔，钟楼里响起姐姐的声音。';
  const staged = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: chapter.proposalId,
    expectedHash: chapter.expectedHash,
    content: draft,
  });
  assert.equal(staged.published, false, 'Partial saves must never publish.');
  const final = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: chapter.proposalId,
    expectedHash: staged.expectedHash,
    content: draft,
    complete: true,
  });
  assert.equal(final.published, true);
  assert.equal(f.run({ kind: 'read', path: chapter.target }).text, draft);
  assert.equal(f.run({ kind: 'review', id: chapter.proposalId }).proposal.status, 'accepted');
  const rewrite = f.run({
    kind: 'agentPrepare',
    request: { mode: 'rewrite', path: chapter.target, instruction: '把开头写得更克制。' },
    requestKey: 'native-call-rewrite',
  });
  const edit = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: rewrite.proposalId,
    expectedHash: rewrite.expectedHash,
    content: '新版本的正文。',
    complete: true,
  });
  assert.equal(edit.published, true);
  assert.equal(f.run({ kind: 'read', path: chapter.target }).text, '新版本的正文。');
  const history = f.run({ kind: 'history', path: chapter.target });
  assert.ok(
    history.versions.some((v) => v.hash === final.expectedHash),
    'The old prose remains restorable.',
  );
});

test('all prose intents use the same tools/parameter contract and default whole-chapter commit', () => {
  for (const mode of [undefined, 'write', 'begin', 'continue', 'rewrite', 'new-chapter']) {
    const f = fixture({ proposalActor: { sessionId: 'native-author' } });
    const body = create(f, 'chapters/mixed.md', '# 雨夜\r\n\r\n旧开头。🌧️\r\n保留段落。');
    const task = f.run({
      kind: 'agentPrepare',
      request: {
        ...(mode ? { mode } : {}),
        chapter: 1,
        path: root + '/' + body.path,
        instruction: '改开头，同时接着写后文。',
        template_key: 'deai',
        without_outline: false,
      },
      requestKey: 'mixed-' + mode,
    });
    assert.equal(task.target, body.path);
    assert.equal(task.contentScope, 'document');
    assert.equal(task.writing.flexible, true);
    assert.equal(task.prerequisite, null, 'Editing prose is not blocked on creating another outline.');
    assert.equal(task.executionPrompt, undefined);
    assert.equal(task.task.kind, 'prose');
    const content = '# 雨夜\r\n\r\n新的开头。🌧️\r\n保留段落。\r\n她终于推开门。';
    const saved = f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: task.proposalId,
      expectedHash: task.expectedHash,
      content,
      complete: true,
    });
    assert.equal(saved.published, true);
    assert.equal(f.run({ kind: 'read', path: body.path }).text, content, 'No implicit concatenation.');
    assert.equal(f.run({ kind: 'history', path: body.path, hash: body.hash }).text, body.text);
  }
});

test('a single writing task can widen a selection or switch explicit append into a mixed whole-chapter update', () => {
  for (const scope of ['selection', 'append']) {
    const f = fixture({ proposalActor: { sessionId: 'native-author' } });
    const body = create(f, 'chapters/mixed.md', '# 雨夜\n\n旧开头。保留段落。');
    const task = f.run({
      kind: 'agentPrepare',
      request: {
        mode: 'begin',
        chapter: 1,
        path: body.path,
        selection: { start: 7, end: 10 },
        instruction: '先改选段，再接着写。',
      },
      requestKey: scope,
    });
    const partial = f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: task.proposalId,
      expectedHash: task.expectedHash,
      content: '未完成的段落。',
      contentScope: scope,
      complete: false,
    });
    assert.equal(partial.contentScope, scope);
    assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
    const content = '# 雨夜\n\n新开头。保留段落。新的结尾。';
    const saved = f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: task.proposalId,
      expectedHash: partial.expectedHash,
      content,
      contentScope: 'document',
      complete: true,
    });
    assert.equal(saved.published, true);
    assert.equal(saved.contentScope, 'document');
    assert.equal(f.run({ kind: 'read', path: body.path }).text, content);
    assert.equal(f.run({ kind: 'history', path: body.path, hash: body.hash }).text, body.text);
  }
});

test('inspect reports editor character count and fresh CAS after native draft writes without changing manuscripts', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f);
  const task = f.run({
    kind: 'agentPrepare',
    request: { instruction: '改开头并续写', path: body.path },
    requestKey: 'draft-count',
  });
  const initial = f.run({ kind: 'agentProposal', action: 'inspect', id: task.proposalId });
  const initialDraft = f.run({ kind: 'read', path: task.draft });
  assert.equal(initial.characters, initialDraft.text.replace(/\s/g, '').length);
  assert.equal(initial.bytes, new TextEncoder().encode(initialDraft.text).length);
  const content = '\ufeff# 雨夜\r\n\r\n她取出钥匙。 🌧️\t窗外传来钟声。\n新的结尾。';
  f.fs.writeFileSync(root + '/' + task.draft, content);
  const draftTime = f.fs.statSync(root + '/' + task.draft).mtimeMs;
  const bodyTime = f.fs.statSync(root + '/' + body.path).mtimeMs;
  const current = f.run({ kind: 'agentProposal', action: 'inspect', id: task.proposalId });
  assert.equal(current.characters, content.replace(/\s/g, '').length);
  assert.equal(current.bytes, new TextEncoder().encode(content).length);
  assert.notEqual(current.bytes, current.characters);
  assert.notEqual(current.expectedHash, initial.expectedHash);
  assert.equal(current.expectedHash, f.run({ kind: 'read', path: task.draft }).hash);
  assert.equal(f.fs.statSync(root + '/' + task.draft).mtimeMs, draftTime);
  assert.equal(f.fs.statSync(root + '/' + body.path).mtimeMs, bodyTime);
  assert.equal(f.run({ kind: 'read', path: body.path }).hash, body.hash);
  assert.throws(
    () =>
      f.run({
        kind: 'agentProposal',
        action: 'submit',
        id: task.proposalId,
        expectedHash: initial.expectedHash,
        content: '不得覆盖新草稿。',
        complete: true,
      }),
    /更新|冲突/,
  );
  assert.equal(f.run({ kind: 'read', path: task.draft }).text, content);
  assert.equal(f.run({ kind: 'read', path: body.path }).hash, body.hash);
  const saved = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: current.expectedHash,
    content,
    contentScope: 'document',
    complete: true,
  });
  assert.equal(saved.published, true);
  assert.equal(saved.characters, current.characters);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, content);
  assert.equal(f.run({ kind: 'history', path: body.path, hash: body.hash }).text, body.text);
});

test('explicit append refuses a whole-chapter duplicate and repairs the same task with precise guidance', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f);
  const task = f.run({
    kind: 'agentPrepare',
    request: { instruction: '改开头并续写', path: body.path },
    requestKey: 'duplicate',
  });
  const content = body.text + '\n后文。';
  assert.throws(
    () =>
      f.run({
        kind: 'agentProposal',
        action: 'submit',
        id: task.proposalId,
        expectedHash: task.expectedHash,
        content,
        contentScope: 'append',
        complete: true,
      }),
    /content_scope=document/,
  );
  assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
  const inspected = f.run({ kind: 'agentProposal', action: 'inspect', id: task.proposalId });
  assert.equal(inspected.expectedHash, task.expectedHash);
  assert.equal(inspected.contentScope, 'document');
  assert.equal(
    f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: task.proposalId,
      expectedHash: task.expectedHash,
      content,
      contentScope: 'document',
      complete: true,
    }).published,
    true,
  );
  assert.equal(f.run({ kind: 'read', path: body.path }).text, content);
});

test('historical append proposals keep their original scope, while an explicit document submission can widen a pending task', () => {
  for (const wholeDocument of [false, true]) {
    const f = fixture({ proposalActor: { sessionId: 'native-author' } });
    const body = create(f);
    const task = f.run({
      kind: 'propose',
      path: body.path,
      expectedHash: body.hash,
      originSessionId: 'native-author',
      edit: { start: body.text.length, end: body.text.length },
      writing: { version: 1, mode: 'continue', instruction: '历史续写任务' },
    });
    const inspected = f.run({ kind: 'agentProposal', action: 'inspect', id: task.id });
    assert.equal(inspected.contentScope, 'append');
    const content = wholeDocument ? '改写后的整章与续文。' : '新的段落。';
    const saved = f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: task.id,
      expectedHash: inspected.expectedHash,
      content,
      complete: true,
      ...(wholeDocument ? { contentScope: 'document' } : {}),
    });
    assert.equal(saved.published, true);
    assert.equal(
      f.run({ kind: 'read', path: body.path }).text,
      wholeDocument ? content : body.text + content,
    );
    assert.equal(f.run({ kind: 'history', path: body.path, hash: body.hash }).text, body.text);
  }
});

test('unified writing keeps cross-book scope, actionable parameter checks and stale-base CAS protection', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f);
  assert.throws(
    () =>
      f.run({
        kind: 'agentPrepare',
        request: { instruction: '改写', path: '/workspace/novels/b-' + 'b'.repeat(32) + '/' + body.path },
        requestKey: 'foreign',
      }),
    /本书章节/,
  );
  assert.throws(
    () =>
      f.run({
        kind: 'agentPrepare',
        request: { instruction: '改写', path: body.path, nonsense: true },
        requestKey: 'unexpected',
      }),
    /nonsense/,
  );
  const task = f.run({
    kind: 'agentPrepare',
    request: { instruction: '改写和续写', path: body.path },
    requestKey: 'cas',
  });
  const newer = f.run({ kind: 'save', path: body.path, text: '作者新稿。', expectedHash: body.hash });
  const result = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: task.expectedHash,
    content: 'AI 的混合修改。',
    contentScope: 'document',
    complete: true,
  });
  assert.equal(result.published, false);
  assert.match(result.publicationIssue, /更新/);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, newer.text);
  assert.equal(f.run({ kind: 'read', path: task.draft }).text, 'AI 的混合修改。');
});

test('an explicit insertion inside a chapter is a selected range, never mislabeled as an end append', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f, 'chapters/insertion.md', '# 雨夜\n\n原有正文。');
  const task = f.run({
    kind: 'agentPrepare',
    request: { path: body.path, instruction: '在正文前加一句', selection: { start: 6, end: 6 } },
    requestKey: 'insert',
  });
  assert.equal(task.contentScope, 'selection');
  const saved = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: task.expectedHash,
    content: '插入句。',
    contentScope: 'selection',
    complete: true,
  });
  assert.equal(saved.published, true);
  assert.equal(
    f.run({ kind: 'read', path: body.path }).text,
    body.text.slice(0, 6) + '插入句。' + body.text.slice(6),
  );
});

test('direct selection/append commits preserve untouched prose, CAS and restorable versions', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f, 'chapters/direct.md', '# 雨夜\n\n她取出钥匙。窗外响起钟声。');
  const start = body.text.indexOf('她'),
    end = body.text.indexOf('窗');
  const task = f.run({
    kind: 'agentPrepare',
    request: {
      mode: 'rewrite',
      path: body.path,
      selection: { start, end },
      instruction: '只改她取钥匙的动作。',
    },
    requestKey: 'direct-selection',
  });
  assert.equal(task.publication, undefined); // Public tool receipt is not a client-supplied policy switch.
  const submitted = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: task.expectedHash,
    content: '她从门缝接过钥匙。',
    complete: true,
  });
  assert.equal(submitted.published, true);
  const after = f.run({ kind: 'read', path: body.path });
  assert.equal(after.text, body.text.slice(0, start) + '她从门缝接过钥匙。' + body.text.slice(end));
  const append = f.run({
    kind: 'agentPrepare',
    request: {
      mode: 'continue',
      path: body.path,
      without_outline: true,
      instruction: '继续写下一步。',
    },
    requestKey: 'direct-append',
  });
  const result = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: append.proposalId,
    expectedHash: append.expectedHash,
    content: '\n她推开门。',
    contentScope: 'append',
    complete: true,
  });
  assert.equal(result.published, true);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, after.text + '\n她推开门。');
  assert.ok(f.run({ kind: 'history', path: body.path }).versions.some((v) => v.hash === body.hash));
});

test('direct old-prose edits preserve concurrent author changes and the generated draft without a silent overwrite', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } }),
    body = create(f);
  const task = f.run({
    kind: 'agentPrepare',
    request: {
      mode: 'rewrite',
      path: body.path,
      instruction: '修改当前章节。',
    },
    requestKey: 'direct-old-conflict',
  });
  f.run({ kind: 'save', path: body.path, expectedHash: body.hash, text: '另一设备的新版本。' });
  const result = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: task.expectedHash,
    content: '本次 AI 修改。',
    complete: true,
  });
  assert.equal(result.published, false);
  assert.ok(result.publicationIssue);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, '另一设备的新版本。');
  assert.equal(f.run({ kind: 'review', id: task.proposalId }).draft.text, '本次 AI 修改。');
});

test('unmanaged old drafts remain visible and adopt without model calls, byte changes, deletion or overwriting a revised chapter', () => {
  const f = fixture();
  const text = '\ufeff# 旧稿\r\n\r\n未收录的正文。🌧️';
  const source = create(f, 'drafts/boss-01.md', text);
  assert.equal(f.run({ kind: 'list' }).documents.find((d) => d.path === source.path).managed, false);
  const adopted = f.run({ kind: 'adoptDraft', path: source.path, expectedHash: source.hash });
  assert.equal(adopted.sourcePreserved, true);
  assert.equal(adopted.document.text, text);
  assert.equal(f.run({ kind: 'read', path: source.path }).text, text);
  assert.equal(f.run({ kind: 'adoptDraft', path: source.path, expectedHash: source.hash }).reused, true);
  f.run({ kind: 'save', path: adopted.document.path, text: '作者修改', expectedHash: adopted.document.hash });
  assert.throws(() => f.run({ kind: 'adoptDraft', path: source.path, expectedHash: source.hash }), /不覆盖/);
});

test('final new-only publication preserves both candidate and concurrent author changes instead of silently replacing them', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  create(
    f,
    'outline.json',
    JSON.stringify([
      { chapter: 1, title: '钟楼', summary: '以铜钥匙交换记忆。', plotPoints: ['进楼付出代价'] },
    ]),
  );
  const task = f.run({
    kind: 'agentPrepare',
    request: { mode: 'new-chapter', chapter: 1, instruction: '写第一章' },
    requestKey: 'conflicting-final',
  });
  const body = f.run({ kind: 'read', path: task.target });
  f.run({
    kind: 'save',
    path: task.target,
    expectedHash: body.hash,
    text: '# 钟楼\n\n作者在另一设备写入的正文。',
  });
  const submitted = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: task.proposalId,
    expectedHash: task.expectedHash,
    content: '# 钟楼\n\nAI 的不同正文。',
    complete: true,
  });
  assert.equal(submitted.saved, true);
  assert.equal(submitted.published, false);
  assert.match(submitted.warning, /已更新/);
  assert.equal(f.run({ kind: 'read', path: task.target }).text, '# 钟楼\n\n作者在另一设备写入的正文。');
  assert.equal(f.run({ kind: 'review', id: task.proposalId }).draft.text, '# 钟楼\n\nAI 的不同正文。');
});

test('unlinked chapter can acquire an explicit plan binding without a new chapter or repeated planning loop', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f, 'chapters/manual.md', '# 钟楼\n\n已发生的正文。');
  create(
    f,
    'outline.json',
    JSON.stringify([
      { chapter: 3, title: '钟楼', summary: '承接已有正文进入钟楼。', plotPoints: ['以记忆交换线索'] },
    ]),
  );
  const task = f.run({
    kind: 'agentPrepare',
    request: { mode: 'continue', path: body.path, chapter: 3, instruction: '接着写' },
    requestKey: 'explicit-binding',
  });
  assert.equal(task.target, body.path);
  assert.equal(task.prerequisite, null);
  assert.equal(f.run({ kind: 'list' }).documents.filter((d) => d.category === 'chapter').length, 1);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
});

test('native proposal commit shares CAS/history, cannot choose formal paths and never publishes', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } });
  const body = create(f),
    original = body.text;
  const p = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    originSessionId: 'native-author',
  });
  const inspect = f.run({ kind: 'agentProposal', action: 'inspect', id: p.id });
  assert.equal(inspect.expectedHash, createHash('sha256').update('').digest('hex'));
  assert.equal(inspect.published, false);
  const save = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: p.id,
    expectedHash: inspect.expectedHash,
    content: '第一版候选',
  });
  assert.equal(save.saved, true);
  assert.equal(save.published, false);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, original);
  assert.throws(
    () =>
      f.run({
        kind: 'agentProposal',
        action: 'submit',
        id: p.id,
        expectedHash: inspect.expectedHash,
        content: '不能覆盖第一版',
      }),
    { status: 409 },
  );
  const next = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: p.id,
    expectedHash: save.expectedHash,
    content: '第二版候选',
  });
  assert.ok(f.run({ kind: 'history', path: p.draft }).versions.some((v) => v.hash === save.expectedHash));
  f.run({ kind: 'reject', id: p.id });
  assert.equal(f.run({ kind: 'agentProposal', action: 'inspect', id: p.id }).editable, false);
  assert.throws(
    () =>
      f.run({
        kind: 'agentProposal',
        action: 'submit',
        id: p.id,
        expectedHash: next.expectedHash,
        content: '不能改处理后的候选',
      }),
    { status: 409 },
  );
  assert.equal(f.run({ kind: 'read', path: body.path }).text, original);
});

test('candidate capability derives actor from native context and preserves concurrent author changes', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } }),
    body = create(f);
  const p = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    originSessionId: 'native-author',
  });
  const wrong = makeDocumentService(f.fs, f.fs.db, id, { proposalActor: { sessionId: 'different' } });
  const ordinary = makeDocumentService(f.fs, f.fs.db, id);
  for (const service of [wrong, ordinary])
    assert.throws(
      () =>
        service.run({
          kind: 'agentProposal',
          action: 'inspect',
          id: p.id,
          actor: 'native-author',
        }),
      { status: 403 },
    );
  const before = f.run({ kind: 'agentProposal', action: 'inspect', id: p.id });
  const remote = f.run({ kind: 'save', path: body.path, expectedHash: body.hash, text: '另一台设备的新稿' });
  const saved = f.run({
    kind: 'agentProposal',
    action: 'submit',
    id: p.id,
    expectedHash: before.expectedHash,
    content: '仍保留生成的候选，不冒充已收录',
  });
  assert.match(saved.warning, /正式文件已更新/);
  assert.throws(() => f.run({ kind: 'accept', id: p.id, draftHash: saved.expectedHash }), { status: 409 });
  assert.equal(f.run({ kind: 'read', path: body.path }).hash, remote.hash);
  assert.equal(f.run({ kind: 'read', path: p.draft }).text, '仍保留生成的候选，不冒充已收录');
});

test('native candidate commit rollback retains both candidate and history after a storage failure', () => {
  const f = fixture({ proposalActor: { sessionId: 'native-author' } }),
    body = create(f);
  const p = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    originSessionId: 'native-author',
  });
  const before = f.run({ kind: 'agentProposal', action: 'inspect', id: p.id });
  f.setFailure(root + '/' + p.draft);
  assert.throws(
    () =>
      f.run({
        kind: 'agentProposal',
        action: 'submit',
        id: p.id,
        expectedHash: before.expectedHash,
        content: '不能只写一半',
      }),
    /storage full/,
  );
  f.setFailure(null);
  assert.equal(
    f.run({ kind: 'agentProposal', action: 'inspect', id: p.id }).expectedHash,
    before.expectedHash,
  );
  assert.equal(f.run({ kind: 'read', path: body.path }).hash, body.hash);
});

test('proposal tools retain original schema, reject path injection, cancellation and a changed Agent scope', async () => {
  const f = fixture(),
    body = create(f);
  const p = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    originSessionId: 'native-author',
  });
  let created,
    cwd = root;
  const registered = new Map();
  const agent = {
    id: 'native-author',
    session: {},
    ctx: { get: () => ({ register: (tool) => registered.set(tool.name, tool) }) },
  };
  const instance = {
    ctx: { storage: { transactionSync: (fn) => f.fs.db.transactionSync(fn) } },
    [Symbol('workspace')]: { ready: async () => {}, provider: () => f.fs, db: f.fs.db },
    sessions: {
      context: {
        on: (_name, callback) => {
          created = callback;
        },
        get: () => ({ get: () => cwd }),
      },
    },
  };
  installProposalTools(instance);
  created({ agent });
  const exec = { agent, signal: new AbortController().signal };
  const imageTool = registered.get('novel_illustration');
  const imageList = JSON.parse(await imageTool.execute({ action: 'list', path: body.path }, exec));
  assert.equal(imageList.chapter.expectedHash, body.hash);
  assert.deepEqual(imageList.chapter.placements, []);
  assert.deepEqual(imageList.images, []);
  assert.equal(
    JSON.parse(await imageTool.execute({ action: 'list', path: root + '/' + body.path }, exec)).chapter
      .expectedHash,
    body.hash,
  );
  await assert.rejects(
    imageTool.execute(
      { action: 'list', path: '/workspace/novels/b-' + 'b'.repeat(32) + '/' + body.path },
      exec,
    ),
    /章节路径无效/,
  );
  await assert.rejects(imageTool.execute({ action: 'upload', content: 'not-an-image' }, exec), /参数无效/);
  const inspect = JSON.parse(
    await registered.get('novel_proposal_inspect').execute({ proposal_id: p.id }, exec),
  );
  assert.equal(inspect.target, root + '/' + body.path);
  assert.equal(inspect.draft, root + '/' + p.draft);
  const submit = registered.get('novel_proposal_submit');
  const input = { proposal_id: p.id, expected_hash: inspect.expectedHash, content: '指定候选' };
  await assert.rejects(submit.execute({ ...input, path: body.path }, exec), /参数无效/);
  cwd = '/workspace';
  await assert.rejects(submit.execute(input, exec), /workspace has changed/);
  cwd = root;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(submit.execute(input, { ...exec, signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(f.run({ kind: 'read', path: p.draft }).text, '');
  const saved = JSON.parse(await submit.execute(input, exec));
  assert.equal(saved.saved, true);
  assert.equal(saved.published, false);
  assert.equal(f.run({ kind: 'read', path: body.path }).hash, body.hash);
});
test('outline and canon submit return the original server assessment and can repair the same candidate without publication', () => {
  for (const target of ['outline.json', 'canon.json']) {
    const f = fixture({ proposalActor: { sessionId: 'native-author' } });
    const body = create(f, target, target === 'outline.json' ? '[]' : '{"characters":[]}');
    create(f, 'seed.md', '林风站在钟楼门口。');
    const p = f.run({
      kind: 'propose',
      path: target,
      expectedHash: body.hash,
      originSessionId: 'native-author',
      ...(target === 'outline.json' ? { range: { start: 1, end: 1 } } : { sources: ['seed.md'] }),
    });
    const first = f.run({ kind: 'agentProposal', action: 'inspect', id: p.id });
    const partial = f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: p.id,
      expectedHash: first.expectedHash,
      content: '{unfinished',
    });
    assert.equal(partial.saved, true);
    assert.equal(partial.published, false);
    assert.ok(partial.validation.issues.length > 0);
    assert.equal(f.run({ kind: 'read', path: p.draft }).text, '{unfinished');
    const content =
      target === 'outline.json'
        ? JSON.stringify({
            storyPlan: '林风为了找回失去的记忆，决定调查钟楼，最终必须为保留真相承担代价。',
            chapters: [
              {
                chapter: 1,
                title: '钟楼',
                summary: '林风在门口留下记号，并决定登楼调查，因此失去离开的机会。',
                plotPoints: ['留下记号', '决定登楼'],
              },
            ],
          })
        : JSON.stringify({
            characters: [
              {
                id: 'person-lin',
                name: '林风',
                trust: 'auto',
                evidenceSources: [{ path: 'seed.md', quote: '林风站在钟楼门口。' }],
              },
            ],
          });
    const complete = f.run({
      kind: 'agentProposal',
      action: 'submit',
      id: p.id,
      expectedHash: partial.expectedHash,
      content,
    });
    assert.equal(complete.published, false);
    if (target === 'outline.json') assert.equal(complete.validation.valid, true);
    else assert.equal(complete.validation.usableSuggestions, 1);
    assert.equal(f.run({ kind: 'read', path: target }).hash, body.hash);
  }
});

test('explicit author resume can hand a legacy candidate to another native conversation without changing first provenance or content', () => {
  const f = fixture({ proposalActor: { sessionId: 'first-agent' } }),
    body = create(f);
  const legacy = f.run({ kind: 'propose', path: body.path, expectedHash: body.hash });
  const before = f.run({ kind: 'read', path: legacy.draft });
  assert.throws(() => f.run({ kind: 'agentProposal', action: 'inspect', id: legacy.id }), { status: 403 });
  const assigned = f.run({
    kind: 'propose',
    resumeId: legacy.id,
    originSessionId: 'first-agent',
    expectedDraftHash: before.hash,
  });
  assert.equal(assigned.originSessionId, undefined);
  assert.equal(assigned.writerSessionId, 'first-agent');
  assert.equal(f.run({ kind: 'agentProposal', action: 'inspect', id: legacy.id }).expectedHash, before.hash);
  assert.throws(
    () =>
      f.run({
        kind: 'propose',
        resumeId: legacy.id,
        originSessionId: 'next-agent',
        expectedDraftHash: '0'.repeat(64),
      }),
    { status: 409 },
  );
  const transferred = f.run({
    kind: 'propose',
    resumeId: legacy.id,
    originSessionId: 'next-agent',
    expectedDraftHash: before.hash,
  });
  assert.equal(transferred.originSessionId, undefined);
  assert.throws(() => f.run({ kind: 'agentProposal', action: 'inspect', id: legacy.id }), { status: 403 });
  const next = makeDocumentService(f.fs, f.fs.db, id, { proposalActor: { sessionId: 'next-agent' } });
  assert.equal(
    next.run({ kind: 'agentProposal', action: 'inspect', id: legacy.id }).expectedHash,
    before.hash,
  );
  assert.equal(f.run({ kind: 'read', path: body.path }).hash, body.hash);
  assert.equal(f.run({ kind: 'read', path: legacy.draft }).hash, before.hash);
});

test('native book activity isolates known books, includes running descendants and keeps unknown/global admission conservative', () => {
  const a = { id: 'a', status: 'running', session: {} },
    b = { id: 'b', status: 'idle', session: {} };
  const other = '/workspace/novels/b-' + 'b'.repeat(32);
  const cwd = new Map([
    [a.session, root],
    [b.session, other],
  ]);
  const instance = {
    activeTurns: new Map([['a', { agent: a }]]),
    sessions: {
      context: {
        get(name) {
          if (name === 'agents') return { list: () => [a, b] };
          if (name === 'workingDirectory') return { get: (session) => cwd.get(session) };
        },
      },
    },
  };
  assert.equal(bookIsGenerating(instance, root), true);
  assert.equal(bookIsGenerating(instance, other), false);
  b.status = 'running'; // Native child activity is visible even outside activeTurns.
  assert.equal(bookIsGenerating(instance, other), true);
  b.status = 'idle';
  cwd.set(a.session, root + '/drafts');
  assert.equal(bookIsGenerating(instance, root), true);
  cwd.set(a.session, '/workspace');
  assert.equal(bookIsGenerating(instance, other), true);
  instance.activeTurns.set('transition', {});
  cwd.set(a.session, root);
  assert.equal(bookIsGenerating(instance, other), true);
  instance.activeTurns.clear();
  a.status = 'idle';
  assert.equal(bookIsGenerating(instance, root), false);
  assert.throws(() => bookIsGenerating(instance, null));
  assert.throws(() => bookIsGenerating({ activeTurns: {} }, root));
  assert.throws(() => bookIsGenerating({ activeTurns: new Map() }, root));
});
test('book identity and manuscript catalog share the original native title without rewriting receipts or traversing draft/body files', async () => {
  const f = fixture({ bookTitle: '原生工作区的新书名' });
  const receipt = Buffer.from(f.fs.readFileSync(root + '/book.json'));
  assert.equal(f.run({ kind: 'list' }).book.title, '原生工作区的新书名');
  const readdir = f.fs.readdirSync.bind(f.fs);
  f.fs.readdirSync = (path) => {
    if (path === root) return readdir(path); // Original receipt-part inspection.
    throw new Error('Identity must not traverse potentially damaged body/candidate folders.');
  };
  assert.deepEqual(f.run({ kind: 'identity' }), {
    version: 1,
    id,
    root,
    title: '原生工作区的新书名',
    titleSource: 'workspace',
  });
  assert.deepEqual(Buffer.from(f.fs.readFileSync(root + '/book.json')), receipt);
  assert.equal(fixture().run({ kind: 'identity' }).titleSource, 'receipt');
  const instance = {
    listWorkspaces: async () => ({
      items: [
        { path: root + '/other', title: '另一作品' },
        { path: root, title: '原生工作区的新书名' },
      ],
    }),
  };
  assert.equal(await nativeBookTitle(instance, root), '原生工作区的新书名');
  assert.equal(await nativeBookTitle({ listWorkspaces: async () => ({ items: [] }) }, root), undefined);
  await assert.rejects(nativeBookTitle(instance, root + '/notes'));
  await assert.rejects(nativeBookTitle({ listWorkspaces: async () => ({}) }, root));
  await assert.rejects(
    nativeBookTitle({ listWorkspaces: async () => ({ items: [{ path: root }, { path: root }] }) }, root),
  );
});
test('identity is authenticated, read-only and forwarded to the same owner, never an independent metadata store', async () => {
  for (const authenticated of [false, true]) {
    const calls = [];
    const native = { fetch: async () => Response.json({ authenticated }) };
    const env = {
      DSH_EDGE_INSTANCE: {
        getByName(name) {
          assert.equal(name, 'owner');
          return {
            fetch(request) {
              calls.push(new URL(request.url).pathname);
              return Response.json({ fixture: true });
            },
          };
        },
      },
    };
    const read = await novelGateway(
      new Request('https://novel.example/api/novels/' + id + '/identity'),
      env,
      {},
      native,
    );
    assert.equal(read.status, authenticated ? 200 : 401);
    assert.deepEqual(calls, authenticated ? ['/__novel_editor/' + id + '/identity'] : []);
    const write = await novelGateway(
      new Request('https://novel.example/api/novels/' + id + '/identity', { method: 'POST' }),
      env,
      {},
      native,
    );
    assert.equal(write.status, authenticated ? 405 : 401);
    assert.equal(calls.length, authenticated ? 1 : 0);
  }
});
function runFixture(publication = 'review') {
  const f = fixture({ runKey: RUN_KEY });
  const original = create(f, 'chapters/existing.md', '# 既有章\n\n作者正文必须保留。');
  const outline = create(
    f,
    'outline.json',
    JSON.stringify({
      extension: { preserve: true },
      chapters: [
        {
          chapter: 1,
          title: '既有章',
          chapterPath: original.path,
          summary: '既有事实',
          plotPoints: ['已有事件'],
        },
        { chapter: 2, title: '新章二', summary: '核对账簿', plotPoints: ['取到账簿'], custom: [1, 2] },
        { chapter: 3, title: '新章三', summary: '保留证据的代价', plotPoints: ['承担代价'] },
      ],
    }),
  );
  create(f, 'rules.json', '{"savedPrompts":{"write":"{chapterNumber}：保留动作与证据"}}');
  const request = {
    kind: 'writingRun',
    action: 'create',
    id: crypto.randomUUID(),
    originSessionId: 'native-run-session',
    publication,
    range: { start: 1, end: 3 },
    expectedHash: outline.hash,
    instruction: '本章写完整，不擅自完结全书。',
  };
  const writer = makeDocumentService(f.fs, f.fs.db, id, {
    runKey: RUN_KEY,
    runActor: { sessionId: request.originSessionId },
  });
  return {
    ...f,
    original,
    outline,
    request,
    writer,
    next: () => writer.run({ kind: 'writingRun', action: 'next', id: request.id }),
    submit: (job, content, complete = true) =>
      writer.run({
        kind: 'writingRun',
        action: 'submit',
        id: request.id,
        chapter: job.chapter,
        expectedHash: job.draft.hash,
        content,
        complete,
      }),
  };
}
test('continuous-writing chapter templates use the native title but never rewrite an existing candidate template after rename', () => {
  const f = runFixture();
  const rules = f.run({ kind: 'read', path: 'rules.json' });
  const value = JSON.parse(rules.text);
  value.savedPrompts.write = '作品：{title}；' + value.savedPrompts.write;
  f.run({ kind: 'save', path: 'rules.json', text: JSON.stringify(value), expectedHash: rules.hash });
  f.run(f.request);
  const writer = (bookTitle) =>
    makeDocumentService(f.fs, f.fs.db, id, {
      runKey: RUN_KEY,
      runActor: { sessionId: f.request.originSessionId },
      bookTitle,
    });
  const next = (service) => service.run({ kind: 'writingRun', action: 'next', id: f.request.id });
  const prepared = next(writer('作者改过的书名'));
  assert.ok(prepared.template.body.includes('作品：作者改过的书名'));
  assert.equal(next(writer('随后再次改名')).template.body, prepared.template.body);
  f.submit(prepared, '第二章正文：保留账簿。');
  assert.ok(next(writer('随后再次改名')).template.body.includes('作品：随后再次改名'));
  assert.equal(JSON.parse(new TextDecoder().decode(f.fs.readFileSync(root + '/book.json'))).title, 'fixture');
});

test('native continuous run creates bindings once, skips existing prose, resumes partial candidates, freezes causal carry and accepts in order', () => {
  const f = runFixture();
  const created = f.run(f.request);
  assert.equal(created.total, 2);
  assert.equal(created.skipped, 1);
  assert.equal(created.generated, 0);
  assert.ok(created.items.every((m) => m.proposalId === null));
  assert.equal(f.run({ ...f.request }).alreadyCreated, true);
  const outline = f.run({ kind: 'read', path: 'outline.json' });
  assert.deepEqual(JSON.parse(outline.text).extension, { preserve: true });
  assert.deepEqual(JSON.parse(outline.text).chapters[1].custom, [1, 2]);
  const two = f.next();
  assert.equal(two.chapter, 2);
  assert.equal(two.previous.path, f.original.path);
  assert.match(two.template.body, /^2：/);
  assert.equal(f.next().draft.path, two.draft.path);
  assert.equal(f.submit(two, '未完成的一段。', false).kind, 'partial');
  const resumed = f.next();
  assert.equal(resumed.draft.path, two.draft.path);
  assert.equal(resumed.draft.hasText, true);
  assert.equal(resumed.run.items[1].partial, true);
  assert.equal(f.submit(resumed, '第二章完整候选，取得账簿。').run.generated, 1);
  const three = f.next();
  assert.equal(three.chapter, 3);
  assert.equal(three.previous.path, two.draft.path);
  assert.equal(f.submit(three, '第三章完整候选，为保留证据承担代价。').run.completed, true);
  assert.equal(f.next().kind, 'completed');
  const p2 = f.run({ kind: 'read', path: two.draft.path }).candidate.id;
  const p3 = f.run({ kind: 'read', path: three.draft.path }).candidate.id;
  const r3 = f.run({ kind: 'review', id: p3 });
  assert.throws(() => f.run({ kind: 'accept', id: p3, draftHash: r3.draft.hash }), /先接受前章/);
  const r2 = f.run({ kind: 'review', id: p2 });
  f.run({ kind: 'accept', id: p2, draftHash: r2.draft.hash });
  f.run({ kind: 'accept', id: p3, draftHash: r3.draft.hash });
  assert.equal(f.run({ kind: 'read', path: f.original.path }).hash, f.original.hash);
  assert.ok(f.run({ kind: 'read', path: two.target }).text.endsWith('第二章完整候选，取得账簿。'));
  assert.equal(f.run({ ...f.request }).alreadyCreated, true);
});
test('explicit new-chapters mode publishes only selected empty chapters and retries do not publish twice', () => {
  const f = runFixture('new-chapters');
  f.run(f.request);
  for (const n of [2, 3]) {
    const job = f.next();
    assert.equal(job.chapter, n);
    const result = f.submit(job, '第 ' + n + ' 章的完整合成正文。');
    assert.equal(result.run.items.find((m) => m.chapter === n).published, true);
    assert.equal(f.submit(job, '第 ' + n + ' 章的完整合成正文。').alreadySubmitted, true);
    assert.ok(f.run({ kind: 'read', path: job.target }).text.endsWith('完整合成正文。'));
  }
  assert.equal(f.next().kind, 'completed');
  assert.equal(f.run({ kind: 'read', path: f.original.path }).hash, f.original.hash);
});
test('native checkpoint catalog survives a new service instance, reports corruption and paginates without hiding earlier tasks', () => {
  const f = runFixture();
  assert.deepEqual(f.run({ kind: 'writingRun', action: 'list' }), { items: [], nextOffset: null });
  const first = f.run(f.request);
  for (let i = 0; i < 21; i++)
    f.run({
      ...f.request,
      id: crypto.randomUUID(),
      expectedHash: f.run({ kind: 'read', path: 'outline.json' }).hash,
    });
  const fresh = makeDocumentService(f.fs, f.fs.db, id, { runKey: RUN_KEY });
  const listing = fresh.run({ kind: 'writingRun', action: 'list' });
  assert.equal(listing.items.length, 20);
  assert.equal(listing.nextOffset, 20);
  assert.ok(listing.items.every((row) => !Object.hasOwn(row, 'items') && row.createdAt));
  const earlier = fresh.run({ kind: 'writingRun', action: 'list', offset: 20 });
  assert.equal(earlier.items.length, 2);
  assert.equal(earlier.nextOffset, null);
  assert.ok(earlier.items.some((row) => row.id === first.id));
  const file = root + '/notes/writing-runs/' + first.id + '.json';
  f.fs.writeFileSync(file, 'not-json');
  const broken = fresh.run({ kind: 'writingRun', action: 'list' });
  assert.ok(broken.items.find((row) => row.id === first.id)?.error.includes('损坏'));
  assert.throws(() => fresh.run({ kind: 'writingRun', action: 'get', id: first.id }), /损坏/);
  assert.throws(() => fresh.run({ kind: 'writingRun', action: 'list', offset: -1 }), { status: 400 });
});
test('large chapter outline remains complete in native source instead of inflating or truncating tool output', () => {
  const f = runFixture();
  const value = JSON.parse(f.outline.text);
  value.chapters[1].summary = '长章纲。'.repeat(6000);
  const outline = f.run({
    kind: 'save',
    path: 'outline.json',
    text: JSON.stringify(value),
    expectedHash: f.outline.hash,
  });
  f.run({ ...f.request, expectedHash: outline.hash });
  const job = f.next();
  assert.equal(job.outline.source, root + '/outline.json');
  assert.ok(JSON.stringify(job.outline).length < 1000);
  assert.equal(
    JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text).chapters[1].summary,
    value.chapters[1].summary,
  );
});
test('changed sources before the next native step persist a blocked checkpoint, not an endlessly resumable failure', () => {
  const f = runFixture();
  f.run(f.request);
  const rules = f.run({ kind: 'read', path: 'rules.json' });
  f.run({ kind: 'save', path: rules.path, text: '{}', expectedHash: rules.hash });
  const next = f.next();
  assert.equal(next.kind, 'conflict');
  assert.equal(next.run.phase, 'blocked');
  assert.match(next.run.notice, /规则或提示词已变化/);
  assert.equal(f.run({ kind: 'writingRun', action: 'get', id: f.request.id }).phase, 'blocked');
  assert.throws(() => f.next(), { status: 409 });
  assert.equal(f.run({ kind: 'read', path: f.original.path }).hash, f.original.hash);
});
test('book backup preserves signed checkpoints and candidates byte-for-byte but a restored copy cannot replay original authorization', async () => {
  const f = runFixture();
  f.run(f.request);
  const job = f.next();
  f.submit(job, '备份前未完成、必须原样保留的候选。', false);
  const files = [];
  function collect(folder = '') {
    for (const name of f.fs.readdirSync(root + (folder ? '/' + folder : ''))) {
      const path = folder ? folder + '/' + name : name;
      if (f.fs.lstatSync(root + '/' + path).isDirectory()) collect(path);
      else files.push({ path, content: f.fs.readFileSync(root + '/' + path) });
    }
  }
  collect();
  const snapshot = await makeBackup({ id, title: '连写备份合成样本' }, files),
    restored = await restoreBackup(snapshot);
  assert.ok(restored.files.some((file) => file.path === 'notes/writing-runs/' + f.request.id + '.json'));
  for (const file of restored.files) {
    assert.deepEqual(file.content, files.find((source) => source.path === file.path).content);
    const target = restored.manifest.root + '/' + file.path;
    f.fs.mkdirSync(target.slice(0, target.lastIndexOf('/')));
    f.fs.writeFileSync(target, file.content);
  }
  f.fs.writeFileSync(restored.manifest.root + '/book.json', JSON.stringify(restored.manifest));
  const copy = makeDocumentService(f.fs, f.fs.db, restored.manifest.id, { runKey: RUN_KEY });
  assert.equal(copy.run({ kind: 'read', path: job.draft.path }).text, '备份前未完成、必须原样保留的候选。');
  assert.throws(() => copy.run({ kind: 'writingRun', action: 'get', id: f.request.id }), /不兼容/);
  assert.ok(copy.run({ kind: 'writingRun', action: 'list' }).items[0].error);
  assert.equal(
    f.next().draft.hasText,
    true,
    'Inspecting/restoring a copy must not close or mutate the source run.',
  );
});
test('run authorization cannot be forged by editing native files or invoked by another session', () => {
  const f = runFixture();
  f.run(f.request);
  const other = makeDocumentService(f.fs, f.fs.db, id, {
    runKey: RUN_KEY,
    runActor: { sessionId: 'another-session' },
  });
  assert.throws(() => other.run({ kind: 'writingRun', action: 'next', id: f.request.id }), { status: 403 });
  assert.throws(() => f.writer.run(f.request), { status: 403 });
  const file = root + '/notes/writing-runs/' + f.request.id + '.json';
  const envelope = JSON.parse(new TextDecoder().decode(f.fs.readFileSync(file)));
  envelope.payload.publication = 'new-chapters';
  f.fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => f.next(), /授权校验失败/);
  assert.equal(f.run({ kind: 'read', path: f.original.path }).hash, f.original.hash);
});
test('rules or formal conflicts retain generated candidate without publishing or pretending complete', () => {
  for (const change of ['rules', 'formal']) {
    const f = runFixture('new-chapters');
    f.run(f.request);
    const job = f.next();
    const current = f.run({ kind: 'read', path: change === 'rules' ? 'rules.json' : job.target });
    f.run({
      kind: 'save',
      path: current.path,
      expectedHash: current.hash,
      text: change === 'rules' ? '{"savedPrompts":{"write":"作者新模板"}}' : '另一台设备的正文。',
    });
    const result = f.submit(job, '已经生成、必须保留的候选。');
    assert.equal(result.kind, 'conflict');
    assert.equal(result.run.phase, 'blocked');
    assert.equal(result.run.generated, 0);
    assert.equal(f.run({ kind: 'read', path: job.draft.path }).text, '已经生成、必须保留的候选。');
    assert.equal(
      f.run({ kind: 'read', path: current.path }).text,
      change === 'rules' ? '{"savedPrompts":{"write":"作者新模板"}}' : '另一台设备的正文。',
    );
    assert.throws(() => f.next(), { status: 409 });
  }
});
test('binding creation and checkpoint write share the original rollback boundary', () => {
  const f = runFixture();
  f.setFailure(root + '/notes/writing-runs/' + f.request.id + '.json');
  assert.throws(() => f.run(f.request), /storage full/);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).hash, f.outline.hash);
  assert.equal(f.run({ kind: 'list' }).documents.filter((m) => m.category === 'chapter').length, 1);
  f.setFailure();
  f.run(f.request);
  const job = f.next();
  f.run({ kind: 'writingRun', action: 'close', id: f.request.id });
  assert.throws(() => f.submit(job, '关闭后不允许写入。'), { status: 409 });
  assert.equal(f.run({ kind: 'read', path: job.draft.path }).text, '');
});

test('expanded prompt is frozen in the original proposal, custom rules edits cannot rewrite history, and invalid template modes fail atomically', () => {
  const f = fixture(),
    body = create(f);
  const rules = create(
    f,
    'rules.json',
    JSON.stringify({ savedPrompts: { write: '作者模板 {title} {chapter} {setting}' } }),
  );
  const p = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    writing: { version: 1, mode: 'continue', instruction: '只写新增' },
    edit: { start: body.text.length, end: body.text.length },
  });
  assert.equal(p.promptTemplate.source, 'custom');
  assert.equal(p.promptTemplate.rulesHash, rules.hash);
  assert.equal(f.run({ kind: 'list' }).proposals[0].promptTemplate, undefined);
  assert.match(p.promptTemplate.body, /作者模板/);
  assert.doesNotMatch(p.promptTemplate.body, /\{setting\}/);
  f.run({
    kind: 'save',
    path: 'rules.json',
    expectedHash: rules.hash,
    text: '{"savedPrompts":{"write":"后来的模板"}}',
  });
  assert.deepEqual(f.run({ kind: 'review', id: p.id }).proposal.promptTemplate, p.promptTemplate);
  const count = f.run({ kind: 'list' }).proposals.length;
  for (const writing of [
    { version: 1, mode: 'continue', instruction: '', templateKey: 'deai' },
    { version: 1, mode: 'rewrite', instruction: '', templateKey: 'ending' },
    { version: 1, mode: 'continue', instruction: '', templateKey: '__proto__' },
    { version: 1, mode: 'begin', instruction: '', purpose: 'whole-book' },
  ])
    assert.throws(() => f.run({ kind: 'propose', path: body.path, expectedHash: body.hash, writing }), {
      status: 400,
    });
  const current = f.run({ kind: 'read', path: 'rules.json' });
  f.run({
    kind: 'save',
    path: 'rules.json',
    expectedHash: current.hash,
    text: '{"savedPrompts":{"write":[]}}',
  });
  assert.throws(
    () =>
      f.run({
        kind: 'propose',
        path: body.path,
        expectedHash: body.hash,
        writing: { version: 1, mode: 'continue', instruction: '' },
      }),
    /不是文本/,
  );
  assert.equal(f.run({ kind: 'list' }).proposals.length, count);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
  for (const [key, mode] of [
    ['deai', 'rewrite'],
    ['ending', 'continue'],
  ]) {
    const fresh = f.run({ kind: 'read', path: 'rules.json' });
    f.run({ kind: 'save', path: 'rules.json', expectedHash: fresh.hash, text: '{}' });
    const special = f.run({
      kind: 'propose',
      path: body.path,
      expectedHash: body.hash,
      writing: { version: 1, mode, instruction: '', templateKey: key },
      ...(mode === 'continue' ? { edit: { start: body.text.length, end: body.text.length } } : {}),
    });
    assert.equal(special.promptTemplate.key, key);
  }
});
test('a checkpoint failure AFTER automatic new-chapter publication rolls back candidate, prose and proposal together', () => {
  const f = runFixture('new-chapters');
  f.run(f.request);
  const job = f.next();
  const original = f.run({ kind: 'read', path: job.target });
  const manifestPath = root + '/notes/writing-runs/' + f.request.id + '.json';
  const write = f.fs.writeFileSync.bind(f.fs);
  let writes = 0;
  f.fs.writeFileSync = (path, value) => {
    if (path === manifestPath && ++writes === 2) throw new Error('checkpoint failure after publication');
    write(path, value);
  };
  assert.throws(() => f.submit(job, '不应半份发布的候选。'), /checkpoint failure/);
  assert.equal(f.run({ kind: 'read', path: job.target }).hash, original.hash);
  assert.equal(f.run({ kind: 'read', path: job.draft.path }).text, '');
  assert.equal(f.run({ kind: 'writingRun', action: 'get', id: f.request.id }).generated, 0);
  assert.equal(f.next().draft.path, job.draft.path);
});

test('proposal provenance stays in the original receipt and resolved candidates remain reviewable but cannot publish again', () => {
  const f = fixture(),
    body = create(f);
  assert.throws(
    () => f.run({ kind: 'propose', path: body.path, expectedHash: body.hash, originSessionId: '../other' }),
    { status: 400 },
  );
  assert.equal(f.run({ kind: 'list' }).proposals.length, 0);
  for (const resolve of ['accept', 'reject']) {
    const original = f.run({ kind: 'read', path: body.path });
    const p = f.run({
      kind: 'propose',
      path: original.path,
      expectedHash: original.hash,
      originSessionId: 'native-session',
    });
    const draft = f.run({ kind: 'read', path: p.draft });
    f.run({ kind: 'save', path: p.draft, text: '候选 ' + resolve, expectedHash: draft.hash });
    const pending = f.run({ kind: 'review', id: p.id });
    assert.equal(pending.proposal.originSessionId, 'native-session');
    f.run({ kind: resolve, id: p.id, draftHash: pending.draft.hash });
    const resolved = f.run({ kind: 'review', id: p.id });
    assert.equal(resolved.proposal.status, resolve === 'accept' ? 'accepted' : 'rejected');
    assert.equal(resolved.proposal.originSessionId, 'native-session');
    assert.equal(resolved.draft.text, pending.draft.text);
    assert.equal(resolved.proposal.resolvedDraftHash, pending.draft.hash);
    assert.equal(
      f.run({ kind: 'history', path: p.draft, hash: pending.draft.hash }).text,
      pending.draft.text,
    );
    assert.throws(
      () =>
        f.run({
          kind: 'propose',
          path: body.path,
          expectedHash: body.hash,
          writing: { version: 1, mode: 'begin', purpose: 'chapter', instruction: '' },
        }),
      { status: 409 },
    );
    assert.throws(() => f.run({ kind: 'accept', id: p.id, draftHash: resolved.draft.hash }), { status: 409 });
    assert.throws(() => f.run({ kind: 'reject', id: p.id }), { status: 409 });
    assert.equal(f.run({ kind: 'read', path: p.draft }).candidate.editable, false);
    f.fs.writeFileSync(root + '/' + p.draft, '原生工具后来的修改');
    assert.equal(f.run({ kind: 'review', id: p.id }).draft.text, pending.draft.text);
    const receiptPath = root + '/drafts/' + p.id + '.proposal.json';
    const receipt = JSON.parse(new TextDecoder().decode(f.fs.readFileSync(receiptPath)));
    const legacyReceipt = { ...receipt };
    delete legacyReceipt.resolvedDraftHash;
    f.fs.writeFileSync(receiptPath, JSON.stringify(legacyReceipt));
    assert.equal(f.run({ kind: 'review', id: p.id }).draft.text, '原生工具后来的修改');
    f.fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    f.fs.unlinkSync(root + '/' + p.draft);
    assert.equal(f.run({ kind: 'review', id: p.id }).draft.hash, pending.draft.hash);
    const frozenPath =
      root +
      '/.novel-history/' +
      createHash('sha256').update(p.draft).digest('hex') +
      '/' +
      pending.draft.hash +
      '.md';
    f.fs.writeFileSync(frozenPath, '损坏历史');
    assert.throws(() => f.run({ kind: 'review', id: p.id }), /快照缺失或损坏/);
  }
  const current = f.run({ kind: 'read', path: body.path });
  const legacy = f.run({ kind: 'propose', path: body.path, expectedHash: current.hash });
  assert.equal(f.run({ kind: 'review', id: legacy.id }).proposal.originSessionId, undefined);
});
test('managed canon candidates expose their frozen editor context and save with original CAS/history, never publication', () => {
  let running = false;
  const f = fixture({ isGenerating: () => running }),
    source = create(f, 'setting.md', '许微带着银铃。'),
    base = create(f, 'canon.json', '{"characters":[],"items":[]}'),
    p = f.run({ kind: 'propose', path: base.path, expectedHash: base.hash, sources: [source.path] });
  let draft = f.run({ kind: 'read', path: p.draft });
  assert.equal(draft.candidate.target, 'canon.json');
  assert.equal(draft.candidate.baseText, base.text);
  assert.deepEqual(draft.candidate.sources, p.sources);
  assert.equal(draft.candidate.editable, true);
  const edited =
    '{"characters":[],"items":[{"id":"bell","name":"银铃","trust":"auto","evidenceSources":[{"path":"setting.md","quote":"银铃"}]}]}';
  const saved = f.run({ kind: 'save', path: p.draft, text: edited, expectedHash: draft.hash });
  assert.equal(saved.candidate.id, p.id);
  assert.equal(f.run({ kind: 'history', path: p.draft, hash: draft.hash }).text, draft.text);
  assert.equal(f.run({ kind: 'read', path: base.path }).text, base.text);
  assert.throws(() => f.run({ kind: 'save', path: p.draft, text: '{}', expectedHash: draft.hash }), {
    status: 409,
  });
  running = true;
  assert.equal(f.run({ kind: 'read', path: p.draft }).candidate.running, true);
  assert.throws(
    () => f.run({ kind: 'save', path: p.draft, text: '{}', expectedHash: saved.hash }),
    /仍有 AI/,
  );
  create(f, 'notes/while-running.md', '普通手稿仍可编辑');
  assert.equal(f.run({ kind: 'read', path: p.draft }).text, edited);
  running = false;
  const review = f.run({ kind: 'review', id: p.id });
  f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash, keys: ['items:0'] });
  draft = f.run({ kind: 'read', path: p.draft });
  assert.equal(draft.candidate.status, 'accepted');
  assert.equal(draft.candidate.editable, false);
  assert.throws(
    () => f.run({ kind: 'save', path: p.draft, text: '{}', expectedHash: draft.hash }),
    /提案已经处理/,
  );
});
test('broken proposal context preserves readable candidate bytes but cannot be silently saved; ordinary drafts still work', () => {
  const f = fixture(),
    base = create(f),
    p = f.run({ kind: 'propose', path: base.path, expectedHash: base.hash });
  f.fs.writeFileSync(root + '/' + p.draft, '候选原文');
  f.fs.writeFileSync(root + '/drafts/' + p.id + '.proposal.json', '{broken');
  const draft = f.run({ kind: 'read', path: p.draft });
  assert.equal(draft.text, '候选原文');
  assert.equal(draft.candidate.editable, false);
  assert.match(draft.candidate.warning, /只读/);
  assert.throws(() => f.run({ kind: 'save', path: p.draft, text: '不应覆盖', expectedHash: draft.hash }), {
    status: 409,
  });
  const ordinary = create(
    f,
    'drafts/' + 'e'.repeat(8) + '-eeee-eeee-eeee-' + 'e'.repeat(12) + '.md',
    '普通草稿',
  );
  assert.equal(ordinary.candidate, undefined);
  assert.equal(
    f.run({ kind: 'save', path: ordinary.path, text: '作者新稿', expectedHash: ordinary.hash }).text,
    '作者新稿',
  );
  const canon = create(f, 'canon.json', '{}'),
    source = create(f, 'setting.md', '来源'),
    cp = f.run({ kind: 'propose', path: canon.path, expectedHash: canon.hash, sources: [source.path] });
  const frozen =
    root +
    '/.novel-history/' +
    createHash('sha256').update('canon.json').digest('hex') +
    '/' +
    canon.hash +
    '.md';
  f.fs.unlinkSync(frozen);
  assert.equal(f.run({ kind: 'read', path: cp.draft }).candidate.editable, false);
});

function orderFixture() {
  const f = fixture();
  const a = create(f, 'chapters/a.md', '\ufeff# 甲章\r\n原正文甲🌧️\r\n');
  const b = create(f, 'chapters/b.md', '# 乙章\n原正文乙\n');
  const outline = create(
    f,
    'outline.json',
    '\ufeff' +
      JSON.stringify({
        extension: { chapter: 1, keep: true },
        chapters: [
          { chapter: '1', title: '甲章', chapterPath: a.path, unknown: { chapter: 1 } },
          { chapter: 2, title: '乙章', chapterPath: b.path },
          { chapter: 3, title: '未写正文的第三章', summary: '保持未关联', plotPoints: [] },
        ],
      }) +
      '\n',
  );
  const rules = create(
    f,
    'rules.json',
    JSON.stringify({
      creativeRules: {
        chapterPOVOverrides: { 1: ['甲角色'], 2: ['乙角色'] },
        narrativePerson: 'third',
      },
      extension: { chapter: 1 },
      referenceText: '第1章的文字引用不做猜测替换',
    }),
  );
  const memory = create(
    f,
    'memory.json',
    JSON.stringify({
      memory: {
        chapterCards: [{ chapter: 1, summary: '旧摘要' }],
        importantEvents: [{ chapter: '2', event: '旧事件' }],
        indexes: { characters: { 人物甲: [1, '2'] } },
      },
      chapterMemories: {
        2: { chapter: 2, sourceChapters: [1], sourceHash: '1:old-content-hash', content: '旧前文接力' },
      },
      extension: { chapter: 1 },
    }),
  );
  const canon = create(
    f,
    'canon.json',
    JSON.stringify({
      characters: [
        {
          id: 'a',
          name: '人物甲',
          trust: 'manual',
          sourceChapter: 1,
          customFields: { chapter: 1 },
          evidenceSources: [{ path: a.path, quote: '原正文甲' }],
        },
      ],
      extension: { chapter: 1 },
    }),
  );
  f.fs.writeFileSync(
    root + '/chapter-index.json',
    JSON.stringify([
      { chapter: 1, paths: [a.path] },
      { chapter: 2, paths: [b.path] },
    ]),
  );
  return { f, a, b, outline, rules, memory, canon };
}
test('chapter order previews are read-only and atomically preserve prose, provenance and unknown fields while remapping typed references', () => {
  const { f, a, b, outline, rules, memory, canon } = orderFixture();
  const startText = '\ufeff# 自定义入口\r\n作者要求不能删改。\r\n';
  f.fs.writeFileSync(root + '/START.md', startText);
  const proposal = f.run({ kind: 'propose', path: a.path, expectedHash: a.hash });
  f.run({
    kind: 'save',
    path: proposal.draft,
    text: '旧接力候选',
    expectedHash: f.run({ kind: 'read', path: proposal.draft }).hash,
  });
  const index = new Uint8Array(f.fs.readFileSync(root + '/chapter-index.json'));
  const receipt = new Uint8Array(f.fs.readFileSync(root + '/book.json'));
  const snapshot = f.run({ kind: 'chapterOrder' });
  const keys = [b.path, a.path, 'outline:3'];
  const input = { kind: 'chapterOrder', action: 'preview', version: snapshot.version, keys };
  const preview = f.run(input);
  assert.equal(preview.fingerprint, f.run(input).fingerprint);
  assert.equal(preview.pendingProposals, 1);
  assert.equal(preview.valid, true);
  for (const file of [outline, rules, memory, canon]) {
    assert.equal(f.run({ kind: 'read', path: file.path }).hash, file.hash);
    assert.deepEqual(f.run({ kind: 'history', path: file.path }).versions, []);
  }
  assert.throws(() => f.run({ ...input, action: 'apply', fingerprint: '0'.repeat(64) }), /预览已失效/);
  f.run({ ...input, action: 'apply', fingerprint: preview.fingerprint });
  const start = new TextDecoder('utf-8', { ignoreBOM: true }).decode(f.fs.readFileSync(root + '/START.md'));
  assert.equal(start, startText);
  const currentOutline = f.run({ kind: 'read', path: 'outline.json' });
  const shape = JSON.parse(currentOutline.text.slice(1));
  assert.deepEqual(
    shape.chapters.map((r) => [r.chapter, r.chapterPath]),
    [
      [1, b.path],
      ['2', a.path],
      [3, null],
    ],
  );
  assert.deepEqual(shape.extension, { chapter: 1, keep: true });
  assert.deepEqual(shape.chapters[1].unknown, { chapter: 1 });
  const currentRules = JSON.parse(f.run({ kind: 'read', path: 'rules.json' }).text);
  assert.deepEqual(currentRules.creativeRules.chapterPOVOverrides, { 1: ['乙角色'], 2: ['甲角色'] });
  assert.deepEqual(currentRules.extension, { chapter: 1 });
  const currentMemory = JSON.parse(f.run({ kind: 'read', path: 'memory.json' }).text);
  assert.equal(currentMemory.memory.chapterCards[0].chapter, 2);
  assert.equal(currentMemory.memory.importantEvents[0].chapter, '1');
  assert.deepEqual(currentMemory.memory.indexes.characters.人物甲, [2, '1']);
  assert.deepEqual(currentMemory.chapterMemories[1].sourceChapters, [2]);
  assert.equal(currentMemory.chapterMemories[1].chapter, 1);
  assert.equal(currentMemory.chapterMemories[1].sourceHash, '1:old-content-hash');
  assert.equal(currentMemory.chapterOrderReview.required, true);
  const currentCanon = JSON.parse(f.run({ kind: 'read', path: 'canon.json' }).text);
  assert.equal(currentCanon.characters[0].sourceChapter, 2);
  assert.equal(currentCanon.characters[0].trust, 'manual');
  assert.deepEqual(currentCanon.characters[0].customFields, { chapter: 1 });
  assert.deepEqual(currentCanon.characters[0].evidenceSources, [{ path: a.path, quote: '原正文甲' }]);
  for (const file of [a, b]) assert.equal(f.run({ kind: 'read', path: file.path }).hash, file.hash);
  assert.deepEqual(f.fs.readFileSync(root + '/chapter-index.json'), index);
  assert.deepEqual(f.fs.readFileSync(root + '/book.json'), receipt);
  for (const file of [outline, rules, memory, canon])
    assert.equal(f.run({ kind: 'history', path: file.path, hash: file.hash }).text, file.text);
  const review = f.run({ kind: 'review', id: proposal.id });
  assert.match(review.orderWarning, /章节顺序已调整/);
  assert.equal(
    review.current.hash,
    proposal.baseHash,
    'The stale guard cannot rely only on unchanged prose bytes.',
  );
  assert.throws(() => f.run({ kind: 'accept', id: proposal.id, draftHash: review.draft.hash }), /重新复核/);
  assert.ok(f.run({ kind: 'reject', id: proposal.id }).ok);
});

test('chapter order keeps empty planned chapters explicitly unbound instead of reattaching old import paths', () => {
  const { f, a } = orderFixture();
  const view = f.run({ kind: 'chapterOrder' });
  const keys = ['outline:3', a.path, 'chapters/b.md'];
  const preview = f.run({ kind: 'chapterOrder', action: 'preview', version: view.version, keys });
  f.run({
    kind: 'chapterOrder',
    action: 'apply',
    version: view.version,
    keys,
    fingerprint: preview.fingerprint,
  });
  const outline = f.run({ kind: 'read', path: 'outline.json' });
  assert.deepEqual(outline.bindings.find((r) => r.chapter === 1).paths, []);
  assert.deepEqual(f.run({ kind: 'read', path: a.path }).outline.chapter, '2');
  const opened = f.run({ kind: 'outlineChapter', chapter: 1, expectedHash: outline.hash });
  assert.equal(opened.created, true);
  assert.notEqual(opened.path, a.path);
});

test('chapter reordering works from free-writing files and preserves gap numbers and original import identity', () => {
  const f = fixture();
  const a = create(f, 'chapters/a.md', '# 自由甲\n正文'),
    b = create(f, 'chapters/b.md', '# 自由乙\n正文');
  let snapshot = f.run({ kind: 'chapterOrder' });
  assert.deepEqual(
    snapshot.entries.map((e) => [e.chapter, e.added]),
    [
      [1, true],
      [2, true],
    ],
  );
  let keys = [b.path, a.path],
    preview = f.run({ kind: 'chapterOrder', action: 'preview', version: snapshot.version, keys });
  f.run({
    kind: 'chapterOrder',
    action: 'apply',
    version: snapshot.version,
    keys,
    fingerprint: preview.fingerprint,
  });
  assert.equal(f.run({ kind: 'read', path: b.path }).outline.chapter, 1);
  const current = f.run({ kind: 'read', path: 'outline.json' });
  f.run({
    kind: 'save',
    path: 'outline.json',
    text: JSON.stringify([
      { chapter: 3, title: '三', chapterPath: b.path },
      { chapter: 9, title: '九', chapterPath: a.path },
    ]),
    expectedHash: current.hash,
  });
  snapshot = f.run({ kind: 'chapterOrder' });
  keys = [a.path, b.path];
  preview = f.run({ kind: 'chapterOrder', action: 'preview', version: snapshot.version, keys });
  f.run({
    kind: 'chapterOrder',
    action: 'apply',
    version: snapshot.version,
    keys,
    fingerprint: preview.fingerprint,
  });
  assert.deepEqual(
    JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text).map((r) => r.chapter),
    [3, 9],
  );
  assert.equal(f.run({ kind: 'read', path: a.path }).outline.chapter, 3);
});

test('chapter-order CAS refuses stale metadata and new chapters while unrelated prose edits are retained exactly', () => {
  const { f, a, b, rules } = orderFixture();
  const view = f.run({ kind: 'chapterOrder' }),
    keys = [b.path, a.path, 'outline:3'];
  const input = { kind: 'chapterOrder', action: 'preview', version: view.version, keys };
  const preview = f.run(input);
  const edited = f.run({
    kind: 'save',
    path: a.path,
    text: a.text + '另一设备正在修改正文尾段',
    expectedHash: a.hash,
  });
  f.run({ ...input, action: 'apply', fingerprint: preview.fingerprint });
  assert.equal(f.run({ kind: 'read', path: a.path }).hash, edited.hash);
  const second = f.run({ kind: 'chapterOrder' });
  const reverse = [a.path, b.path, 'outline:3'];
  const prepared = f.run({ kind: 'chapterOrder', action: 'preview', version: second.version, keys: reverse });
  const currentRules = f.run({ kind: 'read', path: rules.path });
  f.run({ kind: 'save', path: rules.path, text: currentRules.text + '\n', expectedHash: currentRules.hash });
  assert.throws(
    () =>
      f.run({
        kind: 'chapterOrder',
        action: 'apply',
        version: second.version,
        keys: reverse,
        fingerprint: prepared.fingerprint,
      }),
    /关联资料已更新/,
  );
  const third = f.run({ kind: 'chapterOrder' });
  create(f, 'chapters/new.md', '# 新出现的章节');
  assert.throws(
    () =>
      f.run({
        kind: 'chapterOrder',
        action: 'preview',
        version: third.version,
        keys: third.entries.map((e) => e.key).reverse(),
      }),
    /关联资料已更新/,
  );
});

test('chapter-order failures roll back all files and histories, including pending-proposal invalidation', () => {
  const { f, a, b, outline, rules, memory, canon } = orderFixture();
  const proposal = f.run({ kind: 'propose', path: a.path, expectedHash: a.hash });
  const view = f.run({ kind: 'chapterOrder' }),
    keys = [b.path, a.path, 'outline:3'];
  const preview = f.run({ kind: 'chapterOrder', action: 'preview', version: view.version, keys });
  f.setFailure(root + '/memory.json');
  assert.throws(
    () =>
      f.run({
        kind: 'chapterOrder',
        action: 'apply',
        version: view.version,
        keys,
        fingerprint: preview.fingerprint,
      }),
    /storage full/,
  );
  for (const file of [outline, rules, memory, canon]) {
    assert.equal(f.run({ kind: 'read', path: file.path }).hash, file.hash);
    assert.deepEqual(f.run({ kind: 'history', path: file.path }).versions, []);
  }
  assert.equal(f.run({ kind: 'review', id: proposal.id }).orderWarning, undefined);
});

test('chapter-order rejects missing, duplicate, foreign and incompatible identities without guessing or losing source access', () => {
  const { f, a, b } = orderFixture();
  const view = f.run({ kind: 'chapterOrder' });
  for (const keys of [
    [a.path],
    [a.path, a.path, 'outline:3'],
    [b.path, '../other-book.md', 'outline:3'],
    view.entries.map((e) => e.key),
  ])
    assert.throws(() => f.run({ kind: 'chapterOrder', action: 'preview', version: view.version, keys }));
  f.fs.writeFileSync(root + '/memory.json', '{');
  assert.equal(f.run({ kind: 'read', path: 'memory.json' }).text, '{');
  const invalid = f.run({ kind: 'chapterOrder' });
  assert.throws(
    () =>
      f.run({
        kind: 'chapterOrder',
        action: 'preview',
        version: invalid.version,
        keys: invalid.entries.map((e) => e.key).reverse(),
      }),
    /JSON 无效/,
  );
  f.fs.writeFileSync(
    root + '/outline.json',
    JSON.stringify([
      { chapter: 1, chapterPath: a.path },
      { chapter: 2, chapterPath: a.path },
    ]),
  );
  assert.throws(() => f.run({ kind: 'chapterOrder' }), /重复关联/);
});

test('chapter order refuses orphan-key collisions instead of overwriting an unbound future POV', () => {
  const f = fixture();
  const a = create(f, 'chapters/a.md', '# 甲\n正文'),
    b = create(f, 'chapters/b.md', '# 未编号乙\n正文');
  create(f, 'outline.json', JSON.stringify([{ chapter: 1, title: '甲', chapterPath: a.path }]));
  create(
    f,
    'rules.json',
    JSON.stringify({ creativeRules: { chapterPOVOverrides: { 1: ['甲'], 2: ['未绑定的未来视角'] } } }),
  );
  const view = f.run({ kind: 'chapterOrder' });
  assert.throws(
    () => f.run({ kind: 'chapterOrder', action: 'preview', version: view.version, keys: [b.path, a.path] }),
    /碰撞未关联的章节引用/,
  );
});

test('chapter-order resource bounds refuse oversized aggregate state without truncation or any writes', () => {
  const f = fixture();
  const chapter = create(f, 'chapters/budget.md', '# 预算\n正文');
  f.run({ kind: 'propose', path: chapter.path, expectedHash: chapter.hash });
  const text = JSON.stringify({ noise: 'x'.repeat(DOCUMENT_LIMIT - 12) });
  assert.equal(new TextEncoder().encode(text).length, DOCUMENT_LIMIT);
  for (const path of ['outline.json', 'rules.json', 'memory.json', 'canon.json']) create(f, path, text);
  f.fs.writeFileSync(root + '/START.md', '原入口额外占用预算');
  assert.throws(
    () => f.run({ kind: 'chapterOrder' }),
    (error) => error.status === 413 && /8 MiB/.test(error.message),
  );
  assert.deepEqual(f.run({ kind: 'history', path: 'outline.json' }).versions, []);
});

test('chapter-order preview exposes a per-file overflow rather than offering a truncated or unpublishable result', () => {
  const f = fixture();
  const text = JSON.stringify({
    noise: 'x'.repeat(DOCUMENT_LIMIT - 130),
    chapters: [
      { chapter: 1, title: '甲' },
      { chapter: 2, title: '乙' },
    ],
  });
  assert.ok(new TextEncoder().encode(text).length < DOCUMENT_LIMIT);
  const original = create(f, 'outline.json', text);
  const view = f.run({ kind: 'chapterOrder' });
  const keys = ['outline:2', 'outline:1'];
  const preview = f.run({ kind: 'chapterOrder', action: 'preview', version: view.version, keys });
  assert.equal(preview.valid, false);
  assert.ok(preview.issues.some((issue) => issue.includes('outline.json')));
  assert.throws(
    () =>
      f.run({
        kind: 'chapterOrder',
        action: 'apply',
        version: view.version,
        keys,
        fingerprint: preview.fingerprint,
      }),
    (error) => error.status === 409,
  );
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).hash, original.hash);
  assert.deepEqual(f.run({ kind: 'history', path: 'outline.json' }).versions, []);
});
test('chapter ordering neither reads nor recreates retired standalone guides, regardless of guide size', () => {
  const f = fixture();
  const a = create(f, 'chapters/a.md', '# 甲\n正文'),
    b = create(f, 'chapters/b.md', '# 乙\n正文');
  const guide = '# 作者的大型原生规则\n' + 'x'.repeat(600000);
  f.fs.writeFileSync(root + '/AGENTS.md', guide);
  const snapshot = f.run({ kind: 'chapterOrder' }),
    keys = [b.path, a.path];
  const preview = f.run({ kind: 'chapterOrder', action: 'preview', version: snapshot.version, keys });
  assert.equal(preview.valid, true);
  f.run({
    kind: 'chapterOrder',
    action: 'apply',
    version: snapshot.version,
    keys,
    fingerprint: preview.fingerprint,
  });
  assert.deepEqual(
    f.fs.readdirSync(root).filter((name) => name.startsWith('AGENTS.md')),
    ['AGENTS.md'],
  );
  assert.equal(new TextDecoder().decode(f.fs.readFileSync(root + '/AGENTS.md')), guide);
  const largeGuide = 'x'.repeat(1024 * 1024);
  f.fs.writeFileSync(root + '/AGENTS.md', largeGuide);
  const next = f.run({ kind: 'chapterOrder' });
  const invalid = f.run({
    kind: 'chapterOrder',
    action: 'preview',
    version: next.version,
    keys: [a.path, b.path],
  });
  assert.equal(invalid.valid, true);
  f.run({
    kind: 'chapterOrder',
    action: 'apply',
    version: next.version,
    keys: [a.path, b.path],
    fingerprint: invalid.fingerprint,
  });
  assert.equal(new TextDecoder().decode(f.fs.readFileSync(root + '/AGENTS.md')), largeGuide);
  assert.equal(f.fs.readdirSync(root).includes('START.md'), false);
});
test('prose preparation rejects a stale outline before creating a candidate and freezes current planning for later acceptance', () => {
  const f = fixture();
  const body = create(f, 'chapters/a.md', '# 甲\n正文不变');
  const outline = create(f, 'outline.json', '[{"chapter":1,"title":"甲","chapterPath":"chapters/a.md"}]');
  const changed = f.run({
    kind: 'save',
    path: 'outline.json',
    expectedHash: outline.hash,
    text: '[{"chapter":2,"title":"新规划","chapterPath":"chapters/a.md"}]',
  });
  assert.throws(
    () => f.run({ kind: 'propose', path: body.path, expectedHash: body.hash, outlineHash: outline.hash }),
    /未基于旧规划创建/,
  );
  assert.equal(f.run({ kind: 'list' }).proposals.length, 0);
  const proposal = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    outlineHash: changed.hash,
  });
  assert.equal(proposal.contextOutlineHash, changed.hash);
  const draft = f.run({ kind: 'read', path: proposal.draft });
  f.run({ kind: 'save', path: draft.path, text: '候选', expectedHash: draft.hash });
  f.run({ kind: 'save', path: 'outline.json', expectedHash: changed.hash, text: changed.text + '\n' });
  const review = f.run({ kind: 'review', id: proposal.id });
  assert.equal(review.orderWarning, undefined);
  assert.match(review.contextWarning, /当前章纲或正文关联已更新/);
  assert.equal(review.current.hash, body.hash);
  assert.throws(() => f.run({ kind: 'accept', id: proposal.id, draftHash: review.draft.hash }), /需重新复核/);
  assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
});
test('document context changes independently of body text/hash and includes physical part paths and planning warnings', () => {
  const a = {
    hash: 'same-body',
    text: '作者的未提交稿',
    outlineHash: 'old',
    parts: ['chapters/a.md.part-0001'],
  };
  assert.notEqual(documentContextRevision(a), documentContextRevision({ ...a, outlineHash: 'new' }));
  assert.notEqual(documentContextRevision(a), documentContextRevision({ ...a, parts: undefined }));
  assert.notEqual(
    documentContextRevision(a),
    documentContextRevision({ ...a, planningWarning: '关联不唯一' }),
  );
  assert.equal(
    documentContextRevision(a),
    documentContextRevision({ ...a, text: '新输入的正文', updatedAt: 2 }),
  );
});
test('ordinary prose stays independent of optional broken or over-editor-cap planning while freezing its complete native bytes', () => {
  const f = fixture(),
    body = create(f, 'chapters/a.md', '# 已有正文\n续写不应被可选规划挡住');
  f.fs.writeFileSync(root + '/outline.json', '{');
  const broken = f.run({ kind: 'read', path: body.path });
  assert.ok(broken.planningWarning);
  assert.equal(broken.outlineHash, createHash('sha256').update('{').digest('hex'));
  f.fs.unlinkSync(root + '/outline.json');
  const text = JSON.stringify({ chapters: [{ chapter: 1, summary: 'x'.repeat(3 * 1024 * 1024) }] });
  const content = new TextEncoder().encode(text),
    parts = [];
  for (let start = 0; start < content.length; start += PART_LIMIT) {
    const name = 'outline.json.part-' + String(parts.length + 1).padStart(4, '0');
    parts.push(name);
    f.fs.writeFileSync(root + '/' + name, content.slice(start, start + PART_LIMIT));
  }
  f.fs.writeFileSync(
    root + '/outline.json.parts.json',
    JSON.stringify({ format: 'novel-document-parts-v1', parts }),
  );
  const large = f.run({ kind: 'read', path: body.path });
  assert.ok(large.planningWarning);
  assert.equal(large.outlineHash, createHash('sha256').update(content).digest('hex'));
  const proposal = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    outlineHash: large.outlineHash,
  });
  const draft = f.run({ kind: 'read', path: proposal.draft });
  f.run({ kind: 'save', path: draft.path, text: body.text + '\n新增续文', expectedHash: draft.hash });
  const review = f.run({ kind: 'review', id: proposal.id });
  assert.equal(review.contextWarning, undefined);
  f.run({ kind: 'accept', id: proposal.id, draftHash: review.draft.hash });
  assert.match(f.run({ kind: 'read', path: body.path }).text, /新增续文$/);
});

test('chapter title synchronizes the unique outline row and heading without moving files or changing prose', () => {
  const f = fixture();
  const path = 'chapters/stable.md',
    text = '\ufeff# 原标题\r\n\r\n正文🌧️\r\n# 内文标题不动\r\n';
  const before = create(f, path, text);
  const outline = create(
    f,
    'outline.json',
    '\ufeff' +
      JSON.stringify({
        unknown: { keep: true },
        chapters: [{ chapter: 2, title: '原章纲', chapterPath: path, extra: ['保留'] }],
      }) +
      '\n',
  );
  const receipt = new Uint8Array(f.fs.readFileSync(root + '/book.json'));
  const result = f.run({
    kind: 'chapterTitle',
    path,
    title: ' 新标题🌧️ ',
    expectedHash: before.hash,
    outlineHash: outline.hash,
  });
  assert.equal(result.text, text.replace('# 原标题', '# 新标题🌧️'));
  assert.equal(result.path, path);
  assert.equal(result.outline.title, '新标题🌧️');
  const saved = f.run({ kind: 'read', path: 'outline.json' });
  assert.deepEqual(JSON.parse(saved.text.slice(1)).chapters[0], {
    chapter: 2,
    title: '新标题🌧️',
    chapterPath: path,
    extra: ['保留'],
  });
  assert.deepEqual(JSON.parse(saved.text.slice(1)).unknown, { keep: true });
  assert.ok(saved.text.startsWith('\ufeff') && saved.text.endsWith('\n'));
  assert.equal(f.run({ kind: 'history', path, hash: before.hash }).text, text);
  assert.equal(f.run({ kind: 'history', path: 'outline.json', hash: outline.hash }).text, outline.text);
  assert.deepEqual(f.fs.readFileSync(root + '/book.json'), receipt);
});

test('chapter title adds an explicit heading without discarding a titleless first paragraph or BOM', () => {
  const f = fixture(),
    path = 'chapters/plain.txt';
  const before = create(f, path, '\ufeff首段正文\r\n尾段');
  const result = f.run({
    kind: 'chapterTitle',
    path,
    title: '标题',
    expectedHash: before.hash,
    outlineHash: null,
  });
  assert.equal(result.text, '\ufeff# 标题\r\n\r\n首段正文\r\n尾段');
  assert.equal(f.run({ kind: 'read', path }).chapterTitle, '标题');
  assert.throws(() => f.fs.statSync(root + '/outline.json'), /missing/);
});

test('chapter rename checks both complete versions and rejects ambiguous associations or invalid titles', () => {
  const f = fixture(),
    path = 'chapters/1.md';
  const before = create(f, path, '# 原名\n正文');
  const outline = create(f, 'outline.json', JSON.stringify([{ chapter: 1, title: '一', chapterPath: path }]));
  const input = {
    kind: 'chapterTitle',
    path,
    title: '新名',
    expectedHash: before.hash,
    outlineHash: outline.hash,
  };
  for (const title of ['', '两\n行', 'a'.repeat(121), '\u2028', '\u0000'])
    assert.throws(
      () => f.run({ ...input, title }),
      (e) => e.status === 400,
    );
  assert.throws(
    () => f.run({ ...input, expectedHash: '0'.repeat(64) }),
    (e) => e.status === 409 && e.extra.current.hash === before.hash,
  );
  assert.throws(
    () => f.run({ ...input, outlineHash: null }),
    (e) => e.status === 409,
  );
  const changed = f.run({
    kind: 'save',
    path: 'outline.json',
    expectedHash: outline.hash,
    text: JSON.stringify([
      { chapter: 1, chapterPath: path },
      { chapter: 2, chapterPath: path },
    ]),
  });
  assert.throws(() => f.run({ ...input, outlineHash: changed.hash }), /关联不唯一/);
  assert.equal(f.run({ kind: 'read', path }).text, before.text);
  assert.deepEqual(f.run({ kind: 'history', path }).versions, []);
});

test('chapter rename rolls back manuscript, outline and histories when the second file fails', () => {
  const f = fixture(),
    path = 'chapters/1.md';
  const before = create(f, path, '# 原名\n正文');
  const outline = create(
    f,
    'outline.json',
    JSON.stringify([{ chapter: 1, chapterPath: path, title: '原名' }]),
  );
  f.setFailure(root + '/outline.json');
  assert.throws(
    () =>
      f.run({
        kind: 'chapterTitle',
        path,
        title: '新名',
        expectedHash: before.hash,
        outlineHash: outline.hash,
      }),
    /storage full/,
  );
  assert.equal(f.run({ kind: 'read', path }).hash, before.hash);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).hash, outline.hash);
  assert.deepEqual(f.run({ kind: 'history', path }).versions, []);
  assert.deepEqual(f.run({ kind: 'history', path: 'outline.json' }).versions, []);
});

test('chapter directory derives numbered outline order and current headings without rewriting provenance', () => {
  const f = fixture();
  create(f, 'chapters/z.md', '# 正文标题\n正文');
  create(f, 'chapters/a.md', '# 二章正文\n正文');
  create(f, 'chapters/free.md', '# 未关联章节\n正文');
  const outline = create(
    f,
    'outline.json',
    JSON.stringify([
      { chapter: 2, title: '章纲第二章', chapterPath: 'chapters/a.md' },
      { chapter: 1, title: '章纲第一章', chapterPath: 'chapters/z.md' },
    ]),
  );
  const list = f.run({ kind: 'list' }).documents.filter((f) => f.category === 'chapter');
  assert.deepEqual(
    list.map((f) => [f.path, f.title, f.chapter]),
    [
      ['chapters/z.md', '章纲第一章', 1],
      ['chapters/a.md', '章纲第二章', 2],
      ['chapters/free.md', '未关联章节', undefined],
    ],
  );
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).hash, outline.hash);
  assert.deepEqual(f.run({ kind: 'history', path: 'outline.json' }).versions, []);
});

test('long multipart title change retains complete body, path, layout and history', () => {
  const f = fixture(),
    path = 'chapters/long.md',
    text = '\ufeff# 旧标题\r\n' + '长正文🌧️\r\n'.repeat(45000);
  const before = create(f, path, text);
  const result = f.run({
    kind: 'chapterTitle',
    path,
    title: '新标题',
    expectedHash: before.hash,
    outlineHash: null,
  });
  assert.equal(result.text, text.replace('# 旧标题', '# 新标题'));
  assert.ok(result.parts.length > 1);
  assert.equal(f.run({ kind: 'history', path, hash: before.hash }).text, text);
  const list = f.run({ kind: 'list' }).documents;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '新标题');
});

test('chapter labels use the native bounded prefix reader and skip prose reads for named outline bindings', () => {
  const f = fixture();
  create(f, 'chapters/bound.md', '# 本文标题\n长正文');
  create(f, 'chapters/free.md', '# 自由章节\n' + 'x'.repeat(600000));
  create(
    f,
    'outline.json',
    JSON.stringify([{ chapter: 1, title: '章纲标题', chapterPath: 'chapters/bound.md' }]),
  );
  const originalRead = f.fs.readFileSync.bind(f.fs),
    calls = [];
  f.fs.readRangeSync = (path, offset, length) => {
    calls.push([path, offset, length]);
    assert.ok(!path.includes('/bound.md'));
    return originalRead(path).subarray(offset, offset + length);
  };
  f.fs.readFileSync = (path) => {
    assert.ok(
      !path.startsWith(root + '/chapters/') || path.endsWith('.parts.json'),
      'No full prose fetch just for directory labels; layout metadata is still validated.',
    );
    return originalRead(path);
  };
  const list = f.run({ kind: 'list' }).documents.filter((f) => f.category === 'chapter');
  assert.deepEqual(
    list.map((f) => f.title),
    ['章纲标题', '自由章节'],
  );
  assert.deepEqual(calls, [[root + '/chapters/free.md.part-0001', 0, 2048]]);
});

test('document paths exclude archives, credentials, traversal and control bytes', () => {
  for (const path of [
    '../x',
    'chapters/../x.md',
    'chapters\\a.md',
    'archive/source.json',
    'book.json',
    '.novel-history/a.md',
    'chapters/a\n.md',
  ])
    assert.equal(documentPath(path), false);
  assert.equal(documentPath('chapters/新章 (二).md'), true);
});

test('textarea normalization keeps BOM/CRLF and exact UTF-16 selection offsets, including mixed endings and emoji', () => {
  const source = '\ufeff开场\r\n🌧️前文\r\n选中🌧️原句\r\n结尾',
    dom = editorValue(source);
  const start = dom.indexOf('选中'),
    end = start + '选中🌧️原句'.length;
  const range = editorRange(dom, start, end, source);
  assert.equal(range.start, source.indexOf('选中'));
  assert.equal(range.text, '选中🌧️原句');
  assert.equal(editorText(dom, source), source);
  assert.equal(mixedEndings(source), false);
  const mixed = '第一行\r\n第二行\n第三行\r选中🌧️\r\n';
  assert.equal(mixedEndings(mixed), true);
  const mixedDOM = editorValue(mixed),
    m = mixedDOM.indexOf('选中');
  assert.equal(editorRange(mixedDOM, m, m + '选中🌧️'.length, mixed).start, mixed.indexOf('选中'));
});
test('native manuscript changes preserve BOM/CRLF and reject stale revisions, including external VFS edits', () => {
  const f = fixture(),
    first = create(f);
  assert.equal(f.run({ kind: 'read', path: first.path }).text, first.text);
  const next = f.run({ kind: 'save', path: first.path, text: '第二版', expectedHash: first.hash });
  assert.throws(
    () => f.run({ kind: 'save', path: first.path, text: '旧设备覆盖', expectedHash: first.hash }),
    (error) => error.status === 409 && error.extra.current.hash === next.hash,
  );
  f.fs.writeFileSync(root + '/' + first.path, '原生 Agent 的新修改');
  assert.throws(() => f.run({ kind: 'save', path: first.path, text: '旧页覆盖', expectedHash: next.hash }), {
    status: 409,
  });
  assert.equal(f.run({ kind: 'read', path: first.path }).text, '原生 Agent 的新修改');
  assert.equal(f.run({ kind: 'history', path: first.path, hash: first.hash }).text, first.text);
});
test('snapshot and manuscript update roll back together on storage failure', () => {
  const f = fixture(),
    first = create(f);
  f.setFailure(root + '/' + first.path);
  assert.throws(
    () => f.run({ kind: 'save', path: first.path, text: '丢失', expectedHash: first.hash }),
    /storage full/,
  );
  assert.equal(f.run({ kind: 'read', path: first.path }).text, first.text);
  assert.equal(f.run({ kind: 'history', path: first.path }).versions.length, 0);
});

test('logical long documents grow and shrink atomically with native layout receipts and full-byte history', () => {
  const f = fixture(),
    path = 'chapters/long.md';
  const original = '\ufeff' + '雨夜🌧️。\r\n'.repeat(40000);
  assert.ok(new TextEncoder().encode(original).length > PART_LIMIT);
  const first = create(f, path, original);
  assert.equal(first.text, original);
  assert.ok(first.parts.length > 1);
  assert.equal(f.run({ kind: 'list' }).documents.filter((d) => d.category === 'chapter').length, 1);
  for (const part of first.parts) assert.ok(f.fs.statSync(root + '/' + part).size <= PART_LIMIT);
  const short = f.run({ kind: 'save', path, text: '\ufeff短章🌧️\r\n', expectedHash: first.hash });
  assert.equal(short.parts.length, 1);
  assert.equal(f.run({ kind: 'read', path }).text, '\ufeff短章🌧️\r\n');
  assert.equal(f.run({ kind: 'history', path, hash: first.hash }).text, original);
  assert.equal(f.run({ kind: 'history', path }).versions.length, 1);
  assert.throws(() => f.run({ kind: 'save', path, text: '失效覆盖', expectedHash: first.hash }), {
    status: 409,
  });
});

test('native single files above the old editor limit remain readable and migrate to bounded parts only on explicit save', () => {
  const f = fixture(),
    path = 'chapters/native.md',
    text = '原生单文件。\r\n'.repeat(30000);
  f.fs.mkdirSync(root + '/chapters');
  f.fs.writeFileSync(root + '/' + path, text);
  const original = f.run({ kind: 'read', path });
  assert.ok(original.text === text);
  assert.equal(original.parts, undefined);
  const saved = f.run({ kind: 'save', path, text: text + '末尾', expectedHash: original.hash });
  assert.ok(saved.parts.length > 1 && saved.text === text + '末尾');
  assert.ok(f.run({ kind: 'history', path, hash: original.hash }).text === text);
});

test('multipart CAS observes native part edits and refuses missing first/middle/last parts or competing whole files', () => {
  for (const index of [0, 1, 2]) {
    const f = fixture(),
      first = create(f, 'chapters/long.md', '雨'.repeat(380000));
    assert.equal(first.parts.length, 3);
    f.fs.unlinkSync(root + '/' + first.parts[index]);
    assert.throws(() => f.run({ kind: 'read', path: first.path }), { status: 409 });
    assert.throws(
      () => f.run({ kind: 'save', path: first.path, text: '不得覆盖', expectedHash: first.hash }),
      { status: 409 },
    );
  }
  const f = fixture(),
    first = create(f, 'chapters/long.md', '风'.repeat(180000));
  f.fs.writeFileSync(root + '/' + first.parts[1], '原生工具直接编辑');
  const current = f.run({ kind: 'read', path: first.path });
  assert.match(current.text, /原生工具直接编辑$/);
  assert.notEqual(current.hash, first.hash);
  assert.throws(
    () => f.run({ kind: 'save', path: first.path, text: '旧稿', expectedHash: first.hash }),
    (e) => e.status === 409 && e.extra.current.text === current.text,
  );
  f.fs.writeFileSync(root + '/' + first.path, '歧义的整篇');
  assert.throws(() => f.run({ kind: 'read', path: first.path }), { status: 409 });
});

test('multipart file writes, obsolete-part deletion and layout receipts roll back with full history on failure', () => {
  for (const failure of ['chapters/long.md.part-0002', 'chapters/long.md.parts.json']) {
    const f = fixture(),
      first = create(f, 'chapters/long.md', '云'.repeat(180000));
    f.setFailure(root + '/' + failure);
    assert.throws(
      () => f.run({ kind: 'save', path: first.path, text: '应回滚', expectedHash: first.hash }),
      /storage full/,
    );
    f.setFailure(undefined);
    assert.equal(f.run({ kind: 'read', path: first.path }).text, first.text);
    assert.equal(f.run({ kind: 'history', path: first.path }).versions.length, 0);
  }
});

test('long prose proposals replace only the frozen selected range or append, preserving all unselected bytes', () => {
  const f = fixture(),
    original = '\ufeff' + '前文。\r\n'.repeat(60000) + '选中🌧️原句' + '\r\n后文';
  const first = create(f, 'chapters/long.md', original),
    start = original.indexOf('选中'),
    end = original.indexOf('\r\n后文');
  assert.throws(() => f.run({ kind: 'propose', path: first.path, expectedHash: first.hash }), {
    status: 400,
  });
  const p = f.run({ kind: 'propose', path: first.path, expectedHash: first.hash, edit: { start, end } });
  f.fs.writeFileSync(root + '/' + p.draft, '改好的新句');
  const review = f.run({ kind: 'review', id: p.id });
  assert.equal(review.base, '选中🌧️原句');
  const accepted = f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash }).document;
  assert.equal(accepted.text, original.slice(0, start) + '改好的新句' + original.slice(end));
  const append = f.run({
    kind: 'propose',
    path: first.path,
    expectedHash: accepted.hash,
    edit: { start: accepted.text.length, end: accepted.text.length },
  });
  f.fs.writeFileSync(root + '/' + append.draft, '\r\n新增的场景');
  const appendReview = f.run({ kind: 'review', id: append.id });
  assert.equal(appendReview.base, '');
  assert.equal(
    f.run({ kind: 'accept', id: append.id, draftHash: appendReview.draft.hash }).document.text,
    accepted.text + '\r\n新增的场景',
  );
});

test('scoped proposals reject surrogate splits, excessive selection, changed bases and oversized complete documents', () => {
  const f = fixture(),
    first = create(f, 'chapters/1.md', '开场🌧️结尾');
  assert.throws(
    () => f.run({ kind: 'propose', path: first.path, expectedHash: first.hash, edit: { start: 3, end: 5 } }),
    { status: 400 },
  );
  const p = f.run({
    kind: 'propose',
    path: first.path,
    expectedHash: first.hash,
    edit: { start: 0, end: 2 },
  });
  f.fs.writeFileSync(root + '/' + p.draft, '新开场');
  const review = f.run({ kind: 'review', id: p.id });
  f.run({ kind: 'save', path: first.path, text: '另一台设备改变了开场', expectedHash: first.hash });
  assert.throws(() => f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash }), { status: 409 });
  assert.equal(f.run({ kind: 'read', path: first.path }).text, '另一台设备改变了开场');
  assert.throws(() => create(f, 'chapters/too-large.md', 'a'.repeat(DOCUMENT_LIMIT + 1)), { status: 413 });
  assert.equal(
    f.run({ kind: 'list' }).documents.some((d) => d.path.endsWith('too-large.md')),
    false,
  );
  const long = create(f, 'chapters/long.md', 'a'.repeat(40000));
  assert.throws(
    () =>
      f.run({ kind: 'propose', path: long.path, expectedHash: long.hash, edit: { start: 0, end: 33000 } }),
    { status: 413 },
  );
});
test('JSON references accept and preserve UTF-8 BOM, use original snapshots and expose migrated rules', () => {
  const f = fixture(),
    text = '\ufeff{\r\n  "characters": [], "unknown": {"keep": true}\r\n}\r\n';
  const first = create(f, 'canon.json', text);
  assert.equal(first.text, text);
  f.run({ kind: 'save', path: 'canon.json', text: '\ufeff{"characters":[]}', expectedHash: first.hash });
  assert.equal(f.run({ kind: 'history', path: 'canon.json', hash: first.hash }).text, text);
  create(f, 'rules.json', '{"creativeRules":{"styleConstraints":"克制"}}');
  assert.ok(
    f
      .run({ kind: 'list' })
      .documents.some((doc) => doc.path === 'rules.json' && doc.category === 'reference'),
  );
});
test('AI proposals require explicit acceptance, compare exact reviewed bytes and never overwrite newer prose', () => {
  const f = fixture(),
    first = create(f),
    proposal = f.run({ kind: 'propose', path: first.path, expectedHash: first.hash });
  assert.equal(f.run({ kind: 'read', path: first.path }).text, first.text);
  f.fs.writeFileSync(root + '/' + proposal.draft, '候选稿');
  const review = f.run({ kind: 'review', id: proposal.id });
  f.fs.writeFileSync(root + '/' + proposal.draft, '仍在增长的候选稿');
  assert.throws(() => f.run({ kind: 'accept', id: proposal.id, draftHash: review.draft.hash }), {
    status: 409,
  });
  const ready = f.run({ kind: 'review', id: proposal.id });
  f.run({ kind: 'accept', id: proposal.id, draftHash: ready.draft.hash });
  assert.equal(f.run({ kind: 'read', path: first.path }).text, ready.draft.text);
  const second = f.run({
    kind: 'propose',
    path: first.path,
    expectedHash: f.run({ kind: 'read', path: first.path }).hash,
  });
  f.fs.writeFileSync(root + '/' + second.draft, '第二份候选');
  const original = f.run({ kind: 'read', path: first.path });
  f.run({ kind: 'save', path: first.path, text: '作者的新改动', expectedHash: original.hash });
  const stale = f.run({ kind: 'review', id: second.id });
  assert.throws(() => f.run({ kind: 'accept', id: second.id, draftHash: stale.draft.hash }), { status: 409 });
  f.run({ kind: 'reject', id: second.id });
  assert.equal(f.run({ kind: 'read', path: first.path }).text, '作者的新改动');
  assert.equal(f.run({ kind: 'read', path: second.draft }).text, '第二份候选');
});
test('symlinks and hard links cannot escape the book or be overwritten', () => {
  const f = fixture(),
    first = create(f);
  f.setLink(root + '/' + first.path);
  assert.throws(() => f.run({ kind: 'read', path: first.path }), { status: 409 });
  f.setSymlink(root + '/notes');
  assert.throws(() => f.run({ kind: 'save', path: 'notes/x.md', text: 'outside', expectedHash: null }), {
    status: 409,
  });
});
test('canon proposals freeze real source versions, publish only selected pending suggestions and keep originals/history', () => {
  const f = fixture(),
    source = create(f, 'chapters/1.md', '许微把青铜钥匙递给沈澄。');
  const base = create(
    f,
    'canon.json',
    '\ufeff' +
      JSON.stringify({
        notice: '保留',
        characters: [{ id: 'p1', name: '沈澄', trust: 'manual', notes: '作者原文' }],
        items: [],
      }),
  );
  const p = f.run({ kind: 'propose', path: base.path, expectedHash: base.hash, sources: [source.path] });
  assert.equal(p.sources[0].hash, source.hash);
  const candidate = JSON.parse(base.text.slice(1));
  candidate.characters[0].notes = '不允许偷改';
  candidate.items.push({
    id: 'key1',
    name: '青铜钥匙',
    trust: 'auto',
    evidenceSources: [{ path: source.path, quote: '青铜钥匙' }],
  });
  f.fs.writeFileSync(root + '/' + p.draft, JSON.stringify(candidate));
  const review = f.run({ kind: 'review', id: p.id });
  assert.equal(review.canon.validCount, 1);
  assert.equal(f.run({ kind: 'read', path: base.path }).text, base.text);
  assert.throws(
    () => f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash, keys: ['characters:0'] }),
    { status: 400 },
  );
  const accepted = f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash, keys: ['items:0'] });
  const value = JSON.parse(accepted.document.text.slice(1));
  assert.equal(value.characters[0].notes, '作者原文');
  assert.equal(value.items[0].trust, 'auto');
  assert.equal(f.run({ kind: 'history', path: base.path, hash: base.hash }).text, base.text);
});
test('changed evidence and changed canon never publish old suggestions; invalid scope writes no proposal', () => {
  const f = fixture(),
    source = create(f, 'setting.md', '许微带着一枚银铃。'),
    base = create(f, 'canon.json', '{}');
  assert.throws(
    () => f.run({ kind: 'propose', path: base.path, expectedHash: base.hash, sources: ['memory.json'] }),
    { status: 400 },
  );
  assert.equal(f.run({ kind: 'list' }).proposals.length, 0);
  const p = f.run({ kind: 'propose', path: base.path, expectedHash: base.hash, sources: [source.path] });
  f.fs.writeFileSync(
    root + '/' + p.draft,
    JSON.stringify({
      items: [
        { id: 'bell', name: '银铃', trust: 'auto', evidenceSources: [{ path: source.path, quote: '银铃' }] },
      ],
    }),
  );
  const review = f.run({ kind: 'review', id: p.id });
  f.fs.writeFileSync(root + '/' + source.path, source.text + '\n另一设备的新增情节');
  assert.throws(() => f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash, keys: ['items:0'] }), {
    status: 400,
  });
  assert.equal(f.run({ kind: 'read', path: base.path }).text, '{}');
  assert.equal(f.run({ kind: 'list' }).proposals.length, 1);
  f.fs.writeFileSync(root + '/' + base.path, '{"notice":"new base"}');
  assert.throws(() => f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash, keys: ['items:0'] }), {
    status: 409,
  });
});
test('outline chapter creation/binding is atomic, conflict-safe, idempotent and supplies the matching plan to prose', () => {
  const f = fixture(),
    original = create(
      f,
      'outline.json',
      JSON.stringify([
        { chapter: 1, title: '入塔', summary: '第一章因果', plotPoints: ['敲门'], extension: 'keep' },
      ]),
    );
  const opened = f.run({ kind: 'outlineChapter', chapter: 1, expectedHash: original.hash });
  assert.equal(opened.created, true);
  const prose = f.run({ kind: 'read', path: opened.path });
  assert.match(prose.text, /入塔/);
  assert.equal(prose.outline.summary, '第一章因果');
  assert.equal(JSON.parse(f.run({ kind: 'read', path: 'outline.json' }).text)[0].extension, 'keep');
  assert.equal(
    f.run({ kind: 'outlineChapter', chapter: 1, expectedHash: original.hash }).path,
    opened.path,
    'A lost response must not create another chapter.',
  );
  const g = fixture(),
    base = create(g, 'outline.json', original.text);
  g.setFailure(root + '/outline.json');
  assert.throws(() => g.run({ kind: 'outlineChapter', chapter: 1, expectedHash: base.hash }), /storage full/);
  assert.equal(
    g.run({ kind: 'list' }).documents.some((file) => file.category === 'chapter'),
    false,
  );
  assert.equal(g.run({ kind: 'read', path: 'outline.json' }).text, base.text);
});
test('imported chapter links stay provenance-only; split chapters and outlines resolve as complete documents', () => {
  const f = fixture();
  create(f, 'chapters/00001.md', '旧章正文');
  const base = create(
    f,
    'outline.json',
    '[{"chapter":7,"title":"旧标题","summary":"旧概要","plotPoints":[]}]',
  );
  f.fs.writeFileSync(
    root + '/chapter-index.json',
    JSON.stringify([{ chapter: 7, paths: ['chapters/00001.md'] }]),
  );
  const linked = f.run({ kind: 'outlineChapter', chapter: 7, expectedHash: base.hash });
  assert.equal(linked.path, 'chapters/00001.md');
  assert.equal(linked.created, false);
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, base.text);
  f.fs.writeFileSync(
    root + '/chapter-index.json',
    JSON.stringify([{ chapter: 7, paths: ['chapters/00001.md.part-0001', 'chapters/00001.md.part-0002'] }]),
  );
  f.fs.unlinkSync(root + '/chapters/00001.md');
  f.fs.writeFileSync(root + '/chapters/00001.md.part-0001', '长章前半🌧️');
  f.fs.writeFileSync(root + '/chapters/00001.md.part-0002', '长章后半');
  const receipt = JSON.parse(new TextDecoder().decode(f.fs.readFileSync(root + '/book.json')));
  receipt.files = ['chapters/00001.md.part-0001', 'chapters/00001.md.part-0002'].map((path) => ({ path }));
  f.fs.writeFileSync(root + '/book.json', JSON.stringify(receipt));
  const joined = f.run({ kind: 'outlineChapter', chapter: 7, expectedHash: base.hash });
  assert.equal(joined.path, 'chapters/00001.md');
  assert.equal(f.run({ kind: 'read', path: joined.path }).text, '长章前半🌧️长章后半');
  const outlineText = f.run({ kind: 'read', path: 'outline.json' }).text;
  f.fs.unlinkSync(root + '/outline.json');
  f.fs.writeFileSync(root + '/outline.json.part-0001', outlineText.slice(0, 20));
  f.fs.writeFileSync(root + '/outline.json.part-0002', outlineText.slice(20));
  receipt.files.push(...['outline.json.part-0001', 'outline.json.part-0002'].map((path) => ({ path })));
  f.fs.writeFileSync(root + '/book.json', JSON.stringify(receipt));
  assert.equal(f.run({ kind: 'read', path: 'outline.json' }).text, outlineText);
  assert.deepEqual(f.run({ kind: 'list' }).outlineParts, []);
  assert.equal(f.run({ kind: 'list' }).documents.filter((d) => d.category === 'chapter').length, 1);
});
test('outline proposals save direction and batch together, retain original metadata, and refuse stale direction/prose', () => {
  const f = fixture(),
    base = create(
      f,
      'outline.json',
      JSON.stringify([
        { chapter: 1, title: '旧', summary: '旧概要', plotPoints: ['旧事件'], note: '作者要求' },
      ]),
    );
  const p = f.run({ kind: 'propose', path: base.path, expectedHash: base.hash, range: { start: 1, end: 2 } });
  assert.equal(p.plan.hasDirection, false);
  f.fs.writeFileSync(
    root + '/' + p.draft,
    JSON.stringify({
      storyPlan: '贯穿全篇的方向',
      chapters: [
        { chapter: 1, title: '新', summary: '新因果', plotPoints: ['新事件'] },
        { chapter: 2, title: '后果', summary: '承接前章', plotPoints: ['付出代价'] },
      ],
    }),
  );
  const review = f.run({ kind: 'review', id: p.id });
  assert.equal(review.outline.valid, true);
  f.setFailure(root + '/outline.json');
  assert.throws(() => f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash }), /storage full/);
  assert.throws(() => f.run({ kind: 'read', path: 'notes/story-plan.md' }), { status: 404 });
  assert.equal(f.run({ kind: 'read', path: base.path }).text, base.text);
  f.setFailure(undefined);
  const accepted = f.run({ kind: 'accept', id: p.id, draftHash: review.draft.hash });
  assert.equal(JSON.parse(accepted.document.text)[0].note, '作者要求');
  assert.equal(f.run({ kind: 'read', path: 'notes/story-plan.md' }).text, '贯穿全篇的方向');
  const next = f.run({
    kind: 'propose',
    path: base.path,
    expectedHash: accepted.document.hash,
    range: { start: 3, end: 3 },
  });
  f.fs.writeFileSync(
    root + '/' + next.draft,
    JSON.stringify({
      chapters: [{ chapter: 3, title: '继续', summary: '继续因果', plotPoints: ['继续选择'] }],
    }),
  );
  f.fs.writeFileSync(root + '/notes/story-plan.md', '另一个设备的新方向');
  const stale = f.run({ kind: 'review', id: next.id });
  assert.equal(stale.outline.staleSources, true);
  assert.throws(() => f.run({ kind: 'accept', id: next.id, draftHash: stale.draft.hash }), { status: 400 });
});
test('outline source versions detect native prose edits and unsafe associations before stale planning can publish', () => {
  const f = fixture(),
    body = create(f, 'chapters/1.md', '# 第一章\n\n已写的事件与代价。');
  const row = {
    chapter: 1,
    title: '原标题',
    summary: '原概要',
    plotPoints: ['原事件'],
    chapterPath: body.path,
  };
  const base = create(f, 'outline.json', JSON.stringify([row]));
  create(f, 'notes/story-plan.md', '已确定的全篇方向');
  const proposal = f.run({
    kind: 'propose',
    path: base.path,
    expectedHash: base.hash,
    range: { start: 1, end: 1 },
  });
  assert.equal(proposal.plan.sources[0].written, true);
  f.fs.writeFileSync(root + '/' + proposal.draft, JSON.stringify({ chapters: [row] }));
  f.fs.writeFileSync(root + '/' + body.path, body.text + '\n另一个设备的更新。');
  const review = f.run({ kind: 'review', id: proposal.id });
  assert.equal(review.outline.staleSources, true);
  assert.equal(review.outline.valid, false);
  assert.throws(() => f.run({ kind: 'accept', id: proposal.id, draftHash: review.draft.hash }), {
    status: 400,
  });
  assert.equal(f.run({ kind: 'read', path: base.path }).text, base.text);
  f.fs.writeFileSync(root + '/outline.json', '[{"chapter":1,"chapterPath":"../secrets.md"}]');
  assert.throws(() => f.run({ kind: 'outlineChapter', chapter: 1, expectedHash: base.hash }), {
    status: 409,
  });
});
test('future native adapter missing atomic capabilities fails closed', async () => {
  await assert.rejects(nativeWorkspace({}), /Unsupported/);
  const instance = { [Symbol('workspace')]: { ready: async () => {}, provider: () => ({}), db: {} } };
  await assert.rejects(nativeWorkspace(instance), /atomic/);
});

test('writing requests live in the original proposal metadata while planning is projected only from its checked version', () => {
  const f = fixture();
  const body = create(f, 'chapters/request.md', '# 候选依据\n仍在柜台前。');
  const outline = create(
    f,
    'outline.json',
    JSON.stringify([
      {
        chapter: 2,
        title: '账簿',
        summary: '从账簿查出相同票号。',
        note: '证据必须来自账簿。',
        chapterPath: body.path,
      },
    ]),
  );
  const writing = { version: 1, mode: 'continue', instruction: '不解释姐姐生死。\n只写柜台场景。' };
  const proposal = f.run({ kind: 'propose', path: body.path, expectedHash: body.hash, writing });
  assert.deepEqual(proposal.writing, writing);
  assert.equal(proposal.writingContext.outlineHash, outline.hash);
  assert.equal(proposal.writingContext.outline.note, '证据必须来自账簿。');
  const metadata = JSON.parse(
    new TextDecoder().decode(f.fs.readFileSync(root + '/drafts/' + proposal.id + '.proposal.json')),
  );
  assert.deepEqual(metadata.writing, writing);
  assert.equal(metadata.writingContext, undefined, 'No second planning snapshot/store is invented.');
  f.fs.writeFileSync(root + '/' + proposal.draft, '候选正文。');
  const review = f.run({ kind: 'review', id: proposal.id });
  assert.deepEqual(review.writingContext.outline, proposal.writingContext.outline);
  const changed = JSON.parse(outline.text);
  changed[0].summary = '另一个设备的新规划。';
  f.run({ kind: 'save', path: outline.path, text: JSON.stringify(changed), expectedHash: outline.hash });
  const stale = f.run({ kind: 'review', id: proposal.id });
  assert.match(stale.contextWarning, /章纲或正文关联已更新/);
  assert.equal(stale.writingContext.outline, undefined);
  assert.deepEqual(stale.proposal.writing, writing);
  assert.throws(() => f.run({ kind: 'accept', id: proposal.id, draftHash: stale.draft.hash }), {
    status: 409,
  });
  assert.equal(f.run({ kind: 'read', path: body.path }).text, body.text);
});

test('optional writing metadata rejects invalid tasks atomically, preserves legacy proposals and does not copy a large plan into the bounded receipt', () => {
  const f = fixture(),
    body = create(f, 'chapters/large-plan.md', '# 不强制填写规划\n正文。');
  const before = f.run({ kind: 'list' }).proposals.length;
  for (const writing of [
    { version: 1, mode: 'review', instruction: '' },
    { version: 1, mode: 'begin', instruction: null },
    null,
  ]) {
    assert.throws(() => f.run({ kind: 'propose', path: body.path, expectedHash: body.hash, writing }), {
      status: 400,
    });
  }
  assert.equal(f.run({ kind: 'list' }).proposals.length, before);
  const legacy = f.run({ kind: 'propose', path: body.path, expectedHash: body.hash });
  assert.equal(f.run({ kind: 'review', id: legacy.id }).writingContext, undefined);
  const summary = 'x'.repeat(600000);
  create(f, 'outline.json', JSON.stringify([{ chapter: 1, summary, chapterPath: body.path }]));
  const next = f.run({
    kind: 'propose',
    path: body.path,
    expectedHash: body.hash,
    writing: { version: 1, mode: 'continue', instruction: '继续' },
  });
  assert.equal(next.writingContext.outline.summary, summary);
  assert.ok(f.fs.statSync(root + '/drafts/' + next.id + '.proposal.json').size < 10000);
});
test('novel document gateway still requires native owner authentication, not only a configured PIN gate', async () => {
  let called = false;
  const result = await novelGateway(
    new Request('https://novel.example/api/novels/' + id + '/documents'),
    {
      DSH_EDGE_INSTANCE: {
        getByName() {
          called = true;
        },
      },
    },
    {},
    { fetch: async () => Response.json({ authenticated: false }) },
  );
  assert.equal(result.status, 401);
  assert.equal(called, false);
});
test('writing actions use native submission, preserve user drafts and recheck async draft races', () => {
  const book = { format: 'novel-harness-book-v1', id, root, title: 'fixture', stats: { chapters: 0 } };
  let state = { draft: writingPrompt(book) },
    submissions = 0;
  const binding = { ctx: {} };
  const input = {
    state: { getSnapshot: () => state },
    actions: {
      submit() {
        submissions++;
      },
    },
  };
  const ctx = {
    sessions: { binding: () => binding, list: { getSnapshot: () => ({ byId: { s: { cwd: root } } }) } },
    conversation: {
      input: {
        for: () => input,
        requestDraftInitialization(_binding, options) {
          state = { draft: options.prompt };
          return 'applied';
        },
      },
    },
  };
  nativeTask(ctx, 's', book)('写作任务');
  assert.equal(submissions, 1);
  state = { draft: '作者自己的草稿' };
  assert.throws(() => nativeTask(ctx, 's', book), /已保留/);
  state = { draft: '' };
  const pending = nativeTask(ctx, 's', book);
  state = { draft: '异步期间的新草稿' };
  assert.throws(() => pending('不应发送'), /变化/);
  assert.equal(submissions, 1);
});
test('line comparison handles equal, appended, removed and fully changed text without truncation', () => {
  assert.deepEqual(changedLines('一\n二', '一\n三'), {
    before: ['一', '二'],
    after: ['一', '三'],
    start: 1,
    beforeEnd: 2,
    afterEnd: 2,
  });
  assert.equal(changedLines('一', '一').beforeEnd, 1);
  const long = '正文'.repeat(50000);
  assert.equal(changedLines('原文', long).after.join('\n'), long);
});
