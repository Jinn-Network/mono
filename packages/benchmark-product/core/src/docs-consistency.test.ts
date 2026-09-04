import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATED_OPERATIONS } from "./authority/policy.js";
import { BUNDLE_MANIFEST_FILENAME } from "./bundle/manifest.js";
import { BUNDLE_FORMAT, PUBLIC_BUNDLE_FILES } from "./legacy-closures.js";
import {
  BUNDLE_V4_FORMAT,
  BUNDLE_V5_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
  BUNDLE_V8_FORMAT,
  FREEZE_REPO_BUNDLE_SUPPORT,
  FREEZE_REPO_FORMAT,
  FREEZE_REPO_MANIFEST_FILENAME,
  LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
  PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS,
  PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V8_CHECKS,
  SUPPORTED_BUNDLE_FORMATS,
} from "@colophon-claims/verify";
import { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } from "@jinn-network/benchmarking-evidence";
import {
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
} from "@jinn-network/benchmarking-protocol";
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

/** The `@x.y[.z]` token inside a full `npx @colophon-claims/verify@… <bundle-dir>` command. */
const readerLine = (command: string): string => {
  const token = /verify(@[0-9][^\s]*)/u.exec(command)?.[1];
  if (token === undefined) throw new Error(`not a reader command: ${command}`);
  return token;
};

const CHECK_COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** The guide states check counts in words, so a list length has to be rendered the same way. */
const checkCountWord = (checks: readonly string[]): string => {
  const word = CHECK_COUNT_WORDS[checks.length];
  if (word === undefined) throw new Error(`no count word for ${checks.length} checks`);
  return word;
};

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

    expect(parity.entries).toHaveLength(46);
    for (const entry of parity.entries) {
      expect(coreReadme, entry.operation).toContain(`\`${entry.operation}\``);
      expect(coreReadme, entry.cliVerb).toContain(`\`${PRODUCT_BRANDING.commandName} ${entry.cliVerb}`);
    }
    expect(parity.exclusions.map((entry) => entry.name)).toContain("bundle verify");
    expect(coreReadme).toContain(`\`${PRODUCT_BRANDING.commandName} bundle verify --bundle <dir> --json\``);

    for (const operation of GATED_OPERATIONS) expect(coreReadme).toContain(`\`${operation}\``);
    for (const code of PRODUCT_ERROR_CODES) expect(coreReadme).toContain(`\`${code}\``);
    expect(coreReadme).toContain("46 generated operations");
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

  it("pins the freeze-repository section to the renderer's own constants and layout", () => {
    // The guide is where `verify/README.md` points a third party for the layout, so a claim here
    // that the renderer does not honour is a spec defect. This pins the two constants and the two
    // shapes that a reader writes a consumer against.
    const guide = read(bundleReadmePath);
    expect(guide).toContain(`\`${FREEZE_REPO_FORMAT}\``);
    expect(guide).toContain(`\`${FREEZE_REPO_MANIFEST_FILENAME}\``);
    expect(guide).toContain("`artifacts/<role>/<sha256>.<json|bin>`");
    // `freeze.json` deliberately does not restate the source rows; saying it does sends a consumer
    // to a field that is always undefined.
    expect(guide).toMatch(/does not restate the source rows/);
    // The published commit recipe must reproduce the pinned oid under a reader's own git config.
    expect(guide).toContain("GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null");
    expect(guide).toContain("git add -A -f");
    expect(guide).toContain("--no-gpg-sign");
    // The guide said "a qualification bundle" with no format qualifier while the export accepted a
    // fixed two (issue #3540), so a reader could not tell which bundle it would take. An accepted
    // format this section does not name is that same defect returning -- scoped to the section,
    // because every format is named somewhere in a document that describes all of them.
    const freezeStart = guide.indexOf("\n## Freeze-artifact repository\n");
    expect(freezeStart).toBeGreaterThan(-1);
    const freezeEnd = guide.indexOf("\n## ", freezeStart + 1);
    const freezeSection = guide.slice(freezeStart, freezeEnd === -1 ? undefined : freezeEnd);
    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      const accepted = FREEZE_REPO_BUNDLE_SUPPORT[format].qualification;
      expect(freezeSection.includes(`\`${format}\``), `${format} accepted=${accepted}`).toBe(accepted);
    }
  });

  it("pins the published evidence-native v5 closure, its two profiles, and its reader line", () => {
    const guide = read(bundleReadmePath);
    expect(guide).toContain(`\`${BUNDLE_V5_FORMAT}\``);
    expect(guide).toContain(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE);
    expect(guide).toContain(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE);
    for (const path of [
      "benchmark.json",
      "analysis-manifest.json",
      "cohort.json",
      "matrix.json",
      "report.json",
      "report-envelope.json",
      "claim-package.json",
    ]) {
      expect(guide, path).toContain(`\`${path}\``);
    }
    expect(guide).toContain("`artifacts/<sha256>.bin`");
    for (const check of EVIDENCE_NATIVE_BUNDLE_V5_CHECKS) expect(guide, check).toContain(`\`${check}\``);
    expect(guide).toContain("seven checks");
    // A published format whose reader line the guide never states is an uncheckable promise
    // (issue #2975): the pin and the claim-package version have to be readable here.
    expect(guide).toContain(PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND);
    const exactReaderRelease = /verify(@[0-9][^\s]*)/u.exec(PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND)?.[1];
    expect(guide).toContain(`\`${exactReaderRelease}\``);
    expect(guide).toContain("`benchmark-product.claim-package/3`");
    // v5 closure is manifest-relative: the published bundle declares members this document does
    // not enumerate, so a reader told to expect a fixed list would reject the real artifact.
    expect(guide).toMatch(/manifest-relative, not a fixed file list/i);
    expect(guide).toContain("`presentation.json`");
    expect(guide).toContain("`source/`");
  });

  it("pins the per-format reader table to the reader's own constants", () => {
    // Issue #3519: the format-to-reader-line mapping is stated in each format section, in this
    // table, and again in the too-old subsection. Nothing pinned any of them, so a ninth format or
    // a `0.2.1` publication had to be applied in three places and could be applied in one. The
    // table is the row a reader holding only `bundle.json` follows, so it is the one pinned here.
    const guide = read(bundleReadmePath);
    const tableStart = guide.indexOf("\n## Portable verification\n");
    expect(tableStart).toBeGreaterThan(-1);
    const tableEnd = guide.indexOf("\n### Reading a bundle with a reader that is too old\n");
    expect(tableEnd).toBeGreaterThan(tableStart);
    const rows = guide
      .slice(tableStart, tableEnd)
      .split("\n")
      .filter((line) => line.startsWith("| `benchmark-product-public-bundle/"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));

    const instruction = (format: keyof typeof PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS) =>
      PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS[format];

    // Keyed by the row's first cell verbatim. Prompted screening is a fourth axis the format string
    // does not record, so `/2` and `/4` each carry two rows pinning different lines.
    const expected: Record<
      string,
      { pinned: readonly string[]; compatible: readonly string[]; checks: readonly string[] }
    > = {
      [`\`${BUNDLE_FORMAT}\`, unprompted`]: {
        pinned: [readerLine(instruction(BUNDLE_FORMAT).command)],
        compatible: [readerLine(instruction(BUNDLE_FORMAT).compatibleCommand)],
        checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      },
      [`\`${BUNDLE_FORMAT}\`, prompted screening`]: {
        pinned: [
          readerLine(PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND),
          readerLine(LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND),
        ],
        compatible: [readerLine(PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND)],
        checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      },
      [`\`${BUNDLE_V4_FORMAT}\`, unprompted`]: {
        pinned: [readerLine(instruction(BUNDLE_V4_FORMAT).command)],
        compatible: [readerLine(instruction(BUNDLE_V4_FORMAT).compatibleCommand)],
        checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      },
      [`\`${BUNDLE_V4_FORMAT}\`, prompted screening`]: {
        pinned: [
          readerLine(PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND),
          readerLine(LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND),
        ],
        compatible: [readerLine(PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND)],
        checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      },
      // The one row that does not read the instruction table's `command`: claim-package/3 has a
      // single `command` field and no compatible-line field, so a `/5` claim pins the compatible
      // major line and nothing else. Pinning `command` here would state a line no `/5` bundle
      // carries.
      [`\`${BUNDLE_V5_FORMAT}\``]: {
        pinned: [readerLine(PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND)],
        compatible: [],
        checks: EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
      },
      [`\`${BUNDLE_V6_FORMAT}\``]: {
        pinned: [readerLine(instruction(BUNDLE_V6_FORMAT).command)],
        compatible: [readerLine(instruction(BUNDLE_V6_FORMAT).compatibleCommand)],
        checks: PUBLIC_BUNDLE_V6_CHECKS,
      },
      [`\`${BUNDLE_V7_FORMAT}\``]: {
        pinned: [readerLine(instruction(BUNDLE_V7_FORMAT).command)],
        compatible: [readerLine(instruction(BUNDLE_V7_FORMAT).compatibleCommand)],
        checks: PUBLIC_BUNDLE_V7_CHECKS,
      },
      [`\`${BUNDLE_V8_FORMAT}\``]: {
        pinned: [readerLine(instruction(BUNDLE_V8_FORMAT).command)],
        compatible: [readerLine(instruction(BUNDLE_V8_FORMAT).compatibleCommand)],
        checks: PUBLIC_BUNDLE_V8_CHECKS,
      },
    };

    expect(rows.map((cells) => cells[0])).toEqual(Object.keys(expected));
    for (const cells of rows) {
      const [subject, pinnedCell, compatibleCell, checksCell] = cells as [
        string,
        string,
        string,
        string,
      ];
      const row = expected[subject]!;
      for (const line of row.pinned) expect(pinnedCell, subject).toContain(`\`${line}\``);
      for (const line of row.compatible) expect(compatibleCell, subject).toContain(`\`${line}\``);
      if (row.compatible.length === 0) expect(compatibleCell, subject).toBe("none pinned");
      expect(checksCell, subject).toBe(checkCountWord(row.checks));
    }
    // A format with no row is the defect this pins: the table is the fallback for a reader who has
    // only `bundle.json`, so every format that reader can hold must appear in it.
    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      expect(rows.some((cells) => cells[0]!.startsWith(`\`${format}\``)), format).toBe(true);
    }
  });

  it("pins the too-old refusal sample to the formats the released 0.2.0 reader supports", () => {
    // The `supportedFormats` array is quoted verbatim as the thing an auditor diffs their own
    // format against, so it states the RELEASED 0.2.0 list, not the current one. That list is
    // derivable, and derivable POSITIVELY: 0.2.0 reads exactly the formats that stamp the first
    // public line. Deriving it as "not the 0.2.1 line" would silently readmit a future format
    // that pins some third line.
    const guide = read(bundleReadmePath);
    const start = guide.indexOf("\n### Reading a bundle with a reader that is too old\n");
    expect(start).toBeGreaterThan(-1);
    const end = guide.indexOf("\n## ", start + 1);
    const section = guide.slice(start, end === -1 ? undefined : end);
    const sample = /```json\n(\{.*?\})\n```/su.exec(section)?.[1];
    expect(sample, "the too-old subsection must carry the --json refusal sample").toBeDefined();
    const refusal = JSON.parse(sample!) as {
      verifierVersion: string;
      supportedFormats: string[];
    };
    const releasedFormats = SUPPORTED_BUNDLE_FORMATS.filter(
      (format) =>
        PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS[format].command ===
        PUBLIC_BUNDLE_VERIFICATION_COMMAND,
    );
    expect(refusal.supportedFormats).toEqual([...releasedFormats]);
    expect(refusal.verifierVersion).toBe(
      readerLine(LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND).slice(1),
    );
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
