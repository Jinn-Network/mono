import { defineConfig } from '@playwright/test';

const OPERATOR_URL = 'http://127.0.0.1:17340';
const CONSOLE_PORT = 3010;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  testIgnore: /live-console\.e2e\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${CONSOLE_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `yarn build && yarn start --port ${CONSOLE_PORT}`,
    url: `http://127.0.0.1:${CONSOLE_PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NEXT_PUBLIC_JINN_OPERATOR_URL: OPERATOR_URL,
      NEXT_PUBLIC_JINN_UI_TOKEN: 'test-token',
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
