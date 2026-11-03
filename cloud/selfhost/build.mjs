// Builds a separate installation. Never reads the owner's active.json or data.
import { cp, mkdir, readFile, writeFile, symlink, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve('data/anonymous-runtime');
await mkdir(root, { recursive: true });
try {
  const running = JSON.parse(await readFile(join(root, 'running.json'), 'utf8'));
  try {
    process.kill(running.pid, 0);
    throw new Error('Stop the anonymous service before rebuilding.');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function link(target, path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(resolve(target), path, 'junction');
  }
}
await mkdir(join(root, 'cloud/official'), { recursive: true });
await mkdir(join(root, 'cloud/tools'), { recursive: true });
await link('node_modules', join(root, 'node_modules'));
await link('cloud/tools/node_modules', join(root, 'cloud/tools/node_modules'));
for (const path of [
  'cloud/official/novel',
  'cloud/selfhost',
  'cloud/scripts',
  'cloud/host',
  'cloud/worker',
  'cloud/pages',
  'cloud/shared',
  'cloud/legal',
])
  await cp(resolve(path), join(root, path), {
    recursive: true,
    filter: (p) => !/(?:^|[\\/])(?:node_modules|\.wrangler)(?:[\\/]|$)/.test(p),
  });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(resolve(file), join(root, file));
for (const name of ['package.json', 'package-lock.json'])
  await cp(resolve('cloud/official', name), join(root, 'cloud/official', name));
const hash = createHash('sha256')
  .update(await readFile('cloud/official/package-lock.json'))
  .digest('hex');
async function run(file, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      shell: process.platform === 'win32' && file.endsWith('.cmd'),
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error('Setup step failed: ' + code)),
    );
  });
}
let installed;
try {
  installed = await readFile(join(root, '.dependencies'), 'utf8');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (installed !== hash) {
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    '--prefix',
    'cloud/official',
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--maxsockets=2',
  ]);
  await writeFile(join(root, '.dependencies'), hash);
}
await writeFile(
  join(root, '.anonymous-host.json'),
  JSON.stringify({ format: 'novelharness-anonymous-v1', prepared: false }),
);
await run(process.execPath, ['--max-old-space-size=384', 'cloud/selfhost/prepare.mjs']);
await rm(join(root, 'data/official-validation/integration/visitors', '0'.repeat(64)), {
  recursive: true,
  force: true,
});
console.log('Anonymous edition ready. Start with npm run start:public.');
