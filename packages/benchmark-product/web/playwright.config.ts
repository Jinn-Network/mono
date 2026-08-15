import { defineConfig } from "@playwright/test";
import { createRuntimeEnvironment, LOCAL_APP_CAPABILITY_ENV, readRuntimeConfig } from "./browser/runtime-config";

const port = 3017;
Object.assign(process.env, createRuntimeEnvironment());
const runtime = readRuntimeConfig();
process.env.BENCHMARK_PRODUCT_WORKSPACE_DIR = runtime.workspaceDir;
process.env.BENCHMARK_PRODUCT_AGENT_DATA_DIR = runtime.agentDataDir;
process.env.BENCHMARK_PRODUCT_PRINCIPAL = "sponsor-1";
const localAppCapability = process.env[LOCAL_APP_CAPABILITY_ENV]!;

export default defineConfig({
  testDir: "./browser",
  testIgnore: ["**/global-*.ts", "**/runtime-config.ts"],
  globalSetup: "./browser/global-setup.ts",
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
    storageState: {
      cookies: [{
        name: "colophon_local_app",
        value: localAppCapability,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      }],
      origins: [],
    },
  },
  webServer: {
    command: "node local-server.mjs",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      BENCHMARK_PRODUCT_WORKSPACE_DIR: runtime.workspaceDir,
      BENCHMARK_PRODUCT_AGENT_DATA_DIR: runtime.agentDataDir,
      BENCHMARK_PRODUCT_PRINCIPAL: "sponsor-1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      COLOPHON_LOCAL_APP_CAPABILITY: localAppCapability,
      BENCHMARK_PRODUCT_ENABLE_TEST_CONTROLS: "1",
      BENCHMARK_PRODUCT_TEST_SOLVE_DELAY_MS: "10000",
    } as Record<string, string>,
  },
});
