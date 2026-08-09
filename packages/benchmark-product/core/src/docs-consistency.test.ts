import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATED_OPERATIONS } from "./authority/policy.js";
import { BUNDLE_FORMAT, BUNDLE_MANIFEST_FILENAME } from "./bundle/manifest.js";
import { PUBLIC_BUNDLE_FILES } from "./bundle/materialize.js";
import { PRODUCT_ERROR_CODES } from "./errors.js";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productRoot = resolve(coreRoot, "..");
const repoRoot = resolve(productRoot, "../..");

const productReadmePath = resolve(productRoot, "README.md");
const coreReadmePath = resolve(coreRoot, "README.md");
const webReadmePath = resolve(productRoot, "web/README.md");
const bundleReadmePath = resolve(productRoot, "PUBLIC-BUNDLE.md");
const securityPath = resolve(productRoot, "SECURITY.md");
const extractionPath = resolve(
  repoRoot,
  "docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md",
);
const issueDraftsPath = resolve(
  repoRoot,
  "docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md",
);

const requiredDocs = [
  productReadmePath,
  coreReadmePath,
  webReadmePath,
  bundleReadmePath,
  securityPath,
  extractionPath,
  issueDraftsPath,
] as const;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function localMarkdownTargets(markdown: string): readonly string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]!.trim().replace(/^<|>$/g, ""))
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => target.split("#", 1)[0]!)
    .filter((target) => target.length > 0);
}

describe("product documentation consistency", () => {
  it("ships the complete product-local documentation set with no broken local links", () => {
    for (const path of requiredDocs) expect(existsSync(path), path).toBe(true);

    for (const path of requiredDocs) {
      const markdown = read(path);
      for (const target of localMarkdownTargets(markdown)) {
        const resolved = resolve(dirname(path), decodeURIComponent(target));
        expect(existsSync(resolved), `${path} -> ${target}`).toBe(true);
      }
    }
  });

  it("derives the documented agent surface from the generated parity and public policy authorities", () => {
    const parity = JSON.parse(read(resolve(coreRoot, "parity-matrix.v1.json"))) as {
      entries: readonly { operation: string; cliVerb: string }[];
      exclusions: readonly { name: string }[];
    };
    const coreReadme = read(coreReadmePath);

    expect(parity.entries).toHaveLength(27);
    for (const entry of parity.entries) {
      expect(coreReadme, entry.operation).toContain(`\`${entry.operation}\``);
      expect(coreReadme, entry.cliVerb).toContain(`\`benchmark-product ${entry.cliVerb}`);
    }
    expect(parity.exclusions.map((entry) => entry.name)).toContain("bundle verify");
    expect(coreReadme).toContain("`benchmark-product bundle verify --bundle <dir> --json`");

    for (const operation of GATED_OPERATIONS) expect(coreReadme).toContain(`\`${operation}\``);
    for (const code of PRODUCT_ERROR_CODES) expect(coreReadme).toContain(`\`${code}\``);
    expect(coreReadme).toContain("27 generated operations");
    expect(coreReadme).toContain("five gated operations");
    expect(coreReadme).toContain("11 typed error codes");
    expect(coreReadme).toContain("`{\"ok\":true,\"result\":...}`");
    expect(coreReadme).toContain("`{\"ok\":false,\"error\":...}`");
    expect(coreReadme).toMatch(/exit 0[^\n]+exit 1[^\n]+exit 2[^\n]+exit 3/i);
    expect(coreReadme).toMatch(/launch.*resume.*stderr.*final.*stdout/is);
    expect(coreReadme).toMatch(/requested.*terminal.*cancelled/is);
    expect(coreReadme).toMatch(/collect.*contention/is);
    expect(coreReadme).toMatch(/local immutable emission.*no upload.*no hosting.*no deployment/is);
  });

  it("pins the public-bundle guide to the frozen format, file roles, and six checks", () => {
    const guide = read(bundleReadmePath);
    expect(guide).toContain(`\`${BUNDLE_FORMAT}\``);
    expect(guide).toContain(`\`${BUNDLE_MANIFEST_FILENAME}\``);
    for (const path of PUBLIC_BUNDLE_FILES) expect(guide, path).toContain(`\`${path}\``);
    expect(guide).toContain("`records/<sha256>.bin`");
    expect(guide).toContain("`verification/cancel-requested.json`");
    for (const check of [
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]) {
      expect(guide).toContain(`\`${check}\``);
    }
    expect(guide).toContain("six checks");
    expect(guide).toMatch(/not confidential|non-confidential/i);
    expect(guide).toMatch(/local immutable emission.*not hosting/is);
  });

  it("documents the exact private web configuration and package commands", () => {
    const webReadme = read(webReadmePath);
    const webPackage = JSON.parse(read(resolve(productRoot, "web/package.json"))) as {
      scripts: Record<string, string>;
    };
    for (const name of ["dev", "build", "lint", "typecheck", "test", "test:browser"]) {
      expect(webPackage.scripts[name], name).toBeTypeOf("string");
      expect(webReadme).toContain(`\`yarn ${name}\``);
    }
    expect(webReadme).toContain("`BENCHMARK_PRODUCT_WORKSPACE_DIR`");
    expect(webReadme).toContain("`BENCHMARK_PRODUCT_PRINCIPAL`");
    expect(webReadme).toMatch(/server-only.*public.*benchmark-product-core/is);
    expect(webReadme).toMatch(/private.*local.*deployment status.*none/is);
    expect(webReadme).toMatch(/typed.*redact|redact.*typed/is);
  });
});
