// SPDX-License-Identifier: Apache-2.0

/** Names the pipeline this package implements (design §7). Not a claim. */
export const CHAIN_EXTRACTION_PROTOCOL_URI =
  "https://jinn.network/protocols/chain-state-extraction/v1" as const;

/**
 * The connected baseline is established twice on independent fork instances. Two is
 * enough: the baseline is a *reference*, not the durable claim -- K >= 5 belongs to the
 * blackholed protocol CE3 runs (design E4). Its only job here is to refuse to extract
 * from a world that does not even agree with itself while connected.
 */
export const BASELINE_RUN_COUNT = 2;

/** Widenings attempted before the loop gives up, when the request does not say. */
export const DEFAULT_MAX_WIDENINGS = 3;

/**
 * The ceiling a request may not exceed. An unbounded widen loop against a metered
 * archive is a cost incident; the bound is therefore in code, not in a caller's good
 * intentions.
 */
export const MAX_WIDENINGS_CEILING = 8;

export interface ArchiveBudgetLimits {
  readonly maxCalls: number;
  readonly maxBytes: number;
}

/** Sized for one anchored-subset world: thousands of slots, not a full-state image. */
export const DEFAULT_ARCHIVE_BUDGET: ArchiveBudgetLimits = Object.freeze({
  maxCalls: 20_000,
  maxBytes: 256 * 1024 * 1024,
});
