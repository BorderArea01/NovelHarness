import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function leaseFile(runtime, dataDirectory) {
  const id = createHash('sha256').update(resolve(dataDirectory)).digest('hex');
  return join(runtime, 'services', id + '.json');
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid installation lease PID.');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
export async function ensureInstallationIdle(runtime) {
  const dir = join(runtime, 'services');
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Unknown installation lease file.');
    let value;
    try {
      value = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (alive(value.pid)) throw new Error('该构建仍有服务运行；请先停稳所有使用它的实例再构建。');
    await unlink(join(dir, name));
  }
}
export async function claimInstallationLease(runtime, dataDirectory, mode) {
  // Old anonymous hosts used one installation-wide lock. Respect that lock
  // during upgrade; new hosts may share immutable code with separate stores.
  const legacy = join(runtime, 'service.lock');
  try {
    if (alive(Number(await readFile(legacy, 'utf8')))) throw new Error('旧运行内核仍在使用该构建。');
    await unlink(legacy);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const path = leaseFile(runtime, dataDirectory);
  await mkdir(join(runtime, 'services'), { recursive: true });
  try {
    const previous = JSON.parse(await readFile(path, 'utf8'));
    if (alive(previous.pid)) throw new Error('该空间的安装租约仍在使用。');
    await unlink(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, mode, dataDirectory: resolve(dataDirectory), status: 'starting' }),
    { flag: 'wx', mode: 0o600 },
  );
  return {
    async ready(value) {
      await writeFile(path, JSON.stringify({ ...value, mode, dataDirectory: resolve(dataDirectory) }));
    },
    async release() {
      await unlink(path);
    },
  };
}
