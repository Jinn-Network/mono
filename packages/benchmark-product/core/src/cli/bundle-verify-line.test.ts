/**
 * The `bundle verify` human line (issue #3689). This is the third Colophon reader surface, after
 * the standalone reader's verdict and the publisher CLI's local-publish answer; issue #2982 ruled
 * the verb for all of them, and this one was left behind.
 */

import { describe, expect, test } from "vitest";
import type { PublicBundleVerificationResult } from "@colophon-claims/verify";
import { renderBundleVerifyLine } from "./main.js";

const V4_RESULT: PublicBundleVerificationResult = {
  format: "benchmark-product-public-bundle/4",
  identity: "a".repeat(64),
  checks: [
    "manifest", "evidence-closure", "trust", "matrix-rederivation",
    "report-verification", "claim-consistency",
  ],
  benchmarkSha256: "b".repeat(64),
  runSha256: "c".repeat(64),
  matrixSha256: "d".repeat(64),
  reportSha256: "e".repeat(64),
  reportEnvelopeSha256: "f".repeat(64),
};

describe("bundle verify human line", () => {
  test("names the operation and asserts no verified result", () => {
    const line = renderBundleVerifyLine(V4_RESULT);
    expect(line).toBe(
      `recomputed public bundle ${"a".repeat(64)}: manifest, evidence-closure, trust,`
      + " matrix-rederivation, report-verification, claim-consistency\n",
    );
    expect(line).not.toMatch(/verified|certified|validated|audited/i);
  });

  test("a deferred check is still never printed as a bare check name", () => {
    const metadataFirst: PublicBundleVerificationResult = {
      format: "benchmark-product-public-bundle/5",
      identity: `sha256:${"a".repeat(64)}`,
      checks: [
        "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
        "matrix-rederivation", "report-verification", "claim-consistency",
      ],
      benchmarkDigest: `sha256:${"b".repeat(64)}`,
      manifestDigest: `sha256:${"c".repeat(64)}`,
      cohortDigest: `sha256:${"d".repeat(64)}`,
      matrixDigest: `sha256:${"e".repeat(64)}`,
      reportDigest: `sha256:${"f".repeat(64)}`,
      evidenceRecords: 12,
      artifacts: 5,
      verifiedSignerKeyIds: [],
      profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
      artifactContent: {
        status: "not-fetched",
        verified: 2,
        notFetched: 1,
        notFetchedDigests: ["1".repeat(64)],
      },
    };
    const line = renderBundleVerifyLine(metadataFirst);
    expect(line).toContain("artifact-integrity (not fetched)");
    expect(line).toMatch(/^recomputed public bundle /);
  });
});
