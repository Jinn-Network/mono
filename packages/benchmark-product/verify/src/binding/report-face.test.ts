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
  declared = false,
): VerifiedRunBinding =>
  verifyRunBinding({
    procedure: "beacon-binding/1",
    mode: "census",
    sealDigest: SEAL,
    sealedAt: SEALED_AT,
    ...(declared ? { declaredSource: source } : {}),
    beacon: { source, round, value: VALUE },
    itemSha256s: POOL,
    order: ORDER,
  });

const sampled = (
  source: "drand/quicknet" | "bitcoin/mainnet" = "drand/quicknet",
  round = source === "drand/quicknet" ? SEAL_DERIVED_ROUND : 900_000,
  declared = false,
): VerifiedRunBinding =>
  verifyRunBinding({
    procedure: "beacon-binding/1",
    mode: "sampled",
    sealDigest: SEAL,
    sealedAt: SEALED_AT,
    ...(declared ? { declaredSource: source } : {}),
    beacon: { source, round, value: VALUE },
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

      const chosen = runBindingSentence(sampled("drand/quicknet", CHOSEN_ROUND));
      expect(chosen).not.toContain("drawn, not chosen");
      expect(chosen).not.toContain("would have required predicting that value");
      expect(chosen).toContain("one of several the operator could have realized");
      expect(chosen).toContain("possibly different slate from the same inputs");
    });

    test("the operator-chosen sentence names the residue in plain words", () => {
      const chosen = runBindingSentence(sampled("drand/quicknet", CHOSEN_ROUND));
      expect(chosen).toContain("names a round selected after the seal");
      expect(chosen).toContain("available alternative");
      // The value's own unpredictability survives; only the choice among values is retracted.
      expect(chosen).toContain("could not have been predicted");
    });

    // Both modes, because the rule is the branch's and not one mode's: `runBindingSentence` is
    // exported for readers of foreign bundles, which reach sampled x height-indexed even though
    // this product's own `runBind` writes census bindings only.
    test.each(["census", "sampled"] as const)(
      "a height-indexed beacon is operator-chosen in %s mode, and claims no unpredictability it cannot check",
      (mode) => {
        const sentence = runBindingSentence(
          mode === "census" ? census("bitcoin/mainnet") : sampled("bitcoin/mainnet"),
        );
        expect(sentence).toContain("No round follows from a seal on a height-indexed source");
        expect(sentence).toContain("it is the chain, not this bundle, that places it after the seal");
        // Nothing places this height after the seal, so no clause -- the opening included -- may
        // say the value was unpredictable, in either of the two wordings the module can produce.
        expect(sentence).not.toContain("could not have been predicted");
        expect(sentence).not.toContain("could not have predicted");
        expect(sentence).not.toContain("selected after the seal");
      },
    );

    test("the sampled opening on a height-indexed beacon concedes what the bundle cannot place", () => {
      const sentence = runBindingSentence(sampled("bitcoin/mainnet"));
      expect(sentence).toContain("drawn from a value this bundle cannot place after the seal");
      expect(sentence).not.toContain("drawn, not chosen");
      expect(sentence).toContain("possibly different slate from the same inputs");
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

    /**
     * Issue #3425. The census sentence used to assert, unconditionally, that the order was fixed by
     * randomness postdating the seal -- on the `attributive` branch too, where the clauses either
     * side of it both concede that nothing in the bundle places the value after the seal.
     */
    test.each([
      ["drand/quicknet", true],
      ["bitcoin/mainnet", false],
    ] as const)("the census postdating claim keys on postSeal (%s)", (source, asserts) => {
      const sentence = runBindingSentence(census(source));
      expect(sentence).toContain("does not show the population was");
      if (asserts) {
        expect(sentence).toContain("order was fixed by randomness postdating the seal");
        expect(sentence).not.toContain("cannot place after the seal");
      } else {
        expect(sentence).toContain("order was tied to a value this bundle cannot place after the seal");
        expect(sentence).not.toContain("postdating the seal");
      }
    });

    test("the seal-derived clause names the source choice that survives it, without miscounting it", () => {
      const sentence = runBindingSentence(census());
      expect(sentence).toContain("What choosing remains is the source");
      // The height-indexed source has no derivable round at all, so its alternatives are every
      // height published since -- a sentence that counted sources would understate exactly that.
      expect(sentence).toContain("indexed by block height");
    });

    test("the census residue is about the ORDER, and never contradicts the population claim", () => {
      const chosen = runBindingSentence(census("drand/quicknet", CHOSEN_ROUND));
      expect(chosen).toContain("none could be selected after the fact");
      expect(chosen).toContain("possibly different order from the same inputs");
      expect(chosen).not.toContain("slate from the same inputs");
    });
  });

  /**
   * Issue #3426. The round rule of #3322 binds only the round WITHIN a source, and one admitted
   * source has no round rule at all -- so until the seal names the beacon, the residue the
   * seal-derived clause reported was the whole of the control on that branch.
   */
  describe("source choice", () => {
    test.each(["census", "sampled"] as const)(
      "a declared source drops the residue clause in %s mode and states the stronger property",
      (mode) => {
        const build = mode === "census" ? census : sampled;
        const declared = runBindingSentence(build("drand/quicknet", SEAL_DERIVED_ROUND, true));
        expect(declared).toContain("Nor was the source:");
        expect(declared).toContain("the sealed record names the beacon this run binds to");
        expect(declared).toContain("first round this source publishes after the seal");
        // The residue paragraph is retracted, not merely joined by a stronger one.
        expect(declared).not.toContain("What choosing remains is the source");
        expect(declared).not.toContain("could have bound a different one");
        // The connective belongs to THIS branch (#3525): "Nor" continues the negative clause
        // before it, and the chosen-round branch's opener would not.
        expect(declared).not.toContain("The source was not:");
      },
    );

    test("an undeclared source still names the residue, and claims nothing stronger", () => {
      expect(runBindingSentence(census())).toContain("What choosing remains is the source");
      expect(runBindingSentence(census())).toContain("indexed by block height");
      expect(runBindingSentence(census())).not.toContain("Nor was the source:");
    });

    // The third face branch: a scheduled source bound to a later-than-required round. `runBind`
    // refuses it, so it is reachable only through a foreign record read by the exported face --
    // which is exactly why it must not be the one branch that says nothing about the source.
    test.each([true, false])("a chosen round on a scheduled source still states the source (declared=%s)", (declared) => {
      const sentence = runBindingSentence(census("drand/quicknet", CHOSEN_ROUND, declared));
      expect(sentence).toContain("one of several the operator could have realized");
      expect(sentence).toContain(declared ? "The source was not:" : "What choosing remains is the source");
    });

    // #3525. The clause after the colon is the same on both branches; only the connective moves,
    // because on this branch the sentence before it asserts a choice rather than denying one, and
    // "Nor" continuing from a positive statement reads as a contradiction of it.
    test("the declared-source connective follows the clause before it on each branch", () => {
      const sealDerived = runBindingSentence(census("drand/quicknet", SEAL_DERIVED_ROUND, true));
      const chosen = runBindingSentence(census("drand/quicknet", CHOSEN_ROUND, true));
      expect(sealDerived).toContain("The round was not the operator's to pick either");
      expect(sealDerived).toContain("Nor was the source:");
      expect(sealDerived).not.toContain("The source was not:");
      expect(chosen).toContain("was still the operator's choice");
      expect(chosen).toContain("The source was not:");
      expect(chosen).not.toContain("Nor was the source:");
      // Only the connective differs: the property both branches state is one string.
      const property = "the sealed record names the beacon this run binds to, so a binding naming "
        + "any other source is refused.";
      expect(sealDerived).toContain(property);
      expect(chosen).toContain(property);
    });

    // AC3: declaring the source fixes the BEACON, not the height inside it. A face that read
    // "not the operator's to pick" over a height nothing constrains would be the overstatement
    // this whole line of work exists to prevent.
    test.each(["census", "sampled"] as const)(
      "a declared height-indexed source still reports the height as chosen in %s mode",
      (mode) => {
        const build = mode === "census" ? census : sampled;
        const sentence = runBindingSentence(build("bitcoin/mainnet", 900_000, true));
        expect(sentence).toContain("The sealed record names this source");
        expect(sentence).toContain("this height was still the operator's choice");
        expect(sentence).toContain("it is the chain, not this bundle, that places it after the seal");
        // Same prohibitions the undeclared height branch carries: nothing places this value after
        // the seal, so no clause may claim it was unpredictable.
        expect(sentence).not.toContain("could not have been predicted");
        expect(sentence).not.toContain("could not have predicted");
      },
    );

    test("the declared and undeclared faces are never the same sentence", () => {
      expect(runBindingSentence(census("drand/quicknet", SEAL_DERIVED_ROUND, true)))
        .not.toBe(runBindingSentence(census()));
      expect(runBindingSentence(census("bitcoin/mainnet", 900_000, true)))
        .not.toBe(runBindingSentence(census("bitcoin/mainnet")));
    });
  });

  /**
   * Issue #3429. Two precision defects in copy this repo holds to a high bar: the alternatives
   * clauses universally quantified "different", which a one-item census falsifies outright and a
   * two-item one falsifies for roughly half of all rounds; and the beacon was named by a round on
   * a source that indexes by height, in a sentence whose whole point is that distinction.
   */
  describe("precision", () => {
    test.each(["census", "sampled"] as const)(
      "the chosen-round alternatives clause claims a possibly different derivation in %s mode",
      (mode) => {
        const derived = mode === "census" ? "order" : "slate";
        const sentence = mode === "census"
          ? runBindingSentence(census("drand/quicknet", CHOSEN_ROUND))
          : runBindingSentence(sampled("drand/quicknet", CHOSEN_ROUND));
        expect(sentence).toContain(`possibly different ${derived} from the same inputs`);
        // The bare universal is the claim the code cannot support: a beacon value does not move
        // every derivation, so "an available alternative deriving a different X" is false of the
        // rounds that happen to derive the same one.
        expect(sentence).not.toContain(`alternative deriving a different ${derived}`);
      },
    );

    test.each(["census", "sampled"] as const)(
      "the height alternatives clause claims a possibly different derivation in %s mode",
      (mode) => {
        const derived = mode === "census" ? "order" : "slate";
        const sentence = mode === "census"
          ? runBindingSentence(census("bitcoin/mainnet"))
          : runBindingSentence(sampled("bitcoin/mainnet"));
        expect(sentence).toContain(`possibly different ${derived} from the same inputs`);
        expect(sentence).not.toContain(`alternative deriving a different ${derived}`);
      },
    );

    test("a scheduled source's beacon is named by its round", () => {
      expect(runBindingSentence(census())).toContain(`drand quicknet round ${SEAL_DERIVED_ROUND}`);
      expect(runBindingSentence(sampled())).toContain(`drand quicknet round ${SEAL_DERIVED_ROUND}`);
    });

    // The sentence that carries this name then turns on the beacon being a height rather than a
    // round, so naming it "round 900000" contradicts the paragraph it opens.
    test.each(["census", "sampled"] as const)(
      "a height-indexed source's beacon is named by its height in %s mode",
      (mode) => {
        const sentence = mode === "census"
          ? runBindingSentence(census("bitcoin/mainnet"))
          : runBindingSentence(sampled("bitcoin/mainnet"));
        expect(sentence).toContain("Bitcoin mainnet height 900000");
        expect(sentence).not.toContain("Bitcoin mainnet round");
      },
    );
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
