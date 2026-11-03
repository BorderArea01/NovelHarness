// Test the actual CodeMirror document, not its virtualized visible DOM subset.
// Mutations below use real keyboard input through the browser/CM input pipeline.
export async function waitResponsiveLayout(page) {
  // Native ResizeObserver settles after Playwright's viewport command. Do not
  // click a phone launcher which is about to unmount in the desktop layout.
  await page.waitForFunction(() => {
    const frame = document.querySelector('.novel-native-frame');
    if (!frame) return false;
    const width = frame.getBoundingClientRect().width;
    return (
      frame.hasAttribute('data-novel-narrow') === width < 1024 &&
      frame.hasAttribute('data-novel-compact') === width <= 600
    );
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
export async function clickSidebarEntry(page, role, name, options) {
  await waitResponsiveLayout(page);
  const target = page.getByRole(role, { name, exact: true });
  if (!(await target.isVisible())) {
    await page.getByRole('button', { name: '展开导航', exact: true }).click();
  }
  await target.click(options);
}
export async function openChapter(page, path) {
  await openChapterDirectory(page);
  const nav = page.getByRole('navigation', { name: '章节导航', exact: true });
  await nav.getByRole('searchbox', { name: '搜索章节', exact: true }).fill(path);
  const target = nav.locator('button[data-document-path=' + JSON.stringify(path) + ']');
  await target.click();
}
export async function openChapterDirectory(page) {
  const toggle = page.getByRole('button', { name: '展开章节目录', exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByRole('region', { name: '章节目录', exact: true }).waitFor();
}
export async function openDocumentOptions(page) {
  const toggle = page.getByRole('button', { name: '文稿选项', exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByRole('region', { name: '文稿选项', exact: true }).waitFor();
}
export async function openGenerationRecords(page) {
  await openDocumentOptions(page);
  await page.getByRole('button', { name: '生成记录', exact: true }).click();
}
export async function openHistory(page) {
  await openDocumentOptions(page);
  await page.getByRole('button', { name: '历史', exact: true }).click();
}
export async function readEditor(locator) {
  return locator.evaluate(async (element) => {
    const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
    const view = EditorView.findFromDOM(element);
    if (!view) throw new Error('Original CodeMirror view missing.');
    return view.state.doc.toString();
  });
}
export async function fillEditor(locator, value) {
  await locator.focus();
  await locator.press('ControlOrMeta+a');
  // Exercise CodeMirror's real clipboard handler without touching the user's
  // system clipboard. CDP insertText on megabytes is not a browser paste.
  await locator.evaluate(
    (element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    value.replace(/\r\n|\r/g, '\n'),
  );
}
export async function selectEditor(locator, from, to) {
  await locator.evaluate(
    async (element, { from, to }) => {
      const { EditorView } = await import('/novel-assets/editor-vendor.mjs');
      const view = EditorView.findFromDOM(element);
      view.focus();
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    },
    { from, to },
  );
}
export async function waitEditor(locator, expected) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if ((await readEditor(locator)) === expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Original editor content did not reach expected value.');
}
