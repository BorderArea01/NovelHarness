import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectReadingEdition,
  renderReadingEdition,
  readingCatalog,
} from '../pages/public/novel-assets/reading-edition.mjs';
import { chapterFocus, reviewPrompt } from '../pages/public/novel-assets/chapter-focus.mjs';
const id = 'b-' + 'a'.repeat(32),
  root = '/workspace/novels/' + id;
const encode = (text) => new TextEncoder().encode(text);
function fixture() {
  const files = new Map([
    [root + '/chapters/2.md', encode('\uFEFF# 原标题\r\n\r\n正文<script>不是代码</script>。【PP1】\r\n')],
    [root + '/chapters/10.md.part-0001', encode('# 长章\n\n第一段。')],
    [root + '/chapters/10.md.part-0002', encode('后半段🌧️。\n')],
    [root + '/chapters/empty.md', encode('# 空章\n\n')],
  ]);
  let listing = {
    book: { id, title: '测试书 <img src=x onerror=alert(1)>' },
    documents: [
      {
        category: 'chapter',
        path: 'chapters/10.md',
        title: '后果',
        chapter: 1,
        parts: ['chapters/10.md.part-0001', 'chapters/10.md.part-0002'],
      },
      { category: 'chapter', path: 'chapters/2.md', title: '第2章 已有章号', chapter: 2 },
      { category: 'chapter', path: 'chapters/empty.md', title: '空章', chapter: 3 },
      { category: 'draft', path: 'drafts/unaccepted.md' },
      { category: 'reference', path: 'rules.json' },
    ],
  };
  const reads = [];
  return {
    files,
    reads,
    get listing() {
      return listing;
    },
    set listing(v) {
      listing = v;
    },
    api: async (route) => {
      assert.equal(route, 'documents');
      return structuredClone(listing);
    },
    readFile: async (path) => {
      reads.push(path);
      return files.get(path) ?? null;
    },
  };
}
test('reading edition follows current native chapter order, assembles all parts, skips header-only chapters and never exports candidates or settings', async () => {
  const f = fixture(),
    before = structuredClone(f.files),
    progress = [];
  const edition = await collectReadingEdition(f.api, f.readFile, { onProgress: (p) => progress.push(p) });
  assert.equal(edition.chapters.length, 2);
  assert.equal(edition.skipped, 1);
  assert.equal(edition.chapters[0].path, 'chapters/10.md');
  assert.equal(edition.chapters[0].body, '\n第一段。后半段🌧️。\n');
  assert.ok(edition.chapters[1].body.includes('【PP1】'), 'Literal author text is not silently stripped.');
  assert.equal(f.reads.length, 8);
  assert.ok(f.reads.every((path) => path.startsWith(root + '/chapters/')));
  assert.deepEqual(f.files, before);
  assert.equal(edition.consistency, 'double-read-not-atomic');
  assert.equal(progress.filter((p) => p.phase === 'verify').length, 4);
  const txt = renderReadingEdition(edition, 'txt'),
    md = renderReadingEdition(edition, 'markdown'),
    html = renderReadingEdition(edition, 'html');
  assert.ok(txt.text.indexOf('第1章 后果') < txt.text.indexOf('第2章 已有章号'));
  assert.ok(!txt.text.includes('第2章 第2章'));
  assert.ok(!txt.text.includes('原标题'));
  assert.match(md.text, /^# 测试书/);
  assert.ok(md.text.includes('## 第1章 后果'));
  assert.ok(html.text.includes('href="#chapter-1"'));
  assert.ok(html.text.includes('&lt;script&gt;不是代码&lt;/script&gt;'));
  assert.ok(!html.text.includes('<script>'));
  assert.ok(!html.text.includes('<img src=x'));
  assert.ok(html.text.includes("default-src 'none'"));
  assert.ok(!html.filename.includes('<'));
  assert.throws(() => renderReadingEdition(edition, 'pdf'));
});
test('reading export refuses changed body, missing tail, unsafe paths and ambiguous order instead of downloading mixed or incomplete content', async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    collectReadingEdition(f.api, async (path) => {
      const bytes = await f.readFile(path);
      if (++calls === 5) return encode('另一设备修改。');
      return bytes;
    }),
    /正文有变化/,
  );
  const missing = fixture();
  missing.files.delete(root + '/chapters/10.md.part-0002');
  await assert.rejects(collectReadingEdition(missing.api, missing.readFile), /消失或不可读取/);
  for (const change of [
    { navigationWarning: '重复关联' },
    { documents: [{ category: 'chapter', path: '../outside.md' }] },
    { documents: [{ category: 'chapter', path: 'chapters/1.md', parts: ['chapters/1.md.part-0002'] }] },
  ])
    assert.throws(() => readingCatalog({ ...f.listing, ...change }));
  const reordered = fixture();
  let listings = 0;
  await assert.rejects(
    collectReadingEdition(async () => {
      const l = structuredClone(reordered.listing);
      if (++listings > 1) l.documents.reverse();
      return l;
    }, reordered.readFile),
    /章序、标题/,
  );
});
test('cancelled and non-UTF8 reading exports fail without generating a file', async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(collectReadingEdition(f.api, f.readFile, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(f.reads.length, 0);
  const invalid = fixture();
  invalid.files.set(root + '/chapters/2.md', new Uint8Array([255]));
  await assert.rejects(collectReadingEdition(invalid.api, invalid.readFile), /UTF-8/);
});
test('literal leading hashtags and non-title Markdown are preserved rather than mistaken for chapter headers', async () => {
  for (const body of ['#一行字面文本\n正文。', '## 二级标题\n正文。']) {
    const f = fixture();
    f.files.set(root + '/chapters/2.md', encode(body));
    const result = await collectReadingEdition(f.api, f.readFile);
    assert.equal(result.chapters.find((ch) => ch.path === 'chapters/2.md').body, body);
  }
});
test('readable export is not capped by the 2 MiB editor: native fragments remain complete and UTF-8 boundaries survive', async () => {
  const text = '# 超长章\n\n' + '文🌧️'.repeat(330000) + '尾部必须保留。';
  const bytes = encode(text),
    size = 700001,
    files = new Map(),
    parts = [];
  for (let start = 0; start < bytes.length; start += size) {
    const path = 'chapters/large.md.part-' + String(parts.length + 1).padStart(4, '0');
    parts.push(path);
    files.set(root + '/' + path, bytes.slice(start, start + size));
  }
  assert.ok(bytes.length > 2 * 1024 * 1024);
  const listing = {
    book: { id, title: '长章阅读版' },
    documents: [{ category: 'chapter', path: 'chapters/large.md', title: '超长章', parts }],
  };
  const edition = await collectReadingEdition(
    async () => listing,
    async (path) => files.get(path),
  );
  assert.equal(edition.chapters[0].body, text.slice(text.indexOf('\n') + 1));
  assert.ok(renderReadingEdition(edition, 'txt').text.includes('尾部必须保留。'));
});
test('chapter targets remain author planning, not a keyword detector or auto-progress writer; audit asks for actual evidence and limitations', () => {
  const doc = {
    path: 'chapters/2.md',
    hash: 'a'.repeat(64),
    outlineHash: 'b'.repeat(64),
    outline: {
      chapter: 2,
      summary: '取到账簿并承担代价。',
      plotPoints: [{ id: 'p1', desc: '取回账簿', done: true, custom: '保留' }, '失去资格'],
      note: '不要提前解谜',
    },
  };
  const before = structuredClone(doc),
    value = chapterFocus(doc);
  assert.equal(value.points[0].authorMarked, true);
  assert.equal(value.points[1].text, '失去资格');
  assert.deepEqual(doc, before);
  assert.equal(chapterFocus({}), null);
  const book = { id, root };
  for (const focus of ['coverage', 'continuity', 'general']) {
    const prompt = reviewPrompt(
      book,
      doc,
      [{ path: 'memory.json' }, { path: 'outline.json' }, { path: 'rules.json' }],
      { focus, instruction: '保留我未发送的原始要求' },
    );
    const data = JSON.parse(prompt);
    assert.equal(data.request, '保留我未发送的原始要求');
    assert.equal(data.focus, focus);
    assert.deepEqual(data.chapterOutline, doc.outline);
    assert(data.materials.some((m) => m.path.endsWith('/memory.json')));
    assert(!Object.hasOwn(data, 'executionPrompt'));
  }
  assert.throws(() => reviewPrompt(book, { path: doc.path }, [], { focus: 'coverage' }), /未关联/);
  assert.throws(() => reviewPrompt(book, doc, [], { focus: 'unknown' }));
});
