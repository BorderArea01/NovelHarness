// Read-only propagation wait within one explicitly started deployment task.
// Never re-upload, reset credentials or restart a failed/interrupted task.
export async function waitForDeploymentRevision(
  url,
  expected,
  fetcher,
  {
    timeoutMs = 45000,
    intervalMs = 1500,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onWaiting = () => {},
  } = {},
) {
  const deadline = now() + timeoutMs;
  let announced = false;
  while (true) {
    const response = await fetcher(url + '/api/platform/version', {
      signal: AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - now()))),
    });
    if (!response.ok) throw new Error(`Pages revision check failed (HTTP ${response.status}).`);
    const version = await response.json();
    if (version?.revision === expected) return version;
    if (typeof version?.revision !== 'string') throw new Error('Pages returned an invalid source revision.');
    if (now() >= deadline) throw new Error('Pages has not served the expected source revision yet.');
    if (!announced) {
      announced = true;
      onWaiting();
    }
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}
