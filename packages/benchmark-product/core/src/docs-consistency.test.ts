import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATED_OPERATIONS } from "./authority/policy.js";
import { BUNDLE_FORMAT, BUNDLE_MANIFEST_FILENAME } from "./bundle/manifest.js";
import { PUBLIC_BUNDLE_FILES } from "./bundle/materialize.js";
import { PRODUCT_ERROR_CODES } from "./errors.js";
import { PRODUCT_BRANDING } from "./branding.js";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productRoot = resolve(coreRoot, "..");
const repoRoot = resolve(productRoot, "../..");

const productReadmePath = resolve(productRoot, "README.md");
const coreReadmePath = resolve(coreRoot, "README.md");
const webReadmePath = resolve(productRoot, "web/README.md");
const bundleReadmePath = resolve(productRoot, "PUBLIC-BUNDLE.md");
const inspectRuntimePath = resolve(productRoot, "INSPECT-RUNTIME.md");
const securityPath = resolve(productRoot, "SECURITY.md");
const productDesignPath = resolve(
  repoRoot,
  "docs/superpowers/specs/2026-08-05-benchmark-product-design.md",
);
const extractionPath = resolve(
  repoRoot,
  "docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md",
);
const issueDraftsPath = resolve(
  repoRoot,
  "docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md",
);
const finalVerificationPath = resolve(
  repoRoot,
  "docs/superpowers/plans/2026-08-10-benchmark-product-final-verification.md",
);
const productWorkflowPath = resolve(repoRoot, ".github/workflows/benchmark-product-ci.yml");

const requiredDocs = [
  productReadmePath,
  coreReadmePath,
  webReadmePath,
  bundleReadmePath,
  inspectRuntimePath,
  securityPath,
  extractionPath,
  issueDraftsPath,
  finalVerificationPath,
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

/**
 * Every non-test TypeScript/ESM source file the four Colophon packages actually ship, so a new
 * module that hard-codes a reader command cannot slip past the #3023 guard by living somewhere
 * this test did not think to look. Tests are excluded on purpose: asserting a frozen sealed
 * command is exactly what several of them are for.
 */
function productSourceFiles(): readonly string[] {
  const roots = ["check", "core", "cli", "web"].flatMap((pkg) =>
    ["src", "scripts"].map((dir) => resolve(productRoot, pkg, dir))
  );
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__fixtures__" || entry.name === "fixtures") continue;
        walk(path);
        continue;
      }
      if (!/\.(?:ts|tsx|mjs)$/u.test(entry.name)) continue;
      if (/\.(?:test|spec)\.(?:ts|tsx|mjs)$/u.test(entry.name)) continue;
      found.push(path);
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
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

    expect(parity.entries).toHaveLength(41);
    for (const entry of parity.entries) {
      expect(coreReadme, entry.operation).toContain(`\`${entry.operation}\``);
      expect(coreReadme, entry.cliVerb).toContain(`\`${PRODUCT_BRANDING.commandName} ${entry.cliVerb}`);
    }
    expect(parity.exclusions.map((entry) => entry.name)).toContain("bundle verify");
    expect(coreReadme).toContain(`\`${PRODUCT_BRANDING.commandName} bundle verify --bundle <dir> --json\``);

    for (const operation of GATED_OPERATIONS) expect(coreReadme).toContain(`\`${operation}\``);
    for (const code of PRODUCT_ERROR_CODES) expect(coreReadme).toContain(`\`${code}\``);
    expect(coreReadme).toContain("41 generated operations");
    expect(coreReadme).toContain("ten gated operations");
    expect(coreReadme).toContain("11 typed error codes");
    expect(coreReadme).toContain("`{\"ok\":true,\"result\":...}`");
    expect(coreReadme).toContain("`{\"ok\":false,\"error\":...}`");
    expect(coreReadme).toMatch(/exit 0[^\n]+exit 1[^\n]+exit 2[^\n]+exit 3/i);
    expect(coreReadme).toMatch(/launch.*resume.*stderr.*final.*stdout/is);
    expect(coreReadme).toMatch(/requested.*terminal.*cancelled/is);
    expect(coreReadme).toMatch(/collect.*contention/is);
    expect(coreReadme).toMatch(/local immutable emission.*no upload.*no hosting.*no deployment/is);
  });

  it("documents the pinned optional Inspect boundary without independence or EvalLog overclaiming", () => {
    const guide = read(inspectRuntimePath);
    const security = read(securityPath);
    const design = read(productDesignPath);
    expect(guide).toContain("`inspect-ai==0.3.255`");
    expect(guide).toContain("`read_eval_log`");
    expect(guide).toContain("inspect view --log-dir");
    expect(guide).toContain("same-execution-scorer");
    expect(guide).toContain("`separate-log-verification`");
    expect(guide).toContain('`partyIndependence:\n"not-established"`');
    expect(guide).toMatch(/embedded score is source evidence and\s+is not counted as another Matrix vote/is);
    expect(guide).toMatch(/not independent\s+rescoring, method diversity, a separate organization, or real-world party\s+independence/is);
    expect(guide).toMatch(/not called independent/i);
    expect(guide).toMatch(/summary.*not an EvalLog/is);
    expect(guide).toMatch(/no ambient credential variables/i);
    expect(guide).toMatch(/not .*hostile-code sandbox/i);
    expect(guide).toMatch(/private Tier 4 product adapter.*not a Jinn protocol or\s+Tier 3 platform API/is);
    expect(guide).toMatch(/second independent product or evaluation\s+runtime consumer.*separate Tier 3 design.*conformance kit/is);
    expect(security).toMatch(/private Tier 4 adapter machinery.*not a task-execution\s+backend.*reusable platform sandbox/is);
    expect(security).toMatch(/second consumer.*trigger/is);
    expect(design).toContain("**Addendum — 2026-08-13, private Inspect runtime-host boundary");
    expect(design).toMatch(/Private interfaces.*neither Jinn protocol records nor Tier 3 platform APIs/is);
    expect(design).toMatch(/Promotion trigger.*second independent product or\s+evaluation-runtime consumer.*conformance kit before its implementation/is);
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
    expect(webReadme).toMatch(/server-only.*public.*@colophon-claims\/core/is);
    expect(webReadme).toMatch(/private.*local.*deployment status.*none/is);
    expect(webReadme).toMatch(/typed.*redact|redact.*typed/is);
  });

  it("keeps every extraction gate and no-move boundary machine-visible", () => {
    const extraction = read(extractionPath);
    expect(extraction).toContain("**Overall verdict** | **NOT EXTRACTION-READY**");
    for (const gate of [
      "## 1. Published platform dependencies — BLOCKED",
      "## 2. Component-only clean-clone CI — BLOCKED",
      "## 3. Deploy artifacts and platform configuration — NOT GREEN",
      "## 4. No tier-1–3 product references — PASS",
      "## 5. Departing-tree CI and conformance independence — BLOCKED",
      "## 6. Release, tag, and trusted publisher — BLOCKED / N/A",
      "## 7. Review protection migration — BLOCKED",
      "## 8. No vendored platform code — PASS with disclosure",
    ]) {
      expect(extraction, gate).toContain(gate);
    }
    expect(extraction).toMatch(/does not authorize a move.*repository creation.*package release.*deployment.*remote action/is);
    expect(extraction).toMatch(/even if all eight.*PASS.*future decision record/is);
  });

  it("keeps every M2–M5 issue draft complete and all plan authorities inside the product CI trigger", () => {
    const drafts = read(issueDraftsPath);
    for (const packet of [
      "BP-20", "BP-21", "BP-22",
      "BP-30", "BP-31", "BP-32", "BP-33",
      "BP-40", "BP-41",
      "BP-50", "BP-51", "BP-52",
    ]) {
      expect(drafts.match(new RegExp(`^## Draft \\d+ — ${packet} \\u00b7 `, "mu")), packet).not.toBeNull();
    }
    const workflow = read(productWorkflowPath);
    for (const path of [
      "docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md",
      "docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md",
      "docs/superpowers/plans/2026-08-10-benchmark-product-final-verification.md",
    ]) {
      expect(workflow.split(`- "${path}"`).length - 1, path).toBe(2);
    }
  });

  it("keeps the final verification record complete and explicitly bounded", () => {
    const verification = read(finalVerificationPath);
    for (const heading of [
      "## 1. Verdict and authority boundary",
      "## 2. Baseline, resumption, and final local state",
      "## 3. Product outcome by perspective",
      "## 4. Milestone and acceptance evidence",
      "## 5. Packet and review record",
      "## 6. Architecture, dependency, and interface parity",
      "## 7. Verification evidence",
      "## 8. Adversarial, accessibility, and security evidence",
      "## 9. Extraction, drift, hygiene, and merge-readiness caveats",
    ]) {
      expect(verification, heading).toContain(heading);
    }
    expect(verification).toContain("BP-00–BP-52 are integrated locally and M0–M5 are complete");
    expect(verification).toContain("final independent re-review PASS; integrated locally");
    expect(verification).toContain("Remote effects: none");
    expect(verification).toContain("NOT EXTRACTION-READY");
    expect(verification).toContain("27 generated operations");
    expect(verification).toContain("six portable checks");
  });

  /**
   * Issue #3023. The checker publishes as `@colophon-claims/check` (binary `colophon-check`).
   * `@colophon-claims/verify` stays published forever as a passthrough alias, because bundles
   * sealed before the rename print that name in their own reader instructions and a sealed
   * instruction that stops resolving is a broken claim. The old name is therefore legal in
   * exactly two kinds of place: the frozen per-format command constants (below), and prose that
   * explains the alias. It is never legal in a template that emits a NEW instruction — that is
   * what this guard fails on.
   */
  const LEGACY_READER_COMMAND = /npx\s+@colophon-claims\/verify@/u;
  const LEGACY_READER_NAMES = /@colophon-claims\/verify(?![-\w])|colophon-verify(?![-\w])/u;

  /**
   * Modules whose whole job is to state the immutable command an already-sealed bundle format
   * pins. Their strings are claim bytes: `profile/claim.ts` REJECTS a bundle whose recorded
   * command differs, so editing one of these to the new name would fail every published bundle.
   * A new entry here is a deliberate, reviewed act; anything else in the product tree is not.
   */
  const SEALED_COMMAND_MODULES = [
    resolve(productRoot, "check/src/reader-instructions.ts"),
    resolve(productRoot, "check/src/profile/claim.ts"),
    resolve(coreRoot, "src/report/claim.ts"),
  ] as const;

  /** Surfaces that emit a fresh instruction for a reader to run. */
  const READER_INSTRUCTION_SURFACES = [
    resolve(productRoot, "check/src/assets.ts"),
    resolve(productRoot, "check/README.md"),
    resolve(productRoot, "cli/src/main.ts"),
    resolve(coreRoot, "scripts/demo1-export-public-bundle.mjs"),
    productReadmePath,
    resolve(productRoot, "EXTERNAL-VERIFICATION.md"),
  ] as const;

  it("prints only the current reader name in every freshly emitted instruction", () => {
    for (const path of READER_INSTRUCTION_SURFACES) {
      expect(existsSync(path), path).toBe(true);
      expect(read(path), path).not.toMatch(LEGACY_READER_COMMAND);
    }
  });

  it("confines the retired reader name to the frozen per-format command constants", () => {
    for (const path of SEALED_COMMAND_MODULES) {
      expect(existsSync(path), path).toBe(true);
      expect(read(path), path).toMatch(LEGACY_READER_NAMES);
    }
    const sealed = new Set<string>(SEALED_COMMAND_MODULES);
    const offenders = productSourceFiles()
      .filter((path) => !sealed.has(path))
      .filter((path) => LEGACY_READER_NAMES.test(read(path)));
    expect(offenders.map((path) => relative(repoRoot, path))).toEqual([]);
  });

  it("keeps the retired reader name resolving through a published passthrough alias", () => {
    const alias = JSON.parse(read(resolve(productRoot, "verify/package.json"))) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
      publishConfig?: { access?: string };
    };
    const checker = JSON.parse(read(resolve(productRoot, "check/package.json"))) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      exports: Record<string, unknown>;
    };
    expect(checker.name).toBe("@colophon-claims/check");
    expect(Object.keys(checker.bin)).toEqual(["colophon-check"]);
    expect(alias.name).toBe("@colophon-claims/verify");
    expect(Object.keys(alias.bin)).toEqual(["colophon-verify"]);
    expect(alias.publishConfig?.access).toBe("public");
    // Same 0.2 line, so `npx @colophon-claims/verify@0.2` keeps resolving to a real reader.
    expect(alias.version.startsWith("0.2.")).toBe(true);
    expect(alias.dependencies["@colophon-claims/check"]).toBe(checker.version);
    expect(checker.exports["./bin"]).toBe("./dist/bin.js");
    expect(read(resolve(productRoot, "verify/README.md"))).toContain("@colophon-claims/check");
  });
});
