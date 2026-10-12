import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityGrant, initWorkspace } from "@colophon-claims/core";
import { describe, expect, test } from "vitest";
import { assertPackagedLocalApp, localAppCommand, localAppLaunchUrl, startLocalWorkspaceApp } from "./local-app.js";

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

function workspaceFoundedBy(principal: string): string {
  const workspaceDir = join(mkdtempSync(join(tmpdir(), "colophon-local-app-workspace-")), "ws");
  const founded = initWorkspace({ workspaceDir, principal, clock: () => "2026-10-12T12:00:00.000Z" });
  expect(founded.ok).toBe(true);
  return workspaceDir;
}

/**
 * Starts the app from a packaged stand-in whose server records the principal it was started with,
 * reports ready, and waits to be stopped. The real server is a Next build; what these tests hold
 * is the environment the CLI starts it with.
 */
async function principalTheAppStartedAs(options: { readonly workspaceDir: string; readonly principal?: string }): Promise<string> {
  const packageRoot = packageWithLocalApp();
  const agentDataDir = mkdtempSync(join(tmpdir(), "colophon-local-app-agent-"));
  writeFileSync(join(packageRoot, "dist", "local-web", "packages", "benchmark-product", "web", "local-server.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'writeFileSync(join(process.env.BENCHMARK_PRODUCT_AGENT_DATA_DIR, "seen-principal"), process.env.BENCHMARK_PRODUCT_PRINCIPAL);',
    'process.send({ kind: "colophon-local-app-ready", port: 43123 });',
    "setInterval(() => {}, 60_000);",
    "",
  ].join("\n"));
  const app = await startLocalWorkspaceApp({
    workspaceDir: options.workspaceDir,
    agentDataDir,
    packageRoot,
    inheritedEnvironment: { PATH: process.env.PATH },
    ...(options.principal === undefined ? {} : { principal: options.principal }),
  });
  try {
    return readFileSync(join(agentDataDir, "seen-principal"), "utf8");
  } finally {
    await app.close();
  }
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

  test("carries a chosen principal to the app, and still defaults to local-operator", () => {
    const app = assertPackagedLocalApp(packageWithLocalApp());
    const inherited = { PATH: "/usr/bin" };
    expect(localAppCommand(app, "/tmp/ws", "/tmp/agent", "capability", 0, inherited, "me").environment.BENCHMARK_PRODUCT_PRINCIPAL).toBe("me");
    expect(localAppCommand(app, "/tmp/ws", "/tmp/agent", "capability", 0, inherited).environment.BENCHMARK_PRODUCT_PRINCIPAL).toBe("local-operator");
  });
});

// Issue #4957: the app used to act as `local-operator` on every workspace, and a workspace made
// with `init --principal me` has no such member, so every operation the app ran was denied.
describe("starting the app on a workspace", () => {
  test("acts as the principal that initialized it, with no flag", async () => {
    expect(await principalTheAppStartedAs({ workspaceDir: workspaceFoundedBy("me") })).toBe("me");
  });

  test("keeps local-operator on a workspace the app itself founded", async () => {
    expect(await principalTheAppStartedAs({ workspaceDir: workspaceFoundedBy("local-operator") })).toBe("local-operator");
  });

  test("keeps local-operator on a directory that is not a workspace yet, so the app can initialize it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "colophon-local-app-uninitialized-"));
    expect(await principalTheAppStartedAs({ workspaceDir: join(parent, "colophon-workspace") })).toBe("local-operator");
  });

  test("acts as the member named by --principal", async () => {
    const workspaceDir = workspaceFoundedBy("me");
    expect(authorityGrant({ workspaceDir, principal: "me", clock: () => "2026-10-12T12:00:00.000Z" }, { principalId: "agent-1", operations: [] }).ok).toBe(true);
    expect(await principalTheAppStartedAs({ workspaceDir, principal: "agent-1" })).toBe("agent-1");
  });

  test("refuses several members and no choice before it starts anything", async () => {
    const workspaceDir = workspaceFoundedBy("me");
    expect(authorityGrant({ workspaceDir, principal: "me", clock: () => "2026-10-12T12:00:00.000Z" }, { principalId: "agent-1", operations: [] }).ok).toBe(true);
    await expect(principalTheAppStartedAs({ workspaceDir })).rejects.toThrow("several members (me, agent-1)");
  });
});
