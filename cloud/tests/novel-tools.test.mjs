import test from 'node:test';
import assert from 'node:assert/strict';
import { installNovelTools } from '../worker/novel-tools.mjs';
const root = '/workspace/novels/b-' + 'a'.repeat(32);
test('native novel tools register in the original Agent scope, leave ordinary Agents alone and keep schema/output contract untouched', async () => {
  let created,
    cwd = '/workspace',
    calls = 0;
  const registered = [];
  const host = {
    on(name, callback) {
      assert.equal(name, 'agent/created');
      created = callback;
      return () => {};
    },
    get(name) {
      assert.equal(name, 'workingDirectory');
      return { get: () => cwd };
    },
  };
  const definition = {
    name: 'novel_test',
    description: 'fixture',
    parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => {
      calls++;
      return 'ok';
    },
  };
  const agent = {
    session: { header: { cwd: '/workspace' } },
    ctx: {
      get(name) {
        assert.equal(name, 'tools');
        return { register: (tool) => registered.push(tool) };
      },
    },
  };
  installNovelTools(host, () => [definition]);
  created({ agent });
  assert.equal(registered.length, 0);
  cwd = root;
  created({ agent });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].parameters, definition.parameters);
  assert.equal(registered[0].output, definition.output);
  const exec = { agent, signal: new AbortController().signal };
  assert.equal(await registered[0].execute({}, exec), 'ok');
  cwd = root + '/drafts';
  assert.equal(await registered[0].execute({}, exec), 'ok');
  for (const other of ['/workspace', '/workspace/novels/b-' + 'b'.repeat(32)]) {
    cwd = other;
    await assert.rejects(registered[0].execute({}, exec), /workspace has changed/);
  }
  cwd = root;
  await assert.rejects(registered[0].execute({}, { ...exec, agent: { ...agent } }), /Agent or novel/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(registered[0].execute({}, { ...exec, signal: abort.signal }));
  assert.equal(calls, 2, 'Wrong scope and cancellation must never enter the tool body.');
});
test('novel tool extension refuses asynchronous factories and native tool-name shadowing', () => {
  let created;
  const host = {
    on(_name, callback) {
      created = callback;
    },
    get() {
      return { get: () => root };
    },
  };
  const agent = {
    session: {},
    ctx: {
      get: () => ({
        register() {
          throw new Error('must not register');
        },
      }),
    },
  };
  installNovelTools(host, () => Promise.resolve([]));
  assert.throws(() => created({ agent }), /synchronous/);
  installNovelTools(host, () => [{ name: 'write', execute() {} }]);
  assert.throws(() => created({ agent }), /Invalid native novel/);
});

test('async native writer can recheck scope and cancellation at its actual commit boundary', async () => {
  let created,
    registered,
    cwd = root,
    release,
    writes = 0;
  const agent = {
    session: {},
    ctx: {
      get: () => ({
        register(tool) {
          registered = tool;
        },
      }),
    },
  };
  const host = {
    on(_name, callback) {
      created = callback;
    },
    get: () => ({ get: () => cwd }),
  };
  let gate;
  installNovelTools(host, ({ assertScope }) => [
    {
      name: 'novel_write_fixture',
      execute: async (_args, exec) => {
        await gate;
        assertScope(exec);
        writes++;
      },
    },
  ]);
  created({ agent });
  for (const changed of ['directory', 'cancel']) {
    cwd = root;
    const controller = new AbortController();
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = registered.execute({}, { agent, signal: controller.signal });
    if (changed === 'directory') cwd = '/workspace';
    else controller.abort();
    release();
    await assert.rejects(pending);
  }
  assert.equal(writes, 0);
});
