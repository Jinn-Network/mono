// SPDX-License-Identifier: MIT

// The legacy RPC chunking rules as fixtures (operator-daemon composition design §6.6, program
// contract 12: "RPC chunking rules enter kits as test cases, never as ported code"). Every value
// below is derived by READING the legacy oracles, not by importing them:
//
//   client/src/discovery/onchain.ts          -- `DEFAULT_CHUNK_BLOCKS`, the two scan modes,
//                                               the per-pass chunk caps (deleted at cutover
//                                               stage 4, Task 14)
//   client/src/adapters/mech/contracts.ts    -- `LOG_SCAN_CHUNK`, the #807/#801/#803 rationale
//                                               (retires with the mech adapter at stage 2)
//   client/src/adapters/mech/adapter.ts      -- `DEFAULT_ROUTER_LOG_CHUNK_BLOCKS`
//   client/src/corpus/onchain-query.ts       -- the corpus scan's divergent default
//   client/src/autopilot/marketplace-delivery-observer.ts -- `TASK_CREATED_SCAN_CHUNK`
//
// The fresh owner already exists: `createChainLogSource` in
// `@jinn-network/marketplace-venue-base`, consumed by the projector through
// `client/src/daemon/projector-log-source.ts`. `describeChunkPlanConformance` below is the
// obligation any chunked-`getLogs` reader must satisfy -- today the venue chain log source, and
// after cutover stage 4 whichever reader inherits the discovery floor's remaining scans.
//
// The single load-bearing trap this file exists to pin: **legacy sizes a chunk as a block-number
// DELTA, venue-base sizes it as an inclusive block COUNT.** A constant carried across verbatim
// therefore requests one block more than it did before -- and `LOG_SCAN_CHUNK = 1000n` under the
// delta convention is a 1001-block request. Sizing against a provider cap is off-by-one wrong in
// exactly the direction that fails, so the conformance driver states the rule in COUNT terms and
// pins the two boundary spans that discriminate the conventions.
import { describe, expect, test } from "vitest";

/** How a chunk constant is interpreted when a request range is derived from it. */
export type ChunkWidthConvention =
  /** `toBlock - fromBlock + 1 === value` -- the venue-base convention. */
  | "count"
  /** `toBlock - fromBlock === value`, i.e. `value + 1` blocks per request -- the legacy convention. */
  | "delta";

export interface LegacyChunkConstant {
  readonly name: string;
  readonly value: bigint;
  /** Repo-relative path of the oracle the value was read from. */
  readonly source: string;
  readonly convention: ChunkWidthConvention;
  /** Inclusive block count actually requested per `getLogs` round-trip. */
  readonly requestWidthBlocks: bigint;
  readonly governs: string;
  /**
   * `false` marks a constant whose effective request width exceeds the public Base cap. These are
   * recorded deliberately: they are the live legacy inconsistencies the fresh implementation must
   * NOT inherit, not a target to reproduce.
   */
  readonly withinPublicBaseCap: boolean;
}

/**
 * The narrowest cap the default fallback chain must serve. `sepolia.base.org` (the free public
 * Coinbase endpoint that terminates the Base Sepolia default chain) rejects `eth_getLogs` above a
 * 2000-block range, and the fallback transport tries every slot -- so a request wider than the
 * narrowest slot's cap fails the WHOLE chain rather than degrading to one provider.
 * (`client/src/config.ts`'s RPC-default comments; `client/src/discovery/onchain.ts`'s
 * `DEFAULT_CHUNK_BLOCKS` rationale.)
 */
export const PUBLIC_BASE_GETLOGS_RANGE_CAP_BLOCKS = 2_000n;

/**
 * Why 1000 and not 9999 (#807 / #801 / #803, quoted in
 * `client/src/adapters/mech/contracts.ts`): a 9999-block `getLogs` over a delivery-dense region is
 * rejected or times out on publicnode and Tenderly *and* exceeds the 2k range cap of the
 * `sepolia.base.org` fallback -- so every provider in the chain fails and the per-chunk delivery
 * cursor never advances. The failure is a silent permanent stall, not a slow scan.
 */
export const LEGACY_CHUNK_CONSTANTS: readonly LegacyChunkConstant[] = [
  {
    name: "DEFAULT_CHUNK_BLOCKS",
    value: 1_999n,
    source: "client/src/discovery/onchain.ts",
    convention: "delta",
    requestWidthBlocks: 2_000n,
    governs: "every getLogs site in the on-chain discovery floor",
    withinPublicBaseCap: true,
  },
  {
    name: "LOG_SCAN_CHUNK",
    value: 1000n,
    source: "client/src/adapters/mech/contracts.ts",
    convention: "delta",
    requestWidthBlocks: 1001n,
    governs: "router provenance, request/delivery data scans, latest-delivery lookup",
    withinPublicBaseCap: true,
  },
  {
    name: "DEFAULT_ROUTER_LOG_CHUNK_BLOCKS",
    value: 9_999n,
    source: "client/src/adapters/mech/adapter.ts",
    convention: "delta",
    requestWidthBlocks: 10_000n,
    governs: "router log scans and the delivery-log chunker",
    withinPublicBaseCap: false,
  },
  {
    name: "DEFAULT_CHUNK_BLOCKS",
    value: 9_999n,
    source: "client/src/corpus/onchain-query.ts",
    convention: "delta",
    requestWidthBlocks: 10_000n,
    governs: "the corpus MetadataSet scan behind queryEnvelopes",
    withinPublicBaseCap: false,
  },
  {
    name: "TASK_CREATED_SCAN_CHUNK",
    value: 1000n,
    source: "client/src/autopilot/marketplace-delivery-observer.ts",
    convention: "delta",
    requestWidthBlocks: 1001n,
    governs: "the autopilot observer's exact-TaskCreated lookup",
    withinPublicBaseCap: true,
  },
];

/**
 * Not a chunk constant, recorded so it is not mistaken for one:
 * `TASK_CREATED_RECOVERY_WINDOW_BLOCKS = 64n` (`client/src/adapters/mech/contracts.ts`) sizes a
 * *lookback floor*, and its two call sites then request `[head - 64, head]` **or**
 * `[receiptBlock - 64, head]` — the second is unbounded in width whenever the receipt is old, and
 * it is issued unchunked. A fresh reader must route recovery lookups through the same chunked path
 * as every other scan rather than reproducing this shape.
 */
export const LEGACY_UNCHUNKED_LOOKBACK_FLOOR_BLOCKS = 64n;

/**
 * What a legacy scan does when it runs out of its per-pass chunk budget. The two behaviors are
 * different in kind and both are load-bearing: a silent prefix is a wrong-but-plausible number, an
 * empty result is a legible absence. The design's own phrasing at the second site is "absence
 * beats a partial lie".
 */
export interface LegacyBoundedScanRule {
  readonly name: string;
  readonly maxChunksPerPass: number;
  readonly onBudgetExhausted: "silent-prefix" | "empty-result";
  readonly source: string;
  readonly rationale: string;
}

export const LEGACY_BOUNDED_SCAN_RULES: readonly LegacyBoundedScanRule[] = [
  {
    name: "getSolverNetOperatorCount",
    maxChunksPerPass: 50,
    onBudgetExhausted: "silent-prefix",
    source: "client/src/discovery/onchain.ts (MAX_OPERATOR_COUNT_TASK_PAGES)",
    rationale: "bounds a recurring dashboard poll; past the cap the count is an explicit lower bound",
  },
  {
    name: "getTaskPostCounts",
    maxChunksPerPass: 50,
    onBudgetExhausted: "silent-prefix",
    source: "client/src/discovery/onchain.ts (MAX_TASK_POST_COUNT_SCAN_PAGES)",
    rationale: "50 chunks far exceeds the 43,200-block 24h window, so the cap never truncates it",
  },
  {
    name: "getTaskLifecycleEvidence",
    maxChunksPerPass: 50,
    onBudgetExhausted: "empty-result",
    source: "client/src/discovery/onchain.ts",
    rationale: "a partial evidence map reads as complete; returning nothing is the honest signal",
  },
];

export interface ChunkRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface ChunkPlanFixture {
  readonly name: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly chunkBlocks: bigint;
  /** Expected requests under the COUNT convention, ascending. */
  readonly expectedRanges: readonly ChunkRange[];
}

/**
 * The boundary spans that discriminate the count convention from the delta convention. A planner
 * that carried a legacy constant across verbatim produces two ranges for `span-equals-cap` and one
 * over-wide range for `span-one-over-cap`; both fail here.
 */
export const CHUNK_PLAN_FIXTURES: readonly ChunkPlanFixture[] = [
  {
    name: "single-block span requests exactly one range",
    fromBlock: 100n,
    toBlock: 100n,
    chunkBlocks: 10n,
    expectedRanges: [{ fromBlock: 100n, toBlock: 100n }],
  },
  {
    name: "span exactly one chunk wide requests exactly one range",
    fromBlock: 100n,
    toBlock: 109n,
    chunkBlocks: 10n,
    expectedRanges: [{ fromBlock: 100n, toBlock: 109n }],
  },
  {
    name: "span one block over a chunk requests two ranges, the second a single block",
    fromBlock: 100n,
    toBlock: 110n,
    chunkBlocks: 10n,
    expectedRanges: [
      { fromBlock: 100n, toBlock: 109n },
      { fromBlock: 110n, toBlock: 110n },
    ],
  },
  {
    name: "a multi-chunk span tiles with a short final range",
    fromBlock: 1_000n,
    toBlock: 1_024n,
    chunkBlocks: 10n,
    expectedRanges: [
      { fromBlock: 1_000n, toBlock: 1_009n },
      { fromBlock: 1_010n, toBlock: 1_019n },
      { fromBlock: 1_020n, toBlock: 1_024n },
    ],
  },
];

export interface ChunkPlanSubject {
  /**
   * The `getLogs` ranges the subject requests in order to cover `[fromBlock, toBlock]` inclusive.
   * Implementations return the ranges actually handed to the provider, not a plan they intend to
   * execute -- the obligation is about what reaches the RPC.
   */
  requestedRangesFor(fromBlock: bigint, toBlock: bigint): Promise<readonly ChunkRange[]>;
}

function sortRanges(ranges: readonly ChunkRange[]): ChunkRange[] {
  return [...ranges].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0));
}

/**
 * The chunked-`getLogs` obligations a fresh reader inherits from the legacy scanners. Consumed by
 * `@jinn-network/marketplace-venue-base`'s chain log source today; named here as the contract for
 * whichever reader inherits the discovery floor's remaining scans at cutover stage 4.
 */
export function describeChunkPlanConformance(
  build: () => Promise<{ subject: ChunkPlanSubject; chunkBlocks: bigint }>,
): void {
  describe("chunked getLogs plan conformance (design §6.6 -- legacy chunking rules as fixtures)", () => {
    test("every requested range is at most chunkBlocks blocks wide, counted inclusively", async () => {
      const { subject, chunkBlocks } = await build();
      const ranges = await subject.requestedRangesFor(0n, chunkBlocks * 3n + 7n);
      for (const range of ranges) {
        expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(chunkBlocks);
      }
    });

    test("requested ranges tile the span exactly once and cover both endpoints", async () => {
      const { subject, chunkBlocks } = await build();
      const from = 500n;
      const to = 500n + chunkBlocks * 2n + 3n;
      const ranges = sortRanges(await subject.requestedRangesFor(from, to));
      expect(ranges.length > 0).toBe(true);
      expect(ranges[0]!.fromBlock).toBe(from);
      expect(ranges[ranges.length - 1]!.toBlock).toBe(to);
      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index]!.fromBlock).toBe(ranges[index - 1]!.toBlock + 1n);
      }
    });

    test("a single-block span is one request for that block, never a wider probe", async () => {
      const { subject } = await build();
      const ranges = await subject.requestedRangesFor(77n, 77n);
      expect(ranges.length).toBe(1);
      expect(ranges[0]!.fromBlock).toBe(77n);
      expect(ranges[0]!.toBlock).toBe(77n);
    });

    test("a span exactly chunkBlocks wide is one request (count convention, not delta)", async () => {
      const { subject, chunkBlocks } = await build();
      const ranges = await subject.requestedRangesFor(10n, 10n + chunkBlocks - 1n);
      expect(ranges.length).toBe(1);
    });

    test("a span one block wider than chunkBlocks is two requests", async () => {
      const { subject, chunkBlocks } = await build();
      const ranges = await subject.requestedRangesFor(10n, 10n + chunkBlocks);
      expect(ranges.length).toBe(2);
    });

    test("planning the same span twice requests the same ranges", async () => {
      const { subject, chunkBlocks } = await build();
      const first = await subject.requestedRangesFor(0n, chunkBlocks + 4n);
      const second = await subject.requestedRangesFor(0n, chunkBlocks + 4n);
      expect(sortRanges(second)).toEqual(sortRanges(first));
    });
  });
}
