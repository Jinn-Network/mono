// SPDX-License-Identifier: MIT

export interface CensorshipCrossCheck {
  readonly consistent: boolean;
  readonly missing: number;
}

/**
 * Finalized-only cheap floor check for a consumer following one projector. This is detection,
 * not full self-indexing: it compares the announced-open cardinality with the supplied finalized
 * TaskCreated count and reports the exact shortfall.
 */
export function crossCheckCensorship(
  announcedOpenSet: ReadonlySet<unknown>,
  onChainTaskCreatedCount: number,
): CensorshipCrossCheck {
  if (
    !Number.isSafeInteger(onChainTaskCreatedCount)
    || onChainTaskCreatedCount < 0
  ) {
    throw new RangeError("onChainTaskCreatedCount must be a non-negative safe integer");
  }
  const missing = Math.max(0, onChainTaskCreatedCount - announcedOpenSet.size);
  return {
    consistent: missing === 0,
    missing,
  };
}
