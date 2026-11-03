import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapBook, listBooks } from '../worker/book-catalog.mjs';
import { manageBook, listTrashedBooks } from '../worker/book-lifecycle.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { novelGateway } from '../worker/novel-gateway.mjs';

function fixture() {
  let rows = new Map(),
    failRename = false;
  const fs = {
    lstatSync(path) {
      if (!rows.has(path)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      const v = rows.get(path);
      return {
        size: v.data?.length ?? 0,
        nlink: v.links ?? 1,
        isDirectory: () => v.type === 'dir',
        isFile: () => v.type === 'file',
        isSymbolicLink: () => v.type === 'link',
      };
    },
    mkdirSync(path) {
      let p = '';
      for (const part of path.split('/').filter(Boolean)) {
        p += '/' + part;
        if (!rows.has(p)) rows.set(p, { type: 'dir' });
      }
    },
    readFileSync(path) {
      this.lstatSync(path);
      return rows.get(path).data;
    },
    writeFileSync(path, text) {
      rows.set(path, { type: 'file', data: Buffer.from(text) });
    },
    readdirSync(path) {
      this.lstatSync(path);
      return [...rows.keys()]
        .filter((p) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'))
        .map((p) => p.slice(path.length + 1));
    },
    renameSync(from, to) {
      if (failRename) throw Error('storage interruption');
      const selected = [...rows].filter(([p]) => p === from || p.startsWith(from + '/'));
      for (const [p] of selected) rows.delete(p);
      for (const [p, value] of selected) rows.set(to + p.slice(from.length), value);
    },
  };
  const db = {
    transactionSync(fn) {
      const previous = structuredClone(rows);
      try {
        return fn();
      } catch (e) {
        rows = previous;
        throw e;
      }
    },
  };
  return {
    fs,
    db,
    rows: () => structuredClone(rows),
    fail: () => {
      failRename = true;
    },
    link: (path) => rows.set(path, { type: 'link' }),
  };
}
const bundle = (name) =>
  makeBookBundle({
    creationId: name,
    state: { project: { title: name }, outline: [], chapters: [], seed: '' },
  });
function preview(f, id, trashed = false) {
  return manageBook(f.fs, f.db, id, { action: 'inspect', trashed });
}

test('whole-book delete and restore preserve every byte including drafts, memory, history and binary files, not other books', async () => {
  const f = fixture(),
    a = await bundle('A'),
    b = await bundle('B');
  bootstrapBook(f.fs, f.db, a.manifest.id, a);
  bootstrapBook(f.fs, f.db, b.manifest.id, b);
  for (const p of [
    'chapters/1.md',
    'drafts/old.md',
    'notes/story-plan.md',
    '.novel-history/original.md',
    'attachments/blob.bin',
  ]) {
    const abs = a.manifest.root + '/' + p;
    f.fs.mkdirSync(abs.slice(0, abs.lastIndexOf('/')));
    f.fs.writeFileSync(abs, Buffer.from([0, 255, 13, 10, 65]));
  }
  const before = f.rows(),
    p = preview(f, a.manifest.id);
  assert.equal(p.counts.chapters, 1);
  assert.equal(p.counts.histories, 1);
  manageBook(f.fs, f.db, a.manifest.id, { action: 'delete', expectedRevision: p.revision });
  assert.deepEqual(
    listBooks(f.fs, f.db).books.map((x) => x.id),
    [b.manifest.id],
  );
  assert.equal(listTrashedBooks(f.fs, f.db).books[0].id, a.manifest.id);
  const trashed = preview(f, a.manifest.id, true);
  assert.equal(trashed.revision, p.revision);
  manageBook(f.fs, f.db, a.manifest.id, { action: 'restore', expectedRevision: trashed.revision });
  for (const [path, row] of before) assert.deepEqual(f.rows().get(path), row);
});

test('restart is one atomic old-book move plus empty independent identity; failed move rolls back the new book', async () => {
  const f = fixture(),
    a = await bundle('旧书'),
    b = await bundle('新书');
  bootstrapBook(f.fs, f.db, a.manifest.id, a);
  f.fs.writeFileSync(a.manifest.root + '/memory.json', '{"oldStory":"OLD_STORY_SENTINEL"}');
  const p = preview(f, a.manifest.id),
    before = f.rows();
  f.fail();
  assert.throws(
    () =>
      manageBook(f.fs, f.db, a.manifest.id, { action: 'restart', expectedRevision: p.revision, bundle: b }),
    /interruption/,
  );
  assert.deepEqual(f.rows(), before);
  const g = fixture();
  bootstrapBook(g.fs, g.db, a.manifest.id, a);
  g.fs.writeFileSync(a.manifest.root + '/memory.json', '{"oldStory":"OLD_STORY_SENTINEL"}');
  const output = manageBook(g.fs, g.db, a.manifest.id, {
    action: 'restart',
    expectedRevision: preview(g, a.manifest.id).revision,
    bundle: b,
  });
  assert.equal(output.restarted, true);
  assert.notEqual(output.book.root, a.manifest.root);
  for (const [path, row] of g.rows())
    if (path.startsWith(output.book.root + '/') && row.data)
      assert(!Buffer.from(row.data).toString().includes('OLD_STORY_SENTINEL'));
  assert.equal(preview(g, a.manifest.id, true).files, p.files);
});

test('busy, stale version, links, forged IDs and restore collisions never mutate any book', async () => {
  const f = fixture(),
    a = await bundle('A');
  bootstrapBook(f.fs, f.db, a.manifest.id, a);
  const p = preview(f, a.manifest.id),
    original = f.rows();
  assert.throws(
    () =>
      manageBook(
        f.fs,
        f.db,
        a.manifest.id,
        { action: 'delete', expectedRevision: p.revision },
        { isGenerating: () => true },
      ),
    /正在生成/,
  );
  assert.deepEqual(f.rows(), original);
  f.fs.writeFileSync(a.manifest.root + '/memory.json', 'changed');
  const changed = f.rows();
  assert.throws(
    () => manageBook(f.fs, f.db, a.manifest.id, { action: 'delete', expectedRevision: p.revision }),
    /已更新/,
  );
  assert.deepEqual(f.rows(), changed);
  const next = preview(f, a.manifest.id);
  assert.throws(
    () =>
      manageBook(f.fs, f.db, a.manifest.id, {
        action: 'restart',
        expectedRevision: next.revision,
        bundle: { manifest: { id: '../other' } },
      }),
    /独立新书标识/,
  );
  f.link(a.manifest.root + '/linked');
  assert.throws(() => preview(f, a.manifest.id), /链接/);
  const g = fixture();
  bootstrapBook(g.fs, g.db, a.manifest.id, a);
  manageBook(g.fs, g.db, a.manifest.id, {
    action: 'delete',
    expectedRevision: preview(g, a.manifest.id).revision,
  });
  g.fs.mkdirSync(a.manifest.root);
  g.fs.writeFileSync(a.manifest.root + '/new.md', 'new writer');
  const collision = g.rows();
  assert.throws(
    () =>
      manageBook(g.fs, g.db, a.manifest.id, {
        action: 'restore',
        expectedRevision: preview(g, a.manifest.id, true).revision,
      }),
    /已有内容/,
  );
  assert.deepEqual(g.rows(), collision);
});

test('lifecycle uses existing owner auth and explicit POST; recycle catalog query reaches the same owner', async () => {
  for (const authenticated of [false, true]) {
    const forwarded = [];
    const env = {
      DSH_EDGE_INSTANCE: {
        getByName: () => ({
          fetch: (r) => {
            forwarded.push(r.url);
            return Response.json({ ok: true });
          },
        }),
      },
    };
    const native = { fetch: () => Response.json({ authenticated }) };
    const id = 'b-' + 'a'.repeat(32);
    const r = await novelGateway(
      new Request('https://test/api/novels/' + id + '/lifecycle', {
        method: 'POST',
        body: '{"action":"inspect"}',
      }),
      env,
      {},
      native,
    );
    assert.equal(r.status, authenticated ? 200 : 401);
    const list = await novelGateway(new Request('https://test/api/novels?trash=1'), env, {}, native);
    assert.equal(list.status, authenticated ? 200 : 401);
    if (authenticated) assert(forwarded.at(-1).endsWith('/__novel_catalog?trash=1'));
    const get = await novelGateway(
      new Request('https://test/api/novels/' + id + '/lifecycle'),
      env,
      {},
      native,
    );
    assert.equal(get.status, authenticated ? 405 : 401);
  }
});
