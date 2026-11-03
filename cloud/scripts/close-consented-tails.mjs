// Close only temporary tail resources whose IDs occur in this incident's
// locally owned Wrangler tail-creation logs. Never delete unknown tails.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const state = JSON.parse(
  await readFile(new URL('../../data/cloud-platform/deployment.json', import.meta.url), 'utf8'),
);
const config = resolve(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml');
const token =
  process.env.CLOUDFLARE_API_TOKEN ||
  (await readFile(config, 'utf8')).match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if (!token) throw new Error('Existing credential unavailable.');
const endpoint =
  'https://api.cloudflare.com/client/v4/accounts/' +
  state.accountId +
  '/workers/scripts/' +
  state.workerName +
  '/tails';
async function call(url, method = 'GET') {
  const r = await fetch(url, {
    method,
    headers: { authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json();
  if (!r.ok || data.success === false) throw new Error('Tail control-plane request failed: ' + r.status);
  return data.result;
}
const listed = await call(endpoint),
  tails = Array.isArray(listed) ? listed : listed ? [listed] : [];
const directory = resolve(process.env.APPDATA, 'xdg.config/.wrangler/logs');
const logs = [];
for (const name of await readdir(directory)) {
  if (!/^wrangler-2026-10-27_17-(?:07|08|09|10|11).*\.log$/.test(name)) continue;
  const log = await readFile(resolve(directory, name), 'utf8');
  if (log.includes(state.workerName) && /tail/.test(log)) logs.push(log);
}
let removed = 0,
  unknown = 0;
for (const tail of tails) {
  if (!/^[a-f0-9]{32}$/.test(tail.id) || !logs.some((log) => log.includes(tail.id))) {
    unknown++;
    continue;
  }
  await call(endpoint + '/' + tail.id, 'DELETE');
  removed++;
}
console.log(
  JSON.stringify({
    removedOwnedTemporaryTails: removed,
    untouchedUnknownTails: unknown,
    remainingTails: (await call(endpoint))?.length ?? 0,
  }),
);
