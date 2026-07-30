// SPDX-License-Identifier: MIT

import { BROADCAST_DEFAULTS } from "./classify.js";

export interface FeeSnapshot {
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly gasPrice?: bigint;
}

function mulDivCeil(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator;
}

function replacementBump(value: bigint): bigint {
  return mulDivCeil(value, 10_000n + BigInt(BROADCAST_DEFAULTS.replacementBumpBps), 10_000n);
}

function attemptBump(value: bigint, attemptIndex: number): bigint {
  if (attemptIndex <= 0) return value;
  const bps = BigInt(BROADCAST_DEFAULTS.feeBumpBpsPerAttempt) * BigInt(attemptIndex);
  return mulDivCeil(value, 10_000n + bps, 10_000n);
}

function maxOf(...values: readonly (bigint | undefined)[]): bigint | undefined {
  const present = values.filter((value): value is bigint => value !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((max, value) => (value > max ? value : max), present[0]!);
}

/**
 * The relayer profile's fee-bumped replacement (design §7 ruling 1): a resubmission at the same
 * nonce must clear both the fresh estimate for this attempt AND the +15% replacement floor over
 * whatever was last submitted at that nonce.
 */
export function bumpFees(
  current: FeeSnapshot,
  previous: FeeSnapshot | undefined,
  attemptIndex: number,
): FeeSnapshot {
  if (current.gasPrice !== undefined || previous?.gasPrice !== undefined) {
    const gasPrice = maxOf(
      current.gasPrice === undefined ? undefined : attemptBump(current.gasPrice, attemptIndex),
      previous?.gasPrice === undefined ? undefined : replacementBump(previous.gasPrice),
    );
    return gasPrice === undefined ? {} : { gasPrice };
  }
  const maxFeePerGas = maxOf(
    current.maxFeePerGas === undefined ? undefined : attemptBump(current.maxFeePerGas, attemptIndex),
    previous?.maxFeePerGas === undefined ? undefined : replacementBump(previous.maxFeePerGas),
  );
  const maxPriorityFeePerGas = maxOf(
    current.maxPriorityFeePerGas === undefined
      ? undefined
      : attemptBump(current.maxPriorityFeePerGas, attemptIndex),
    previous?.maxPriorityFeePerGas === undefined
      ? undefined
      : replacementBump(previous.maxPriorityFeePerGas),
  );
  return maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined
    ? { maxFeePerGas, maxPriorityFeePerGas }
    : {};
}
