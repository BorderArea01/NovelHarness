import { request } from '@playwright/test';
// Same real localhost service and signed browser cookies, with a per-scenario
// HTTP lifetime. Disposing individual response bodies alone does not release
// every request/log object accumulated by a long-lived APIRequestContext.
export async function newFixtureApi(browserContext) {
  const client = await request.newContext({
    storageState: { cookies: await browserContext.cookies(), origins: [] },
  });
  const get = client.get.bind(client);
  // Local Pages can reset an idle pooled socket. Playwright retries only
  // ECONNRESET here, once, on these read-only checks; HTTP errors still fail.
  // Never replay a write whose commit may already have happened.
  client.get = (url, options) => get(url, { maxRetries: 1, ...options });
  return client;
}
