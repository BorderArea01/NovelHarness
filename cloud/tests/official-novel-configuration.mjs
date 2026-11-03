// Real snapshot configuration is checked OFFLINE. The executable host receives
// a separate copy whose credentials are replaced with explicit fixture values.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, lstat, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  importLegacyConfiguration,
  readLegacyConfiguration,
  configurationHash,
} from '../official/novel/configuration.mjs';
import { importHistoricalState } from '../official/novel/history.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { prepareOfficialNovel } from '../scripts/prepare-official-novel.mjs';
import { vfsFileFingerprint } from '../official/novel/storage.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { privateDirectory } from '../scripts/private-directory.mjs';

const root = resolve('data/official-validation/integration');
const source = resolve('data/official-validation/source-main.sqlite');
const sqlite = join(root, 'configuration-fixture.sqlite');
const home = join(root, 'configuration-runtime-fixture');
const offlineHome = join(root, 'configuration-offline-home');
const reopening = process.argv.includes('--reopen');
const reportPath = join(root, reopening ? 'configuration-reopen-report.json' : 'configuration-report.json');
const witnessPath = join(root, 'configuration-witness.json');
const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let app,
  model,
  phase = 'prepare';
const report = {
  passed: false,
  complete: false,
  at: new Date().toISOString(),
  freshProcess: reopening,
  productionSwitched: false,
  realModelCalls: 0,
};
await privateDirectory(root);
await writeFile(reportPath, JSON.stringify(report, null, 2));
const activeBefore = bytesHash(await readFile('data/local-host/active.json'));
const sourceBefore = bytesHash(await readFile(source));
try {
  let witness;
  if (!reopening) {
    // Reuse one bounded synthetic fixture. Check the final absolute target and
    // ownership marker before recursive removal; Node rm unlinks child
    // dependency junctions instead of traversing their shared targets.
    assert.equal(resolve(home), resolve(root, 'configuration-runtime-fixture'));
    let previous;
    try {
      previous = await lstat(home);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previous) {
      assert(previous.isDirectory() && !previous.isSymbolicLink());
      assert.equal(await realpath(home), resolve(home));
      const marker = JSON.parse(await readFile(join(home, 'fixture-owner.json'), 'utf8'));
      assert.equal(marker.format, 'novel-synthetic-config-fixture-v1');
      const imported = JSON.parse(await readFile(join(home, 'configuration-import.json'), 'utf8'));
      assert.equal(imported.credentialPolicy, 'synthetic');
      await rm(home, { recursive: true, force: false });
    }
    await privateDirectory(home);
    await writeFile(
      join(home, 'fixture-owner.json'),
      JSON.stringify({ format: 'novel-synthetic-config-fixture-v1' }),
    );
    await prepareOfficialNovel();
    phase = 'offline real configuration';
    const offline = await importLegacyConfiguration({ sourcePath: source, home: offlineHome });
    assert.equal(offline.status, 'ready');
    assert.equal(offline.credentialPolicy, 'offline-only');
    assert.equal(
      configurationHash(await importLegacyConfiguration({ sourcePath: source, home: offlineHome })),
      configurationHash(offline),
    );
    await assert.rejects(
      () => startOfficialNovel({ sqlite, home: offlineHome }),
      /offline verification only/,
    );
    const incomplete = join(root, 'configuration-incomplete-home');
    await privateDirectory(incomplete);
    await writeFile(
      join(incomplete, 'configuration-import.json'),
      JSON.stringify({ status: 'running', credentialPolicy: 'synthetic' }),
    );
    await assert.rejects(
      () => startOfficialNovel({ sqlite, home: incomplete }),
      /incomplete offline configuration import/,
    );
    report.realCredentialsVerifiedOfflineOnly = true;
    report.offline = offline;
    phase = 'synthetic credential copy';
    await copyFile(source, sqlite);
    const db = new Database(sqlite);
    try {
      const refs = db.prepare('SELECT key FROM _cf_KV WHERE key LIKE ?').all('dsh-edge:credential:%');
      db.transaction(() => {
        for (const row of refs)
          db.prepare('UPDATE _cf_KV SET value=? WHERE key=?').run(
            serialize('fixture-only-no-real-provider-key'),
            row.key,
          );
      })();
    } finally {
      db.close();
    }
    phase = 'native configuration and history import';
    const imported = await importLegacyConfiguration({ sourcePath: sqlite, home });
    assert.equal(imported.credentialPolicy, 'synthetic');
    await importHistoricalState({ sourcePath: sqlite, home });
    const state = readLegacyConfiguration(sqlite);
    const workspace = state.units.find((unit) => unit.spec.name === 'workspace');
    witness = {
      registryHash: configurationHash(workspace.tables.workspaces),
      workspaceOrder: workspace.global.workspaceIds,
      archivedSessionIds: workspace.global.archivedSessionIds,
      pinnedSessionIds: workspace.global.pinnedSessionIds,
      defaultModel: state.defaultModel,
      settings: state.settings,
    };
  } else witness = JSON.parse(await readFile(witnessPath, 'utf8'));
  phase = 'native boot with copied configuration';
  model = await startModelFixture();
  app = await startOfficialNovel({ sqlite, home, fixtureEndpoint: model.url });
  const before = configurationHash(vfsFileFingerprint(app.storage));
  const ctx = app.ctx,
    settings = ctx.get('settings'),
    credentials = ctx.get('credentials');
  const view = (ns) => settings.describe({ redactSecrets: true }).find((item) => item.ns === ns);
  assert.equal(ctx.get('agents').list().length, 0, 'Configuration restore activated a historical Agent.');
  const registry = ctx.get('workspaceRegistry').list();
  assert.equal(
    configurationHash(Object.fromEntries(registry.map((item) => [item.id, item.record]))),
    witness.registryHash,
    'Workspace identities/order/membership were not restored.',
  );
  assert.equal(configurationHash(registry.map((item) => item.id)), configurationHash(witness.workspaceOrder));
  assert.equal(
    configurationHash(ctx.get('workspaceRegistry').archivedSessionIds),
    configurationHash(witness.archivedSessionIds),
  );
  assert.equal(
    configurationHash(ctx.get('workspaceRegistry').pinnedSessionIds),
    configurationHash(witness.pinnedSessionIds),
  );
  assert.equal(
    configurationHash(ctx.get('agentDefaultModel').currentSelection()),
    configurationHash(witness.defaultModel),
  );
  const selection = ctx.get('agentDefaultModel').currentSelection();
  assert(
    ctx
      .get('llm')
      .listProviders()
      .some((item) => item.id === selection.provider),
    'Imported default model provider is unavailable.',
  );
  assert.equal(view('ui-theme').value.preference, witness.settings['ui-theme'].preference);
  assert.equal(
    view('ui-settings-general').value.welcomeNoticeVersion,
    witness.settings['ui-settings-general'].welcomeNoticeVersion,
  );
  for (const [ns, config] of Object.entries(witness.settings)) {
    const descriptor = view(ns);
    assert(descriptor, 'Imported settings namespace has no active owner.');
    for (const [field, value] of Object.entries(config))
      assert.equal(
        configurationHash(descriptor.value[field]),
        configurationHash(value),
        'Imported setting is not effective.',
      );
  }
  const key = await credentials.resolve('DEEPSEEK_API_KEY');
  assert.equal(key.source, 'file');
  assert.equal(
    configurationHash(key.value),
    configurationHash(reopening ? 'fixture-only-updated-key' : 'fixture-only-no-real-provider-key'),
  );
  assert(
    !JSON.stringify(settings.describe({ redactSecrets: true })).includes(key.value),
    'Settings exposed the credential value.',
  );
  if (!reopening) {
    phase = 'native settings edits';
    const theme = view('ui-theme');
    await settings.update('ui-theme', { fontSize: 17 }, theme.revision);
    assert.equal(view('ui-theme').value.fontSize, 17);
    await assert.rejects(
      () => settings.update('ui-theme', { fontSize: 18 }, theme.revision),
      (error) => error.code === 'SETTINGS_CONFLICT',
    );
    const provider = view('llm-deepseek');
    await settings.update('llm-deepseek', { maxTokens: 1536 }, provider.revision);
    assert.equal(view('llm-deepseek').value.maxTokens, 1536);
    const nextModel = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' };
    await ctx.get('agentDefaultModel').saveSelection(nextModel);
    witness.defaultModel = nextModel;
    const envBefore = process.env.DEEPSEEK_API_KEY;
    await credentials.set('DEEPSEEK_API_KEY', 'fixture-only-updated-key');
    assert.equal((await credentials.resolve('DEEPSEEK_API_KEY')).value, 'fixture-only-updated-key');
    assert.equal(
      process.env.DEEPSEEK_API_KEY,
      envBefore,
      'Managed credentials leaked into process environment.',
    );
    const userPatch = await readFile(join(app.profile, 'cordis.patch.yml'));
    assert(
      !userPatch.includes('novel-sqlite-filesystem'),
      'Generated host graph still occupies the user settings layer.',
    );
    witness.patchHash = bytesHash(userPatch);
    witness.filesHash = before;
    await writeFile(witnessPath, JSON.stringify(witness, null, 2));
  } else {
    assert.equal(view('ui-theme').value.fontSize, 17);
    assert.equal(view('llm-deepseek').value.maxTokens, 1536);
    assert.equal(
      bytesHash(await readFile(join(app.profile, 'cordis.patch.yml'))),
      witness.patchHash,
      'Startup regenerated the user settings file.',
    );
    assert.equal(before, witness.filesHash);
  }
  assert.equal(configurationHash(vfsFileFingerprint(app.storage)), before);
  assert.equal(model.requests.length, 0);
  assert.equal(ctx.get('agents').list().length, 0);
  report.nativeWorkspaceRecords = registry.length;
  report.defaultModelAndUiPreferencesRestored = true;
  report.nativeCredentialsReadableAndRedacted = true;
  report.userSettingsSeparateFromHostDefaults = true;
  await app.shutdown.shutdown(0);
  app = undefined;
  if (!reopening) {
    phase = 'fresh process settings reopen';
    await promisify(execFile)(
      process.execPath,
      ['--max-old-space-size=384', 'cloud/tests/official-novel-configuration.mjs', '--reopen'],
      { cwd: process.cwd(), windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024 },
    );
    assert.equal(
      JSON.parse(await readFile(join(root, 'configuration-reopen-report.json'), 'utf8')).passed,
      true,
    );
    report.nativeEditsSurviveFreshProcess = true;
    phase = 'reject stale reimport';
    const readyBefore = bytesHash(await readFile(join(home, 'configuration-import.json')));
    await assert.rejects(() => importLegacyConfiguration({ sourcePath: sqlite, home }));
    assert.equal(bytesHash(await readFile(join(home, 'configuration-import.json'))), readyBefore);
    report.reimportDoesNotOverwriteEditsOrInvalidateReadyState = true;
  }
  assert.equal(bytesHash(await readFile(source)), sourceBefore);
  assert.equal(bytesHash(await readFile('data/local-host/active.json')), activeBefore);
  report.passed = true;
} catch (error) {
  report.failure = {
    phase,
    name: error.name,
    code: error.code ?? null,
    message: String(error.message).split('\n')[0].slice(0, 200),
  };
  process.exitCode = 1;
} finally {
  if (app) await app.shutdown.shutdown(1);
  if (model) await model.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
