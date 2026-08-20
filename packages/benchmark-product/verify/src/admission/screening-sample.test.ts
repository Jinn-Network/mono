// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for `screening-sample/1` (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.5 "(1) Sample membership").
 *
 * Every digest, seed, and item id below is synthetic: `"sha256:" + "<digit>".repeat(64)` patterns,
 * never a real dataset row.
 */

import { describe, expect, test } from "vitest";
import {
  ScreeningSampleError,
  compareScreeningStreamEntries,
  computeScreeningPoolDigest,
  computeScreeningSample,
  type ScreeningStreamEntry,
} from "./screening-sample.js";

const ID = (digit: string, length = 64): string => `sha256:${digit.repeat(length)}`;

const POOL_5 = [ID("1"), ID("2"), ID("3"), ID("4"), ID("5")];
const SEED = "synthetic-seed-alpha";

describe("computeScreeningSample", () => {
  test("1. determinism: identical inputs yield identical output across repeated calls", () => {
    const first = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 3 });
    const second = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 3 });
    expect(second).toEqual(first);
  });

  test("2. seed sensitivity: changing only sampleSeed changes the draw", () => {
    const a = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 3 });
    const b = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: "synthetic-seed-beta", sampleSize: 3 });
    expect(b.order).not.toEqual(a.order);
    // The pool digest is a property of the identity set alone, so it must be unchanged.
    expect(b.poolDigest).toBe(a.poolDigest);
  });

  test("3. pool sensitivity: changing only the identity set changes the draw for the same seed", () => {
    const a = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 3 });
    const differentPool = [ID("1"), ID("2"), ID("3"), ID("4"), ID("6")];
    const b = computeScreeningSample({ itemSha256s: differentPool, sampleSeed: SEED, sampleSize: 3 });
    expect(b.poolDigest).not.toBe(a.poolDigest);
    expect(b.order).not.toEqual(a.order);
  });

  test("4. input-order independence: shuffling the input array does not change the result", () => {
    const shuffled = [POOL_5[4]!, POOL_5[1]!, POOL_5[3]!, POOL_5[0]!, POOL_5[2]!];
    const inOrder = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 3 });
    const outOfOrder = computeScreeningSample({ itemSha256s: shuffled, sampleSeed: SEED, sampleSize: 3 });
    expect(outOfOrder).toEqual(inOrder);
  });

  test("5. sampleSize prefix property: the size-3 sample is a prefix of the size-5 sample", () => {
    const three = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 3 });
    const five = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 5 });
    expect(five.order.slice(0, 3)).toEqual(three.sample);
    expect(five.sample).toEqual(five.order);
  });

  test("full order is a permutation of the identity set, and sample is its first sampleSize entries", () => {
    const result = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 2 });
    expect([...result.order].sort()).toEqual([...POOL_5].sort());
    expect(result.sample).toEqual(result.order.slice(0, 2));
    expect(result.sample).toHaveLength(2);
  });
});

describe("computeScreeningPoolDigest", () => {
  test("is order-independent (sorts before digesting)", () => {
    const forward = computeScreeningPoolDigest(POOL_5);
    const reversed = computeScreeningPoolDigest([...POOL_5].reverse());
    expect(reversed).toBe(forward);
  });

  test("matches the sha256:<64-hex> shape", () => {
    expect(computeScreeningPoolDigest(POOL_5)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("compareScreeningStreamEntries (tie-break and unsigned-byte ordering)", () => {
  test("6. tie-break determinism: equal streams sort by itemSha256 code-unit order", () => {
    // A real HMAC-SHA256 collision cannot be constructed, so the comparator is exercised directly
    // against two entries with byte-identical streams.
    const stream = new Uint8Array(32).fill(0x42);
    const higherId: ScreeningStreamEntry = { itemSha256: ID("9"), stream };
    const lowerId: ScreeningStreamEntry = { itemSha256: ID("1"), stream };

    expect(compareScreeningStreamEntries(lowerId, higherId)).toBeLessThan(0);
    expect(compareScreeningStreamEntries(higherId, lowerId)).toBeGreaterThan(0);
    expect(compareScreeningStreamEntries(lowerId, { ...lowerId })).toBe(0);

    const shuffled = [higherId, lowerId].sort(compareScreeningStreamEntries);
    expect(shuffled.map((entry) => entry.itemSha256)).toEqual([lowerId.itemSha256, higherId.itemSha256]);
  });

  test("7. unsigned byte comparison: ordering must not flip at the 0x7F/0x80 boundary", () => {
    // entryLow's stream starts 0x7F (127 unsigned); entryHigh's starts 0x80 (128 unsigned).
    // Read through a *signed* 8-bit view, 0x7F is +127 but 0x80 is -128 -- the classic bug, where
    // a signed comparison would rank entryHigh (byte 0x80) *before* entryLow (byte 0x7F) because
    // -128 < 127. This test asserts the actual (correct) unsigned ordering: entryLow before
    // entryHigh, and independently proves the signed reading really does invert by asserting the
    // Int8Array views have opposite sign, so a signed-byte implementation provably fails this case.
    const entryLow: ScreeningStreamEntry = { itemSha256: ID("1"), stream: new Uint8Array([0x7f, 0, 0]) };
    const entryHigh: ScreeningStreamEntry = { itemSha256: ID("2"), stream: new Uint8Array([0x80, 0, 0]) };

    // Prove the boundary actually crosses sign under a signed reading (documents the bug this
    // test exists to catch; it does not exercise the implementation).
    expect(new Int8Array(entryLow.stream.buffer)[0]).toBeGreaterThan(0); // 0x7f -> +127
    expect(new Int8Array(entryHigh.stream.buffer)[0]).toBeLessThan(0); // 0x80 -> -128

    expect(compareScreeningStreamEntries(entryLow, entryHigh)).toBeLessThan(0);
    expect(compareScreeningStreamEntries(entryHigh, entryLow)).toBeGreaterThan(0);

    const sorted = [entryHigh, entryLow].sort(compareScreeningStreamEntries);
    expect(sorted.map((entry) => entry.itemSha256)).toEqual([entryLow.itemSha256, entryHigh.itemSha256]);
  });

  test("byte comparison takes priority over shorter-length streams (defensive; streams are always 32 bytes in practice)", () => {
    const shorter: ScreeningStreamEntry = { itemSha256: ID("1"), stream: new Uint8Array([1, 2]) };
    const longerSamePrefix: ScreeningStreamEntry = { itemSha256: ID("2"), stream: new Uint8Array([1, 2, 0]) };
    expect(compareScreeningStreamEntries(shorter, longerSamePrefix)).toBeLessThan(0);
  });
});

describe("refusals", () => {
  test("8a. empty identity set refuses", () => {
    expect(() => computeScreeningSample({ itemSha256s: [], sampleSeed: SEED, sampleSize: 1 })).toThrow(
      ScreeningSampleError,
    );
  });

  test("8b. duplicate itemSha256 refuses", () => {
    const withDuplicate = [ID("1"), ID("2"), ID("1")];
    expect(() =>
      computeScreeningSample({ itemSha256s: withDuplicate, sampleSeed: SEED, sampleSize: 1 }),
    ).toThrow(ScreeningSampleError);
  });

  test("8c. malformed digest refuses: wrong prefix", () => {
    const malformed = [ID("1"), "md5:" + "2".repeat(64)];
    expect(() =>
      computeScreeningSample({ itemSha256s: malformed, sampleSeed: SEED, sampleSize: 1 }),
    ).toThrow(ScreeningSampleError);
  });

  test("8c. malformed digest refuses: uppercase hex", () => {
    const malformed = [ID("1"), `sha256:${"A".repeat(64)}`];
    expect(() =>
      computeScreeningSample({ itemSha256s: malformed, sampleSeed: SEED, sampleSize: 1 }),
    ).toThrow(ScreeningSampleError);
  });

  test("8c. malformed digest refuses: wrong hex length", () => {
    const malformed = [ID("1"), `sha256:${"2".repeat(63)}`];
    expect(() =>
      computeScreeningSample({ itemSha256s: malformed, sampleSeed: SEED, sampleSize: 1 }),
    ).toThrow(ScreeningSampleError);
  });

  test("8d. sampleSize of 0 refuses", () => {
    expect(() => computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 0 })).toThrow(
      ScreeningSampleError,
    );
  });

  test("8d. negative sampleSize refuses", () => {
    expect(() => computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: -1 })).toThrow(
      ScreeningSampleError,
    );
  });

  test("8d. non-integer sampleSize refuses", () => {
    expect(() => computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 1.5 })).toThrow(
      ScreeningSampleError,
    );
  });

  test("8d. sampleSize greater than the pool size refuses", () => {
    expect(() => computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 6 })).toThrow(
      ScreeningSampleError,
    );
  });

  test("8d. sampleSize equal to the pool size is accepted (boundary, not a refusal)", () => {
    const result = computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: SEED, sampleSize: 5 });
    expect(result.sample).toHaveLength(5);
  });

  test("8e. empty sampleSeed refuses", () => {
    expect(() => computeScreeningSample({ itemSha256s: POOL_5, sampleSeed: "", sampleSize: 1 })).toThrow(
      ScreeningSampleError,
    );
  });
});

describe("9. frozen cross-language vector", () => {
  // Fixed, synthetic inputs. Any conforming reimplementation of `screening-sample/1` (§6.5) in any
  // language MUST reproduce every literal value below exactly. Do not change these literals without
  // updating the spec's own worked example, if any, and flagging the change as a frozen-fixture
  // change per the S2 brief.
  const FROZEN_ITEM_SHA256S = [ID("1"), ID("2"), ID("3"), ID("4"), ID("5")];
  const FROZEN_SEED = "screening-sample-v1-frozen-vector";

  test("poolDigest is the sha256 of canonical-JSON bytes of the sorted, unique identity set", () => {
    expect(computeScreeningPoolDigest(FROZEN_ITEM_SHA256S)).toBe(
      "sha256:4997e61a49be58c196bef5123c273864f034a692d9820c297ce0f2a3cc7ad29b",
    );
  });

  test("full order and sample for sampleSize=3 match the frozen vector exactly", () => {
    const result = computeScreeningSample({
      itemSha256s: FROZEN_ITEM_SHA256S,
      sampleSeed: FROZEN_SEED,
      sampleSize: 3,
    });

    expect(result.poolDigest).toBe("sha256:4997e61a49be58c196bef5123c273864f034a692d9820c297ce0f2a3cc7ad29b");
    expect(result.order).toEqual([ID("1"), ID("2"), ID("4"), ID("5"), ID("3")]);
    expect(result.sample).toEqual([ID("1"), ID("2"), ID("4")]);
    expect(result.sample).toEqual(result.order.slice(0, 3));
  });
});
