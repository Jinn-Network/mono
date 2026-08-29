// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for `beacon-binding/1` (issue #2976).
 *
 * Every digest, beacon value and item id below is synthetic -- `"sha256:" + "<digit>".repeat(64)`
 * patterns and repeated-hex beacon values, never a real drand round or block hash.
 */

import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  BEACON_BINDING_PROCEDURE,
  BEACON_SOURCES,
  BEACON_SOURCE_IDS,
  RunBindingError,
  beaconRoundInstant,
  computeBeaconOrder,
  verifyRunBinding,
  type BeaconReference,
  type RunBinding,
} from "./beacon-binding.js";
import { computeScreeningPoolDigest } from "../admission/screening-sample.js";

const ID = (digit: string): string => `sha256:${digit.repeat(64)}`;
const SEAL = ID("a");
const VALUE = "b".repeat(64);
const POOL = [ID("1"), ID("2"), ID("3"), ID("4"), ID("5")];

/** drand quicknet round 1 is genesis; every round after it is 3 seconds later. */
const QUICKNET_LATE_ROUND = 100_000_000;
const beacon = (overrides: Partial<BeaconReference> = {}): BeaconReference => ({
  source: "drand/quicknet",
  round: QUICKNET_LATE_ROUND,
  value: VALUE,
  ...overrides,
});

const censusBinding = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => {
  const base = {
    procedure: BEACON_BINDING_PROCEDURE,
    mode: "census",
    sealDigest: SEAL,
    sealedAt: "2026-08-01T00:00:00.000Z",
    beacon: beacon(),
    itemSha256s: POOL,
    order: computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).order,
  };
  return { ...base, ...overrides };
};

const sampledBinding = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => {
  const order = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).order;
  const base = {
    procedure: BEACON_BINDING_PROCEDURE,
    mode: "sampled",
    sealDigest: SEAL,
    sealedAt: "2026-08-01T00:00:00.000Z",
    beacon: beacon(),
    poolItemSha256s: POOL,
    sampleSize: 2,
    sample: order.slice(0, 2),
  };
  return { ...base, ...overrides };
};

describe("beaconRoundInstant", () => {
  test("maps a drand quicknet round to its published instant by genesis + (round - 1) * period", () => {
    const source = BEACON_SOURCES["drand/quicknet"];
    expect(beaconRoundInstant(beacon({ round: 1 }))).toBe(
      new Date(source.genesisTimeSeconds * 1000).toISOString(),
    );
    expect(beaconRoundInstant(beacon({ round: 2 }))).toBe(
      new Date((source.genesisTimeSeconds + source.periodSeconds) * 1000).toISOString(),
    );
  });

  test("maps a drand default-chain round on its own 30-second schedule", () => {
    const source = BEACON_SOURCES["drand/default"];
    expect(beaconRoundInstant(beacon({ source: "drand/default", round: 3 }))).toBe(
      new Date((source.genesisTimeSeconds + 2 * source.periodSeconds) * 1000).toISOString(),
    );
  });

  test("returns undefined for a height-indexed source, whose time needs headers", () => {
    expect(beaconRoundInstant(beacon({ source: "bitcoin/mainnet", round: 900_000 }))).toBeUndefined();
  });

  test("every registered source is either scheduled or height-indexed, and none is both", () => {
    for (const id of BEACON_SOURCE_IDS) {
      const source = BEACON_SOURCES[id];
      const scheduled = source.timeBasis === "deterministic-round-time";
      expect("genesisTimeSeconds" in source).toBe(scheduled);
      expect("periodSeconds" in source).toBe(scheduled);
    }
  });
});

describe("computeBeaconOrder", () => {
  test("orders by the HMAC stream keyed on utf8(sealDigest || beaconValue), message utf8(itemSha256)", () => {
    const key = Buffer.from(`${SEAL}${VALUE}`, "utf8");
    const expected = [...POOL]
      .map((itemSha256) => ({
        itemSha256,
        hex: createHmac("sha256", key).update(Buffer.from(itemSha256, "utf8")).digest("hex"),
      }))
      .sort((left, right) => (left.hex < right.hex ? -1 : left.hex > right.hex ? 1 : 0))
      .map((entry) => entry.itemSha256);

    expect(computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).order)
      .toEqual(expected);
  });

  test("is a permutation of the pool", () => {
    const { order } = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL });
    expect([...order].sort()).toEqual([...POOL].sort());
  });

  test("does not depend on input order", () => {
    const forward = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL });
    const reversed = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: [...POOL].reverse() });
    expect(reversed.order).toEqual(forward.order);
    expect(reversed.poolDigest).toBe(forward.poolDigest);
  });

  test("a different beacon value reorders the same pool", () => {
    const other = computeBeaconOrder({ sealDigest: SEAL, beaconValue: "c".repeat(64), itemSha256s: POOL });
    const base = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL });
    expect(other.order).not.toEqual(base.order);
  });

  test("a different seal digest reorders the same pool under the same beacon", () => {
    const other = computeBeaconOrder({ sealDigest: ID("f"), beaconValue: VALUE, itemSha256s: POOL });
    const base = computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL });
    expect(other.order).not.toEqual(base.order);
  });

  test("poolDigest is the shared identity-set digest of screening-sample/1", () => {
    expect(computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).poolDigest)
      .toBe(computeScreeningPoolDigest(POOL));
  });

  test.each([
    ["sealDigest", { sealDigest: "not-a-digest" }],
    ["beaconValue", { beaconValue: "B".repeat(64) }],
    ["itemSha256s[1]", { itemSha256s: [ID("1"), "nope"] }],
  ])("refuses a malformed %s", (path, overrides) => {
    expect(() => computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL, ...overrides }))
      .toThrow(new RegExp(`^${path.replace(/[[\]]/gu, "\\$&")}: `, "u"));
  });

  test("refuses an empty identity set", () => {
    expect(() => computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: [] }))
      .toThrow(/identity set must be non-empty/u);
  });

  test("refuses a duplicated identity", () => {
    expect(() => computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: [ID("1"), ID("1")] }))
      .toThrow(/must not contain duplicate/u);
  });
});

describe("verifyRunBinding", () => {
  test("accepts a census binding and returns the recomputed execution order", () => {
    const verified = verifyRunBinding(censusBinding());
    expect(verified.mode).toBe("census");
    expect(verified.sample).toBeUndefined();
    expect(verified.poolSize).toBe(POOL.length);
    expect(verified.order).toEqual(
      computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).order,
    );
    expect(verified.postSeal).toBe("proven-offline");
    expect(verified.beaconInstant).toBe(beaconRoundInstant(beacon()));
  });

  test("accepts a sampled binding and returns the recomputed slate", () => {
    const verified = verifyRunBinding(sampledBinding());
    expect(verified.mode).toBe("sampled");
    expect(verified.sample).toEqual(
      computeBeaconOrder({ sealDigest: SEAL, beaconValue: VALUE, itemSha256s: POOL }).order.slice(0, 2),
    );
  });

  test("fails on a declared sample that is not the derived draw", () => {
    const tampered = sampledBinding();
    const derived = tampered["sample"] as string[];
    // Swap in a pool member the derivation did not draw -- the post-hoc selection this exists to stop.
    const notDrawn = POOL.find((item) => !derived.includes(item))!;
    expect(() => verifyRunBinding({ ...tampered, sample: [derived[0], notDrawn] }))
      .toThrow(/^sample: declared sample differs from the beacon-binding\/1 recomputation/u);
  });

  test("fails on a reordered census order", () => {
    const base = censusBinding();
    const order = [...(base["order"] as string[])].reverse();
    expect(() => verifyRunBinding({ ...base, order }))
      .toThrow(/^order: declared execution order differs/u);
  });

  test("fails on a sample of the right members in the wrong order", () => {
    const base = sampledBinding();
    const sample = [...(base["sample"] as string[])].reverse();
    expect(() => verifyRunBinding({ ...base, sample })).toThrow(/^sample: /u);
  });

  test("fails a beacon round that does not postdate the seal", () => {
    expect(() => verifyRunBinding(censusBinding({ sealedAt: "2099-01-01T00:00:00.000Z" })))
      .toThrow(/does not postdate the seal/u);
  });

  test("fails a beacon round published exactly at the seal instant", () => {
    const at = beaconRoundInstant(beacon())!;
    expect(() => verifyRunBinding(censusBinding({ sealedAt: at }))).toThrow(/does not postdate the seal/u);
  });

  test("reports a height-indexed beacon as attributive rather than proven", () => {
    const verified = verifyRunBinding(censusBinding({ beacon: beacon({ source: "bitcoin/mainnet", round: 900_000 }) }));
    expect(verified.postSeal).toBe("attributive");
    expect(verified.beaconInstant).toBeUndefined();
  });

  test("refuses a sampleSize larger than the pool", () => {
    const base = sampledBinding();
    expect(() => verifyRunBinding({ ...base, sampleSize: POOL.length + 1 }))
      .toThrow(/^sampleSize: must not exceed the pool size/u);
  });

  test.each([
    ["a foreign procedure", { procedure: "beacon-binding/2" }],
    ["an unknown beacon source", { beacon: { source: "lottery/uk", round: 1, value: VALUE } }],
    ["an uppercase beacon value", { beacon: beacon({ value: "B".repeat(64) }) }],
    ["a round of zero", { beacon: beacon({ round: 0 }) }],
    ["an unparseable sealedAt", { sealedAt: "yesterday" }],
    ["an empty population", { itemSha256s: [], order: [] }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => verifyRunBinding(censusBinding(overrides))).toThrow(RunBindingError);
  });

  test("refuses an unknown extra key rather than ignoring it", () => {
    expect(() => verifyRunBinding(censusBinding({ note: "extra" }))).toThrow(RunBindingError);
  });

  test("refuses a value that is not a binding at all", () => {
    expect(() => verifyRunBinding(undefined)).toThrow(RunBindingError);
    expect(() => verifyRunBinding("census")).toThrow(RunBindingError);
  });

  test("round-trips a typed binding", () => {
    const binding = censusBinding() as unknown as RunBinding;
    expect(verifyRunBinding(binding).sealDigest).toBe(SEAL);
  });
});
