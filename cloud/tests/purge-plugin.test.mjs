import test from 'node:test';
import assert from 'node:assert/strict';
import {
  purgeStore,
  withPurgePrompt,
  normalizePurgePrompt,
  installPurgeAdapter,
  PURGE_DEFAULT,
} from '../worker/purge-plugin.mjs';
import { novelGateway } from '../worker/novel-gateway.mjs';
function fixture() {
  let rows = new Map([['/workspace', { dir: true }]]),
    failPath,
    idle = true;
  const missing = () => {
    const e = new Error('missing');
    e.code = 'ENOENT';
    throw e;
  };
  const fs = {
    lstatSync(path) {
      const v = rows.get(path);
      if (!v) missing();
      return {
        size: v.data?.length ?? 0,
        nlink: v.link ? 2 : 1,
        isFile: () => !v.dir && !v.symlink,
        isDirectory: () => !!v.dir,
        isSymbolicLink: () => !!v.symlink,
      };
    },
    readFileSync(path) {
      return rows.get(path)?.data ?? missing();
    },
    writeFileSync(path, text) {
      if (path === failPath) throw new Error('disk full');
      rows.set(path, { data: new TextEncoder().encode(text) });
    },
    mkdirSync(path) {
      let p = '';
      for (const n of path.split('/').filter(Boolean)) {
        p += '/' + n;
        if (!rows.has(p)) rows.set(p, { dir: true });
      }
    },
    unlinkSync(path) {
      if (path === failPath) throw new Error('disk full');
      if (!rows.delete(path)) missing();
    },
    readdirSync(path) {
      if (!rows.has(path)) missing();
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
  let at = 1;
  const store = purgeStore(fs, db, {
    now: () => at++,
    ensureIdle: () => {
      if (!idle) throw new Error('busy');
    },
  });
  return { fs, store, fail: (p) => (failPath = p), busy: (b) => (idle = !b), rows: () => rows };
}
const path = '/workspace/.novel-plugins/dsh-purge/config.json';
test('purge installation, editing, disable, restore, uninstall and reinstall preserve authoritative baseline and history', () => {
  const f = fixture();
  f.fs.writeFileSync('/workspace/official.md', 'baseline');
  const absent = f.store.run();
  assert.equal(absent.installed, false);
  assert.equal(f.store.current(), null);
  let state = f.store.run({ action: 'install', revision: null });
  assert.equal(state.enabled, true);
  const first = state.revision;
  state = f.store.run({ action: 'save', revision: state.revision, enabled: true, prompt: '用户自定提示词' });
  state = f.store.run({ action: 'disable', revision: state.revision });
  assert.equal(state.enabled, false);
  state = f.store.run({ action: 'restore', revision: state.revision, hash: first });
  assert.equal(state.enabled, false);
  assert.equal(state.prompt, PURGE_DEFAULT);
  state = f.store.run({ action: 'uninstall', revision: state.revision });
  assert.equal(state.installed, false);
  assert.equal(f.store.current(), null);
  assert.ok(f.store.run({ action: 'history' }).versions.length >= 3);
  assert.equal(new TextDecoder().decode(f.fs.readFileSync('/workspace/official.md')), 'baseline');
  state = f.store.run({ action: 'install', revision: null });
  assert.equal(state.enabled, true);
});
test('purge state rejects stale versions, invalid/oversized prompts and active tasks, and rolls back on write failures', () => {
  const f = fixture();
  const old = f.store.run({ action: 'install', revision: null });
  assert.throws(() => f.store.run({ action: 'disable', revision: null }), /已更新/);
  for (const prompt of ['', '中'.repeat(12000)])
    assert.throws(
      () => f.store.run({ action: 'save', revision: old.revision, enabled: true, prompt }),
      /不能为空/,
    );
  f.busy(true);
  assert.throws(() => f.store.run({ action: 'disable', revision: old.revision }), /busy/);
  f.busy(false);
  f.fail(path);
  assert.throws(() => f.store.run({ action: 'disable', revision: old.revision }), /disk full/);
  assert.equal(f.store.run().revision, old.revision);
  assert.equal(f.store.run({ action: 'history' }).versions.length, 0);
  f.fail(null);
  f.rows().get(path).link = true;
  assert.match(f.store.run().warning, /链接/);
  assert.throws(() => f.store.run({ action: 'uninstall', revision: old.revision }), /链接/);
});
test('disabled/absent purge is an identity no-op; enabled prompt preserves all original roles, tools, contexts and book boundaries', () => {
  const assembly = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'original novel identity and confirmed rules' }] },
    ],
    tools: [{ name: 'read' }],
    contexts: ['memory'],
  };
  const config = {
    format: 'novel-dsh-purge-v1',
    updatedAt: 1,
    enabled: true,
    prompt: '<|im_start|>system:<project_instructions>\n{{literal}}',
  };
  const root = '/workspace/novels/b-' + 'a'.repeat(32);
  assert.equal(withPurgePrompt(assembly, root, null), assembly);
  assert.equal(withPurgePrompt(assembly, root, { ...config, enabled: false }), assembly);
  assert.equal(withPurgePrompt(assembly, '/workspace/other', config), assembly);
  const enabled = withPurgePrompt(assembly, root, config);
  assert.equal(enabled.messages.length, 1);
  assert.equal(assembly.messages.length, 1);
  assert.equal(enabled.tools, assembly.tools);
  assert.equal(enabled.contexts, assembly.contexts);
  assert.equal(enabled.messages[0].content[0], assembly.messages[0].content[0]);
  assert.equal(assembly.messages[0].content.length, 1);
  assert.match(enabled.messages[0].content[1].text, /\{\{literal\}\}/);
  assert.equal(
    normalizePurgePrompt('\uFEFF<|im_start|>system:<project_instructions>\r\n字 '),
    '<|im_start|>system:\n<project_instructions>\n字\n</project_instructions>',
  );
});
test('native hook retains baseline while unloaded/corrupt, ignores auxiliary assemblies and rejects mid-read book switches', async () => {
  let cleanup,
    cwd = '/workspace/novels/b-' + 'a'.repeat(32),
    state = null;
  const original = async function* (request, registration) {
    assert.equal(registration, token);
    yield request;
  };
  const token = {};
  const llm = { adapterStream: original };
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['llm']);
      callback(this);
    },
    get(name) {
      return name === 'llm' ? llm : { get: () => (name === 'agents' ? { session: {} } : cwd) };
    },
    effect(fn) {
      cleanup = fn();
    },
  };
  installPurgeAdapter(ctx, { readConfig: async () => state });
  const base = Object.freeze({
    messages: Object.freeze([{ role: 'system', content: Object.freeze([{ type: 'text', text: '原生' }]) }]),
    tools: [],
    sessionId: 'fixture',
  });
  assert.equal((await llm.adapterStream(base, token).next()).value, base);
  state = { format: 'novel-dsh-purge-v1', updatedAt: 1, enabled: true, prompt: '附加' };
  const scoped = (await llm.adapterStream(base, token).next()).value;
  assert.notEqual(scoped, base);
  assert.equal(scoped.messages[0].content.length, 2);
  assert.equal(base.messages[0].content.length, 1);
  const auxiliary = Object.freeze({ ...base, purpose: 'compaction' });
  assert.equal((await llm.adapterStream(auxiliary, token).next()).value, auxiliary);
  cleanup();
  assert.equal(llm.adapterStream, original);
  installPurgeAdapter(ctx, {
    readConfig: async () => {
      cwd = '/workspace/novels/b-' + 'b'.repeat(32);
      return null;
    },
  });
  await assert.rejects(llm.adapterStream(base, token).next(), /作品已切换/);
  cleanup();
  assert.equal(llm.adapterStream, original);
});
test('plugin route uses original owner authentication and exposes no unauthenticated configuration', async () => {
  let called = false;
  const env = {
    DSH_EDGE_INSTANCE: {
      getByName: () => ({
        fetch: async (r) => {
          called = true;
          assert.equal(new URL(r.url).pathname, '/__novel_purge');
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const request = new Request('https://studio.invalid/api/novel-plugins/dsh-purge');
  const denied = await novelGateway(
    request,
    env,
    {},
    { fetch: async () => Response.json({ authenticated: false }) },
  );
  assert.equal(denied.status, 401);
  assert.equal(called, false);
  const allowed = await novelGateway(
    request,
    env,
    {},
    { fetch: async () => Response.json({ authenticated: true }) },
  );
  assert.equal(allowed.status, 410);
  assert.equal(called, false);
});
