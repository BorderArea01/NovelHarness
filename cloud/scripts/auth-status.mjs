import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existingProxyEnvironment } from './verification-transport.mjs';

const cli = fileURLToPath(new URL('../tools/node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(process.execPath, ['--max-old-space-size=384', cli, 'whoami', '--json'], {
  windowsHide: true,
  env: { ...process.env, ...(await existingProxyEnvironment()), WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output = (output + String(chunk)).slice(-32000);
});
// Deliberately do not echo account email, IDs, permissions or credential-store output.
child.stderr.on('data', () => {});
child.on('error', () => {
  console.log(JSON.stringify({ authenticated: false, status: 'not-verified' }));
  process.exitCode = 1;
});
child.on('exit', (code) => {
  try {
    const text = output.replace(/\u001b\[[0-9;]*m/g, '');
    const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    console.log(
      JSON.stringify({
        authenticated: code === 0 && data.loggedIn === true,
        status: data.loggedIn === false ? 'login-required' : code === 0 ? 'authenticated' : 'not-verified',
        ...(code === 0 ? { accountCount: Array.isArray(data.accounts) ? data.accounts.length : 0 } : {}),
      }),
    );
  } catch {
    console.log(JSON.stringify({ authenticated: false, status: 'not-verified' }));
  }
});
