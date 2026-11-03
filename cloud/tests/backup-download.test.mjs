import test from 'node:test';
import assert from 'node:assert/strict';
import { backupDownload } from './backup-download.mjs';
function fixture(progress) {
  let listener,
    time = 0,
    step = 0;
  const page = {
    url: () => 'http://127.0.0.1:8792',
    on(_name, fn) {
      listener = fn;
    },
    off() {
      listener = null;
    },
    locator: () => ({ evaluate: async () => progress(step) }),
  };
  const options = {
    now: () => time,
    pause: async () => {
      time += 1000;
      step++;
      if (step === 22) listener?.('real-event');
    },
  };
  return { page, options, listener: () => listener };
}
test('backup waits for real download while progress advances, not an arbitrary 15s total; listeners release', async () => {
  const f = fixture((step) => ({ text: '复核备份 ' + step + ' / 200', failed: false }));
  assert.equal(await backupDownload(f.page, async () => {}, f.options), 'real-event');
  assert.equal(f.listener(), null);
});
test('backup still fails after 15s without progress and immediately on genuine application errors', async () => {
  const f = fixture(() => ({ text: '读取备份 1 / 200', failed: false }));
  await assert.rejects(
    backupDownload(f.page, async () => {}, f.options),
    /progress stalled/,
  );
  assert.equal(f.listener(), null);
  const g = fixture(() => ({ text: '文件已在另一设备更新', failed: true }));
  await assert.rejects(
    backupDownload(g.page, async () => {}, g.options),
    /另一设备更新/,
  );
});
