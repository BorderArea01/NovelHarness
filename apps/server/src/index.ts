import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { openDatabase } from './db.js';
import { loadOrCreateKey } from './crypto.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { runBackup } from './backup.js';

const host = process.env.HOST ?? '0.0.0.0',
  port = Number(process.env.PORT ?? 3210),
  dataDir = resolve(process.env.DATA_DIR ?? 'data');
const dbPath = resolve(dataDir, 'novel-writer.sqlite'),
  keyPath = resolve(dataDir, 'server.key');
const db = openDatabase(dbPath),
  key = loadOrCreateKey(keyPath),
  store = new Store(db, key),
  app = createApp(db, store);

await runBackup(db, dataDir, keyPath).catch((error) => console.error('备份失败', error));
setInterval(
  () => runBackup(db, dataDir, keyPath).catch((error) => console.error('备份失败', error)),
  60 * 60 * 1000,
).unref();
const server = app.listen(port, host, () => {
  console.log(`小说写作服务已启动: http://127.0.0.1:${port}`);
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? [])
      if (address.family === 'IPv4' && !address.internal)
        console.log(`局域网访问: http://${address.address}:${port}`);
  if (!store.isSetup()) console.log('首次运行：请在主机本机打开页面设置四位 PIN。');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
