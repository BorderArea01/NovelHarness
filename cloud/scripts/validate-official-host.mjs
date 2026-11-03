// An isolated, replayable official-host compatibility lab. Never a launcher for
// production. Source SQLite is opened read-only; all execution uses a fresh home.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, symlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { privateDirectory } from './private-directory.mjs';

const repository = resolve('.');
const install = resolve('cloud/official');
const modules = join(install, 'node_modules');
const lab = resolve('data/official-validation');
const home = join(lab, 'home');
const work = join(lab, 'work');
const report = {
  format: 'novel-official-host-lab-v1',
  at: new Date().toISOString(),
  productionSwitched: false,
  productionWrites: 0,
  realModelCalls: 0,
  complete: false,
};
await privateDirectory(lab);
for (const folder of [
  home,
  work,
  join(lab, 'user'),
  join(lab, 'temp'),
  join(lab, 'documents'),
  join(home, 'profiles/web'),
])
  await mkdir(folder, { recursive: true });
// Deliberately do not inherit provider keys, proxy credentials, real user home,
// NODE_OPTIONS preload hooks, or any production host configuration.
const env = Object.fromEntries(
  ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
Object.assign(env, {
  PATH: [dirname(process.execPath), join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(
    ';',
  ),
  USERPROFILE: join(lab, 'user'),
  HOME: join(lab, 'user'),
  APPDATA: join(lab, 'user/AppData/Roaming'),
  LOCALAPPDATA: join(lab, 'user/AppData/Local'),
  TEMP: join(lab, 'temp'),
  TMP: join(lab, 'temp'),
  DSH_HOME: home,
  DSH_BASE: join(modules, '@deepseek-ai'),
  DSH_SURFACE: 'web',
  DSH_PROFILE: 'web',
  DSH_TELEMETRY_DISABLED: '1',
  NOVEL_OFFICIAL_LAB: lab,
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => {
  const rel = relative(root, resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const children = new Set();
async function child(file, args = [], timeout = 45000, heap = 192) {
  const proc = spawn(process.execPath, ['--max-old-space-size=' + heap, file, ...args], {
    cwd: work,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(proc);
  let out = '',
    err = '';
  proc.stdout.on('data', (data) => {
    out = (out + data).slice(-100000);
  });
  proc.stderr.on('data', (data) => {
    err = (err + data).slice(-100000);
  });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const code = await new Promise((ok, bad) => {
      proc.once('error', bad);
      proc.once('exit', ok);
    });
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    children.delete(proc);
  }
}
try {
  const activeBytes = await readFile('data/local-host/active.json');
  const active = JSON.parse(activeBytes);
  report.productionRelease = active.revision;
  const response = await fetch('http://127.0.0.1:3211/api/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  report.productionHealthyBefore = true;
  // A separate SQLite online backup: no login, source pause, export endpoint,
  // checkpoint, owner-key read or alteration of the active release pointer.
  const root = join(active.candidate, 'storage/do');
  const namespaces = (await readdir(root)).filter((name) => name.endsWith('-main'));
  assert.equal(namespaces.length, 1);
  const dir = join(root, namespaces[0]);
  const sources = (await readdir(dir)).filter((name) => /^[a-f0-9]{64}\.sqlite$/.test(name));
  assert.equal(sources.length, 1);
  const backup = join(lab, 'source-main.sqlite');
  if (!existsSync(backup)) {
    const source = new Database(join(dir, sources[0]), { readonly: true, fileMustExist: true });
    try {
      await source.backup(backup);
    } finally {
      source.close();
    }
  }
  report.sourceSnapshotAt = (await stat(backup)).mtime.toISOString();
  const db = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    const rows = db
      .prepare(
        `WITH RECURSIVE tree(inode,path) AS (
      SELECT 1,'' UNION ALL SELECT d.child_inode,t.path || '/' || d.name
      FROM vfs_dirents d JOIN tree t ON d.parent_inode=t.inode
    ) SELECT t.path,n.* FROM tree t JOIN vfs_nodes n ON t.inode=n.inode`,
      )
      .all();
    const files = rows.filter((row) => row.type === 'file' && row.path.startsWith('/workspace/novels/'));
    let bytes = 0,
      collisions = 0,
      invalidWindowsPaths = 0,
      missingBytes = 0;
    const names = new Set();
    const manifest = [];
    const physicalRoot = join(lab, 'book-files');
    let copiedFiles = 0;
    for (const file of files) {
      const key = file.path
        .toLowerCase()
        .split('/')
        .map((p) => p.replace(/[. ]+$/g, ''))
        .join('/');
      if (names.has(key)) collisions++;
      else names.add(key);
      if (
        file.path
          .split('/')
          .some(
            (p) =>
              /[<>:"\\|?*\u0000-\u001f]/.test(p) ||
              /[. ]$/.test(p) ||
              /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
          )
      )
        invalidWindowsPaths++;
      const parts = db
        .prepare(
          'SELECT b.bytes FROM vfs_chunks c JOIN vfs_blob_bytes b ON b.hash=c.hash WHERE c.inode=? ORDER BY c.idx',
        )
        .all(file.inode);
      const data = Buffer.concat(parts.map((p) => p.bytes));
      if (data.length !== file.size) missingBytes++;
      bytes += data.length;
      if (names.size && collisions === 0 && invalidWindowsPaths === 0 && missingBytes === 0) {
        const target = resolve(physicalRoot, '.' + file.path);
        assert(inside(physicalRoot, target), 'Book-copy destination escapes the lab.');
        await mkdir(dirname(target), { recursive: true });
        if (!existsSync(target)) await writeFile(target, data, { flag: 'wx', mode: 0o600 });
        assert.equal(sha(await readFile(target)), sha(data));
        copiedFiles++;
      }
      manifest.push({ pathHash: sha(file.path), bytes: data.length, sha256: sha(data) });
    }
    report.source = {
      backedUp: true,
      sqliteIntegrity: true,
      books: new Set(files.map((f) => f.path.split('/')[3])).size,
      files: files.length,
      bytes,
      windowsCaseCollisions: collisions,
      invalidWindowsPaths,
      physicalCopyFilesVerified: copiedFiles,
      incompleteFileBytes: missingBytes,
      links: rows.filter((r) => r.type === 'symlink' && r.path.startsWith('/workspace/novels/')).length,
      sessions: db.prepare('SELECT count(*) AS n FROM dsh_sessions').get().n,
      events: db.prepare('SELECT count(*) AS n FROM dsh_session_events').get().n,
      attachments: db
        .prepare('SELECT count(*) AS count,sum(bytes) AS bytes FROM dsh_edge_attachment_objects')
        .get(),
      sessionVersions: db.prepare('SELECT version,count(*) AS n FROM dsh_sessions GROUP BY version').all(),
    };
    let verifiedAttachments = 0;
    const attachmentRoot = join(lab, 'attachment-copy');
    await mkdir(attachmentRoot, { recursive: true });
    for (const item of db.prepare('SELECT * FROM dsh_edge_attachment_objects').all()) {
      assert.match(item.digest, /^[a-f0-9]{64}$/);
      const chunks = db
        .prepare(
          'SELECT chunk_index,data FROM dsh_edge_attachment_chunks WHERE digest=? ORDER BY chunk_index',
        )
        .all(item.digest);
      assert.equal(chunks.length, item.chunks);
      chunks.forEach((chunk, index) => assert.equal(chunk.chunk_index, index));
      const data = Buffer.concat(chunks.map((chunk) => chunk.data));
      assert.equal(data.length, item.bytes);
      assert.equal(sha(data), item.digest);
      const target = join(attachmentRoot, item.digest + '.bin');
      if (!existsSync(target)) await writeFile(target, data, { flag: 'wx', mode: 0o600 });
      assert.equal(sha(await readFile(target)), item.digest);
      verifiedAttachments++;
    }
    report.source.attachments.copiesVerified = verifiedAttachments;
    await writeFile(join(lab, 'source-files-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  } finally {
    db.close();
  }
  const profile = join(home, 'profiles/web');
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'dsh-purge': '1.1.82' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-purge'] } },
      },
      null,
      2,
    ),
  );
  if (!existsSync(join(profile, 'node_modules')))
    await symlink(modules, join(profile, 'node_modules'), 'junction');
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    [
      '- insert:',
      '    - id: dsh-purge',
      '      name: dsh-purge',
      '      inject: [systemPrompt, tools]',
      '      config:',
      '        enabled: true',
      '        autoApplyOnStart: false',
      '        autoUpdateOnStart: false',
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: ${JSON.stringify(join(home, 'sessions'))}`,
      '    compression: none',
      '- id: session-log-deepseek',
      '  disabled: true',
      '- id: workspace-controller',
      '  config:',
      `    documentsDirectory: ${JSON.stringify(join(lab, 'documents'))}`,
      '- id: desktop-product-telemetry',
      '  disabled: true',
      '- id: product-analytics',
      '  disabled: true',
      '',
    ].join('\n'),
  );
  const cli = join(modules, '@deepseek-ai/dsh/lib/bin.js');
  const version = await child(cli, ['--version']);
  assert.equal(version.code, 0, version.err);
  assert.match(version.out, /0\.2\.1-rc\.2/);
  report.officialVersion = '0.2.1-rc.2';
  const patchResult = await child(resolve('cloud/scripts/official-patch-lab.mjs'));
  await writeFile(join(lab, 'patch-diagnostics.log'), patchResult.out + '\n' + patchResult.err, {
    mode: 0o600,
  });
  assert.equal(patchResult.code, 0, 'Isolated patch probe failed; see private diagnostics.');
  report.patches = JSON.parse(await readFile(join(lab, 'patch-report.json'), 'utf8'));
  await writeFile(join(lab, 'session-report.json'), JSON.stringify({ complete: false, pending: true }));
  const sessions = await child(resolve('cloud/scripts/official-session-lab.mjs'), [], 90000);
  await writeFile(join(lab, 'session-diagnostics.log'), sessions.out + '\n' + sessions.err, { mode: 0o600 });
  if (existsSync(join(lab, 'session-report.json')))
    report.conversationReplay = JSON.parse(await readFile(join(lab, 'session-report.json'), 'utf8'));
  if (sessions.code !== 0)
    report.conversationReplay = { ...report.conversationReplay, complete: false, exitCode: sessions.code };
  // Invalidate prior successful receipts BEFORE starting a new probe. A timeout,
  // abort or native crash must never inherit stale success from an earlier run.
  await writeFile(join(lab, 'boot-report.json'), JSON.stringify({ passed: false, pending: true }));
  const boot = await child(resolve('cloud/scripts/official-boot-lab.mjs'), [], 90000, 384);
  await writeFile(join(lab, 'boot-diagnostics.log'), boot.out + '\n' + boot.err, { mode: 0o600 });
  report.boot = { passed: boot.code === 0, diagnostic: 'boot-diagnostics.log' };
  if (existsSync(join(lab, 'boot-report.json')))
    report.boot = JSON.parse(await readFile(join(lab, 'boot-report.json'), 'utf8'));
  if (boot.code !== 0) report.boot = { ...report.boot, passed: false, exitCode: boot.code };
  // Original official host has no novel HTTP gateway, VFS transaction adapter,
  // PIN wrapper, or custom book tools. Do not declare these ported by installing.
  report.migration = {
    readyToSwitch: false,
    novelToolsPorted: false,
    atomicManuscriptStoragePorted: false,
    isolatedConversationsImported: report.conversationReplay?.complete === true,
    liveConversationsImported: false,
    pinGatewayPorted: false,
    reason: 'Official-host installation is not a migration of Edge VFS, book APIs or novel UI.',
  };
  assert.deepEqual(await readFile(resolve(repository, 'data/local-host/active.json')), activeBytes);
  const after = await fetch('http://127.0.0.1:3211/api/health', { signal: AbortSignal.timeout(10000) });
  report.productionHealthyAfter = after.status === 200;
  report.productionPointerUnchanged = true;
  report.complete = report.boot.passed === true && report.conversationReplay?.complete === true;
  if (!report.complete) process.exitCode = 1;
} catch (error) {
  report.failure = String(error.message).slice(0, 1000);
  process.exitCode = 1;
} finally {
  for (const proc of children) proc.kill();
  await writeFile(join(lab, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        ...report,
        patches: report.patches && {
          ...report.patches,
          rows: undefined,
          statuses: Object.fromEntries(
            [...new Set(report.patches.rows.map((row) => row.status))].map((status) => [
              status,
              report.patches.rows.filter((row) => row.status === status).length,
            ]),
          ),
        },
      },
      null,
      2,
    ),
  );
}
