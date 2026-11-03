import { defineConfig } from '@playwright/test';

const e2ePort = Number(process.env.PLAYWRIGHT_PORT || 3210);

export default defineConfig({
  testDir: './tests',
  // Keep databases and live guard logs outside Playwright's cleanup boundary.
  outputDir: './test-results/playwright-artifacts',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: {
    command: 'npm start',
    url: `http://127.0.0.1:${e2ePort}/api/health`,
    reuseExistingServer: false,
    env: {
      DATA_DIR: process.env.PLAYWRIGHT_DATA_DIR || 'test-results/e2e-data',
      PORT: String(e2ePort),
      HOST: '127.0.0.1',
    },
  },
});
