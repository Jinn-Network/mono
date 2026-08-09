import { defineConfig } from "@playwright/test";
import { createRuntimeEnvironment, readRuntimeConfig } from "./browser/runtime-config";

const port = 3017;
Object.assign(process.env, createRuntimeEnvironment());
const runtime = readRuntimeConfig();
process.env.BENCHMARK_PRODUCT_WORKSPACE_DIR = runtime.workspaceDir;
process.env.BENCHMARK_PRODUCT_PRINCIPAL = "sponsor-1";

export default defineConfig({
  testDir: "./browser",
  testIgnore: ["**/global-*.ts", "**/runtime-config.ts"],
  globalSetup: "./browser/global-setup.ts",
  globalTeardown: "./browser/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `yarn next start --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      BENCHMARK_PRODUCT_WORKSPACE_DIR: runtime.workspaceDir,
      BENCHMARK_PRODUCT_PRINCIPAL: "sponsor-1",
      BENCHMARK_PRODUCT_ENABLE_TEST_CONTROLS: "1",
      BENCHMARK_PRODUCT_TEST_SOLVE_DELAY_MS: "10000",
    } as Record<string, string>,
  },
});
