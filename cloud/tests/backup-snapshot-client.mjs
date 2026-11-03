// Keep the downloaded full backup in the bounded browser that already reads it.
// Do not duplicate a multi-MiB base64 JSON through the 128MiB test driver.
export async function retainBackupInput(page) {
  await page.locator('#project-file').evaluate((input) => {
    input.addEventListener(
      'change',
      (event) => {
        globalThis.__nativeVerificationBackupFile = event.target.files?.[0];
      },
      { capture: true, once: true },
    );
  });
}
export async function verifyBackupSnapshot(page, { bookId, authored, restoredRoot }) {
  return page.evaluate(
    async ({ bookId, authored, restoredRoot }) => {
      const file = globalThis.__nativeVerificationBackupFile;
      if (!file) throw new Error('Original selected backup File is missing.');
      const snapshot = JSON.parse(await file.text());
      if (snapshot.sourceId !== bookId) throw new Error('Backup source identity mismatch.');
      const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
      const decode = (data) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const chapter = snapshot.files.find((item) => item.path === 'chapters/新章 (二).md');
      if (!chapter || !equal(decode(chapter.data), new TextEncoder().encode(authored)))
        throw new Error('Downloaded authored chapter byte mismatch.');
      if (restoredRoot) {
        for (const item of snapshot.files) {
          const expected = decode(item.data);
          for (const root of [
            '/workspace/novels/' + bookId,
            ...(item.path === 'book.json' ? [] : [restoredRoot]),
          ]) {
            const response = await fetch(
              '/api/workspace/file?path=' + encodeURIComponent(root + '/' + item.path),
            );
            if (response.status !== 200) throw new Error('Backup verification read failed: ' + item.path);
            const actual = new Uint8Array(await response.arrayBuffer());
            if (!equal(actual, expected))
              throw new Error('Backup source/restored byte mismatch: ' + item.path);
          }
        }
        delete globalThis.__nativeVerificationBackupFile;
      }
      return { files: snapshot.files.length, sourceId: snapshot.sourceId, allBytesCompared: !!restoredRoot };
    },
    { bookId, authored, restoredRoot },
  );
}
