import {
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
} from "@jinn-network/benchmarking-protocol";
import { describe, expect, test } from "vitest";
import { bundleIdentityLabel, isMetadataFirstBundle } from "./outcome.js";
import type { PublicBundleVerificationResult } from "./verify.js";

const DIGEST = "a".repeat(64);

describe("bundleIdentityLabel", () => {
  test("prefixes a legacy bare digest", () => {
    expect(bundleIdentityLabel({ identity: DIGEST })).toBe(`sha256:${DIGEST}`);
  });

  test("leaves an evidence-native identity that already carries the prefix alone", () => {
    expect(bundleIdentityLabel({ identity: `sha256:${DIGEST}` })).toBe(`sha256:${DIGEST}`);
  });
});

function evidenceNative(profile: string, status: "verified" | "not-fetched"): PublicBundleVerificationResult {
  return {
    format: "benchmark-product-public-bundle/5",
    profile,
    identity: `sha256:${DIGEST}`,
    checks: [
      "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
      "matrix-rederivation", "report-verification", "claim-consistency",
    ],
    artifactContent: { status, verified: 0, notFetched: 0, notFetchedDigests: [] },
    benchmarkDigest: `sha256:${DIGEST}`,
    manifestDigest: `sha256:${DIGEST}`,
    cohortDigest: `sha256:${DIGEST}`,
    matrixDigest: `sha256:${DIGEST}`,
    reportDigest: `sha256:${DIGEST}`,
    evidenceRecords: 0,
    artifacts: 0,
    verifiedSignerKeyIds: [],
  } as PublicBundleVerificationResult;
}

describe("isMetadataFirstBundle", () => {
  test("keys on the declared profile, not on whether a body happened to be deferred", () => {
    const profile = BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE;
    // Zero declared artifacts means nothing was deferred, so `artifactContent.status` reads
    // `verified` -- the observed side effect the declared profile must not be inferred from.
    expect(isMetadataFirstBundle(evidenceNative(profile, "verified"))).toBe(true);
  });

  test("is false for the full-evidence profile", () => {
    const profile = BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE;
    expect(isMetadataFirstBundle(evidenceNative(profile, "verified"))).toBe(false);
  });

  test("is false for a legacy format that declares no profile", () => {
    const legacy = {
      format: "benchmark-product-public-bundle/2",
      identity: DIGEST,
      checks: [],
      benchmarkSha256: DIGEST, runSha256: DIGEST, matrixSha256: DIGEST,
      reportSha256: DIGEST, reportEnvelopeSha256: DIGEST,
    } as unknown as PublicBundleVerificationResult;
    expect(isMetadataFirstBundle(legacy)).toBe(false);
  });
});
