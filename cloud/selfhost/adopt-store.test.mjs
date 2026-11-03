import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { adoptSharedStore, restoreLegacyStore } from './adopt-store.mjs';
import { claimDataDirectory } from './data-directory.mjs';

test('legacy registration reuses exact DB, home and auth audience; live owners are refused and rollback restores managed links', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'novel-adopt-'));
  const legacy = join(temp, 'legacy'),
    runtime = join(temp, 'runtime'),
    root = join(legacy, 'data/store');
  const profile = join(root, 'home/profiles/novel-lab-persistent');
  try {
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await mkdir(join(profile, 'host-bundle'), { recursive: true });
    await mkdir(runtime);
    const put = (p, value) => writeFile(p, JSON.stringify(value));
    await put(join(runtime, '.anonymous-host.json'), { format: 'novelharness-anonymous-v1', prepared: true });
    await put(join(legacy, 'production-runtime.json'), { format: 'novel-private-production-runtime-v1' });
    await put(join(root, 'promotion.json'), {
      dataPolicy: 'preserve-current-formal-only',
      status: 'offline-conversion-verified',
    });
    await writeFile(join(root, 'owner-key.txt'), 'fixture-owner-key-not-for-models'.repeat(2));
    await writeFile(join(profile, 'package.json'), '{"private":true}');
    await writeFile(join(profile, 'host-bundle/cordis.patch.yml'), 'original managed bundle');
    const raw = new Database(join(root, 'main.sqlite'));
    raw.exec(
      "CREATE TABLE vfs_meta(k TEXT PRIMARY KEY,v INTEGER); INSERT INTO vfs_meta VALUES('schema_version',8); CREATE TABLE novel(text TEXT); INSERT INTO novel VALUES('保留原书正文');",
    );
    raw.close();
    const pin = new Database(join(root, 'home/web-pin.sqlite'));
    pin.exec('CREATE TABLE pin_kv(key TEXT PRIMARY KEY,value TEXT)');
    pin
      .prepare('INSERT INTO pin_kv VALUES (?,?)')
      .run('pin-state', JSON.stringify({ version: 1, epoch: 'fixture', pin: { hash: 'fixture' } }));
    pin.close();
    const original = await readFile(join(root, 'main.sqlite'));
    for (const name of ['novel-harness-bridge', 'dsh-purge']) {
      const from = join(legacy, 'cloud/official/node_modules', name),
        to = join(runtime, 'cloud/official/node_modules', name);
      await mkdir(from, { recursive: true });
      await mkdir(to, { recursive: true });
      await symlink(from, join(profile, 'node_modules', name), 'junction');
    }
    const running = join(legacy, 'production-running.json');
    await put(running, { pid: process.pid, port: 3211 });
    const options = { legacyRuntime: legacy, runtimeDirectory: runtime, dataDirectory: root, apply: true };
    await assert.rejects(adoptSharedStore(options), /仍在运行/);
    const deadPid = Number(
      execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
    await put(running, { pid: deadPid, port: 3211 });
    const plan = await adoptSharedStore(options);
    assert.equal(plan.status, 'registered');
    assert.deepEqual(await readFile(join(root, 'main.sqlite')), original);
    const marker = JSON.parse(await readFile(join(root, '.novelharness-store.json'), 'utf8'));
    assert.equal(marker.authAuthority, 'localhost:3211');
    assert.equal(marker.mode, 'shared');
    const claim = await claimDataDirectory(root, 'shared');
    await assert.rejects(restoreLegacyStore(root), /仍在运行/);
    await claim.release();
    await restoreLegacyStore(root);
    assert.equal(
      await realpath(join(profile, 'node_modules/novel-harness-bridge')),
      await realpath(join(legacy, 'cloud/official/node_modules/novel-harness-bridge')),
    );
    assert.deepEqual(await readFile(join(root, 'main.sqlite')), original);
    assert.equal(
      await readFile(join(profile, 'host-bundle/cordis.patch.yml'), 'utf8'),
      'original managed bundle',
    );
  } finally {
    assert(temp.startsWith(join(tmpdir(), 'novel-adopt-')));
    await rm(temp, { recursive: true, force: true });
  }
});
