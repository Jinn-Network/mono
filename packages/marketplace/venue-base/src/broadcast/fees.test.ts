// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { bumpFees, type FeeSnapshot } from "./fees.js";

describe("bumpFees (design §7 ruling 1 -- fee-bumped replacement)", () => {
  test("attempt 0 with no previous returns the estimate unchanged", () => {
    const current: FeeSnapshot = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
    expect(bumpFees(current, undefined, 0)).toEqual(current);
  });

  test("attempt n > 0 multiplies by 10000 + 1500n basis points with ceiling division", () => {
    const current: FeeSnapshot = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 101n };
    // attempt 1: bps = 1500 * 1 = 1500 -> factor 11500/10000
    const result = bumpFees(current, undefined, 1);
    expect(result.maxFeePerGas).toBe((1_000n * 11_500n + 9_999n) / 10_000n);
    expect(result.maxPriorityFeePerGas).toBe((101n * 11_500n + 9_999n) / 10_000n);

    // attempt 3: bps = 1500 * 3 = 4500 -> factor 14500/10000
    const result3 = bumpFees(current, undefined, 3);
    expect(result3.maxFeePerGas).toBe((1_000n * 14_500n + 9_999n) / 10_000n);
  });

  test("a previous snapshot forces at least +15% over the previous fee even when the fresh estimate dropped", () => {
    const current: FeeSnapshot = { maxFeePerGas: 500n, maxPriorityFeePerGas: 50n };
    const previous: FeeSnapshot = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
    const result = bumpFees(current, previous, 1);
    // previous replacement floor: ceil(1000 * 11500 / 10000) = 1150
    expect(result.maxFeePerGas).toBe(1_150n);
    expect(result.maxFeePerGas! * 10_000n).toBeGreaterThanOrEqual(previous.maxFeePerGas! * 11_500n);
    expect(result.maxPriorityFeePerGas).toBe(115n);
  });

  test("EIP-1559 and legacy gasPrice never mix in one result", () => {
    const eip1559 = bumpFees({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }, undefined, 0);
    expect(eip1559.gasPrice).toBeUndefined();
    expect(eip1559.maxFeePerGas).toBeDefined();
    expect(eip1559.maxPriorityFeePerGas).toBeDefined();

    const legacy = bumpFees({ gasPrice: 1_000n }, undefined, 0);
    expect(legacy.maxFeePerGas).toBeUndefined();
    expect(legacy.maxPriorityFeePerGas).toBeUndefined();
    expect(legacy.gasPrice).toBe(1_000n);

    const legacyBumped = bumpFees({ gasPrice: 500n }, { gasPrice: 1_000n }, 1);
    expect(legacyBumped.maxFeePerGas).toBeUndefined();
    expect(legacyBumped.maxPriorityFeePerGas).toBeUndefined();
    expect(legacyBumped.gasPrice).toBe(1_150n);
  });

  test("an empty estimate with an empty previous yields {}", () => {
    expect(bumpFees({}, undefined, 0)).toEqual({});
    expect(bumpFees({}, {}, 2)).toEqual({});
  });
});
