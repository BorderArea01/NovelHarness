import assert from 'node:assert/strict';
// The full 200-file read+recheck may outlast one ordinary click deadline. Keep
// the ORIGINAL 15s stalled-progress bound, fail immediately on the app's error,
// and bound total time. No larger sample/heap, retry, re-download or fake event.
export async function backupDownload(
  page,
  start,
  { now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  let downloaded,
    previous = '',
    changed = now();
  const begun = changed,
    receive = (value) => {
      downloaded = value;
    };
  page.on('download', receive);
  try {
    await start();
    while (!downloaded) {
      const state = await page.locator('#status').evaluate((node) => ({
        text: node.textContent,
        failed: node.classList.contains('error'),
      }));
      if (state.failed) throw new Error('Backup failed: ' + state.text);
      if (state.text !== previous) {
        previous = state.text;
        changed = now();
      }
      if (now() - changed > 15000) throw new Error('Backup progress stalled: ' + previous);
      if (now() - begun > 90000) throw new Error('Backup exceeded the bounded full-transfer deadline.');
      await pause(100);
    }
    return downloaded;
  } finally {
    page.off('download', receive);
  }
}
