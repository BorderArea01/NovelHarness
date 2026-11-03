// First integration gate: original manuscript code + actual original SQLite VFS.
// The official host/plugin lifecycle and browser gates are expanded here, rather
// than treating the standalone plugin boot receipt as product compatibility.
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareOfficialNovel } from '../scripts/prepare-official-novel.mjs';
import { openNovelStorage, vfsFileFingerprint } from '../official/novel/storage.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { verifyOfficialNovelLoop } from './official-novel-loop.mjs';
import { privateDirectory } from '../scripts/private-directory.mjs';
import { verifyOfficialNovelFilesystem } from './official-novel-filesystem.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const activeBefore = await readFile('data/local-host/active.json');
const root = resolve('data/official-validation/integration');
const report = {
  format: 'novel-official-integration-v1',
  at: new Date().toISOString(),
  complete: false,
  status: 'running',
  productionWrites: 0,
  productionSwitched: false,
  realModelCalls: 0,
  gates: {
    sqliteVfs: false,
    nativeNovelTools: false,
    workflow: false,
    browser: false,
    auth: false,
    attachments: false,
    restart: false,
    purgeLifecycle: false,
  },
};
let storage;
let app;
let model;
await privateDirectory(root);
await writeFile(join(root, 'integration-report.json'), JSON.stringify(report, null, 2));
try {
  const { worker } =
    process.env.NOVEL_OFFICIAL_USE_PREPARED_BASELINE === '1'
      ? { worker: join(root, 'baseline/worker') }
      : await prepareOfficialNovel();
  const target = join(root, 'test-main.sqlite');
  await copyFile(resolve('data/official-validation/source-main.sqlite'), target);
  storage = await openNovelStorage(target);
  const before = vfsFileFingerprint(storage);
  const manifest = JSON.parse(await readFile('data/official-validation/source-files-manifest.json', 'utf8'));
  assert.equal(before.length, manifest.length);
  const { createHash } = await import('node:crypto');
  const pathHash = (p) => createHash('sha256').update(p).digest('hex');
  for (const file of before) {
    const expected = manifest.find((item) => item.pathHash === pathHash(file.path));
    assert(expected);
    assert.equal(file.hash, expected.sha256);
    assert.equal(file.bytes, expected.bytes);
  }
  // Exercise the production document service on a wholly synthetic new book.
  const load = (name) => import(pathToFileURL(join(worker, name + '.mjs')));
  const { makeDocumentService } = await load('novel-documents');
  const { bootstrapBook } = await load('book-catalog');
  const { makeBookBundle } = await import('../pages/public/novel-assets/bundle.mjs');
  const bundle = await makeBookBundle(null, {
    title: '官方宿主隔离集成测试',
    seed: '雨夜，钥匙，陌生来信。',
  });
  const created = bootstrapBook(storage.fs, storage.db, bundle.manifest.id, bundle);
  assert.equal(created.book.id, bundle.manifest.id);
  const bookRoot = bundle.manifest.root;
  const fs = storage.fs;
  fs.mkdirSync(bookRoot + '/chapters', { recursive: true });
  const file = bookRoot + '/chapters/1.md';
  fs.writeFileSync(file, '# 雨夜\n\n她拾起了门口的钥匙。\n');
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(
    () =>
      storage.db.transactionSync(() => {
        fs.writeFileSync(file, '# 不应提交\n');
        fs.writeFileSync(bookRoot + '/chapters/rollback.md', '不应存在');
        throw new Error('synthetic interruption');
      }),
    /synthetic interruption/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(bookRoot + '/chapters/rollback.md'), false);
  const service = makeDocumentService(fs, storage.db, bundle.manifest.id);
  const chapters = service.run({ kind: 'list' });
  assert(chapters);
  // Existing real-book copies are untouched even though test writes occurred.
  const after = vfsFileFingerprint(storage).filter((item) => !item.path.startsWith(bookRoot + '/'));
  assert.deepEqual(after, before);
  assert.deepEqual(await readFile('data/local-host/active.json'), activeBefore);
  report.gates.sqliteVfs = true;
  report.sqliteVfs = {
    sourceFilesReadAndHashed: before.length,
    originalBookBytesUnchanged: true,
    actualSqliteTransactions: true,
    nestedRollbackVerified: true,
    originalDocumentServiceLoaded: true,
    originalBookBootstrapUsed: true,
    schemaChanged: false,
  };
  storage.close();
  storage = undefined;
  const { startOfficialNovel } = await import('../official/novel/runtime.mjs');
  model = await startModelFixture();
  app = await startOfficialNovel({ sqlite: target, home: join(root, 'home'), fixtureEndpoint: model.url });
  const ctx = app.ctx;
  report.composition = {
    fs: ctx.get('fs')?.constructor?.name,
    storage: !!ctx.get('novelStorage'),
    novelHost: !!ctx.get('novelHost'),
  };
  const workspace = await ctx.get('workspaceRegistry').create(bookRoot, '官方宿主隔离集成测试');
  assert.equal(workspace.path, bookRoot);
  const createdSession = await ctx.get('sessionController').create({ cwd: bookRoot });
  const agent = ctx.get('agents').get(createdSession.sessionId);
  assert(agent);
  const tools = agent.ctx.get('tools');
  const names = [
    'novel_proposal_prepare',
    'novel_proposal_inspect',
    'novel_proposal_submit',
    'novel_outline_update',
    'novel_run_next',
    'novel_run_submit',
  ];
  for (const name of names) assert(tools.get(name, agent), 'Missing original novel tool: ' + name);
  const exec = { agent, signal: new AbortController().signal, callId: 'isolated-novel-call-1' };
  const prepare = JSON.parse(
    await tools
      .get('novel_proposal_prepare', agent)
      .execute({ path: file, instruction: '改写开头，同时续写后文。' }, exec),
  );
  const mixed = '# 雨夜\n\n她没有拿起钥匙，而是先检查了门锁。\n\n门内传来一声轻响。\n';
  const submitted = JSON.parse(
    await tools.get('novel_proposal_submit', agent).execute(
      {
        proposal_id: prepare.proposalId,
        expected_hash: prepare.expectedHash,
        content: mixed,
        complete: true,
        content_scope: 'document',
      },
      { ...exec, callId: 'isolated-novel-call-2' },
    ),
  );
  assert.equal(submitted.published, true);
  const targetFs = await ctx.get('fs').resolve(file);
  assert.equal(await ctx.get('fs').readText(targetFs), mixed);
  const assembly = await ctx.get('systemPrompt').assemble({ agent, scope: agent, signal: exec.signal });
  assert(assembly.sections.some((section) => section.name === 'dsh-purge' && section.text));
  const workflow = assembly.contexts.find((item) => item.name === 'novel:authoring-workflow');
  assert.equal(workflow, undefined, 'Retired dynamic task instructions must not reappear.');
  const identity = (value) => value.contexts.find((item) => item.name === 'novel:book-identity')?.text;
  assert(identity(assembly)?.includes('官方宿主隔离集成测试'));
  await ctx.get('workspaceController').rename({ workspaceId: workspace.id, title: '隔离作品的新标题' });
  const renamed = await ctx.get('systemPrompt').assemble({ agent, scope: agent, signal: exec.signal });
  assert(identity(renamed)?.includes('隔离作品的新标题'));
  assert(!identity(renamed)?.includes('官方宿主隔离集成测试'));
  await ctx.get('workingDirectory').set(agent, '/workspace', exec.signal);
  const globalAssembly = await ctx.get('systemPrompt').assemble({ agent, scope: agent, signal: exec.signal });
  assert(!identity(globalAssembly));
  assert(!globalAssembly.contexts.find((item) => item.name === 'novel:authoring-workflow')?.text);
  await ctx.get('workingDirectory').set(agent, bookRoot, exec.signal);
  await ctx.get('workspaceController').rename({ workspaceId: workspace.id, title: '官方宿主隔离集成测试' });
  app.storage.fs.writeFileSync(bookRoot + '/AGENTS.md', '本书测试约定：NOVEL_VFS_INSTRUCTIONS_VERIFIED。');
  report.gates.nativeNovelTools = true;
  report.nativeNovelTools = {
    officialHostAndOriginalPlugin: true,
    originalToolDefinitionsRegistered: names.length,
    originalProposalPublished: true,
    genericReadSeesSameManuscript: true,
    originalPurgeWithoutRetiredDynamicInstructions: true,
    secondAgentLoopAdded: false,
    currentBookIdentityTracksRenameAndDirectory: true,
  };
  report.nativeLoop = await verifyOfficialNovelLoop({
    ctx,
    model,
    agent,
    file,
    service: makeDocumentService(app.storage.fs, app.storage.db, bundle.manifest.id),
  });
  report.gates.workflow = true;
  report.filesystem = await verifyOfficialNovelFilesystem({
    ctx,
    storage: app.storage,
    root: bookRoot,
    service: makeDocumentService(app.storage.fs, app.storage.db, bundle.manifest.id),
  });
  assert.deepEqual(
    vfsFileFingerprint(app.storage).filter((item) => !item.path.startsWith(bookRoot + '/')),
    before,
  );
  assert.deepEqual(await readFile('data/local-host/active.json'), activeBefore);
  const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const witness = {
    filesHash: sha(vfsFileFingerprint(app.storage)),
    sessionId: agent.id,
    eventCount: agent.session.log.length,
    logHash: sha(agent.session.log),
    messagesHash: sha(agent.session.deriveMessages()),
    cwd: bookRoot,
    fixtureEndpoint: model.url,
  };
  await writeFile(join(root, 'restart-witness.json'), JSON.stringify(witness));
  await writeFile(join(root, 'restart-report.json'), JSON.stringify({ passed: false, status: 'running' }));
  await app.shutdown.shutdown(0);
  app = null;
  await promisify(execFile)(
    process.execPath,
    ['--max-old-space-size=192', 'cloud/tests/official-novel-reopen.mjs'],
    {
      cwd: resolve('.'),
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 65536,
    },
  );
  report.restart = JSON.parse(await readFile(join(root, 'restart-report.json'), 'utf8'));
  assert.equal(report.restart.passed, true);
  report.gates.restart = true;
  assert.deepEqual(await readFile('data/local-host/active.json'), activeBefore);
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (app) await app.shutdown.shutdown(process.exitCode ? 1 : 0);
  if (model) await model.close();
  storage?.close();
  report.status = report.failure ? 'failed' : 'passed';
  await writeFile(join(root, 'integration-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, failure: report.failure?.split('\n')[0] }, null, 2));
}
