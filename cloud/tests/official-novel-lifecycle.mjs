// Managed profile lifecycle, not the upstream global desktop/shim uninstaller.
// Every host boot is a fresh process; the four states share one isolated DB.
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareOfficialNovel } from '../scripts/prepare-official-novel.mjs';
import { openNovelStorage, vfsFileFingerprint } from '../official/novel/storage.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { privateDirectory } from '../scripts/private-directory.mjs';

const root = resolve('data/official-validation/integration');
const sqlite = join(root, 'lifecycle-main.sqlite'),
  home = join(root, 'lifecycle-home');
const phase = process.argv[2];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hashFiles = (value) => sha(JSON.stringify(value));
const witnessPath = join(root, 'lifecycle-witness.json');
const activeBefore = await readFile('data/local-host/active.json');
let app, model;
const report = {
  complete: false,
  passed: false,
  phase: phase ?? 'controller',
  realModelCalls: 0,
  productionSwitched: false,
  upstreamGlobalUninstallerExecuted: false,
};
await privateDirectory(root);
const reportPath = join(root, phase ? 'lifecycle-' + phase + '-report.json' : 'lifecycle-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
try {
  if (!phase) {
    const { worker } = await prepareOfficialNovel();
    await copyFile(resolve('data/official-validation/source-main.sqlite'), sqlite);
    const storage = await openNovelStorage(sqlite);
    try {
      const sourceFilesHash = hashFiles(vfsFileFingerprint(storage));
      const { bootstrapBook } = await import(pathToFileURL(join(worker, 'book-catalog.mjs')));
      const { makeBookBundle } = await import('../pages/public/novel-assets/bundle.mjs');
      const bundle = await makeBookBundle(null, { title: '插件生命周期隔离测试', seed: '雨夜的来信。' });
      bootstrapBook(storage.fs, storage.db, bundle.manifest.id, bundle);
      const file = bundle.manifest.root + '/chapters/1.md';
      storage.fs.mkdirSync(bundle.manifest.root + '/chapters', { recursive: true });
      const text = '# 来信\n\n她收到了第一封信。\n';
      storage.fs.writeFileSync(file, text);
      await writeFile(
        witnessPath,
        JSON.stringify(
          { bookRoot: bundle.manifest.root, file, currentHash: sha(text), sourceFilesHash },
          null,
          2,
        ),
      );
    } finally {
      storage.close();
    }
    report.states = [];
    for (const state of ['enabled', 'disabled', 'removed', 'reinstalled']) {
      await promisify(execFile)(
        process.execPath,
        ['--max-old-space-size=384', 'cloud/tests/official-novel-lifecycle.mjs', state],
        { cwd: process.cwd(), windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024 },
      );
      const result = JSON.parse(await readFile(join(root, 'lifecycle-' + state + '-report.json'), 'utf8'));
      assert.equal(result.passed, true, 'Lifecycle subprocess did not pass.');
      report.states.push(result);
    }
    report.profileRemovalAndReinstall = true;
    report.exactRestoreRetainsNovelClientAndHostSeams = true;
  } else {
    assert(['enabled', 'disabled', 'removed', 'reinstalled'].includes(phase));
    const mode = phase === 'reinstalled' ? 'enabled' : phase;
    const witness = JSON.parse(await readFile(witnessPath, 'utf8'));
    model = await startModelFixture();
    app = await startOfficialNovel({ sqlite, home, fixtureEndpoint: model.url, purgeMode: mode });
    const ctx = app.ctx;
    assert.equal(
      sha(app.storage.fs.readFileSync(witness.file, 'utf8')),
      witness.currentHash,
      'Manuscript lost across lifecycle restart.',
    );
    assert.equal(
      hashFiles(
        vfsFileFingerprint(app.storage).filter((item) => !item.path.startsWith(witness.bookRoot + '/')),
      ),
      witness.sourceFilesHash,
    );
    const profile = JSON.parse(await readFile(join(app.profile, 'package.json'), 'utf8'));
    assert(profile.dependencies['novel-harness-bridge'].startsWith('file:'), 'Novel client dependency lost.');
    assert.equal(profile.dsh.profile.bundles.includes('dsh-purge'), mode !== 'removed');
    const session = await ctx.get('sessionController').create({ cwd: witness.bookRoot });
    const agent = ctx.get('agents').get(session.sessionId);
    const tools = agent.ctx.get('tools');
    for (const name of [
      'novel_proposal_prepare',
      'novel_proposal_inspect',
      'novel_proposal_submit',
      'novel_outline_update',
      'novel_run_next',
      'novel_run_submit',
      'read',
      'bash',
      'grep',
      'glob',
    ])
      assert(tools.get(name, agent), 'Novel/native tool lost during lifecycle: ' + name);
    assert.equal(!!tools.get('purge_status', agent), mode === 'enabled');
    const exec = { agent, signal: new AbortController().signal, callId: 'lifecycle-prepare' };
    const prepared = JSON.parse(
      await tools
        .get('novel_proposal_prepare', agent)
        .execute({ path: witness.file, instruction: '修改并继续本章。' }, exec),
    );
    const text = '# 来信\n\n她收到了新的一封信。\n\n阶段：' + phase + '。\n';
    const saved = JSON.parse(
      await tools.get('novel_proposal_submit', agent).execute(
        {
          proposal_id: prepared.proposalId,
          expected_hash: prepared.expectedHash,
          content: text,
          complete: true,
          content_scope: 'document',
        },
        { ...exec, callId: 'lifecycle-submit' },
      ),
    );
    assert.equal(saved.published, true, 'Novel tool no longer publishes.');
    assert.equal(await ctx.get('fs').readText(await ctx.get('fs').resolve(witness.file)), text);
    const assembly = await ctx.get('systemPrompt').assemble({ agent, scope: agent, signal: exec.signal });
    assert(assembly.contexts.some((item) => item.name === 'novel:authoring-workflow' && item.text));
    assert.equal(
      assembly.sections.some((item) => item.name === 'dsh-purge' && !!item.text),
      mode === 'enabled',
    );
    const core = await import(pathToFileURL(resolve('cloud/official/node_modules/dsh-purge/lib/core.js')));
    const base = resolve('cloud/official/node_modules/@deepseek-ai');
    const targets = [...new Set(Object.values(core.targetFiles(base)).flat().filter(Boolean))];
    if (phase === 'enabled') {
      witness.patchBases = [];
      for (const file of targets) {
        const rel = relative(resolve('cloud/official'), file);
        assert(!rel.startsWith('..'), 'Host target outside isolated installation.');
        witness.patchBases.push({ path: rel, sha: sha(await readFile(file + '.dshpurge.bak')) });
      }
    }
    if (phase === 'removed') {
      for (const item of witness.patchBases)
        assert.equal(
          sha(await readFile(resolve('cloud/official', item.path))),
          item.sha,
          'Restore differs from novel-aware baseline.',
        );
      for (const [name, asset] of [
        ['conversation', 'conversation'],
        ['sidebar', 'sidebar'],
        ['layout', 'layout'],
        ['settings-general', 'settings'],
      ])
        assert.equal(
          sha(
            await readFile(
              resolve('cloud/official/node_modules/@deepseek-ai/dsh-client-ui-' + name + '/lib/client.js'),
            ),
          ),
          sha(await readFile(join(root, 'baseline/native-shell', asset + '.js'))),
          'Restore replaced novel UI with stock DSH UI.',
        );
    }
    assert.equal(model.requests.length, 0);
    witness.currentHash = sha(text);
    await writeFile(witnessPath, JSON.stringify(witness, null, 2));
    await app.shutdown.shutdown(0);
    app = undefined;
    report.novelAndNativeToolsRetained = true;
    report.novelAutoPublishWorks = true;
    report.novelWorkflowRetained = true;
    report.purgeEnabled = mode === 'enabled';
    report.originalBooksUnchanged = true;
  }
  assert.equal(sha(await readFile('data/local-host/active.json')), sha(activeBefore));
  report.passed = true;
} catch (error) {
  report.failure = {
    name: error.name,
    code: error.code ?? null,
    message: String(error.message).split('\n')[0].slice(0, 240),
  };
  process.exitCode = 1;
} finally {
  if (app) await app.shutdown.shutdown(1);
  if (model) await model.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
