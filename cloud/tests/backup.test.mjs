import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBookBundle } from '../pages/public/novel-assets/bundle.mjs';
import { restoreBackup, TRANSFER_FILE_LIMIT } from '../pages/public/novel-assets/backup.mjs';
import { makeWorkspaceClient } from '../pages/public/novel-assets/workspace.mjs';

const encoder = new TextEncoder();
async function fixture() {
  const bundle = await makeBookBundle(null, { seed: '飞升钟声里传来求救' }),
    root = bundle.manifest.root;
  const files = new Map(
    bundle.files.map(({ path, content }) => [root + '/' + path, encoder.encode(content)]),
  );
  files.set(root + '/book.json', encoder.encode(JSON.stringify(bundle.manifest)));
  const authored = '\ufeff作者新写的正文\r\n雨越下越急。🌧️';
  files.set(root + '/chapters/新章 (二).md', encoder.encode(authored));
  const calls = [],
    reads = new Map();
  let mutate, scanOverride, identityOverride;
  const fetcher = async (url, init = {}) => {
    init.signal?.throwIfAborted();
    calls.push({ url, method: init.method ?? 'GET' });
    if (url === '/api/novels/' + bundle.manifest.id + '/identity') {
      const value = {
        version: 1,
        id: bundle.manifest.id,
        root,
        title: bundle.manifest.title,
        titleSource: 'workspace',
      };
      const override = identityOverride?.(value);
      return override instanceof Response ? override : Response.json(override ?? value);
    }
    if (url === '/api/workspace/exec') {
      const command = JSON.parse(init.body).command;
      assert.match(command, new RegExp(`^find ${root} (?:-type f|! -type f ! -type d) -print0$`));
      const type = command.includes('! -type') ? 'l' : 'f';
      const fallback = {
        exitCode: 0,
        stdout:
          type === 'l' ? '' : [...files.keys()].filter((p) => p.startsWith(root + '/')).join('\0') + '\0',
      };
      return Response.json(scanOverride?.(type, fallback) ?? fallback);
    }
    const path = new URL(url, 'https://novel.example').searchParams.get('path');
    if (init.method === 'PUT') {
      // Pinned native API accepts UTF-8 and consumes one leading BOM.
      files.set(path, encoder.encode(new TextDecoder('utf-8', { fatal: true }).decode(init.body)));
      return Response.json({ ok: true });
    }
    reads.set(path, (reads.get(path) ?? 0) + 1);
    const override = mutate?.(path, reads.get(path));
    if (override instanceof Response) return override;
    return files.has(path) ? new Response(files.get(path)) : new Response('', { status: 404 });
  };
  return {
    bundle,
    root,
    authored,
    files,
    calls,
    client: makeWorkspaceClient(fetcher),
    setMutation(fn) {
      mutate = fn;
    },
    setScan(fn) {
      scanOverride = fn;
    },
    setIdentity(fn) {
      identityOverride = fn;
    },
  };
}

test('current-directory backup includes newly authored files; restore preserves UTF-8/BOM bytes in a separate book', async () => {
  const f = await fixture(),
    original = new Map(f.files),
    progress = [];
  const backup = await f.client.backup(f.bundle.manifest.id, { onProgress: (p) => progress.push(p.phase) });
  assert.equal(
    f.calls.some((call) => call.method === 'PUT'),
    false,
  );
  assert.ok(backup.files.some((file) => file.path === 'chapters/新章 (二).md'));
  assert.ok(progress.includes('read') && progress.includes('verify'));
  const restored = await restoreBackup(backup);
  assert.notEqual(restored.manifest.id, f.bundle.manifest.id);
  assert.match(restored.manifest.title, /恢复副本/);
  const result = await f.client.import(restored);
  assert.equal(result.alreadyImported, false);
  for (const [path, bytes] of original) assert.deepEqual(f.files.get(path), bytes);
  for (const file of restored.files)
    assert.deepEqual(f.files.get(restored.manifest.root + '/' + file.path), file.content);
  assert.equal(
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      f.files.get(restored.manifest.root + '/chapters/新章 (二).md'),
    ),
    f.authored,
  );
  const path = restored.manifest.root + '/chapters/新章 (二).md';
  f.files.set(path, encoder.encode('副本后来的新改动'));
  const again = await restoreBackup({ ...backup, createdAt: 'a different export time' });
  assert.equal(again.manifest.id, restored.manifest.id);
  assert.equal((await f.client.import(again)).alreadyImported, true);
  assert.equal(new TextDecoder().decode(f.files.get(path)), '副本后来的新改动');
});

test('backup and restoration use the native live title while all original receipt/body bytes stay unchanged', async () => {
  const f = await fixture(),
    before = f.files.get(f.root + '/book.json');
  f.setIdentity((value) => ({ ...value, title: '改名后的作品 🌧️' }));
  const backup = await f.client.backup(f.bundle.manifest.id);
  assert.equal(backup.title, '改名后的作品 🌧️');
  const restored = await restoreBackup(backup);
  assert.equal(restored.manifest.title, '改名后的作品 🌧️（恢复副本）');
  assert.deepEqual(f.files.get(f.root + '/book.json'), before);
  assert.equal(new TextDecoder().decode(before).includes('改名后的作品'), false);
  assert.equal(
    f.calls.some((call) => call.method === 'PUT'),
    false,
  );
  const again = await restoreBackup({ ...backup, title: '后来的另一个名称' });
  assert.equal(
    again.manifest.id,
    restored.manifest.id,
    'Restoration idempotence is based on original file bytes, not mutable presentation names.',
  );
  const legacy = await restoreBackup({ ...backup, title: undefined });
  assert.equal(legacy.manifest.title, f.bundle.manifest.title + '（恢复副本）');
});

test('cancelling the final identity verification cannot return an otherwise complete backup for download', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let reads = 0;
  f.setIdentity((value) => {
    if (++reads === 2) controller.abort();
    return value;
  });
  await assert.rejects(f.client.backup(f.bundle.manifest.id, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(
    f.calls.some((call) => call.method === 'PUT'),
    false,
  );
});

test('backup rejects wrong identity, unavailable title owner and rename during transfer without writing data', async () => {
  for (const mode of ['wrong-book', 'unavailable', 'renamed']) {
    const f = await fixture();
    let reads = 0;
    f.setIdentity((value) => {
      if (mode === 'unavailable') return new Response('', { status: 503 });
      if (mode === 'wrong-book') return { ...value, id: 'b-' + '0'.repeat(32) };
      return { ...value, title: ++reads === 1 ? '初始名称' : '另一设备改名' };
    });
    await assert.rejects(f.client.backup(f.bundle.manifest.id), /身份|书名/);
    assert.equal(
      f.calls.some((call) => call.method === 'PUT'),
      false,
    );
    if (mode !== 'renamed')
      assert.equal(
        f.calls.some((call) => call.url === '/api/workspace/exec'),
        false,
      );
  }
});

test('backup detects text changes and file-list changes; never writes or publishes a partial snapshot', async () => {
  for (const kind of ['content', 'listing']) {
    const f = await fixture(),
      target = f.root + '/chapters/新章 (二).md';
    if (kind === 'content')
      f.setMutation((path, count) => {
        if (path === target && count === 2) f.files.set(path, encoder.encode('另一设备的新稿'));
      });
    else {
      let scans = 0;
      f.setScan((type, result) =>
        type === 'f' && ++scans === 2 ? { ...result, stdout: result.stdout + f.root + '/new.md\0' } : result,
      );
    }
    await assert.rejects(f.client.backup(f.bundle.manifest.id), /发生变化/);
    assert.equal(
      f.calls.some((call) => call.method === 'PUT'),
      false,
    );
  }
});

test('unsafe IDs, out-of-book scans, symlinks and truncated listings fail closed', async () => {
  const f = await fixture();
  await assert.rejects(f.client.backup('../private'), /标识无效/);
  assert.equal(f.calls.length, 0);
  for (const mode of ['outside', 'link', 'truncated', 'unterminated']) {
    const f = await fixture();
    f.setScan((type, result) => {
      if (mode === 'outside' && type === 'f') return { ...result, stdout: '/workspace/other/book.json\0' };
      if (mode === 'link' && type === 'l') return { ...result, stdout: f.root + '/link\0' };
      if (mode === 'truncated') return { ...result, outputTruncated: true };
      if (mode === 'unterminated' && type === 'f') return { ...result, stdout: f.root + '/book.json' };
      return result;
    });
    await assert.rejects(f.client.backup(f.bundle.manifest.id));
    assert.equal(f.calls.filter((call) => call.url.includes('/file?')).length, 0);
  }
});

test('cancelled backup and unreadable or oversized file are not reported as complete', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await assert.rejects(
    f.client.backup(f.bundle.manifest.id, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { name: 'AbortError' },
  );
  assert.equal(
    f.calls.some((call) => call.method === 'PUT'),
    false,
  );
  const unreadable = await fixture();
  unreadable.setMutation(() => new Response('unavailable', { status: 503 }));
  await assert.rejects(unreadable.client.backup(unreadable.bundle.manifest.id), /HTTP 503/);
  const big = await fixture();
  big.files.set(big.root + '/too-large.md', new Uint8Array(TRANSFER_FILE_LIMIT + 1));
  await assert.rejects(big.client.backup(big.bundle.manifest.id), /超过 1 MiB/);
});

test('tampered backup, traversal, duplicate paths, collisions and oversized metadata fail before restore writes', async () => {
  const f = await fixture(),
    backup = await f.client.backup(f.bundle.manifest.id);
  for (const mutate of [
    (b) => {
      b.files[0].sha256 = '0'.repeat(64);
    },
    (b) => {
      b.files[0].path = '../private';
    },
    (b) => {
      b.files.push({ ...b.files[0] });
    },
    (b) => {
      b.files.push({ ...b.files[0], path: b.files[0].path + '/nested' });
    },
    (b) => {
      b.files[0].bytes = TRANSFER_FILE_LIMIT + 1;
    },
    (b) => {
      b.sourceId = 'b-' + '0'.repeat(32);
    },
  ]) {
    const input = structuredClone(backup);
    mutate(input);
    await assert.rejects(restoreBackup(input));
  }
  assert.equal(
    f.calls.some((call) => call.method === 'PUT'),
    false,
  );
});

test('binary bytes remain in downloaded backup; unsupported automatic restore refuses the full package before upload', async () => {
  const f = await fixture(),
    bytes = new Uint8Array([137, 80, 78, 71, 255, 0]);
  f.files.set(f.root + '/image.png', bytes);
  const backup = await f.client.backup(f.bundle.manifest.id);
  const image = backup.files.find((file) => file.path === 'image.png');
  assert.deepEqual(
    Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)),
    bytes,
  );
  await assert.rejects(restoreBackup(backup), /非 UTF-8/);
  assert.equal(
    f.calls.some((call) => call.method === 'PUT'),
    false,
  );
});
