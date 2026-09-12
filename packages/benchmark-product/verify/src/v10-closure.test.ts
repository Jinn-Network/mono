// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #4191: the composed presentation generation's closure, pinned where a reader can read it.
 *
 * `/10` is `/6` with a different report page, and the whole point of the allocation is that
 * nothing else moves: same mandatory members, same seven checks, same claim-package shape, one
 * different reader line. Each assertion below is one half of that sentence, stated against the
 * constants rather than against a rendered artefact — the page itself is proven in
 * `assets-report-prose.test.ts`.
 *
 * `/10` is deliberately NOT a member of the frozen legacy zoo: `legacy-closures.ts` is closed, so
 * its schema must keep refusing this format even though `verify.ts` accepts it.
 */

import { describe, expect, test } from "vitest";
import {
  BUNDLE_V6_FORMAT,
  LegacyBundleFormatSchema,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
} from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import {
  PUBLIC_BUNDLE_V10_CHECKS,
  PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS,
} from "./reader-instructions.js";
import { FREEZE_REPO_BUNDLE_SUPPORT } from "./freeze-repo.js";
import { summarizeVerificationOutcome } from "./outcome.js";
import type { PublicBundleVerificationResult } from "./verify.js";

const DIGEST = "a".repeat(64);

describe("the composed presentation generation's allocation", () => {
  test("the format literal, and the reserved /9 hole beside it", () => {
    expect(BUNDLE_V10_FORMAT).toBe("benchmark-product-public-bundle/10");
    // `/9` belongs to an open branch (PR #4090, issue #3698) that has not landed here. The hole is
    // the assertion: this package must not claim to read a format it does not implement.
    expect(SUPPORTED_BUNDLE_FORMATS).toEqual([
      "benchmark-product-public-bundle/2",
      "benchmark-product-public-bundle/4",
      "benchmark-product-public-bundle/5",
      "benchmark-product-public-bundle/6",
      "benchmark-product-public-bundle/7",
      "benchmark-product-public-bundle/8",
      "benchmark-product-public-bundle/10",
    ]);
  });

  test("the frozen legacy admission still refuses it", () => {
    expect(LegacyBundleFormatSchema.safeParse(BUNDLE_V10_FORMAT).success).toBe(false);
  });

  test("the checks are v6's, unchanged and in order", () => {
    // Identity, not deep equality: a presentation allocation that grew a check would be claiming
    // the render proves something the records did not already prove.
    expect(PUBLIC_BUNDLE_V10_CHECKS).toBe(PUBLIC_BUNDLE_V6_CHECKS);
    expect(PUBLIC_BUNDLE_V10_CHECKS).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
  });

  test("the reader line is v7's 0.2.1, never v6's first-public 0.1", () => {
    // Aliases, not fresh literals: `.github/scripts/colophon-publish-manifest.test.mjs` walks the
    // product tree and pins exactly which files may quote a verifier specifier.
    expect(PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND).toBe(PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe(PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS[BUNDLE_V10_FORMAT]).toEqual({
      command: "npx @colophon-claims/verify@0.2.1 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.2 <bundle-dir>",
    });
  });

  test("the outcome denominator is seven, derived rather than inherited", () => {
    const result = {
      format: BUNDLE_V10_FORMAT,
      identity: DIGEST,
      checks: [...PUBLIC_BUNDLE_V10_CHECKS],
      benchmarkSha256: DIGEST, runSha256: DIGEST, matrixSha256: DIGEST,
      reportSha256: DIGEST, reportEnvelopeSha256: DIGEST,
    } as unknown as PublicBundleVerificationResult;
    const outcome = summarizeVerificationOutcome(result);
    expect(outcome.total).toBe(7);
    expect(outcome.passed).toBe(7);
    expect(outcome.notFetched).toBe(0);
  });

  test("it carries no qualification graph, so the freeze export refuses it", () => {
    // Stated against v6's own row rather than as a literal: `/10` mirroring `/6` is the claim, and
    // a literal here would still pass if v6's meaning to the freeze projection ever moved.
    expect(FREEZE_REPO_BUNDLE_SUPPORT[BUNDLE_V10_FORMAT])
      .toEqual(FREEZE_REPO_BUNDLE_SUPPORT[BUNDLE_V6_FORMAT]);
    expect(FREEZE_REPO_BUNDLE_SUPPORT[BUNDLE_V10_FORMAT].qualification).toBe(false);
  });
});
