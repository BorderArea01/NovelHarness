import { mkdir, readFile, writeFile, readdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function claimDataDirectory(directory, mode) {
  if (!['isolated', 'shared'].includes(mode)) throw new Error('Unknown data-directory mode.');
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const pid = Number(await readFile(join(root, '.adoption.lock'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('迁移锁格式异常，未打开数据。');
    try {
      process.kill(pid, 0);
      throw new Error('数据正在登记迁移，请完成或恢复迁移后启动。');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const marker = join(root, '.novelharness-store.json');
  let saved;
  try {
    saved = JSON.parse(await readFile(marker, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (saved) {
    if (saved.format !== 'novelharness-store-v1' || saved.mode !== mode)
      throw new Error('数据目录属于另一种模式；请选择独立目录，不会自动转换或合并数据。');
  } else {
    const names = await readdir(root);
    // Preserve old anonymous installations without relabelling a private book
    // store. Existing shared stores require an explicit offline adoption.
    if (names.length && !(mode === 'isolated' && names.every((n) => /^[a-f0-9]{64}$/.test(n))))
      throw new Error('已有数据尚未登记。请先停稳旧服务并核验迁移，未打开或覆盖数据库。');
    await writeFile(marker, JSON.stringify({ format: 'novelharness-store-v1', mode }), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const path = join(root, '.service.lock');
  let lock;
  try {
    lock = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('数据锁格式异常，未启动第二个写入者。');
    try {
      process.kill(pid, 0);
      throw new Error('数据目录正在使用，禁止同时启动第二个服务。');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
    await unlink(path);
    lock = await open(path, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid));
  return {
    root,
    async release() {
      await lock.close();
      await unlink(path);
    },
  };
}

export async function sharedOwnerKey(root) {
  const path = join(root, 'owner-key.txt');
  try {
    const key = (await readFile(path, 'utf8')).trim();
    if (key.length < 32) throw new Error('恢复口令文件损坏，未更换密钥。');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('hex');
    await writeFile(path, key, { flag: 'wx', mode: 0o600 });
    return key;
  }
}

export async function visitorSigningKeys(root, legacyPath) {
  const path = join(root, 'visitor-secret.json');
  let keys;
  try {
    keys = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (legacyPath) {
      try {
        keys = JSON.parse(await readFile(legacyPath, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    keys ??= { secret: randomBytes(32).toString('hex'), deployment: randomBytes(8).toString('hex') };
    if (!/^[a-f0-9]{64}$/.test(keys.secret) || !/^[a-f0-9]{16}$/.test(keys.deployment))
      throw new Error('访客签名密钥损坏，未生成替代密钥。');
    await writeFile(path, JSON.stringify(keys), { flag: 'wx', mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(keys.secret) || !/^[a-f0-9]{16}$/.test(keys.deployment))
    throw new Error('访客签名密钥损坏，未生成替代密钥。');
  return keys;
}
