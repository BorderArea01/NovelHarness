import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapBook, listBooks } from '../worker/book-catalog.mjs';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';
import { makeDocumentClient } from '../pages/public/novel-assets/manuscript-core.mjs';
import { novelGateway } from '../worker/novel-gateway.mjs';

function fixture() {
  let rows = new Map(),
    failPath,
    corruptPath;
  const missing = () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const fs = {
    lstatSync(path) {
      const value = rows.get(path);
      if (!value) missing();
      return {
        size: value.bytes?.length ?? 0,
        nlink: 1,
        isSymbolicLink: () => value.type === 'link',
        isDirectory: () => value.type === 'dir',
        isFile: () => value.type === 'file',
      };
    },
    mkdirSync(path) {
      let current = '';
      for (const part of path.split('/').filter(Boolean)) {
        current += '/' + part;
        if (!rows.has(current)) rows.set(current, { type: 'dir' });
      }
    },
    readFileSync(path) {
      if (!rows.has(path)) missing();
      return rows.get(path).bytes;
    },
    writeFileSync(path, text) {
      if (path === failPath) throw new Error('storage interrupted');
      rows.set(path, {
        type: 'file',
        bytes: new TextEncoder().encode(path === corruptPath ? 'wrong bytes' : text),
      });
    },
    readdirSync(path) {
      return [...rows.keys()]
        .filter((p) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'))
        .map((p) => p.slice(path.length + 1));
    },
  };
  const db = {
    transactionSync(fn) {
      const before = structuredClone(rows);
      try {
        return fn();
      } catch (e) {
        rows = before;
        throw e;
      }
    },
  };
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET' });
    init.signal?.throwIfAborted();
    if (url === '/api/novels') return Response.json(listBooks(fs, db));
    const match = /^\/api\/novels\/(b-[a-f0-9]{32})\/bootstrap$/.exec(url);
    if (match) return Response.json(bootstrapBook(fs, db, match[1], JSON.parse(init.body)));
    const path = new URL(url, 'http://localhost').searchParams.get('path');
    if (init.method === 'PUT') {
      fs.mkdirSync(path.slice(0, path.lastIndexOf('/')));
      fs.writeFileSync(path, new TextDecoder().decode(init.body));
      return Response.json({ ok: true });
    }
    return rows.has(path) ? new Response(fs.readFileSync(path)) : new Response(null, { status: 404 });
  };
  return {
    fs,
    db,
    requests,
    client: makeWorkspaceClient(fetcher),
    fail: (path) => {
      failPath = path;
    },
    corrupt: (path) => {
      corruptPath = path;
    },
    link: (path) => rows.set(path, { type: 'link' }),
    has: (path) => rows.has(path),
  };
}
const bundle = (title = '延迟测试') =>
  makeBookBundle({
    creationId: title,
    state: { project: { title }, seed: '雨夜钟声。', outline: [], chapters: [] },
  });

test('new book uses ONE atomic request; retired guide files are not uploaded', async () => {
  const data = await bundle();
  assert.equal(data.files.length, 8);
  const old = fixture();
  await old.client.import(data);
  assert.equal(old.requests.length, 35);
  const fresh = fixture();
  const created = await fresh.client.create(data);
  assert.equal(fresh.requests.length, 1);
  assert.equal(created.book.id, data.manifest.id);
  for (const file of data.files)
    assert.equal(
      new TextDecoder().decode(fresh.fs.readFileSync(data.manifest.root + '/' + file.path)),
      file.content,
    );
  fresh.fs.writeFileSync(data.manifest.root + '/seed.md', '作者后续修改');
  assert.equal((await fresh.client.create(data)).alreadyImported, true);
  assert.equal(
    new TextDecoder().decode(fresh.fs.readFileSync(data.manifest.root + '/seed.md')),
    '作者后续修改',
  );
});

test('failed initialization rolls back ALL files and receipt, then explicit retry succeeds', async () => {
  const data = await bundle();
  for (const tail of ['rules.json', 'book.json']) {
    const f = fixture();
    f.fail(data.manifest.root + '/' + tail);
    assert.throws(() => bootstrapBook(f.fs, f.db, data.manifest.id, data), /interrupted/);
    assert.equal(f.has(data.manifest.root), false);
    assert.deepEqual(listBooks(f.fs, f.db), { books: [] });
    f.fail(null);
    assert.equal(bootstrapBook(f.fs, f.db, data.manifest.id, data).alreadyImported, false);
  }
  const f = fixture();
  f.corrupt(data.manifest.root + '/seed.md');
  assert.throws(() => bootstrapBook(f.fs, f.db, data.manifest.id, data), /校验不一致/);
  assert.equal(f.has(data.manifest.root), false);
});

test('bootstrap validates whole bundle before writes, refuses links, existing staging and other-book paths', async () => {
  const data = await bundle();
  for (const change of [
    (b) => {
      b.files.at(-1).content += 'tampered';
    },
    (b) => {
      b.files[0].path = '../outside';
    },
    (b) => {
      b.manifest.stats.chapters = 1;
    },
    (b) => {
      b.manifest.root = '/workspace/other';
    },
  ]) {
    const f = fixture(),
      bad = structuredClone(data);
    change(bad);
    assert.throws(() => bootstrapBook(f.fs, f.db, data.manifest.id, bad));
    assert.equal(f.has(data.manifest.root), false);
  }
  const f = fixture();
  f.fs.mkdirSync(data.manifest.root);
  assert.throws(() => bootstrapBook(f.fs, f.db, data.manifest.id, data), /未完成/);
  const l = fixture();
  l.fs.mkdirSync('/workspace');
  l.link('/workspace/novels');
  assert.throws(() => bootstrapBook(l.fs, l.db, data.manifest.id, data), /链接/);
  assert.throws(() => listBooks(l.fs, l.db), /链接/);
});

test('library reads ten completed books in ONE request; partial imports stay invisible, corruption stays an error', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await f.client.create(await bundle('小说' + i));
  f.fs.mkdirSync('/workspace/novels/b-' + 'f'.repeat(32));
  f.requests.length = 0;
  assert.equal((await f.client.list()).length, 10);
  assert.equal(f.requests.length, 1);
  const book = (await bundle()).manifest;
  f.fs.mkdirSync(book.root);
  f.fs.writeFileSync(book.root + '/book.json', '{broken');
  assert.throws(() => listBooks(f.fs, f.db), /损坏/);
});

test('independent document reads never reuse a held poll or data from before a write', async () => {
  const releases = [],
    calls = [];
  const api = makeDocumentClient('b-' + 'a'.repeat(32), async (url, init) => {
    calls.push(init.method);
    return new Promise((resolve) =>
      releases.push(() => resolve(Response.json({ text: String(calls.length) }))),
    );
  });
  const first = api('document', null, { path: 'seed.md' });
  const same = api('document', null, { path: 'seed.md' });
  assert.equal(calls.length, 2);
  releases.shift()();
  releases.shift()();
  assert.deepEqual(await first, await same);
  const next = api('document', null, { path: 'seed.md' });
  assert.equal(calls.length, 3);
  releases.shift()();
  await next;
  const beforeWrite = api('document', null, { path: 'seed.md' });
  const write = api('document', { path: 'seed.md', text: 'new', expectedHash: 'base' });
  const afterWrite = api('document', null, { path: 'seed.md' });
  assert.equal(calls.length, 6);
  for (const release of releases) release();
  await Promise.all([beforeWrite, write, afterWrite]);
});

test('batched book routes still require native authentication and reach ONLY the original owner', async () => {
  for (const authenticated of [false, true]) {
    const forwarded = [];
    const env = {
      DSH_EDGE_INSTANCE: {
        getByName(name) {
          assert.equal(name, 'owner');
          return {
            fetch(req) {
              forwarded.push(new URL(req.url).pathname);
              return Response.json({ ok: true });
            },
          };
        },
      },
    };
    const native = { fetch: () => Response.json({ authenticated }) };
    const id = 'b-' + 'a'.repeat(32);
    for (const [path, method, target] of [
      ['/api/novels', 'GET', '/__novel_catalog'],
      ['/api/novels/' + id + '/bootstrap', 'POST', '/__novel_editor/' + id + '/bootstrap'],
    ]) {
      const response = await novelGateway(
        new Request('https://novel.example' + path, { method }),
        env,
        {},
        native,
      );
      assert.equal(response.status, authenticated ? 200 : 401);
      if (authenticated) assert.equal(forwarded.at(-1), target);
    }
    assert.equal(forwarded.length, authenticated ? 2 : 0);
    assert.equal(
      (
        await novelGateway(
          new Request('https://novel.example/api/novels', { method: 'POST' }),
          env,
          {},
          native,
        )
      ).status,
      authenticated ? 405 : 401,
    );
  }
});
