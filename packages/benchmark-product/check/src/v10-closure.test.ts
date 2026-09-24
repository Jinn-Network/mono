// SPDX-License-Identifier: Apache-2.0

/**
 * The composed generation's allocation, pinned where a reader can read it (issue #4191 allocated
 * the number; issue #3403 made it the capability generation).
 *
 * `/10` states its capabilities in its manifest rather than in the choice of number, so nothing
 * here is a fixed cell any more: the check list, the denominator, and what the format means to the
 * freeze projection are all derived from the vector a bundle declares. What IS fixed is pinned
 * below — the literal, the `/9` hole beside it, the legacy admission that must keep refusing it,
 * and the closure the vector naming `anchoring` alone composes to, which is exactly the closure
 * this format was before it carried a vector. The page it renders is proven in
 * `assets-report-prose.test.ts`.
 */

import { describe, expect, test } from "vitest";
import {
  LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  LegacyBundleFormatSchema,
  PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_FILES,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
} from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import {
  PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS,
} from "./reader-instructions.js";
import { CAPABILITY_REGISTRY, READER_RELEASE_LINES, composeClosure, readerInstructions } from "./capabilities.js";
import { freezeRepoBundleSupport } from "./freeze-repo.js";
import { summarizeVerificationOutcome } from "./outcome.js";
import { expectRefusal } from "./testing/expect-refusal.js";
import type { PublicBundleVerificationResult } from "./verify.js";

const DIGEST = "a".repeat(64);

/** Every vector the registry admits, by brute force over its subsets. */
const ADMITTED_VECTORS: readonly string[][] = Array.from({ length: 2 ** CAPABILITY_REGISTRY.length }, (_, mask) =>
  CAPABILITY_REGISTRY.filter((__, index) => (mask & (1 << index)) !== 0).map((entry) => entry.token).sort())
  .filter((vector) => {
    try {
      composeClosure(vector);
      return true;
    } catch {
      return false;
    }
  });

describe("the composed generation's allocation", () => {
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

  test("the vector naming anchoring alone composes to the closure this format had before it carried one", () => {
    // v6's members and v6's seven checks, in order. Nothing that was true of the pre-vector `/10`
    // stops being true of the bundle that declares exactly what that format implied.
    const closure = composeClosure(["anchoring"]);
    expect(closure.mandatoryFiles).toEqual(PUBLIC_BUNDLE_FILES);
    expect(closure.checks).toEqual(PUBLIC_BUNDLE_V6_CHECKS);
    expect(closure.claimSections).toEqual(["anchors"]);
  });

  test("the reader line is the first checker release, never v7's verify 0.2.1 or v6's first-public 0.1", () => {
    // The row is the release table's checker entry, which `.github/scripts/colophon-publish-manifest.mjs`
    // lists among the files whose reader specifiers the publish guard checks against npm.
    expect(PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND).toBe(READER_RELEASE_LINES["check@0.2.1"].command);
    expect(PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe(READER_RELEASE_LINES["check@0.2.1"].compatibleCommand);
    expect(PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND).not.toBe(PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND)
      .not.toBe(PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND);
    expect(PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS[BUNDLE_V10_FORMAT]).toEqual({
      command: "npx @colophon-claims/check@0.2.1 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/check@0.2 <bundle-dir>",
    });
  });

  test("no admitted vector pins a reader that refuses /10 (issue #4746)", () => {
    // Every exact line the frozen closures pin names a verify release that predates the composed
    // generation. Each is immutable and refuses a /10 bundle at manifest parse, so a /10 claim
    // naming one tells its reader to run a checker that refuses the bundle in hand. The first
    // checker release is the one that reads /10, and `@0.2` under the checker's own name admits
    // no release before it.
    const preComposition = new Set<string>([
      PUBLIC_BUNDLE_VERIFICATION_COMMAND,
      PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
      PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
      LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
    ]);
    for (const vector of ADMITTED_VECTORS) {
      const { command, compatibleCommand } = readerInstructions(vector);
      expect(preComposition.has(command), JSON.stringify(vector)).toBe(false);
      expect(command, JSON.stringify(vector)).toBe("npx @colophon-claims/check@0.2.1 <bundle-dir>");
      expect(compatibleCommand, JSON.stringify(vector)).toBe("npx @colophon-claims/check@0.2 <bundle-dir>");
    }
  });

  test("repointing /10 leaves every earlier format's reader lines byte for byte (issue #4746)", () => {
    const { [BUNDLE_V10_FORMAT]: _composed, ...earlier } = PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS;
    const first = {
      command: "npx @colophon-claims/verify@0.1.0 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.1 <bundle-dir>",
    };
    const second = {
      command: "npx @colophon-claims/verify@0.2.1 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.2 <bundle-dir>",
    };
    expect(earlier).toEqual({
      "benchmark-product-public-bundle/2": first,
      "benchmark-product-public-bundle/4": first,
      "benchmark-product-public-bundle/5": first,
      "benchmark-product-public-bundle/6": first,
      "benchmark-product-public-bundle/7": second,
      "benchmark-product-public-bundle/8": second,
    });
    expect(PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND).toBe(second.command);
    expect(LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND)
      .toBe("npx @colophon-claims/verify@0.2.0 <bundle-dir>");
  });

  test("the format's one instruction row is the line every admitted vector derives", () => {
    // The row serves a reader who has only the format string, and surfaces keyed by format read
    // it. It stays truthful exactly as long as no vector derives a later line. The capability that
    // first needs a later release fails here, which is the moment those surfaces must start
    // reading `readerInstructions(vector)` instead.
    expect(ADMITTED_VECTORS.length).toBeGreaterThan(1);
    for (const vector of ADMITTED_VECTORS) {
      expect(readerInstructions(vector), JSON.stringify(vector))
        .toEqual(PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS[BUNDLE_V10_FORMAT]);
    }
  });

  test("the outcome denominator is derived from the declared vector, never inherited from a cell", () => {
    const outcomeOf = (capabilities: readonly string[]) => {
      const checks = [...composeClosure(capabilities).checks];
      return summarizeVerificationOutcome({
        format: BUNDLE_V10_FORMAT,
        capabilities,
        identity: DIGEST,
        checks,
        benchmarkSha256: DIGEST, runSha256: DIGEST, matrixSha256: DIGEST,
        reportSha256: DIGEST, reportEnvelopeSha256: DIGEST,
      } as unknown as PublicBundleVerificationResult);
    };
    expect(outcomeOf([])).toEqual(expect.objectContaining({ total: 6, passed: 6, notFetched: 0 }));
    expect(outcomeOf(["anchoring"])).toEqual(expect.objectContaining({ total: 7, passed: 7 }));
    expect(outcomeOf(["anchoring", "binary-qualification", "disclosure-specification"]))
      .toEqual(expect.objectContaining({ total: 8, passed: 8 }));
  });

  test("an untyped caller's unknown or missing vector is refused, never counted", () => {
    // `summarizeVerificationOutcome` is a published entry point. A JavaScript caller can hand it a
    // `/10` result with no vector or a token this build does not implement; printing some other
    // vector's denominator over it is exactly the accounting the derivation exists to forbid.
    for (const capabilities of [undefined, ["zz-unknown"]]) {
      const refusal = expectRefusal(() => summarizeVerificationOutcome({
        format: BUNDLE_V10_FORMAT,
        ...(capabilities === undefined ? {} : { capabilities }),
        identity: DIGEST,
        checks: [],
      } as unknown as PublicBundleVerificationResult));
      expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
    }
  });

  test("the freeze export accepts it exactly when it declares the qualification graph", () => {
    const support = (capabilities: readonly string[]) =>
      freezeRepoBundleSupport({ format: BUNDLE_V10_FORMAT, capabilities: [...capabilities], files: [] });
    expect(support(["anchoring"])).toEqual({ qualification: false, disclosure: false });
    expect(support(["anchoring", "binary-qualification"])).toEqual({ qualification: true, disclosure: false });
    expect(support(["binary-qualification", "disclosure-specification"])).toEqual({ qualification: true, disclosure: true });
  });
});
