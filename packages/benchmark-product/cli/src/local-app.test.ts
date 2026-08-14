import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertPackagedLocalApp, localAppCommand, localAppLaunchUrl } from "./local-app.js";

function packageWithLocalApp(): string {
  const root = mkdtempSync(join(tmpdir(), "colophon-local-app-"));
  const app = join(root, "dist", "local-web", "packages", "benchmark-product", "web");
  mkdirSync(join(app, ".next"), { recursive: true });
  mkdirSync(join(app, ".next", "static"), { recursive: true });
  mkdirSync(join(root, "node_modules", "next"), { recursive: true });
  mkdirSync(join(app, "public", "brand"), { recursive: true });
  writeFileSync(join(app, "local-server.mjs"), "// packaged test server\n");
  writeFileSync(join(app, ".next", "BUILD_ID"), "test-build\n");
  writeFileSync(join(root, "node_modules", "next", "package.json"), "{}\n");
  writeFileSync(join(app, "public", "brand", "favicon.svg"), "<svg />\n");
  return root;
}

function hoistedPackageWithLocalApp(): string {
  const installRoot = mkdtempSync(join(tmpdir(), "colophon-local-app-hoisted-"));
  const root = join(installRoot, "node_modules", "@colophon-claims", "cli");
  const app = join(root, "dist", "local-web", "packages", "benchmark-product", "web");
  mkdirSync(join(app, ".next", "static"), { recursive: true });
  mkdirSync(join(installRoot, "node_modules", "next"), { recursive: true });
  mkdirSync(join(app, "public", "brand"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@colophon-claims/cli" }));
  writeFileSync(join(app, "local-server.mjs"), "// packaged test server\n");
  writeFileSync(join(app, ".next", "BUILD_ID"), "test-build\n");
  writeFileSync(join(installRoot, "node_modules", "next", "package.json"), "{}\n");
  writeFileSync(join(app, "public", "brand", "favicon.svg"), "<svg />\n");
  return root;
}

describe("packaged local workspace app", () => {
  test("constructs a loopback-only, ephemeral launch with a one-time capability", () => {
    const packageRoot = packageWithLocalApp();
    const app = assertPackagedLocalApp(packageRoot);
    const capability = "single-use-capability";
    const command = localAppCommand(app, "/tmp/colophon-workspace", "/tmp/colophon-agent-data", capability, 0, {
      PATH: "/usr/bin",
      HOME: "/private/home",
      ANTHROPIC_API_KEY: "must-not-reach-the-local-app",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([join(packageRoot, "dist", "local-web", "packages", "benchmark-product", "web", "local-server.mjs")]);
    expect(command.cwd).toBe(join(packageRoot, "dist", "local-web", "packages", "benchmark-product", "web"));
    expect(command.environment).toMatchObject({
      HOSTNAME: "127.0.0.1",
      PORT: "0",
      NEXT_TELEMETRY_DISABLED: "1",
      BENCHMARK_PRODUCT_WORKSPACE_DIR: "/tmp/colophon-workspace",
      BENCHMARK_PRODUCT_AGENT_DATA_DIR: "/tmp/colophon-agent-data",
      BENCHMARK_PRODUCT_PRINCIPAL: "local-operator",
      COLOPHON_LOCAL_APP_CAPABILITY: capability,
    });
    expect(command.environment.HOME).toBeUndefined();
    expect(command.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(localAppLaunchUrl(43123, capability)).toBe("http://127.0.0.1:43123/__colophon_launch?capability=single-use-capability");
  });

  test("refuses to launch a partial package before opening a browser", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "colophon-local-app-missing-"));
    mkdirSync(join(packageRoot, "dist", "local-web", "packages", "benchmark-product", "web"), { recursive: true });
    expect(() => assertPackagedLocalApp(packageRoot)).toThrow("local-server.mjs");
  });

  test("accepts npm's ordinary hoisted runtime dependency layout", () => {
    expect(assertPackagedLocalApp(hoistedPackageWithLocalApp()).root).toContain("dist/local-web");
  });
});
