import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

    expect(parity.entries).toHaveLength(45);
    for (const entry of parity.entries) {
      expect(coreReadme, entry.operation).toContain(`\`${entry.operation}\``);
      expect(coreReadme, entry.cliVerb).toContain(`\`${PRODUCT_BRANDING.commandName} ${entry.cliVerb}`);
    }
    expect(parity.exclusions.map((entry) => entry.name)).toContain("bundle verify");
    expect(coreReadme).toContain(`\`${PRODUCT_BRANDING.commandName} bundle verify --bundle <dir> --json\``);

    for (const operation of GATED_OPERATIONS) expect(coreReadme).toContain(`\`${operation}\``);
    for (const code of PRODUCT_ERROR_CODES) expect(coreReadme).toContain(`\`${code}\``);
    expect(coreReadme).toContain("45 generated operations");
    expect(coreReadme).toContain("nine gated operations");
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
});
