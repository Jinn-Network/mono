// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the shared binding-to-run linkage rule (issue #3370).
 *
 * The table below is the whole rule, exercised on the pure inputs both callers reduce to. The
 * WORKSPACE side's end-to-end proof that the same function still refuses the same three forgeries
 * with the same messages is `core/src/operations/run-bind.test.ts`, which must pass unmodified; the
 * BUNDLE side's is `core/src/bundle/v10-binding-materialize.test.ts`. Neither of those can live
 * here, because this package cannot depend on the product core that materializes a bundle.
 *
 * Every digest, beacon value and item id below is synthetic.
 */

import { describe, expect, test } from "vitest";
import {
  BEACON_BINDING_PROCEDURE,
  RunBindingError,
  computeBeaconOrder,
  requiredBeaconRound,
  verifyRunBinding,
  type VerifiedRunBinding,
} from "./beacon-binding.js";
import { assertRunBindingLinkage } from "./bundle-carriage.js";

const RUN_SHA256 = "a".repeat(64);
const SEAL_DIGEST = `sha256:${RUN_SHA256}`;
const SEALED_AT = "2026-08-01T00:00:00.000Z";
const VALUE = "b".repeat(64);
const POOL = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`];

/** The round the seal derives, so the fixture is the strongest binding the rule can be handed. */
const SEAL_DERIVED_ROUND = requiredBeaconRound("drand/quicknet", SEALED_AT)!.round;

function bound(overrides: Record<string, unknown> = {}): VerifiedRunBinding {
  return verifyRunBinding({
    procedure: BEACON_BINDING_PROCEDURE,
    mode: "census",
    sealDigest: SEAL_DIGEST,
    sealedAt: SEALED_AT,
    beacon: { source: "drand/quicknet", round: SEAL_DERIVED_ROUND, value: VALUE },
    itemSha256s: POOL,
    order: computeBeaconOrder({ sealDigest: SEAL_DIGEST, beaconValue: VALUE, itemSha256s: POOL }).order,
    ...overrides,
  });
}

describe("assertRunBindingLinkage", () => {
  test("admits the binding that belongs to this run", () => {
    expect(() => assertRunBindingLinkage({
      binding: bound({ declaredSource: "drand/quicknet" }),
      runSha256: RUN_SHA256,
      sealedAt: SEALED_AT,
      declaredSource: "drand/quicknet",
    })).not.toThrow();
  });

  test("refuses a record whose sealDigest names another run", () => {
    // The post-hoc move the binding exists to make impossible: honest bytes, honest digest,
    // internally consistent -- everything but the run they belong to.
    expect(() => assertRunBindingLinkage({
      binding: bound(),
      runSha256: "c".repeat(64),
      sealedAt: SEALED_AT,
      declaredSource: undefined,
    })).toThrow(
      new RegExp(`binding covers ${SEAL_DIGEST}, which is not this run's sealed Run sha256:${"c".repeat(64)}`, "u"),
    );
  });

  test("refuses a record whose sealedAt disagrees with the run's declared seal instant", () => {
    expect(() => assertRunBindingLinkage({
      binding: bound(),
      runSha256: RUN_SHA256,
      sealedAt: "2020-01-01T00:00:00Z",
      declaredSource: undefined,
    })).toThrow(/binding names a seal at 2026-08-01T00:00:00\.000Z, but this run was sealed at 2020-01-01T00:00:00Z/u);
  });

  test("skips the seal-instant comparison when the run declares no instant", () => {
    // Every Run sealed before `beacon-source/v1` carried `sealedAt` is this case. Absence is the
    // legal, pre-existing state, so failing it would refuse every already-published run rather than
    // catch a forgery -- the check the bytes support is the one that runs, and the one they do not
    // is named to the reader by step 2d of EXTERNAL-VERIFICATION.md instead.
    expect(() => assertRunBindingLinkage({
      binding: bound(),
      runSha256: RUN_SHA256,
      sealedAt: undefined,
      declaredSource: undefined,
    })).not.toThrow();
  });

  test("refuses a record that drops a source its run declared", () => {
    // Omission is the case that makes the source check load-bearing rather than tidy: a binding
    // that simply drops the field verifies clean and reports `operator-chosen`.
    expect(() => assertRunBindingLinkage({
      binding: bound(),
      runSha256: RUN_SHA256,
      sealedAt: SEALED_AT,
      declaredSource: "drand/quicknet",
    })).toThrow(/binding declares no beacon source, but its sealed Run declares drand\/quicknet/u);
  });

  test("refuses a record that declares a source its run did not", () => {
    expect(() => assertRunBindingLinkage({
      binding: bound({ declaredSource: "drand/quicknet" }),
      runSha256: RUN_SHA256,
      sealedAt: SEALED_AT,
      declaredSource: undefined,
    })).toThrow(/binding names drand\/quicknet as this run's declared beacon source, but its sealed Run declares none/u);
  });

  test("refuses a record that names a different source than its run", () => {
    expect(() => assertRunBindingLinkage({
      binding: bound({ declaredSource: "drand/quicknet" }),
      runSha256: RUN_SHA256,
      sealedAt: SEALED_AT,
      declaredSource: "drand/default",
    })).toThrow(
      /binding names drand\/quicknet as this run's declared beacon source, but its sealed Run declares drand\/default/u,
    );
  });

  test("raises RunBindingError, so every caller translates one error class", () => {
    try {
      assertRunBindingLinkage({
        binding: bound(),
        runSha256: "c".repeat(64),
        sealedAt: SEALED_AT,
        declaredSource: undefined,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RunBindingError);
      expect((error as RunBindingError).path).toBe("sealDigest");
    }
  });
});
