import { submissionExtensionBlock } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";

/**
 * The three legs of `preregistration-precedes-dispatch` (design §7.2, §12.1). Leg (a) is
 * structural and needs only `benchmarking-records` — it runs unconditionally below. Legs (b)
 * (anchored: a chain observes the Run announcement at/before the earliest cell post) and (c)
 * (local append-order-only, labeled non-decision-grade) need a dispatched-cell transcript that
 * does not exist until `benchmarking/run` (wave 2, M4) and `benchmarking/marketplace` (wave 3,
 * M7) land; callers supply them once those packages exist.
 */
export interface OrderingLegs {
  readonly anchored?: {
    readonly runAnnouncedAt: string;
    readonly earliestCellPostAt: string;
    readonly violatesOrder: boolean;
  };
  readonly localAppendOrder?: {
    readonly runAppendedBeforeCells: boolean;
  };
}

/**
 * §16 ordering conformance. Leg (a) (structural) is real and green here, against
 * `benchmarking-records` alone: a dispatched cell's `jinn.benchmarking/cell` extension block
 * commits to the Run digest it was built from, so a verifier can catch a cell dispatched under a
 * Run other than the one it claims. Legs (b)/(c) run only when a caller supplies a transcript
 * (M4/M7 territory, see this package's README) — omitted legs are reported, not silently skipped.
 */
export function describeOrderingConformance(legs: OrderingLegs = {}): void {
  describe("benchmarking ordering conformance: preregistration-precedes-dispatch (design §7.2/§16)", () => {
    describe("leg (a): structural (the extension block commits to a specific Run digest)", () => {
      test("a dispatched cell's extension block carries its own Run digest, cellKey, and armId", () => {
        const runDigest = `sha256:${"a".repeat(64)}`;
        const cell = `${"b".repeat(64)}/armA/1`;
        const block = submissionExtensionBlock(runDigest, cell, "armA");
        expect(block).toEqual({ run: runDigest, cellKey: cell, armId: "armA" });
      });

      test("a verifier can detect a cell dispatched under a Run other than the pre-registered one", () => {
        const preregisteredRunDigest = `sha256:${"1".repeat(64)}`;
        const otherRunDigest = `sha256:${"2".repeat(64)}`;
        const cell = `${"c".repeat(64)}/armA/1`;
        const block = submissionExtensionBlock(otherRunDigest, cell, "armA");
        expect(block.run === preregisteredRunDigest).toBe(false);
      });
    });

    describe("leg (b): anchored (a chain-observed Run announcement at/before the earliest cell post)", () => {
      test.runIf(legs.anchored !== undefined)("the announcement precedes the earliest cell post", () => {
        expect(legs.anchored!.violatesOrder).toBe(false);
        expect(new Date(legs.anchored!.runAnnouncedAt).getTime())
          .toBeLessThanOrEqual(new Date(legs.anchored!.earliestCellPostAt).getTime());
      });

      test.skipIf(legs.anchored !== undefined)(
        "skipped: no anchored transcript supplied (asserted by benchmarking/marketplace, M7)",
        () => {},
      );
    });

    describe("leg (c): local append-order-only (labeled non-decision-grade, §12.2)", () => {
      test.runIf(legs.localAppendOrder !== undefined)(
        "the Run record was appended before its cells, in local append order",
        () => {
          expect(legs.localAppendOrder!.runAppendedBeforeCells).toBe(true);
        },
      );

      test.skipIf(legs.localAppendOrder !== undefined)(
        "skipped: no local-append-order transcript supplied (asserted by benchmarking/run, M4)",
        () => {},
      );
    });
  });
}
