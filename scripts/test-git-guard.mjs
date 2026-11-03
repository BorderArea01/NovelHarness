import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const hook = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url));
const gitExec = process.platform === 'win32' ? execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim() : '';
const shell = process.platform === 'win32'
  ? [resolve(gitExec, '../../../bin/sh.exe'), resolve(gitExec, '../../../usr/bin/sh.exe')].find(existsSync)
  : 'sh';
assert(shell, 'The Git distribution must provide its POSIX shell.');
const sha = 'a'.repeat(40), old = 'b'.repeat(40);
for (const [target, allowed] of [
  ['refs/heads/main', false], ['refs/heads/master', false],
  ['refs/heads/release', false], ['refs/heads/release/v5', false],
  ['refs/heads/fix/search', true], ['refs/heads/chore/ci-publish-guard', true],
]) {
  const result = spawnSync(shell, [hook, 'origin', 'https://github.com/example/project.git'], {
    input: `refs/heads/work ${sha} ${target} ${old}\n`, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, allowed ? 0 : 1, target + ': ' + result.stderr);
}
const deletion = spawnSync(shell, [hook], { input: `(delete) ${'0'.repeat(40)} refs/heads/main ${old}\n`, encoding: 'utf8', windowsHide: true });
assert.equal(deletion.status, 1, 'Shared-branch deletion must also be blocked.');
console.log('Push guard passed: feature branches allowed; shared updates and deletion refused. No remote push performed.');
