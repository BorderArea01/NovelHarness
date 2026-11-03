import type { NovelDb } from './db.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

export async function runBackup(
  db: NovelDb,
  dataDir: string,
  keyPath: string,
  force = false,
): Promise<string | null> {
  const dir = join(dataDir, 'backups'),
    day = new Date().toISOString().slice(0, 10),
    target = join(dir, `daily-${day}.sqlite`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(target) && !force) return null;
  await db.backup(target);
  copyFileSync(keyPath, join(dir, 'server.key'));
  const daily = readdirSync(dir)
    .filter((x) => /^daily-.*\.sqlite$/.test(x))
    .sort()
    .reverse();
  for (const old of daily.slice(7)) rmSync(join(dir, old));
  const date = new Date(),
    week = `${date.getUTCFullYear()}-${String(Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + new Date(Date.UTC(date.getUTCFullYear(), 0, 1)).getUTCDay() + 1) / 7)).padStart(2, '0')}`;
  const weekly = join(dir, `weekly-${week}.sqlite`);
  if (!existsSync(weekly)) copyFileSync(target, weekly);
  const weeks = readdirSync(dir)
    .filter((x) => /^weekly-.*\.sqlite$/.test(x))
    .sort()
    .reverse();
  for (const old of weeks.slice(4)) rmSync(join(dir, old));
  return basename(target);
}
