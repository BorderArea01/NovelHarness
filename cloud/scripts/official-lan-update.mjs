// Owner-requested LAN-only update. Never switches active.json, cloud, networks
// or production storage. No provider credentials leave the private home.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { stageHostRelease } from '../host/stage.mjs';
import { prepareOfficialNovel } from './prepare-official-novel.mjs';
import { privateDirectory } from './private-directory.mjs';
import { openNovelStorage, vfsFileFingerprint } from '../official/novel/storage.mjs';
import { repairManagedBookPrompts } from '../shared/managed-prompt-repair.mjs';

const scope = resolve('data/official-validation/integration');
const stage = join(scope, 'lan-staging');
const action = process.argv[2];
assert(['prepare', 'stop', 'pause-tests', 'apply', 'refresh', 'check', 'verify'].includes(action));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const pointer = join(stage, 'pending-update.json');
const running = await json(join(stage, 'running.json'));
const origin = 'http://127.0.0.1:3212';
async function authenticated() {
  const key = (await readFile(join(stage, 'owner-key.txt'), 'utf8')).trim();
  const r = await fetch(origin + '/api/auth/recover', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: key }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, 'Existing owner authentication failed; no PIN was changed.');
  await r.arrayBuffer();
  return r.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
async function idle() {
  const cookie = await authenticated();
  const r = await fetch(origin + '/api/session/list', {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: 'session/list',
      payload: { args: { _request: {} } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(r.status, 200, 'Cannot verify isolated session activity.');
  const wire = await r.json();
  const body = wire.result?.value ?? wire.result?.data ?? wire;
  if (wire.result?.ok === false)
    throw new Error(
      'Session metadata rejected: ' +
        wire.result.error?.code +
        ' ' +
        String(wire.result.error?.message).slice(0, 160),
    );
  assert(Array.isArray(body.items), 'Unknown native activity shape.');
  assert(
    body.items.every((i) => typeof i.running === 'boolean'),
    'Incomplete native activity state.',
  );
  assert(!body.items.some((i) => i.running), 'AI is still running; isolated update not started.');
  return { idle: true, sessions: body.items.length };
}
async function inventory(root) {
  const rows = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name),
        rel = relative(root, path).replaceAll('\\', '/');
      if (e.isSymbolicLink()) continue; // Program junctions, not private data.
      if (e.isDirectory()) await walk(path);
      else if (e.isFile() && !/-(wal|shm)$/.test(path)) {
        const b = await readFile(path);
        rows.push({ path: rel, bytes: b.length, hash: sha(b) });
      } else if (!e.isFile()) throw new Error('Unexpected snapshot file type.');
    }
  }
  await walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
function inside(path, root) {
  const rel = relative(root, resolve(path));
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Update path escapes isolated scope.');
}
function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference="Stop"; $p=Get-CimInstance Win32_Process -Filter "ProcessId=' +
        pid +
        '"; if($p){$p|Select-Object ProcessId,CommandLine|ConvertTo-Json -Compress}',
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(r.status, 0);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
async function awaitStopped(pid) {
  for (let n = 0; n < 40; n++) {
    if (!processIdentity(pid)) return;
    await delay(250);
  }
  throw new Error('Graceful shutdown has not completed; no files were replaced.');
}
if (action === 'check') {
  console.log(JSON.stringify({ ...(await idle()), productionSwitched: false }));
} else if (action === 'prepare') {
  await idle();
  const folder = join(scope, 'lan-updates', new Date().toISOString().replace(/[:.]/g, '-'));
  await privateDirectory(folder);
  const active = await readFile('data/local-host/active.json');
  const release = join(folder, 'source');
  await stageHostRelease(release);
  const files = await inventory(release),
    hostFiles = await inventory(resolve('cloud/official/novel')),
    revision = sha(JSON.stringify({ files, hostFiles }));
  await prepareOfficialNovel({
    sourceRelease: { release, revision },
    destination: join(folder, 'candidate'),
  });
  const receipt = {
    format: 'novel-lan-update-v1',
    folder,
    revision,
    previousPid: running.pid,
    productionActiveHash: sha(active),
    preparedAt: new Date().toISOString(),
    status: 'prepared',
  };
  await writeFile(join(folder, 'source-manifest.json'), JSON.stringify(files), { mode: 0o600 });
  await writeFile(join(folder, 'host-manifest.json'), JSON.stringify(hostFiles), { mode: 0o600 });
  await writeFile(pointer, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  assert.equal(sha(await readFile('data/local-host/active.json')), sha(active));
  console.log(JSON.stringify({ prepared: true, folder, revision, productionSwitched: false }));
} else {
  const update = await json(pointer);
  inside(update.folder, join(scope, 'lan-updates'));
  assert.equal(update.format, 'novel-lan-update-v1');
  assert.equal(sha(await readFile('data/local-host/active.json')), update.productionActiveHash);
  if (action === 'refresh') {
    // Revise code after an offline acceptance failure, retaining the SAME
    // already-verified data backup. Never restart a failed candidate merely
    // to obtain another backup, and never reapply a data migration here.
    assert.equal(update.status, 'applied');
    assert(!processIdentity(running.pid), 'LAN writer must remain stopped.');
    assert(!processIdentity(update.previousPid), 'Previous LAN writer must remain stopped.');
    const backup = await json(join(update.backup, 'home-fingerprints.json'));
    assert(Array.isArray(backup));
    const folder = join(update.folder, 'revisions', new Date().toISOString().replace(/[:.]/g, '-'));
    await privateDirectory(folder);
    const release = join(folder, 'source');
    await stageHostRelease(release);
    const files = await inventory(release),
      hostFiles = await inventory(resolve('cloud/official/novel'));
    const revision = sha(JSON.stringify({ files, hostFiles }));
    await prepareOfficialNovel({
      sourceRelease: { release, revision },
      destination: join(folder, 'candidate'),
    });
    const previous = join(folder, 'previous');
    await mkdir(previous);
    for (const name of ['baseline', 'baseline.json', 'vfs.mjs']) {
      await rename(join(scope, name), join(previous, name));
      await rename(join(folder, 'candidate', name), join(scope, name));
    }
    update.revisions ??= [];
    update.revisions.push({ previousRevision: update.revision, revision, folder });
    update.revision = revision;
    await writeFile(join(folder, 'source-manifest.json'), JSON.stringify(files), { mode: 0o600 });
    await writeFile(join(folder, 'host-manifest.json'), JSON.stringify(hostFiles), { mode: 0o600 });
    await writeFile(pointer, JSON.stringify(update, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ refreshed: true, revision, dataWrites: 0, productionSwitched: false }));
  } else if (action === 'stop' || action === 'pause-tests') {
    if (action === 'stop') {
      assert.equal(update.status, 'prepared');
      assert.equal(running.pid, update.previousPid);
    } else {
      // A read-only-model test may share the original plugin installation.
      // Pause the verified preview without creating another code release or
      // altering its update receipt, database, PIN, or production process.
      assert.equal(update.status, 'verified');
      assert.equal(running.sourceRevision, update.revision);
    }
    assert(processIdentity(running.pid)?.CommandLine.includes('cloud/scripts/serve-official-lan.mjs'));
    await idle();
    // Node's Windows SIGTERM forcibly terminates instead of calling handlers.
    // A short-lived LOOPBACK inspector invokes this owned process's existing
    // SIGTERM handler, which closes ingress, flushes native owners and exits.
    // No debugger is kept running; never connect to another process's port.
    const probe = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) }).catch(
      () => null,
    );
    if (probe) {
      const targets = await probe.json();
      assert(
        targets.length === 1 &&
          targets[0].title?.replaceAll('\\', '/') === 'cloud/scripts/serve-official-lan.mjs',
        'Inspector belongs to an unknown process.',
      );
    } else process._debugProcess(running.pid);
    let target;
    for (let n = 0; n < 30; n++) {
      const r = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) }).catch(
        () => null,
      );
      if (r?.ok) {
        const items = await r.json();
        target = items.find((i) => i.type === 'node');
        if (target) break;
      }
      await delay(100);
    }
    assert(target?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9229/'));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    let seq = 0;
    const evaluate = (expression) =>
      new Promise((done, fail) => {
        const id = ++seq;
        const timeout = setTimeout(() => fail(new Error('Owned shutdown inspection timed out.')), 10000);
        const handler = (e) => {
          const data = JSON.parse(e.data);
          if (data.id !== id) return;
          clearTimeout(timeout);
          ws.removeEventListener('message', handler);
          data.error || data.result?.exceptionDetails
            ? fail(new Error('Owned shutdown evaluation refused.'))
            : done(data.result.result.value);
        };
        ws.addEventListener('message', handler);
        ws.send(
          JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }),
        );
      });
    let stopping = false;
    try {
      assert.equal(await evaluate('process.pid'), running.pid);
      assert.equal(
        await evaluate('process.listeners("SIGTERM").filter(f=>f.toString().includes("stop().then")).length'),
        1,
      );
      // Recheck immediately before invoking the original shutdown path.
      await idle();
      await evaluate('process.listeners("SIGTERM").find(f=>f.toString().includes("stop().then"))()');
      stopping = true;
    } finally {
      if (!stopping)
        await evaluate('setImmediate(()=>process.getBuiltinModule("node:inspector").close()); true').catch(
          () => {},
        );
      ws.close();
    }
    await awaitStopped(running.pid);
    if (action === 'stop') {
      update.status = 'stopped';
      await writeFile(pointer, JSON.stringify(update, null, 2), { mode: 0o600 });
    } else {
      const storage = await openNovelStorage(join(stage, 'main.sqlite'));
      try {
        await writeFile(
          join(stage, 'test-pause.json'),
          JSON.stringify(
            {
              format: 'novel-lan-test-pause-v1',
              at: new Date().toISOString(),
              pid: running.pid,
              revision: running.sourceRevision,
              bookFingerprint: sha(JSON.stringify(vfsFileFingerprint(storage))),
              productionActiveHash: update.productionActiveHash,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } finally {
        storage.close();
      }
    }
    console.log(
      JSON.stringify({ stopped: true, gracefully: true, pid: running.pid, productionSwitched: false }),
    );
  } else if (action === 'verify') {
    assert.equal(update.status, 'applied');
    assert.equal(running.sourceRevision, update.revision);
    const acceptance = await json(join(stage, 'lan-test.json'));
    assert.equal(acceptance.passed, true);
    assert.equal(acceptance.sourceRevision, update.revision);
    const cookie = await authenticated();
    const original = await json(join(update.backup, 'book-fingerprints.json'));
    const changed = new Map(update.migration.files.map((f) => [f.path, f.hash]));
    let checked = 0;
    for (const file of original) {
      const expected = changed.has(file.path) ? changed.get(file.path) : file.hash;
      const response = await fetch(
        origin + '/api/workspace/file?' + new URLSearchParams({ path: file.path }),
        { headers: { cookie }, signal: AbortSignal.timeout(15000) },
      );
      if (expected === null) {
        assert.equal(response.status, 404);
        await response.arrayBuffer();
      } else {
        assert.equal(response.status, 200);
        assert.equal(sha(new Uint8Array(await response.arrayBuffer())), expected);
      }
      checked++;
    }
    const oldHome = await json(join(update.backup, 'home-fingerprints.json'));
    let preserved = 0;
    const managedHomeChanges = [];
    let appendedSessionFiles = 0;
    for (const file of oldHome.filter((f) => !f.path.endsWith('.sqlite'))) {
      let actual;
      try {
        actual = sha(await readFile(join(stage, 'home', file.path)));
      } catch (error) {
        // npm owns and automatically rotates its diagnostic logs at startup.
        // This is not novel/session/credential state. Require the exact
        // pre-update bytes to remain in the full backup, and report removal
        // explicitly instead of restoring cache files behind npm's writer.
        if (
          error.code === 'ENOENT' &&
          /^user\/AppData\/Local\/npm-cache\/_logs\/\d{4}-\d{2}-\d{2}T[\d_]+Z-debug-\d+\.log$/.test(file.path)
        ) {
          assert.equal(sha(await readFile(join(update.backup, 'home', file.path))), file.hash);
          managedHomeChanges.push({
            path: file.path,
            previousHash: file.hash,
            hash: null,
            kind: 'native-npm-log-rotation-original-in-backup',
          });
          continue;
        }
        const cache = update.sessionRepairs?.find(
          (item) => file.path === 'storages/session_projcache/sessions/' + item.id + '.json',
        );
        if (error.code !== 'ENOENT' || !cache) throw error;
        const dir = join(stage, 'home', 'storages/session_projcache/sessions');
        const backups = (await readdir(dir)).filter((name) => name.startsWith(cache.id + '.json.bak.'));
        let archived = false;
        for (const name of backups) if (sha(await readFile(join(dir, name))) === file.hash) archived = true;
        assert(archived, 'Invalidated native checkpoint was not preserved in its owner backup.');
        managedHomeChanges.push({
          path: file.path,
          previousHash: file.hash,
          kind: 'derived-checkpoint-backed-up-and-invalidated',
        });
        continue;
      }
      const critical =
        /^(sessions\/|attachments\/|\.credentials\.yaml$|prompt-inject\.md$|profiles\/[^/]+\/cordis\.patch\.yml$)/.test(
          file.path,
        );
      if (critical && actual !== file.hash && file.path.startsWith('sessions/')) {
        const repaired = update.sessionRepairs?.find((item) => item.path.replaceAll('\\', '/') === file.path);
        if (repaired) {
          assert.equal(file.hash, repaired.previousHash);
          assert.equal(actual, repaired.hash, 'Repaired history changed after verification.');
          preserved++;
          continue;
        }
        const old = await readFile(join(update.backup, 'home', file.path));
        const current = await readFile(join(stage, 'home', file.path));
        assert(
          current.subarray(0, old.length).equals(old),
          'Original session records were rewritten: ' + file.path,
        );
        appendedSessionFiles++;
      } else if (critical)
        assert.equal(
          actual,
          file.hash,
          'An original conversation, attachment, credential or user profile changed: ' + file.path,
        );
      if (actual === file.hash) preserved++;
      else managedHomeChanges.push({ path: file.path, previousHash: file.hash, hash: actual });
    }
    const oldPin = new Database(join(update.backup, 'home/web-pin.sqlite'), { readonly: true });
    const currentPin = new Database(join(stage, 'home/web-pin.sqlite'), { readonly: true });
    try {
      const a = JSON.parse(oldPin.prepare('SELECT value FROM pin_kv WHERE key=?').get('pin-state').value);
      const b = JSON.parse(currentPin.prepare('SELECT value FROM pin_kv WHERE key=?').get('pin-state').value);
      assert.deepEqual(b.pin, a.pin);
      assert.equal(b.epoch, a.epoch);
    } finally {
      oldPin.close();
      currentPin.close();
    }
    update.status = 'verified';
    update.verifiedAt = new Date().toISOString();
    update.pid = running.pid;
    update.managedHomeChanges = managedHomeChanges;
    update.verification = {
      checkedOriginalBookFiles: checked,
      preservedNativeHomeFiles: preserved,
      appendedSessionFiles,
      repairedSessions: update.sessionRepairs?.length ?? 0,
      managedHomeChanges: managedHomeChanges.length,
      pinPreserved: true,
      nativePluginWebPassed: true,
      lanBrowserPassed: true,
      productionActiveUnchanged: true,
    };
    await writeFile(pointer, JSON.stringify(update, null, 2), { mode: 0o600 });
    await writeFile(join(update.folder, 'update-receipt.json'), JSON.stringify(update, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        verified: true,
        revision: update.revision,
        ...update.verification,
        productionSwitched: false,
      }),
    );
  } else {
    assert.equal(update.status, 'stopped');
    assert(!processIdentity(update.previousPid), 'Old LAN writer is still alive.');
    const backup = join(update.folder, 'backup');
    await privateDirectory(backup);
    const links = [];
    async function snapshot(dir, dest) {
      await mkdir(dest, { recursive: true });
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, e.name),
          to = join(dest, e.name);
        if (e.isSymbolicLink()) {
          const { readlink } = await import('node:fs/promises');
          links.push({ path: relative(stage, path), target: await readlink(path) });
          continue;
        }
        if (e.isDirectory()) await snapshot(path, to);
        else if (e.isFile() && !/-(wal|shm)$/.test(path)) {
          if (path.endsWith('.sqlite')) {
            const db = new Database(path, { readonly: true, fileMustExist: true });
            try {
              assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
              await db.backup(to);
            } finally {
              db.close();
            }
          } else await copyFile(path, to);
        }
      }
    }
    await snapshot(join(stage, 'home'), join(backup, 'home'));
    for (const name of ['main.sqlite', 'owner-key.txt', 'staging.json', 'running.json']) {
      const from = join(stage, name),
        to = join(backup, name);
      if (name.endsWith('.sqlite')) {
        const db = new Database(from, { readonly: true, fileMustExist: true });
        try {
          assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
          await db.backup(to);
        } finally {
          db.close();
        }
      } else await copyFile(from, to);
    }
    const homeBefore = await inventory(join(stage, 'home'));
    const homeAfter = await inventory(join(backup, 'home'));
    // SQLite online backup may change page layout, so compare its integrity and
    // logical rows separately; all other home files must be byte-identical.
    assert.deepEqual(
      homeAfter.filter((f) => !f.path.endsWith('.sqlite')),
      homeBefore.filter((f) => !f.path.endsWith('.sqlite')),
    );
    for (const file of homeBefore.filter((f) => f.path.endsWith('.sqlite'))) {
      const a = new Database(join(stage, 'home', file.path), { readonly: true }),
        b = new Database(join(backup, 'home', file.path), { readonly: true });
      try {
        const schema = a.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
        assert.deepEqual(
          b.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(),
          schema,
        );
        for (const { name } of schema) {
          const q = '"' + name.replaceAll('"', '""') + '"';
          assert.deepEqual(b.prepare('SELECT * FROM ' + q).all(), a.prepare('SELECT * FROM ' + q).all());
        }
      } finally {
        a.close();
        b.close();
      }
    }
    const storage = await openNovelStorage(join(stage, 'main.sqlite'));
    try {
      const before = vfsFileFingerprint(storage);
      const expected = await openNovelStorage(join(backup, 'main.sqlite'));
      try {
        assert.deepEqual(vfsFileFingerprint(expected), before);
      } finally {
        expected.close();
      }
      await writeFile(join(backup, 'book-fingerprints.json'), JSON.stringify(before), { mode: 0o600 });
      const preview = repairManagedBookPrompts(storage.fs, storage.db);
      update.migration = repairManagedBookPrompts(storage.fs, storage.db, {
        apply: true,
        ensureIdle() {
          assert(!processIdentity(update.previousPid));
        },
      });
      assert.equal(update.migration.changed, preview.changed);
      const allowed = new Set(preview.files.map((f) => f.path));
      const after = new Map(vfsFileFingerprint(storage).map((f) => [f.path, f]));
      for (const file of before) if (!allowed.has(file.path)) assert.deepEqual(after.get(file.path), file);
      update.unchangedBookFiles = before.filter((f) => !allowed.has(f.path)).length;
    } finally {
      storage.close();
    }
    await writeFile(join(backup, 'home-fingerprints.json'), JSON.stringify(homeBefore), { mode: 0o600 });
    await writeFile(join(backup, 'program-junctions.json'), JSON.stringify(links), { mode: 0o600 });
    await rename(join(scope, 'baseline'), join(backup, 'baseline'));
    await rename(join(scope, 'baseline.json'), join(backup, 'baseline.json'));
    await rename(join(scope, 'vfs.mjs'), join(backup, 'vfs.mjs'));
    await rename(join(update.folder, 'candidate/baseline'), join(scope, 'baseline'));
    await rename(join(update.folder, 'candidate/baseline.json'), join(scope, 'baseline.json'));
    await rename(join(update.folder, 'candidate/vfs.mjs'), join(scope, 'vfs.mjs'));
    update.status = 'applied';
    update.backup = backup;
    update.appliedAt = new Date().toISOString();
    await writeFile(pointer, JSON.stringify(update, null, 2), { mode: 0o600 });
    console.log(
      JSON.stringify({
        applied: true,
        revision: update.revision,
        backup,
        changedBookFiles: update.migration.changed,
        unchangedBookFiles: update.unchangedBookFiles,
        productionSwitched: false,
      }),
    );
  }
}
