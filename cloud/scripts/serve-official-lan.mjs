// Explicitly owner-authorized LAN preview. Never reads/writes active.json,
// production storage, the public relay, firewall or EasyTier configuration.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { startNovelWeb } from '../official/novel/web.mjs';

const root = resolve('data/official-validation/integration/lan-staging');
const home = join(root, 'home');
const report = JSON.parse(await readFile(join(root, 'staging.json'), 'utf8'));
assert.equal(report.status, 'prepared');
const ownerKey = (await readFile(join(root, 'owner-key.txt'), 'utf8')).trim();
const hosts = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && !n.internal && n.family === 'IPv4')
  .map((n) => n.address);
let app,
  web,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (web) await web.close();
  if (app) await app.shutdown.shutdown(0);
}
process.on('SIGTERM', () => stop().then(() => process.exit(0)));
process.on('SIGINT', () => stop().then(() => process.exit(0)));
try {
  const baseline = JSON.parse(
    await readFile(resolve('data/official-validation/integration/baseline.json'), 'utf8'),
  );
  app = await startOfficialNovel({ sqlite: join(root, 'main.sqlite'), home, staging: true });
  assert.equal(
    app.ctx.get('agents').list().length,
    0,
    'Staging must not automatically resume paid AI turns.',
  );
  web = await startNovelWeb(app, { ownerKey, home, lanHosts: hosts, port: 3212 });
  await writeFile(
    join(root, 'running.json'),
    JSON.stringify({
      pid: process.pid,
      port: 3212,
      readyAt: new Date().toISOString(),
      hosts,
      origin: web.origin,
      novelAssetsRevision: baseline.novelAssetsRevision,
      sourceRevision: baseline.sourceRelease,
      productionSwitched: false,
    }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ready: true, port: 3212, productionSwitched: false }));
} catch (error) {
  await writeFile(
    join(root, 'boot-failure.json'),
    JSON.stringify({ name: error.name, code: error.code ?? null }),
    { mode: 0o600 },
  );
  console.error('LAN staging did not become ready. Production remains unchanged.');
  await stop();
  process.exitCode = 1;
}
