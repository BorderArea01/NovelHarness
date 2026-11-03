// One-time registration of an existing private store. Data stays at the same
// physical path; no manuscript/session import, reserialization or cloud switch.
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, realpath, unlink, symlink, open, readlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
function inside(root, path) {
  const rel = relative(root, path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Path escapes the declared legacy installation.');
}
function stopped(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Unknown legacy owner PID.');
  try {
    process.kill(pid, 0);
    throw new Error('旧服务仍在运行；请先确认 AI 空闲并停稳服务。');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function unlocked(root) {
  try {
    stopped(Number(await readFile(join(root, '.service.lock'), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function inspectLegacyStore({ legacyRuntime, runtimeDirectory, dataDirectory }) {
  assert(
    [legacyRuntime, runtimeDirectory, dataDirectory].every((v) => typeof v === 'string' && v.trim()),
    'Declare legacy runtime, target runtime and data directory.',
  );
  const previous = resolve(legacyRuntime),
    runtime = resolve(runtimeDirectory),
    root = resolve(dataDirectory);
  inside(previous, root);
  const prepared = await json(join(runtime, '.anonymous-host.json'));
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.format, 'novelharness-anonymous-v1');
  let running, legacyCookies;
  try {
    const staging = await json(join(root, 'staging.json'));
    assert.equal(staging.format, 'novel-owner-authorized-lan-staging-v1');
    running = await json(join(root, 'running.json'));
    legacyCookies = ['novel_stage_owner', 'novel_stage_pin'];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const manifest = await json(join(previous, 'production-runtime.json'));
    assert.equal(manifest.format, 'novel-private-production-runtime-v1');
    const promotion = await json(join(root, 'promotion.json'));
    assert.equal(promotion.dataPolicy, 'preserve-current-formal-only');
    assert.equal(promotion.status, 'offline-conversion-verified');
    running = await json(join(previous, 'production-running.json'));
    legacyCookies = ['dsh_edge_owner', 'novel_pin'];
  }
  assert(Number.isInteger(running.port) && running.port > 0 && running.port < 65536);
  const key = (await readFile(join(root, 'owner-key.txt'), 'utf8')).trim();
  assert(key.length >= 32);
  const raw = new Database(join(root, 'main.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(raw.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(raw.prepare("SELECT v FROM vfs_meta WHERE k='schema_version'").get()?.v, 8);
  } finally {
    raw.close();
  }
  const pinDb = new Database(join(root, 'home/web-pin.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const state = JSON.parse(pinDb.prepare('SELECT value FROM pin_kv WHERE key=?').get('pin-state').value);
    assert.equal(state.version, 1);
    assert(state.pin && state.epoch);
  } finally {
    pinDb.close();
  }
  const profile = join(root, 'home/profiles/novel-lab-persistent');
  const links = [];
  for (const name of ['novel-harness-bridge', 'dsh-purge']) {
    const path = join(profile, 'node_modules', name);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT' && name === 'dsh-purge') continue;
      throw error;
    }
    assert(stat.isSymbolicLink(), 'Managed profile dependency is not a junction.');
    const before = join(previous, 'cloud/official/node_modules', name),
      after = join(runtime, 'cloud/official/node_modules', name);
    assert.equal(
      await realpath(path),
      await realpath(before),
      'Unknown dependency target; leave it unchanged.',
    );
    await realpath(after);
    links.push({ path, before, after });
  }
  return {
    format: 'novelharness-adoption-v1',
    status: 'inspected',
    previous,
    runtime,
    root,
    previousPid: running.pid,
    authAuthority: 'localhost:' + running.port,
    legacyCookies,
    links,
    profile,
    keyHash: sha(key),
    at: new Date().toISOString(),
  };
}

export async function adoptSharedStore(options) {
  const plan = await inspectLegacyStore(options);
  if (!options.apply) return plan;
  stopped(plan.previousPid);
  await unlocked(plan.root);
  const markerPath = join(plan.root, '.novelharness-store.json');
  try {
    await lstat(markerPath);
    throw new Error('数据目录已经登记，未重复改动。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lockPath = join(plan.root, '.adoption.lock'),
    lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  const receiptPath = join(plan.root, '.novelharness-adoption.json');
  let previousReceipt;
  try {
    previousReceipt = await json(receiptPath);
    assert.equal(previousReceipt.status, 'restored', '已有未恢复的迁移记录，未覆盖。');
    assert.equal(previousReceipt.root, plan.root);
    assert.equal(previousReceipt.keyHash, plan.keyHash);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await lock.close();
      await unlink(lockPath);
      throw error;
    }
  }
  const changed = [];
  let recorded = false;
  let ledgerChanged = false;
  try {
    plan.manifest = (await readFile(join(plan.profile, 'package.json'))).toString('base64');
    try {
      plan.previousLedger = (await readFile(join(plan.profile, '.novelharness-dependencies.json'))).toString(
        'base64',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    plan.bundle = (await readFile(join(plan.profile, 'host-bundle/cordis.patch.yml'))).toString('base64');
    plan.status = 'registering';
    await writeFile(receiptPath, JSON.stringify(plan, null, 2), {
      flag: previousReceipt ? 'w' : 'wx',
      mode: 0o600,
    });
    recorded = true;
    stopped(plan.previousPid);
    for (const link of plan.links) {
      assert.equal(await realpath(link.path), await realpath(link.before));
      // Unlink only the verified managed junction; never recurse into a target.
      await unlink(link.path);
      changed.push(link);
      await symlink(link.after, link.path, 'junction');
    }
    const targets = {};
    for (const name of ['novel-harness-bridge', 'dsh-purge', 'novel-host-bundle']) {
      try {
        targets[name] = await readlink(join(plan.profile, 'node_modules', name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await writeFile(
      join(plan.profile, '.novelharness-dependencies.json'),
      JSON.stringify({ format: 'novelharness-profile-dependencies-v1', targets }),
      { mode: 0o600 },
    );
    ledgerChanged = true;
    await writeFile(
      markerPath,
      JSON.stringify({
        format: 'novelharness-store-v1',
        mode: 'shared',
        authAuthority: plan.authAuthority,
        legacyCookies: plan.legacyCookies,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    assert.equal(sha((await readFile(join(plan.root, 'owner-key.txt'), 'utf8')).trim()), plan.keyHash);
    plan.status = 'registered';
    await writeFile(receiptPath, JSON.stringify(plan, null, 2));
    return plan;
  } catch (error) {
    for (const link of changed.reverse()) {
      try {
        const stat = await lstat(link.path);
        assert(stat.isSymbolicLink());
        await unlink(link.path);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await symlink(link.before, link.path, 'junction');
    }
    if (ledgerChanged) {
      const ledger = join(plan.profile, '.novelharness-dependencies.json');
      if (plan.previousLedger) await writeFile(ledger, Buffer.from(plan.previousLedger, 'base64'));
      else await unlink(ledger);
    }
    try {
      const marker = await json(markerPath);
      assert.equal(marker.authAuthority, plan.authAuthority);
      await unlink(markerPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (recorded) {
      plan.status = 'failed';
      await writeFile(receiptPath, JSON.stringify(plan, null, 2));
    }
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function restoreLegacyStore(dataDirectory) {
  const root = resolve(dataDirectory),
    path = join(root, '.novelharness-adoption.json');
  const plan = await json(path);
  assert.equal(plan.root, root);
  assert(['registered', 'registering', 'failed'].includes(plan.status));
  await unlocked(root);
  for (const link of plan.links) {
    inside(root, link.path);
    assert((await lstat(link.path)).isSymbolicLink());
    const actual = await realpath(link.path);
    if (actual === (await realpath(link.before))) continue;
    assert.equal(actual, await realpath(link.after));
    await unlink(link.path);
    await symlink(link.before, link.path, 'junction');
  }
  await writeFile(join(plan.profile, 'package.json'), Buffer.from(plan.manifest, 'base64'));
  await writeFile(join(plan.profile, 'host-bundle/cordis.patch.yml'), Buffer.from(plan.bundle, 'base64'));
  const ledger = join(plan.profile, '.novelharness-dependencies.json');
  if (plan.previousLedger) await writeFile(ledger, Buffer.from(plan.previousLedger, 'base64'));
  else {
    try {
      await unlink(ledger);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    const marker = await json(join(root, '.novelharness-store.json'));
    assert.equal(marker.authAuthority, plan.authAuthority);
    await unlink(join(root, '.novelharness-store.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  plan.status = 'restored';
  await writeFile(path, JSON.stringify(plan, null, 2));
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('cloud/selfhost/adopt-store.mjs')) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.includes('='))
      .map((a) => {
        const at = a.indexOf('=');
        return [a.slice(0, at), a.slice(at + 1)];
      }),
  );
  const plan = await adoptSharedStore({
    legacyRuntime: args['--legacy-runtime'],
    runtimeDirectory: args['--runtime-directory'],
    dataDirectory: args['--data-directory'],
    apply: process.argv.includes('--apply'),
  });
  console.log(
    JSON.stringify({
      status: plan.status,
      dataDirectory: plan.root,
      mode: 'shared',
      dataMoved: false,
      originalKeyPreserved: true,
    }),
  );
}
