import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 15_000,
  use: {
    browserName: 'chromium',
    headless: true,
    // CI can provide a system/browser-cache executable when the headless shell
    // is unavailable: PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome.
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  },
  reporter: [['list']],
});
