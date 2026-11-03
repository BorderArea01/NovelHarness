import assert from 'node:assert/strict';

// Test driver only: release accumulated browser/HTTP protocol owners between
// independent scenarios. Preserve the complete browser data, not fewer fixture
// bytes; the SAME local workerd, book, versions and history remain live.
export async function rotateFixtureContext({ browser, context, page, origin }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const state = await context.storageState({ indexedDB: true });
  const session = await page.evaluate(() => Object.entries(sessionStorage));
  await context.close();
  const next = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  try {
    const restored = await next.storageState({ indexedDB: true });
    const normalized = (origins) =>
      origins
        .map((entry) => ({
          ...entry,
          localStorage: Object.fromEntries(entry.localStorage.map(({ name, value }) => [name, value])),
        }))
        .sort((a, b) => a.origin.localeCompare(b.origin));
    assert.deepEqual(normalized(restored.origins), normalized(state.origins));
    assert.deepEqual(restored.cookies, state.cookies);
    await next.addInitScript(
      ({ origin, entries }) => {
        // Seed only the new context's first navigation. Later real reloads
        // must retain the author's newer view/draft intent, not replay ours.
        if (location.origin !== origin || sessionStorage.length) return;
        for (const [key, value] of entries) sessionStorage.setItem(key, value);
      },
      { origin, entries: session },
    );
    const nextPage = await next.newPage();
    console.log(
      'Fixture context rotated: complete cookies/localStorage/IndexedDB restored and compared; same local VFS; no sample or heap change.',
    );
    return { context: next, page: nextPage };
  } catch (error) {
    await next.close();
    throw error;
  }
}
