// SPDX-License-Identifier: Apache-2.0

/** Coverage for the `beacon-binding/1` report face (issue #2976, acceptance criteria 3 and 4). */

import { describe, expect, test } from "vitest";
import {
  computeBeaconOrder,
  requiredBeaconRound,
  verifyRunBinding,
  type VerifiedRunBinding,
} from "./beacon-binding.js";
import { runBindingClass, runBindingSentence, runBoundVenueLimits } from "./report-face.js";

const ID = (digit: string): string => `sha256:${digit.repeat(64)}`;
const SEAL = ID("a");
const VALUE = "b".repeat(64);
const POOL = [ID("1"), ID("2"), ID("3"), ID("4"), ID("5")];
const ORDER = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).order;
const SEALED_AT = "2026-08-01T00:00:00.000Z";

/** The one round the seal above names on quicknet's schedule -- what `bind` now admits (#3322). */
const SEAL_DERIVED_ROUND = requiredBeaconRound("drand/quicknet", SEALED_AT)!.round;
/** A later round: postdates the seal, but the operator picked it from among those published since. */
const CHOSEN_ROUND = SEAL_DERIVED_ROUND + 1_000;

const census = (
  source: "drand/quicknet" | "bitcoin/mainnet" = "drand/quicknet",
  round = source === "drand/quicknet" ? SEAL_DERIVED_ROUND : 900_000,
): VerifiedRunBinding =>
  verifyRunBinding({
    procedure: "beacon-binding/1",
    mode: "census",
    sealDigest: SEAL,
    sealedAt: SEALED_AT,
    beacon: { source, round, value: VALUE },
    itemSha256s: POOL,
    order: ORDER,
  });

const sampled = (round = SEAL_DERIVED_ROUND): VerifiedRunBinding =>
  verifyRunBinding({
    procedure: "beacon-binding/1",
    mode: "sampled",
    sealDigest: SEAL,
    sealedAt: SEALED_AT,
    beacon: { source: "drand/quicknet", round, value: VALUE },
    poolItemSha256s: POOL,
    sampleSize: 2,
    sample: ORDER.slice(0, 2),
  });

describe("runBindingClass", () => {
  test.each([
    [undefined, "none"],
    [sampled(), "beacon-drawn-slate"],
    [census(), "beacon-ordering-only"],
  ])("classifies %#", (binding, expected) => {
    expect(runBindingClass(binding as VerifiedRunBinding | undefined)).toBe(expected);
  });
});

describe("runBindingSentence", () => {
  test("the unbound sentence says execution is not established to follow the seal", () => {
    const sentence = runBindingSentence(undefined);
    expect(sentence).toContain("bound to no public randomness");
    expect(sentence).toContain("execution followed the seal");
  });

  test("the sampled sentence states the draw, its inputs, and offline recomputation", () => {
    const sentence = runBindingSentence(sampled());
    expect(sentence).toContain("drawn, not chosen");
    expect(sentence).toContain("2 items");
    expect(sentence).toContain("declared pool of 5");
    expect(sentence).toContain("beacon-binding/1");
    expect(sentence).toContain(`drand quicknet round ${SEAL_DERIVED_ROUND}`);
    expect(sentence).toContain("recomputes the derivation offline");
    expect(sentence).toContain(SEALED_AT);
  });

  test("the census sentence names the ordering-only binding as the weaker one, in plain words", () => {
    const sentence = runBindingSentence(census());
    expect(sentence).toContain("whole declared population of 5 items");
    expect(sentence).toContain("binds execution ORDER only");
    expect(sentence).toContain("weaker binding than a beacon-drawn slate");
    expect(sentence).toContain("does not show the population was");
    expect(sentence).toContain("recomputes the derivation offline");
  });

  test("a scheduled beacon asserts its publication instant; a height-indexed one is attributive", () => {
    expect(runBindingSentence(census())).toContain("did not exist until");
    const attributive = runBindingSentence(census("bitcoin/mainnet"));
    expect(attributive).toContain("requires block headers");
    expect(attributive).not.toContain("did not exist until");
  });

  test("the two modes never share one sentence", () => {
    expect(runBindingSentence(sampled())).not.toBe(runBindingSentence(census()));
  });

  /**
   * Issue #3322. The sampled sentence used to assert, unconditionally, that selecting the slate
   * after the fact would have required predicting the beacon value. That is true only where the
   * seal named the round; where the operator picked one, selecting the slate after the fact needed
   * no prediction at all, only a wait.
   */
  describe("round choice", () => {
    test("the sampled sentence claims an unchosen slate only where the seal named the round", () => {
      const sealDerived = runBindingSentence(sampled());
      expect(sealDerived).toContain("drawn, not chosen");
      expect(sealDerived).toContain("would have required predicting that value");
      expect(sealDerived).toContain("first round this source publishes after the seal");

      const chosen = runBindingSentence(sampled(CHOSEN_ROUND));
      expect(chosen).not.toContain("drawn, not chosen");
      expect(chosen).not.toContain("would have required predicting that value");
      expect(chosen).toContain("could still have been selected after the fact");
    });

    test("the operator-chosen sentence names the residue in plain words", () => {
      const chosen = runBindingSentence(sampled(CHOSEN_ROUND));
      expect(chosen).toContain("names a round selected after the seal");
      expect(chosen).toContain("available alternative");
      // The value's own unpredictability survives; only the choice among values is retracted.
      expect(chosen).toContain("could not have been predicted");
    });

    test("a height-indexed beacon is always operator-chosen: no round follows from its seal", () => {
      expect(runBindingSentence(census("bitcoin/mainnet")))
        .toContain("Which post-seal value applied was still the operator's choice");
    });

    test("the census sentence gains the residue and nothing stronger", () => {
      const chosen = runBindingSentence(census("drand/quicknet", CHOSEN_ROUND));
      expect(chosen).toContain("binds execution ORDER only");
      expect(chosen).toContain("weaker binding than a beacon-drawn slate");
      expect(chosen).toContain("does not show the population was");
      expect(chosen).toContain("still the operator's choice");
      // Nothing in the census branch may claim the stronger property, on either basis.
      for (const sentence of [chosen, runBindingSentence(census())]) {
        expect(sentence).not.toContain("drawn, not chosen");
        expect(sentence).not.toContain("would have required predicting that value");
      }
    });

    test("the seal-derived clause names the source choice that survives it", () => {
      expect(runBindingSentence(census())).toContain("beacon sources");
    });
  });
});

describe("runBoundVenueLimits", () => {
  const limits = ["one", "two"];

  test("is the identity for an unbound run, preserving existing limits bytes", () => {
    expect(runBoundVenueLimits(limits, undefined)).toBe(limits);
  });

  test("appends exactly the binding sentence, leaving the existing entries in place", () => {
    const bound = census();
    expect(runBoundVenueLimits(limits, bound)).toEqual([...limits, runBindingSentence(bound)]);
  });
});
