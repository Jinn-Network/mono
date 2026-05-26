import { defineConfig } from '@playwright/test';

const VITE_PORT = 17332;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.e2e\.test\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  webServer: {
    command: `yarn dev --port ${VITE_PORT} --strictPort`,
    url: `http://127.0.0.1:${VITE_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // JINN_INDEXER_URL env is honoured by vite.config.ts; default targets local 42069.
  },
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
