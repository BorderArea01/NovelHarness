import { spawn } from 'node:child_process';
// Sequential: both modes consume the SAME build and never overlap hosts/tests.
for (const script of ['isolation.test.mjs', 'shared.test.mjs']) {
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--max-old-space-size=192', 'cloud/selfhost/' + script], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', fail);
    child.once('exit', (code) => (code === 0 ? done() : fail(new Error(script + ' failed: ' + code))));
  });
}
