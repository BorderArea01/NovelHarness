// Only for isolated localhost browser fixtures. Headless Chromium has no OS
// keyboard: simulate visual-only resizing without changing layout height.
export function visibleViewportFixture(page) {
  return {
    visibleViewport: async (height, top = 0, scale = 1) => {
      await page.evaluate(
        ({ height, top, scale }) => {
          const vv = window.visualViewport;
          window.__fixtureViewportDescriptors ??= Object.fromEntries(
            ['height', 'offsetTop', 'scale'].map((key) => [key, Object.getOwnPropertyDescriptor(vv, key)]),
          );
          for (const [key, value] of Object.entries({ height, offsetTop: top, scale }))
            Object.defineProperty(vv, key, { configurable: true, value });
          vv.dispatchEvent(new Event('resize'));
        },
        { height, top, scale },
      );
    },
    restoreViewport: async () => {
      await page.evaluate(() => {
        for (const [key, value] of Object.entries(window.__fixtureViewportDescriptors ?? {})) {
          if (value) Object.defineProperty(window.visualViewport, key, value);
          else delete window.visualViewport[key];
        }
        delete window.__fixtureViewportDescriptors;
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
    },
  };
}
