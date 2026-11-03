// Isolated official-host composition. Never changes the active release, formal
// storage, public relay or any network configuration.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installHostCompatibility } from './host-compat.mjs';
import { initializeNovelStorage } from './storage.mjs';
import { installNovelClientBase } from './client-base.mjs';
import { configureNovelProfile, NOVEL_PROFILE } from './profile.mjs';
import { installStagingManagementGuard } from './staging-management.mjs';
import { installPreStepCompatibility } from '../../scripts/prepare-pre-step-compat.mjs';

export async function startOfficialNovel({
  sqlite,
  home,
  fixtureEndpoint,
  purgeMode: requestedMode,
  staging = false,
  production = false,
  anonymous = false,
  installationPrepared = false,
}) {
  assert(!(staging && production));
  assert(!anonymous || (!staging && !production));
  assert(
    requestedMode === undefined || ['enabled', 'disabled', 'removed'].includes(requestedMode),
    'Invalid isolated plugin lifecycle state.',
  );
  const allowed = resolve('data/official-validation/integration');
  const rel = relative(allowed, resolve(home));
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
  if (anonymous) {
    assert(/^visitors[/\\][a-f0-9]{64}[/\\]home$/.test(rel));
    assert.equal(resolve(sqlite), resolve(home, '../main.sqlite'));
    assert.equal(
      JSON.parse(await readFile('.anonymous-host.json', 'utf8')).format,
      'novelharness-anonymous-v1',
    );
    assert(!fixtureEndpoint, 'Anonymous deployment does not inherit fixture credentials.');
  } else assert(!installationPrepared);
  if (production) {
    assert(!fixtureEndpoint, 'Production credentials cannot be sent to a fixture.');
    assert.equal(resolve(home), join(allowed, 'formal-promotion/home'));
    assert.equal(resolve(sqlite), join(allowed, 'formal-promotion/main.sqlite'));
    const receipt = JSON.parse(await readFile(join(home, '../promotion.json'), 'utf8'));
    assert.equal(receipt.format, 'novel-formal-only-promotion-v1');
    assert.equal(receipt.dataPolicy, 'preserve-current-formal-only');
    assert.equal(receipt.status, 'offline-conversion-verified');
    assert.equal((await readFile('production-runtime.json', 'utf8')).length > 0, true);
  }
  if (staging) {
    assert.equal(resolve(home), join(allowed, 'lan-staging/home'));
    assert.equal(resolve(sqlite), join(allowed, 'lan-staging/main.sqlite'));
    assert(!fixtureEndpoint, 'Staging credentials must not be sent to a fixture endpoint.');
    const authorization = JSON.parse(await readFile(join(home, '../staging.json'), 'utf8'));
    assert.equal(authorization.format, 'novel-owner-authorized-lan-staging-v1');
    assert.equal(authorization.status, 'prepared');
    assert.equal(authorization.productionSwitched, false);
  }
  try {
    const imported = JSON.parse(await readFile(join(home, 'configuration-import.json'), 'utf8'));
    assert.equal(imported.status, 'ready', 'An incomplete offline configuration import cannot boot.');
    assert(
      staging || production || imported.credentialPolicy !== 'offline-only',
      'Real credential copies are for offline verification only.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const modules = resolve('cloud/official/node_modules');
  for (const key of Object.keys(process.env))
    if (/(KEY|TOKEN|SECRET|PASSWORD|PIN|DEEPSEEK|^DSH_|PROXY|NODE_OPTIONS)/i.test(key))
      delete process.env[key];
  Object.assign(process.env, {
    DSH_HOME: home,
    DSH_BASE: join(modules, '@deepseek-ai'),
    DSH_SURFACE: 'web',
    DSH_PROFILE: NOVEL_PROFILE,
    DSH_TELEMETRY_DISABLED: '1',
    USERPROFILE: join(home, 'user'),
    HOME: join(home, 'user'),
    APPDATA: join(home, 'user/AppData/Roaming'),
    LOCALAPPDATA: join(home, 'user/AppData/Local'),
    NOVEL_STAGE_MANAGEMENT_LOCK: staging || production || anonymous ? 'preparing' : '',
  });
  await installStagingManagementGuard();
  // This laboratory never accepts real provider credentials or remote model
  // endpoints. An end-to-end tool-loop test must use a loopback fixture.
  if (fixtureEndpoint) {
    const endpoint = new URL(fixtureEndpoint);
    assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port);
    assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
    process.env.DEEPSEEK_API_KEY = 'fixture-only-no-real-provider-key';
    process.env.DEEPSEEK_BASE_URL = endpoint.origin + '/v1';
  }
  for (const folder of [home, join(home, 'user'), join(home, 'documents')])
    await mkdir(folder, { recursive: true });
  const core = await import(pathToFileURL(join(modules, 'dsh-purge/lib/core.js')));
  const targets = Object.values(core.targetFiles(process.env.DSH_BASE)).flat().filter(Boolean);
  for (const path of targets) {
    const p = relative(resolve('cloud/official'), resolve(path)),
      h = relative(resolve(home), resolve(path));
    assert(
      (!p.startsWith('..') && !isAbsolute(p)) || (!h.startsWith('..') && !isAbsolute(h)),
      'Patch target escapes isolated installation.',
    );
  }
  if (!installationPrepared) {
    assert.equal((await core.revertAll(process.env.DSH_BASE)).errors.length, 0);
    await installHostCompatibility();
    await installNovelClientBase();
  }
  const { profile, bundle, mode: purgeMode } = await configureNovelProfile({ home, modules, requestedMode });
  let patches = [];
  if (purgeMode !== 'removed' && !installationPrepared) {
    const backup = await core.backupAll(process.env.DSH_BASE);
    assert.equal(backup.errors.length, 0, 'Plugin backup failed: ' + JSON.stringify(backup.errors));
    patches = await core.applyPatches(process.env.DSH_BASE);
  }
  if (!installationPrepared) await installPreStepCompatibility();
  const storage = await initializeNovelStorage(sqlite);
  const file = (name) => JSON.stringify(pathToFileURL(resolve('cloud/official/novel', name + '.mjs')).href);
  await writeFile(
    join(bundle, 'cordis.patch.yml'),
    [
      '- insert:',
      '    - id: novel-sqlite-filesystem',
      '      name: ' + file('filesystem'),
      '      config:',
      '        sqlite: ' + JSON.stringify(sqlite),
      '    - id: novel-vfs-subprocess',
      '      name: ' + file('subprocess'),
      '      inject: [novelStorage, fs]',
      '    - id: novel-directory-picker',
      '      name: ' + file('directory-picker'),
      '      inject: [fs, novelStorage]',
      '    - id: novel-bash',
      "      name: '@deepseek-ai/dsh-bash-sandbox'",
      '      config:',
      '        cwd: /workspace',
      '        timeoutMs: 15000',
      '        maxTimeoutMs: 60000',
      '    - id: novel-harness-bridge',
      '      name: novel-harness-bridge',
      '    - id: novel-authoring-tools',
      '      name: ' + file('tools'),
      '      inject: [novelStorage, workingDirectory, systemPrompt, agents, workspaceRegistry]',
      '      config:',
      '        runKey: isolated-novel-checkpoint-key-not-a-production-secret',
      '- id: fs-sandbox',
      '  disabled: true',
      '- id: subprocess',
      '  disabled: true',
      '- id: directory-picker',
      '  disabled: true',
      '- id: bash-sandbox',
      '  disabled: true',
      '- id: pwsh-sandbox',
      '  disabled: true',
      '- id: tool-bash',
      '  disabled: false',
      '- id: tool-pwsh',
      '  disabled: true',
      ...(fixtureEndpoint
        ? [
            '- id: llm-deepseek',
            '  config:',
            '    baseURL: ' + JSON.stringify(new URL(fixtureEndpoint).origin + '/v1'),
            '    thinking: disabled',
            '    maxTokens: 2048',
            '    streamIdleTimeoutMs: 15000',
          ]
        : []),
      '- id: session-persistence-jsonl',
      '  config:',
      '    root: ' + JSON.stringify(join(home, 'sessions')),
      '    compression: none',
      '- id: attachment-local',
      '  config:',
      '    dshHome: ' + JSON.stringify(home),
      '    imageCompressionConcurrency: 1',
      '- id: web-app',
      '  config:',
      '    openBrowser: false',
      '    printUrl: false',
      '- id: workspace-controller',
      '  config:',
      '    documentsDirectory: /workspace',
      '- id: working-directory',
      '  config:',
      '    defaultDirectory: /workspace',
      '- id: sandbox-policy',
      '  config:',
      '    mode: danger-full-access',
      '    workspaceRoot: /workspace',
      '- id: session-controller',
      '  config:',
      '    nativeOpen: false',
      '- id: session-log-deepseek',
      '  disabled: true',
      '- id: desktop-product-telemetry',
      '  disabled: true',
      '- id: product-analytics',
      '  disabled: true',
      '',
    ].join('\n'),
  );
  const { loadLayeredEnv } = await import(
    pathToFileURL(join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js'))
  );
  if (staging || production || anonymous) process.env.NOVEL_STAGE_MANAGEMENT_LOCK = 'locked';
  const { runProfile } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh/lib/profile-boot.js')));
  // Import third-party plugin code only AFTER private env setup and management
  // guards; early static imports would cache its unguarded management modules.
  const { installAuthoringBoundary } = await import('./purge-authoring.mjs');
  const log = console.log;
  console.log = (...args) => {
    if (!String(args[0]).startsWith('dsh web:')) log(...args);
  };
  try {
    const app = await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: NOVEL_PROFILE,
      patchFiles: [],
      configureHost: installAuthoringBoundary,
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    });
    if (staging || production || anonymous) process.env.NOVEL_STAGE_MANAGEMENT_LOCK = 'locked';
    return {
      ...app,
      storage,
      patches,
      profile,
      staging,
      production,
      anonymous,
      origin: app.ctx.get('webServer').getOrigin(),
    };
  } catch (error) {
    storage.close();
    throw error;
  } finally {
    console.log = log;
  }
}
