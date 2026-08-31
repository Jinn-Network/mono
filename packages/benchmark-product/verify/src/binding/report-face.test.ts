// SPDX-License-Identifier: Apache-2.0

/** Coverage for the `beacon-binding/1` report face (issue #2976, acceptance criteria 3 and 4). */

import { describe, expect, test } from "vitest";
import {
  computeBeaconOrder,
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

const census = (source: "drand/quicknet" | "bitcoin/mainnet" = "drand/quicknet"): VerifiedRunBinding =>
  verifyRunBinding({
    procedure: "beacon-binding/1",
    mode: "census",
    sealDigest: SEAL,
    sealedAt: SEALED_AT,
    beacon: { source, round: source === "drand/quicknet" ? 100_000_000 : 900_000, value: VALUE },
    itemSha256s: POOL,
    order: ORDER,
  });

const sampled = (): VerifiedRunBinding =>
  verifyRunBinding({
    procedure: "beacon-binding/1",
    mode: "sampled",
    sealDigest: SEAL,
    sealedAt: SEALED_AT,
    beacon: { source: "drand/quicknet", round: 100_000_000, value: VALUE },
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
    expect(sentence).toContain("drand quicknet round 100000000");
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
