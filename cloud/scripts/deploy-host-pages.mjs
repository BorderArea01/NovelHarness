// Re-publish the SAME verified Pages files with ONLY its backend binding changed.
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { existingProxyEnvironment } from './verification-transport.mjs';
import { verifyUiRelease } from './verify-ui-release.mjs';
if (!process.argv.includes('--owner-requested')) throw new Error('Explicit public host switch required.');
const root = resolve('.');
const deployment = JSON.parse(await readFile('data/cloud-platform/deployment.json', 'utf8'));
const active = JSON.parse(await readFile('data/local-host/active.json', 'utf8'));
const cutover = JSON.parse(await readFile('data/local-host/cutover.json', 'utf8'));
const relay = JSON.parse(await readFile('data/local-host/relay.json', 'utf8'));
if (!active.verifiedReady || active.targetId !== cutover.targetId || cutover.relayWorker !== relay.worker)
  throw new Error('Verified host and updated project binding required.');
let stage, revision;
if (process.env.NOVEL_HOST_UI_RELEASE) {
  const release = resolve(process.env.NOVEL_HOST_UI_RELEASE);
  if (!release.startsWith(resolve('data/local-host/releases') + sep) || active.release !== release)
    throw new Error('Active, owned UI release required.');
  const receipt = await verifyUiRelease(release);
  const tested = JSON.parse(await readFile(resolve(release, 'tested.json'), 'utf8'));
  if (
    receipt.revision !== tested.revision ||
    active.revision !== receipt.revision
  )
    throw new Error('Tested UI release required.');
  stage = resolve(release, 'pages');
  revision = receipt.revision;
} else {
  stage = resolve(deployment.stage);
  revision = deployment.revision;
  if (!stage.startsWith(resolve('data/cloud-platform') + sep))
    throw new Error('Owned original verified Pages release required.');
  if (active.release)
    throw new Error('Explicit current UI release required; refusing to publish the old interface.');
}
const target = resolve('data/local-host/pages-release-' + Date.now());
await mkdir(target);
await cp(resolve(stage, 'public'), resolve(target, 'public'), { recursive: true });
await cp(resolve(stage, 'functions'), resolve(target, 'functions'), { recursive: true });
await cp(resolve(stage, 'src'), resolve(target, 'src'), { recursive: true });
const quote = JSON.stringify;
await writeFile(
  resolve(target, 'wrangler.toml'),
  `name = ${quote(deployment.pagesProject)}\npages_build_output_dir = "./public"\ncompatibility_date = "2026-08-14"\n[vars]\nPLATFORM_REVISION = ${quote(revision)}\n[[services]]\nbinding = "HARNESS"\nservice = ${quote(relay.worker)}\n[env.preview.vars]\nPLATFORM_REVISION = ${quote(revision)}\n[[env.preview.services]]\nbinding = "HARNESS"\nservice = ${quote(deployment.workerName + '-preview')}\n`,
);
const proxy = await existingProxyEnvironment();
const child = spawn(
  process.execPath,
  [
    '--max-old-space-size=192',
    resolve('cloud/tools/node_modules/wrangler/bin/wrangler.js'),
    'pages',
    'deploy',
    'public',
    '--project-name',
    deployment.pagesProject,
    '--branch',
    'main',
    '--commit-dirty=true',
  ],
  {
    cwd: target,
    windowsHide: true,
    env: {
      ...process.env,
      ...proxy,
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_ACCOUNT_ID: deployment.accountId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (part) => {
    output = (output + part).slice(-16000);
  });
const code = await new Promise((done, reject) => {
  child.on('error', reject);
  child.on('exit', done);
});
if (code !== 0) {
  console.error('Pages relay publication failed. Private deployment output retained.');
  await writeFile(resolve(target, 'publish.log'), output, { mode: 0o600 });
  process.exitCode = 1;
} else {
  cutover.pagesRelease = target;
  cutover.pagesPublishedAt = new Date().toISOString();
  cutover.frontendRevision = revision;
  await writeFile('data/local-host/cutover.json', JSON.stringify(cutover, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      pagesPublished: true,
      originalUrl: deployment.url,
      backend: relay.worker,
      originalCloudRetainedFrozen: true,
    }),
  );
}
