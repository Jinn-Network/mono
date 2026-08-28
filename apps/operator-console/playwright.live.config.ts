import { defineConfig } from '@playwright/test';

/**
 * Live console ↔ daemon. Requires:
 *   - operator daemon from this branch on 127.0.0.1:7331
 *   - `yarn dev` (or start) at http://localhost:3000 with
 *     NEXT_PUBLIC_JINN_OPERATOR_URL and NEXT_PUBLIC_JINN_UI_TOKEN
 *
 * Does not start or mock the daemon. Browse localhost, not 127.0.0.1
 * (Next 16 403s `/_next/static` as cross-origin).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /live-console\.e2e\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node -e "process.exit(1)"',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 5_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
