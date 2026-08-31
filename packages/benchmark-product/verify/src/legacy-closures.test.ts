import { describe, expect, test } from "vitest";
import {
  ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  ANCHORED_CLAIM_PACKAGE_SCHEMA_ID,
  BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
  BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
  CLAIM_PACKAGE_SCHEMA_ID,
  LEGACY_ANCHOR_MEMBER_PATTERN,
  LEGACY_BUNDLE_FORMATS,
  LEGACY_CLOSURES,
  LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
  PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_FILES,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFIER_MAJOR,
  PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_FILES,
  PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_VERIFIER_MAJOR,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  LegacyBundleFormatSchema,
  legacyClosure,
} from "./legacy-closures.js";

/**
 * The freeze is the point: these are the exact values existing bundles were materialized, signed,
 * and digested against, so this file is a byte-level pin rather than a behavioral test. An edit
 * that reaches these constants is an edit to bundles that already shipped, and it fails here
 * before it can reach a golden fixture.
 */
describe("frozen legacy closure values", () => {
  test("the four format literals", () => {
    expect(BUNDLE_FORMAT).toBe("benchmark-product-public-bundle/2");
    expect(BUNDLE_V4_FORMAT).toBe("benchmark-product-public-bundle/4");
    expect(BUNDLE_V6_FORMAT).toBe("benchmark-product-public-bundle/6");
    expect(BUNDLE_V7_FORMAT).toBe("benchmark-product-public-bundle/7");
    expect(LEGACY_BUNDLE_FORMATS).toEqual([
      "benchmark-product-public-bundle/2",
      "benchmark-product-public-bundle/4",
      "benchmark-product-public-bundle/6",
      "benchmark-product-public-bundle/7",
    ]);
  });

  test("the format admission accepts exactly those four and nothing else", () => {
    for (const format of LEGACY_BUNDLE_FORMATS) {
      expect(LegacyBundleFormatSchema.safeParse(format).success).toBe(true);
    }
    for (const other of [
      "benchmark-product-public-bundle/3",
      "benchmark-product-public-bundle/5",
      "benchmark-product-public-bundle/8",
      "",
    ]) {
      expect(LegacyBundleFormatSchema.safeParse(other).success).toBe(false);
    }
  });

  test("the member lists, in order", () => {
    expect(PUBLIC_BUNDLE_FILES).toEqual([
      "static-bundle.json", "benchmark.json", "run.json", "matrix.json", "report.json",
      "report-envelope.json", "claim-package.json", "verdicts.json", "evidence.json",
      "verification/assembly.jsonl", "trust/public-keys.json", "index.html", "badge.svg",
      "social-card.svg", "README.md", "share.txt",
    ]);
    // v4 is v2 with exactly one member inserted, and the insertion point is part of the frozen
    // shape: the manifest is path-sorted at build time, but every reader that walks this list in
    // order sees `qualification.json` immediately after `claim-package.json`.
    expect(PUBLIC_BUNDLE_V4_FILES).toEqual([
      "static-bundle.json", "benchmark.json", "run.json", "matrix.json", "report.json",
      "report-envelope.json", "claim-package.json", "qualification.json", "verdicts.json",
      "evidence.json", "verification/assembly.jsonl", "trust/public-keys.json", "index.html",
      "badge.svg", "social-card.svg", "README.md", "share.txt",
    ]);
  });

  test("the check arrays, in order", () => {
    expect(PUBLIC_BUNDLE_VERIFICATION_CHECKS).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
    expect(PUBLIC_BUNDLE_V6_CHECKS).toEqual([
      ...PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      "integrity-anchors",
    ]);
    expect(PUBLIC_BUNDLE_V7_CHECKS).toEqual(PUBLIC_BUNDLE_V6_CHECKS);
  });

  test("the claim-package ids", () => {
    expect(CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/1");
    expect(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/2");
    expect(ANCHORED_CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/4");
    expect(ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/5");
  });

  test("the reader-instruction rows", () => {
    expect(PUBLIC_BUNDLE_VERIFIER_MAJOR).toBe("0.1");
    expect(PUBLIC_BUNDLE_V4_VERIFIER_MAJOR).toBe("0.1");
    expect(PUBLIC_BUNDLE_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.1.0 <bundle-dir>");
    expect(PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.1 <bundle-dir>");
    expect(PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND).toBe(PUBLIC_BUNDLE_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND).toBe(PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND).toBe(PUBLIC_BUNDLE_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND).toBe(PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND);
    // v7 is the one closure that cannot stamp the first public line.
    expect(PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.2.1 <bundle-dir>");
    expect(PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.2 <bundle-dir>");
    expect(BINARY_QUALIFICATION_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.1.0 <bundle-dir>");
    expect(BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.1 <bundle-dir>");
    expect(PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.2.1 <bundle-dir>");
    expect(LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.2.0 <bundle-dir>");
    expect(PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND).toBe("npx @colophon-claims/verify@0.2 <bundle-dir>");
  });
});

describe("the four closure cells", () => {
  test("the table has exactly the four formats and each cell names itself", () => {
    expect(Object.keys(LEGACY_CLOSURES).sort()).toEqual([...LEGACY_BUNDLE_FORMATS].sort());
    for (const format of LEGACY_BUNDLE_FORMATS) {
      expect(legacyClosure(format).format).toBe(format);
    }
  });

  test("two independent axes: v6 is v2 plus anchors, v7 is v4 plus anchors", () => {
    expect(LEGACY_BUNDLE_FORMATS.map((format) => {
      const closure = legacyClosure(format);
      return [format, closure.carriesQualification, closure.carriesAnchors];
    })).toEqual([
      [BUNDLE_FORMAT, false, false],
      [BUNDLE_V4_FORMAT, true, false],
      [BUNDLE_V6_FORMAT, false, true],
      [BUNDLE_V7_FORMAT, true, true],
    ]);
  });

  test("the qualification axis alone decides the mandatory member list", () => {
    for (const format of LEGACY_BUNDLE_FORMATS) {
      const closure = legacyClosure(format);
      expect(closure.mandatoryFiles)
        .toEqual(closure.carriesQualification ? PUBLIC_BUNDLE_V4_FILES : PUBLIC_BUNDLE_FILES);
    }
  });

  test("the anchor axis alone decides the check list", () => {
    for (const format of LEGACY_BUNDLE_FORMATS) {
      const closure = legacyClosure(format);
      expect(closure.checks)
        .toEqual(closure.carriesAnchors ? PUBLIC_BUNDLE_V6_CHECKS : PUBLIC_BUNDLE_VERIFICATION_CHECKS);
    }
  });

  test("each cell carries its own reader instructions", () => {
    expect(legacyClosure(BUNDLE_FORMAT).instructions).toEqual({
      command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
    });
    expect(legacyClosure(BUNDLE_V4_FORMAT).instructions).toEqual({
      command: PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
    });
    expect(legacyClosure(BUNDLE_V6_FORMAT).instructions).toEqual({
      command: PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
    });
    expect(legacyClosure(BUNDLE_V7_FORMAT).instructions).toEqual({
      command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
    });
  });
});

describe("the anchor member shape", () => {
  test("admits exactly a lowercase sha256-named record under anchors/", () => {
    const digest = "a".repeat(64);
    expect(LEGACY_ANCHOR_MEMBER_PATTERN.test(`anchors/${digest}.bin`)).toBe(true);
    for (const path of [
      `anchors/${"A".repeat(64)}.bin`,
      `anchors/${"a".repeat(63)}.bin`,
      `anchors/${digest}.json`,
      `anchors/nested/${digest}.bin`,
      `records/${digest}.bin`,
      `x/anchors/${digest}.bin`,
    ]) {
      expect(LEGACY_ANCHOR_MEMBER_PATTERN.test(path), path).toBe(false);
    }
  });

  test("the pattern is stateless across calls", () => {
    const path = `anchors/${"b".repeat(64)}.bin`;
    expect(LEGACY_ANCHOR_MEMBER_PATTERN.test(path)).toBe(true);
    expect(LEGACY_ANCHOR_MEMBER_PATTERN.test(path)).toBe(true);
  });
});
