import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verificationTransport, existingProxyEnvironment } from './verification-transport.mjs';
import { waitForDeploymentRevision } from './deployment-readiness.mjs';
import { stageRuntime } from './stage-runtime.mjs';
import { runtimeConfig } from './runtime-config.mjs';
import { requireIdleRuntime } from './runtime-activity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ownedRoot = resolve(root, 'data/cloud-platform');
const metadataPath = resolve(ownedRoot, 'deployment.json');
const ownerKeyPath = resolve(ownedRoot, 'owner-key.txt');
const cli = resolve(root, 'cloud/tools/node_modules/wrangler/bin/wrangler.js');
let state,
  ownerKey = '';
let cliProxy = {};

function insideOwned(path) {
  const target = resolve(path);
  if (!target.startsWith(ownedRoot + sep)) throw new Error('Deployment path is outside the owned directory.');
  return target;
}
async function saveState() {
  const temp = insideOwned(metadataPath + '.pending');
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, metadataPath);
}
async function command(
  args,
  { cwd = root, input, executable = process.execPath, prefix = ['--max-old-space-size=192', cli] } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...prefix, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...cliProxy,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        ...(state?.accountId ? { CLOUDFLARE_ACCOUNT_ID: state.accountId } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-64000);
      });
    child.on('error', reject);
    child.on('exit', (code) => {
      const safe = ownerKey ? output.replaceAll(ownerKey, '[owner-key-redacted]') : output;
      if (code !== 0) reject(new Error(`Cloudflare command failed (${code}): ${safe.slice(-6000)}`));
      else resolvePromise(safe);
    });
    child.stdin.end(input);
  });
}
function jsonOutput(text) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  return JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
}
async function digestTree(directory) {
  const hash = createHash('sha256');
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        hash.update(relative(directory, full).replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(await readFile(full));
        hash.update('\0');
      } else throw new Error('Unexpected source link in deployment input.');
    }
  }
  for (const part of ['functions', 'src', 'public', 'worker']) await visit(resolve(directory, part));
  return hash.digest('hex');
}
async function verify(url, fetch) {
  const version = await waitForDeploymentRevision(url, state.revision, fetch, {
    onWaiting: () =>
      console.log('Waiting for Pages source propagation; no re-upload, credential reset or model request.'),
  });
  const healthResponse = await fetch(url + '/api/health', { signal: AbortSignal.timeout(15000) });
  if (!healthResponse.ok) throw new Error('The deployed DSH health check failed.');
  const health = await healthResponse.json();
  if (health.version !== '0.30.0') throw new Error('Unexpected deployed DSH runtime version.');
  const before = await fetch(url + '/novels/', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (before.status !== 302 || before.headers.get('location') !== '/login')
    throw new Error('Anonymous novel page did not require login.');
  const login = await fetch(url + '/api/auth/recover', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: ownerKey }),
  });
  const cookies = login.headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  if (
    login.status !== 200 ||
    !cookies.some((value) => value.startsWith('__Host-dsh_edge_owner=')) ||
    !cookies.some((value) => value.startsWith('__Host-novel_pin='))
  )
    throw new Error('HTTPS owner login was not verified.');
  const session = await (
    await fetch(url + '/api/auth/session', { headers: { cookie }, signal: AbortSignal.timeout(15000) })
  ).json();
  if (session.authenticated !== true) throw new Error('Signed owner session was not accepted.');
  const page = await fetch(url + '/?view=library', {
    headers: { cookie },
    signal: AbortSignal.timeout(15000),
  });
  const shellHtml = await page.text();
  if (!page.ok || !shellHtml.includes('__DSH_BOOT__') || !shellHtml.includes('harness-boot.mjs'))
    throw new Error('Authenticated unified native application was not served.');
  const probe = await fetch(url + '/api/novels/b-' + '0'.repeat(32) + '/documents', {
    headers: { cookie },
    signal: AbortSignal.timeout(15000),
  });
  await probe.arrayBuffer();
  if (![200, 404].includes(probe.status)) throw new Error('Native atomic document adapter is not ready.');
  const ready = await fetch(url + '/api/ready', { headers: { cookie }, signal: AbortSignal.timeout(30000) });
  await ready.arrayBuffer();
  if (!ready.ok) throw new Error('Native runtime readiness is not verified; no model prompt was sent.');
  return {
    revision: version.revision,
    runtimeVersion: health.version,
    httpsOwnerLogin: true,
    privateNovelPage: true,
    runtimeReady: true,
    unifiedNativeShell: true,
    nativeDocumentAdapter: true,
    modelCalls: 0,
  };
}

try {
  if (existsSync(resolve(root, 'data/local-host/cutover.json'))) {
    const cutover = JSON.parse(await readFile(resolve(root, 'data/local-host/cutover.json'), 'utf8'));
    if (cutover.stores?.main?.frozen)
      throw new Error('Cloud source has been frozen for local ownership. Use the local-host release workflow; cloud database deployment is blocked to prevent split-brain.');
  }
  cliProxy = await existingProxyEnvironment();
  const auth = jsonOutput(await command(['whoami', '--json']));
  if (auth.loggedIn !== true || auth.accounts?.length !== 1)
    throw new Error('Exactly one authenticated Cloudflare account is required; no resources were changed.');
  const runtimePackage = JSON.parse(
    await readFile(resolve(root, 'cloud/tools/node_modules/dsh-edge/package.json'), 'utf8'),
  );
  if (runtimePackage.version !== '0.30.0')
    throw new Error('Unexpected installed DSH version; no resources were changed.');
  await mkdir(ownedRoot, { recursive: true });
  if (existsSync(metadataPath)) {
    state = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (
      state.format !== 'novel-harness-deployment-v1' ||
      !/^novel-harness-[a-f0-9]{12}$/.test(state.workerName) ||
      !/^novel-studio-[a-f0-9]{12}$/.test(state.pagesProject)
    )
      throw new Error('Unknown existing deployment record; refusing to replace it.');
    if (state.accountId !== auth.accounts[0].id)
      throw new Error('Deployment belongs to another Cloudflare account; no resources were changed.');
  } else {
    const suffix = randomBytes(6).toString('hex');
    state = {
      format: 'novel-harness-deployment-v1',
      accountId: auth.accounts[0].id,
      workerName: `novel-harness-${suffix}`,
      pagesProject: `novel-studio-${suffix}`,
      runtimeVersion: '0.30.0',
      status: 'planned',
    };
    await saveState();
  }
  if (existsSync(ownerKeyPath)) ownerKey = (await readFile(ownerKeyPath, 'utf8')).trim();
  else {
    if (state.ownerSecretApplied)
      throw new Error('Previously deployed owner key is missing; automatic credential reset is prohibited.');
    ownerKey = randomBytes(48).toString('base64url');
    await writeFile(ownerKeyPath, ownerKey + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (!/^[A-Za-z0-9_-]{64}$/.test(ownerKey))
    throw new Error('Unknown owner key file; it was not overwritten.');
  if (process.platform === 'win32')
    await command(
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve(root, 'cloud/scripts/protect-owner-key.ps1'),
        '-Path',
        ownerKeyPath,
      ],
      { executable: 'powershell.exe', prefix: [] },
    );

  const stage = insideOwned(resolve(ownedRoot, 'release-' + Date.now()));
  await mkdir(stage);
  const pagesSource = resolve(root, 'cloud/pages');
  for (const part of ['functions', 'src', 'public'])
    await cp(resolve(pagesSource, part), resolve(stage, part), { recursive: true, errorOnExist: true });
  await stageRuntime(resolve(stage, 'worker'), { pagesPublic: resolve(stage, 'public') });
  state.revision = await digestTree(stage);
  state.stage = stage;
  state.url = `https://${state.pagesProject}.pages.dev`;
  const quote = (value) => JSON.stringify(String(value).replaceAll('\\', '/'));
  const workerConfig = resolve(stage, 'worker-wrangler.toml');
  const runtime = resolve(root, 'cloud/tools/node_modules/dsh-edge');
  await writeFile(
    workerConfig,
    runtimeConfig({
      name: state.workerName,
      accountId: state.accountId,
      entry: resolve(stage, 'worker/entry.mjs'),
      assets: resolve(runtime, 'dist'),
    }),
  );
  await writeFile(
    resolve(stage, 'wrangler.toml'),
    `name = ${quote(state.pagesProject)}\npages_build_output_dir = "./public"\ncompatibility_date = "2026-08-14"\n[vars]\nPLATFORM_REVISION = ${quote(state.revision)}\n[[services]]\nbinding = "HARNESS"\nservice = ${quote(state.workerName)}\n[env.preview.vars]\nPLATFORM_REVISION = ${quote(state.revision)}\n[[env.preview.services]]\nbinding = "HARNESS"\nservice = ${quote(state.workerName + '-preview')}\n`,
  );
  await saveState();

  const workerCode = createHash('sha256');
  workerCode.update(await readFile(new URL('./runtime-config.mjs', import.meta.url)));
  for (const name of (await readdir(resolve(stage, 'worker'))).filter((name) => name.endsWith('.mjs')).sort())
    workerCode.update(await readFile(resolve(stage, 'worker', name)));
  const workerRevision = workerCode.digest('hex');
  if (!state.workerUploaded || state.workerRevision !== workerRevision) {
    if (state.workerUploaded) {
      const transport = await verificationTransport();
      try {
        await requireIdleRuntime(state.url, ownerKey, transport.request, {
          pinWrapper: !!state.workerRevision,
        });
      } finally {
        await transport.close();
      }
      console.log('Existing runtime is idle; no story content or model credentials were read.');
    }
    console.log(
      'Uploading the private PIN-enabled Worker; existing owner namespace and secrets remain unchanged.',
    );
    await command(['deploy', '--config', workerConfig]);
    state.workerUploaded = true;
    state.workerRevision = workerRevision;
    state.status = 'worker-uploaded';
    await saveState();
  }
  if (!state.ownerSecretApplied) {
    console.log('Applying the owner secret through stdin; no key will be printed.');
    await command(['secret', 'bulk', '--config', workerConfig], {
      input: JSON.stringify({ DSH_EDGE_ACCESS_KEY: ownerKey }),
    });
    state.ownerSecretApplied = true;
    await saveState();
  }
  if (!state.pagesProjectCreated) {
    console.log('Creating the new independent Pages project.');
    await command(['pages', 'project', 'create', state.pagesProject, '--production-branch', 'main'], {
      cwd: stage,
    });
    state.pagesProjectCreated = true;
    await saveState();
  }
  if (!state.pagesUploaded || state.uploadedRevision !== state.revision) {
    console.log('Uploading the Pages gateway and novel workbench.');
    await command(
      [
        'pages',
        'deploy',
        'public',
        '--project-name',
        state.pagesProject,
        '--branch',
        'main',
        '--commit-dirty=true',
      ],
      { cwd: stage },
    );
    state.pagesUploaded = true;
    state.uploadedRevision = state.revision;
    state.status = 'uploaded-verification-pending';
    await saveState();
  }
  console.log('Verifying source revision, HTTPS owner login and native readiness without model calls.');
  const transport = await verificationTransport();
  try {
    state.verification = await verify(state.url, transport.request);
  } finally {
    await transport.close();
  }
  state.status = 'verified';
  await saveState();
  console.log(
    JSON.stringify({
      status: state.status,
      url: state.url,
      revision: state.revision,
      ownerKeyFile: ownerKeyPath,
      modelKeyConfiguredByThisTask: false,
      verification: state.verification,
    }),
  );
} catch (error) {
  console.error(ownerKey ? error.message.replaceAll(ownerKey, '[owner-key-redacted]') : error.message);
  console.error(
    'Deployment stopped. Owned checkpoints were retained; no automatic rollback, credential reset or retry was performed.',
  );
  process.exitCode = 1;
}
