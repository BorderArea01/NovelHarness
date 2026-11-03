// Provider seam regression, in addition to model/tool-loop tests.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DefenseInDepthBox } from '../official/node_modules/just-bash/dist/bundle/index.js';

export async function verifyOfficialNovelFilesystem({ ctx, storage, root, service }) {
  const fs = ctx.get('fs');
  const path = root + '/chapters/provider-check.md';
  const target = await fs.resolve(path);
  assert.equal(await fs.stat(target), undefined);
  const original = '# 工具测试\n\n她停了停，问：“你认得这封信吗？”\n';
  const first = await fs.writeText(target, original, { kind: 'createIfAbsent' });
  assert.equal(first.operation, 'create');
  assert.equal(service.run({ kind: 'read', path: 'chapters/provider-check.md' }).text, original);
  await assert.rejects(
    () => fs.writeText(target, '不能覆盖', { kind: 'createIfAbsent' }),
    (error) => error.code === 'FS_NOT_OBSERVED',
  );
  const next = original.replace('停了停', '后退了一步');
  await fs.writeText(target, next, { kind: 'replaceIfVersion', version: first.version });
  await assert.rejects(
    () => fs.writeText(target, '过期修改', { kind: 'replaceIfVersion', version: first.version }),
    (error) => error.code === 'FS_STALE_VERSION',
  );
  const historyHash = first.version.slice('doc:'.length);
  assert.equal(
    service.run({ kind: 'history', path: 'chapters/provider-check.md', hash: historyHash }).text,
    original,
  );
  const current = await fs.stat(target);
  await fs.editText(
    target,
    { oldString: '后退了一步', newString: '抬起了眼' },
    { kind: 'replaceIfVersion', version: current.version },
  );
  const edited = next.replace('后退了一步', '抬起了眼');
  assert.equal(await fs.readText(target), edited);
  assert.deepEqual(
    Buffer.from(await fs.readByteRange(target, { offset: 5, length: 18 })),
    Buffer.from(edited).subarray(5, 23),
  );
  await assert.rejects(
    () => fs.readBytes(target, undefined, 4),
    (error) => error.code === 'FS_TOO_LARGE',
  );
  const streamed = await fs.streamText(target);
  let body = '';
  for await (const part of streamed) body += part;
  assert.equal(body, edited);

  const alias = root + '/chapter-link';
  storage.fs.symlinkSync(root + '/chapters', alias);
  assert.equal((await fs.resolve(alias + '/provider-check.md')).targetKey, target.targetKey);
  const missingAlias = await fs.resolve(alias + '/alias-created.md');
  assert.equal(missingAlias.targetKey, (await fs.resolve(root + '/chapters/alias-created.md')).targetKey);
  await fs.writeText(missingAlias, '# 同一目标\n\n从别名创建的章节。\n', { kind: 'createIfAbsent' });
  assert.equal(
    service.run({ kind: 'read', path: 'chapters/alias-created.md' }).text,
    '# 同一目标\n\n从别名创建的章节。\n',
  );

  let changes = 0,
    watcherError;
  const close = await fs.watch(
    target,
    (error) => {
      if (error) watcherError = error;
      else changes++;
    },
    new AbortController().signal,
  );
  try {
    await fs.writeText(target, edited + '\n她等着回答。\n');
    const deadline = Date.now() + 3000;
    while (!changes && Date.now() < deadline) await delay(30);
    assert.ifError(watcherError);
    assert(changes > 0, 'SQLite VFS invalidations did not reach the official watcher.');
  } finally {
    await close();
  }

  // A multipart chapter is one logical document for native reads and writes.
  const large = '# 分片章节\n\n' + '夜雨中的来信与脚步声。'.repeat(21000);
  const largePath = 'chapters/multipart-check.md';
  const saved = service.run({ kind: 'save', path: largePath, text: large, expectedHash: null });
  assert(saved.parts?.length > 1);
  const logical = await fs.resolve(root + '/' + largePath);
  assert.equal(await fs.readText(logical), large);
  assert.equal((await fs.stat(logical)).size, Buffer.byteLength(large));
  const shell = ctx.get('shell');
  const largeRead = await shell.execute(
    shell.resolve({
      command: 'cat chapters/multipart-check.md',
      workdir: root,
      stdoutMaxBytes: 2 * 1024 * 1024,
    }),
  );
  assert.equal((await largeRead.result()).stdout.text, large);
  await fs.writeText(logical, '# 缩短后\n\n分片原稿仍在历史中。\n');
  assert.equal(service.run({ kind: 'history', path: largePath, hash: saved.hash }).text, large);

  // Incident regression: upstream shell byte strings must not be UTF-8 encoded
  // twice when redirected to the same logical SQLite manuscript provider.
  const encodingPath = 'chapters/shell-encoding-check.md';
  const encodingBody =
    '\ufeff# 第一章\r\n\r\n她抬头，看见来人。🌧️ café\r\n' +
    '长篇改写的每一个中文字符都必须原样保存。\r\n'.repeat(10000);
  const encodingSaved = service.run({
    kind: 'save',
    path: encodingPath,
    text: encodingBody,
    expectedHash: null,
  });
  const runShell = async (command) =>
    (await shell.execute(shell.resolve({ command, workdir: root }))).result();
  const encodingResult = await runShell(
    `cp ${encodingPath} /tmp/encoding-copy.md; cp /tmp/encoding-copy.md ${encodingPath}; cat /tmp/encoding-copy.md > ${encodingPath}; ` +
      `cat ${encodingPath} | tee /tmp/encoding-tee.md > /dev/null; cat /tmp/encoding-tee.md > ${encodingPath}`,
  );
  assert.equal(encodingResult.exitCode, 0, encodingResult.stderr.text);
  assert.equal(service.run({ kind: 'read', path: encodingPath }).hash, encodingSaved.hash);
  assert.equal(await fs.readText(await fs.resolve(root + '/' + encodingPath)), encodingBody);
  const changed = await runShell(
    `printf '\\347\\254\\254\\344\\270\\200\\347\\253\\240\\n' > ${encodingPath}`,
  );
  assert.equal(changed.exitCode, 0, changed.stderr.text);
  assert.equal(service.run({ kind: 'read', path: encodingPath }).text, '第一章\n');
  assert.equal(
    service.run({ kind: 'history', path: encodingPath, hash: encodingSaved.hash }).text,
    encodingBody,
  );
  const safe = service.run({ kind: 'read', path: encodingPath });
  await assert.rejects(
    () =>
      runShell(
        `printf '/w==' | base64 -d > /tmp/encoding-invalid.bin; cat /tmp/encoding-invalid.bin > ${encodingPath}`,
      ),
    /不是有效 UTF-8/,
  );
  assert.equal(service.run({ kind: 'read', path: encodingPath }).hash, safe.hash);
  storage.fs.writeFileSync('/tmp/encoding-oversize.md', '中'.repeat(710000));
  await assert.rejects(() => runShell(`cat /tmp/encoding-oversize.md > ${encodingPath}`), /2 MiB/);
  assert.equal(service.run({ kind: 'read', path: encodingPath }).hash, safe.hash);
  const cancelled = ctx.get('subprocess').spawn({
    argv: ['bash', '-c', `: > ${encodingPath}; sleep 1; printf late > ${encodingPath}`],
    cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
  });
  await delay(50);
  cancelled.terminate();
  assert.equal((await cancelled.done).signal, 'SIGTERM');
  assert.equal(service.run({ kind: 'read', path: encodingPath }).hash, safe.hash);
  const sameFile = await runShell(`cp ${encodingPath} chapter-link/shell-encoding-check.md`);
  assert.notEqual(sameFile.exitCode, 0);
  assert.equal(service.run({ kind: 'read', path: encodingPath }).hash, safe.hash);
  const cleared = await runShell(`: > ${encodingPath}`);
  assert.equal(cleared.exitCode, 0);
  const empty = service.run({ kind: 'read', path: encodingPath });
  assert.equal(empty.text, '', 'An explicit intentional empty write must still work.');
  service.run({ kind: 'save', path: encodingPath, text: encodingBody, expectedHash: empty.hash });
  const replacement = await runShell(
    `sed 's/她抬头/他回头/g' ${encodingPath} > /tmp/encoding-sed.md; cat /tmp/encoding-sed.md > ${encodingPath}`,
  );
  assert.equal(replacement.exitCode, 0, replacement.stderr.text);
  const replaced = service.run({ kind: 'read', path: encodingPath });
  assert(replaced.text.includes('他回头，看见来人。🌧️ café'));
  assert(replaced.text.endsWith('长篇改写的每一个中文字符都必须原样保存。\r\n'));

  const execution = await shell.execute(
    shell.resolve({ command: 'printf "temporary-output" > /tmp/novel-provider-check.txt', workdir: root }),
  );
  assert.equal((await execution.result()).exitCode, 0);
  assert.equal(await fs.readText(await fs.resolve('/tmp/novel-provider-check.txt')), 'temporary-output');
  const failure = await ctx.get('subprocess').spawn({
    argv: ['rg', '--json', '--regexp=[', '--', 'chapters'],
    cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
    graceMs: 100,
  });
  assert.equal((await failure.done).exitCode, 2, 'Malformed patterns must not be reported as no-match.');
  // Exercise the native read-only preview service too, not just model tools.
  const preview = ctx.get('workspaceFiles');
  const scope = { workspaceRoot: root };
  const signal = new AbortController().signal;
  const page = await preview.read(scope, 'chapters/provider-check.md', {}, signal);
  assert(page.text.includes('她等着回答。'));
  const sentinel = join(process.env.DSH_HOME, 'host-boundary-sentinel.txt');
  await writeFile(sentinel, 'isolated-host-file-must-not-be-exposed');
  for (const escaped of [
    sentinel,
    'C:/Windows/win.ini',
    '/etc/passwd',
    '/workspace/../../outside-vfs',
    '../outside-vfs',
  ]) {
    await assert.rejects(
      () => fs.resolve(escaped, { cwd: '/workspace' }),
      (error) => error.code === 'FS_OUTSIDE_WORKSPACE',
    );
  }
  await assert.rejects(
    () => preview.read(scope, sentinel, {}, signal),
    (error) => error.code === 'FS_OUTSIDE_WORKSPACE',
  );
  const foreignTarget = { targetKey: sentinel, displayPath: sentinel };
  for (const operation of [
    () => fs.readText(foreignTarget),
    () => fs.stat(foreignTarget),
    () => fs.writeText(foreignTarget, 'must not overwrite'),
    () => fs.listDir(foreignTarget),
  ])
    await assert.rejects(operation, (error) => error.code === 'FS_OUTSIDE_WORKSPACE');
  storage.fs.symlinkSync('/outside-vfs', root + '/outside-link');
  await assert.rejects(
    () => fs.resolve(root + '/outside-link/secret.txt'),
    (error) => error.code === 'FS_OUTSIDE_WORKSPACE',
  );
  assert.equal(fs.processPathFromHostPath(sentinel), undefined);
  const subprocess = ctx.get('subprocess');
  assert.throws(
    () =>
      subprocess.spawn({
        argv: ['node', '-e', 'process.exit(0)'],
        cwd: process.env.DSH_HOME,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
        graceMs: 100,
      }),
    /outside the novel SQLite execution world/,
  );
  assert.throws(() => subprocess.spawnTerminal({ cwd: process.env.DSH_HOME }), /OS terminal/);
  assert.equal(await readFile(sentinel, 'utf8'), 'isolated-host-file-must-not-be-exposed');
  const blank = await ctx.get('sessionController').create({});
  const blankAgent = ctx.get('agents').get(blank.sessionId);
  assert.equal(ctx.get('workingDirectory').get(blankAgent.session), '/workspace');
  const picker = ctx.get('directoryPicker').capability();
  assert.equal(picker.kind, 'browse');
  const folders = await picker.list();
  assert.equal(folders.path, '/workspace');
  assert.equal(folders.home, '/workspace');
  assert(folders.entries.some((entry) => entry.name === 'novels'));
  assert(folders.crumbs.every((entry) => entry.path.startsWith('/workspace')));
  const created = await picker.createDirectory('/tmp', 'picker-check');
  assert.equal(created, '/tmp/picker-check');
  assert(storage.fs.statSync(created).isDirectory());
  await assert.rejects(
    () => picker.createDirectory('/tmp', 'picker-check'),
    (error) => error.code === 'directory-exists',
  );
  for (const outside of [process.env.DSH_HOME, '/etc', '/workspace/../../outside-vfs']) {
    await assert.rejects(
      () => picker.list(outside),
      (error) => error.code === 'directory-unreadable',
    );
    await assert.rejects(
      () => picker.createDirectory(outside, 'must-not-create'),
      (error) => error.code === 'directory-create-failed',
    );
  }
  await assert.rejects(
    () => picker.createDirectory('/tmp', '../escape'),
    (error) => error.code === 'directory-create-failed',
  );
  const outsideSessionDir = join(process.env.DSH_HOME, 'must-not-create-from-session');
  await assert.rejects(() => ctx.get('sessionController').create({ cwd: outsideSessionDir }));
  await assert.rejects(
    () => stat(outsideSessionDir),
    (error) => error.code === 'ENOENT',
  );
  await assert.rejects(() =>
    ctx.get('workspaceRegistry').create(process.env.DSH_HOME, 'must-not-register-host-directory'),
  );
  await assert.rejects(() =>
    ctx.get('workspaceRegistry').create('/outside-vfs', 'must-not-register-unmapped-directory'),
  );
  const defense = DefenseInDepthBox.getInstance();
  assert.equal(defense.getStatus().state, 'enabled', 'Shell secondary defenses were not enabled.');
  assert.equal(defense.getStats().refCount, 0, 'Shell defense context leaked past settled commands.');
  assert.equal(DefenseInDepthBox.isInSandboxedContext(), false);
  return {
    versionConflictRejected: true,
    genericWritePreservesOriginalHistory: true,
    literalEditAndBoundedReads: true,
    symlinkIdentityShared: true,
    watchersInvalidate: true,
    multipartReadWriteAndHistory: true,
    shellTemporaryFilesReadable: true,
    chineseShellRewritesByteExact: true,
    octalUtf8PrintfRoundtrip: true,
    invalidUtf8DoesNotOverwriteManuscript: true,
    searchFailureNotNoMatch: true,
    nativeWorkspacePreviewUsesSameDocuments: true,
    physicalHostFilesystemFallbackRemoved: true,
    physicalHostProcessFallbackRemoved: true,
    defaultWorkspaceIsVirtual: true,
    nativeDirectoryBrowserUsesSameVirtualFilesystem: true,
    nativeSessionAndWorkspaceCommandsConfinedToVfs: true,
    shellSecondaryDefenseEnabledAndReleased: true,
  };
}
