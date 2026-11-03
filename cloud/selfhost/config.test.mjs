import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentConfig, loadDeploymentConfig } from './config.mjs';
import { claimDataDirectory, visitorSigningKeys } from './data-directory.mjs';
import { claimInstallationLease, ensureInstallationIdle } from './installation-lease.mjs';
import { checkDeployment } from './check-deployment.mjs';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

test('public access configuration is explicit and never pretends to create a tunnel', async () => {
  assert.equal(deploymentConfig().ingress, 'lan');
  assert.equal(deploymentConfig({ publicOrigin: 'https://novels.example.test' }).ingress, 'reverse-proxy');
  const privatePublic = deploymentConfig({
    mode: 'shared',
    ingress: 'cloudflare-vpc',
    publicOrigin: 'https://novels.example.test',
  });
  assert.equal(privatePublic.ingress, 'cloudflare-vpc');
  for (const config of [
    { ingress: 'unknown' },
    { ingress: 'lan', publicOrigin: 'https://novels.example.test' },
    { ingress: 'reverse-proxy' },
    { mode: 'isolated', ingress: 'cloudflare-vpc', publicOrigin: 'https://novels.example.test' },
    { mode: 'shared', ingress: 'cloudflare-vpc', publicOrigin: 'http://novels.example.test' },
  ])
    assert.throws(() => deploymentConfig(config));
  const root = await mkdtemp(join(tmpdir(), 'novel-deploy-check-'));
  try {
    const artifact = join(root, 'program'),
      store = join(root, 'persistent');
    await mkdir(artifact);
    await writeFile(
      join(artifact, '.anonymous-host.json'),
      JSON.stringify({ format: 'novelharness-anonymous-v1', prepared: true }),
    );
    const config = { ...privatePublic, runtimeDirectory: artifact, dataDirectory: store };
    const first = await checkDeployment(config);
    assert.equal(first.configurationValid, true);
    assert.equal(first.publicConnectionVerified, false);
    assert.equal(first.networkChanged, false);
    assert(first.checks.some((c) => c.name === 'access' && c.status === 'warning'));
    assert.equal(existsSync(store), false, 'Read-only checks must not initialize a new store.');
    await mkdir(store);
    await writeFile(
      join(store, '.novelharness-store.json'),
      JSON.stringify({ format: 'novelharness-store-v1', mode: 'isolated' }),
    );
    assert.equal((await checkDeployment(config)).configurationValid, false);
    assert.equal(existsSync(join(store, 'main.sqlite')), false);
  } finally {
    assert(root.startsWith(join(tmpdir(), 'novel-deploy-check-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('one configuration selects mode; explicit environment overrides JSON without accepting secrets in JSON', async () => {
  assert.equal(deploymentConfig().mode, 'isolated');
  const c = deploymentConfig({ mode: 'shared', port: 3215 }, { PORT: '3216' });
  assert.equal(c.mode, 'shared');
  assert.equal(c.port, 3216);
  for (const value of [
    { mode: 'typo' },
    { port: -1 },
    { initialPin: '123456' },
    { publicOrigin: 'https://user:secret@example.test/' },
  ])
    assert.throws(() => deploymentConfig(value));
  const root = await mkdtemp(join(tmpdir(), 'novel-config-'));
  try {
    await writeFile(
      join(root, 'novelharness.config.json'),
      JSON.stringify({ mode: 'shared', dataDirectory: 'books' }),
    );
    const loaded = await loadDeploymentConfig({ cwd: root, env: {} });
    assert.equal(loaded.mode, 'shared');
    assert.equal(loaded.dataDirectory, join(root, 'books'));
  } finally {
    assert(root.startsWith(join(tmpdir(), 'novel-config-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('visitor identity secrets belong to persistent data, with explicit preservation of old installation secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-visitor-key-'));
  try {
    const legacy = join(root, 'old.json'),
      keys = { secret: 'a'.repeat(64), deployment: 'b'.repeat(16) };
    await writeFile(legacy, JSON.stringify(keys));
    assert.deepEqual(await visitorSigningKeys(root, legacy), keys);
    assert.deepEqual(await visitorSigningKeys(root), keys);
    await writeFile(join(root, 'visitor-secret.json'), 'broken');
    await assert.rejects(visitorSigningKeys(root, legacy));
  } finally {
    assert(root.startsWith(join(tmpdir(), 'novel-visitor-key-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('one immutable build supports independent instances and refuses rebuilding while either is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-lease-'));
  let a, b;
  try {
    a = await claimInstallationLease(root, join(root, 'a'), 'shared');
    b = await claimInstallationLease(root, join(root, 'b'), 'isolated');
    await assert.rejects(ensureInstallationIdle(root), /仍有服务/);
    await a.release();
    a = null;
    await assert.rejects(ensureInstallationIdle(root), /仍有服务/);
    await b.release();
    b = null;
    await ensureInstallationIdle(root);
  } finally {
    await a?.release();
    await b?.release();
    assert(root.startsWith(join(tmpdir(), 'novel-lease-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('data mode and live writer locks prevent mixing stores or starting a second owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-lock-'));
  let claim;
  try {
    claim = await claimDataDirectory(root, 'shared');
    await assert.rejects(claimDataDirectory(root, 'shared'), /正在使用/);
    await assert.rejects(claimDataDirectory(root, 'isolated'), /另一种模式/);
    await claim.release();
    claim = null;
    const reopened = await claimDataDirectory(root, 'shared');
    await reopened.release();
    const old = join(root, 'unregistered');
    await import('node:fs/promises').then((fs) => fs.mkdir(old));
    await writeFile(join(old, 'main.sqlite'), 'existing-data-must-not-be-opened');
    await assert.rejects(claimDataDirectory(old, 'shared'), /尚未登记/);
  } finally {
    await claim?.release();
    assert(root.startsWith(join(tmpdir(), 'novel-lock-')));
    await rm(root, { recursive: true, force: true });
  }
});
