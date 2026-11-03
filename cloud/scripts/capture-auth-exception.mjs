// Explicit owner consent is required: Cloudflare live tail may reset DOs.
// No raw event/request/log objects are printed or persisted.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existingProxyEnvironment, verificationTransport } from './verification-transport.mjs';
if (!process.argv.includes('--owner-consented')) throw new Error('Explicit owner consent required.');
const state = JSON.parse(
  await readFile(new URL('../../data/cloud-platform/deployment.json', import.meta.url), 'utf8'),
);
const owner = (
  await readFile(new URL('../../data/cloud-platform/owner-key.txt', import.meta.url), 'utf8')
).trim();
const safe = (value) =>
  String(value ?? '')
    .replaceAll(owner, '[redacted]')
    .replace(/Bearer\s+\S+|sk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .slice(0, 1200);
const transport = await verificationTransport();
const child = spawn(
  process.execPath,
  [
    '--max-old-space-size=192',
    fileURLToPath(new URL('../tools/node_modules/wrangler/bin/wrangler.js', import.meta.url)),
    'tail',
    state.workerName,
    '--format',
    'json',
    '--status',
    'error',
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      ...(await existingProxyEnvironment()),
      CLOUDFLARE_ACCOUNT_ID: state.accountId,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let buffered = '',
  started = false,
  stderr = '',
  exceptions = 0,
  probeTask;
// JSON output intentionally has no connection banner in the pinned Wrangler.
// Generate two bounded anonymous requests while its socket is being opened.
const firstProbe = setTimeout(() => {
  probeTask = probe();
}, 5000);
const secondProbe = setTimeout(() => {
  probeTask = probe();
}, 15000);
async function probe() {
  for (const path of ['/api/auth/session', '/']) {
    try {
      const r = await transport.request(state.url + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.text();
      console.log(
        JSON.stringify({
          probe: path,
          status: r.status,
          ...(r.headers.get('content-type')?.includes('json') ? { response: safe(body) } : {}),
        }),
      );
    } catch (e) {
      console.log(JSON.stringify({ probe: path, error: safe(e.message) }));
    }
  }
}
function parse() {
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < buffered.length; i++) {
    const c = buffered[i];
    if (start < 0) {
      if (c === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const event = JSON.parse(buffered.slice(start, i + 1));
        started = true;
        for (const e of event.exceptions ?? []) {
          exceptions++;
          console.log(
            JSON.stringify({
              outcome: event.outcome,
              exception: { name: safe(e.name), message: safe(e.message) },
            }),
          );
        }
      } catch {}
      buffered = buffered.slice(i + 1);
      parse();
      return;
    }
  }
  if (buffered.length > 131072) buffered = '';
}
child.stdout.on('data', (chunk) => {
  const text = String(chunk);
  if (!started && /Connected to|Successfully created tail/i.test(text)) {
    started = true;
    console.log('Temporary error capture connected.');
    probeTask = probe();
  }
  buffered += text;
  parse();
});
child.stderr.on('data', (chunk) => {
  stderr = (stderr + String(chunk)).slice(-3000);
});
try {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 40000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (!started) {
    console.log(JSON.stringify({ connected: false, cliError: safe(stderr) }));
    process.exitCode = 1;
  } else {
    await probeTask;
    console.log(JSON.stringify({ captureFinished: true, exceptions }));
  }
} finally {
  clearTimeout(firstProbe);
  clearTimeout(secondProbe);
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
  }
  await transport.close();
}
