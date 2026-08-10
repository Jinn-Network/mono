import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  PINNED_CHROMIUM_VERSION,
  PINNED_PERMISSIONS_POLICY,
  PINNED_PERMISSIONS_POLICY_FEATURES,
} from "../permissions-policy.mjs";

const packageFile = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));

describe("private production web security contract", () => {
  test("next start config applies no-store and a same-origin restrictive header set", () => {
    const config = readFileSync(packageFile("next.config.mjs"), "utf8");
    for (const required of [
      "Cache-Control",
      "no-store",
      "Content-Security-Policy",
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "connect-src 'self'",
      "X-Content-Type-Options",
      "nosniff",
      "X-Frame-Options",
      "DENY",
      "Referrer-Policy",
      "no-referrer",
      "Permissions-Policy",
    ]) expect(config, required).toContain(required);
    expect(config).toContain('value: PINNED_PERMISSIONS_POLICY');
    expect(PINNED_CHROMIUM_VERSION).toBe("147.0.7727.15");
    expect(PINNED_PERMISSIONS_POLICY_FEATURES).toHaveLength(process.platform === "darwin" ? 81 : 80);
    expect([...PINNED_PERMISSIONS_POLICY_FEATURES].sort()).toEqual(PINNED_PERMISSIONS_POLICY_FEATURES);
    expect(new Set(PINNED_PERMISSIONS_POLICY_FEATURES).size).toBe(PINNED_PERMISSIONS_POLICY_FEATURES.length);
    expect(PINNED_PERMISSIONS_POLICY).toBe(
      PINNED_PERMISSIONS_POLICY_FEATURES.map((feature) => `${feature}=()`).join(", "),
    );
    for (const capability of [
      "attribution-reporting",
      "captured-surface-control",
      "compute-pressure",
      "keyboard-map",
      "local-network-access",
      "on-device-speech-recognition",
      "private-aggregation",
      "summarizer",
      "sync-xhr",
      "translator",
    ]) expect(PINNED_PERMISSIONS_POLICY_FEATURES, capability).toContain(capability);
    expect(PINNED_PERMISSIONS_POLICY_FEATURES.includes("bluetooth")).toBe(process.platform === "darwin");
    expect(config).not.toMatch(/https?:\/\//u);
  });

  test("the product-local threat model names every BP-50 trust boundary and no deployment", () => {
    const path = packageFile("../SECURITY.md");
    expect(existsSync(path)).toBe(true);
    const note = readFileSync(path, "utf8").toLowerCase();
    for (const required of [
      "protected assets",
      "trust boundaries",
      "local-process authority",
      "filesystem",
      "cancellation",
      "concurrency",
      "browser/server",
      "non-goals",
      "deployment status: none",
    ]) expect(note, required).toContain(required);
  });

  test("the product owns a production-build Chromium and axe gate wired into CI", () => {
    const packageJson = JSON.parse(readFileSync(packageFile("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["test:browser:production"]).toContain("yarn build");
    expect(packageJson.scripts?.["test:browser:production"]).toContain("BP50_BUILD_SECRET_SENTINEL");
    expect(packageJson.scripts?.["test:browser"]).toContain("playwright test");
    const workflow = readFileSync(packageFile("../../../.github/workflows/benchmark-product-ci.yml"), "utf8");
    const webJob = workflow.slice(workflow.indexOf("\n  web:"), workflow.indexOf("\n  verify:"));
    expect(webJob).toContain("yarn playwright install --with-deps chromium");
    expect(webJob).toContain("yarn test:browser");
    expect(workflow.slice(0, workflow.indexOf("\n  web:"))).not.toContain("yarn test:browser");
  });

  test("the browser gate audits all violations and proves copied-bundle confidentiality independently", () => {
    const browser = readFileSync(packageFile("browser/production-flow.spec.ts"), "utf8");
    expect(browser).toContain("results.violations, `${label}");
    expect(browser).not.toContain("violation.impact ===");
    for (const state of [
      "landing route",
      "new draft route",
      "uninitialized workspace",
      "initialized workspace",
      "invalid action result",
      "draft setup",
      "quoted draft",
      "locked draft",
      "locked run monitor",
      "active run monitor",
      "closed run monitor",
      "sealed results",
      "reported results",
      "verified results",
      "published results",
    ]) expect(browser, state).toContain(state);
    expect(browser).toContain("consoleMessages");
    expect(browser).toContain("requestUrls");
    expect(browser).toContain("runtime.buildSecret");
    expect(browser).toContain("report-signing-key.pem");
    expect(browser).toContain("rmSync(WORKSPACE");
    expect(browser).toContain("bundle\", \"verify");
  });
});
