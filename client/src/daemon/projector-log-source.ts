/**
 * The projector's production event feed (cutover stage 1, finding E20 / close-out plan §C3).
 *
 * `ProjectorLoopConfig.logSource` used to declare its own `{fetchLogs, heads}` shape with no
 * production implementation anywhere — only Task 9's unit-test fake — and that shape was not
 * even the same *kind* as venue-base's `ChainLogSource` (chunked `getLogs` sized to provider
 * caps, a hash-verified `(blockNumber, blockHash)` high-water mark, dual live/finalized marks,
 * reorg rollback with orphaned-hash retention). Rather than build a second cursor that could
 * disagree with venue-base's about what a reorg means, `ProjectorLoop` now consumes
 * `ChainLogSource` directly (see `projector-loop.ts`). This module is the host-facing factory
 * that builds one for the projector, plus the one read-only capability the loop needs that
 * `ChainLogSource` deliberately does not expose: a live "what does the chain report as finalized
 * right now" query for the boot catch-up gate.
 */
import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import {
  createChainLogSource,
  type ChainLogSource,
  type ChainLogSourceOptions,
  type VenueStateDatabase,
} from '@jinn-network/marketplace-venue-base';
import type { Address, Hex, PublicClient } from 'viem';

export type { ChainLogSource, ChainLogSourceOptions } from '@jinn-network/marketplace-venue-base';

export interface ProjectorLogSourceInput {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  /**
   * A caller-owned venue state database. This helper remains for isolated integrations that
   * already own a state handle; the operator composition instead consumes `BaseVenue.logSource`
   * directly, so it never opens or receives another handle for the same state path.
   */
  readonly state: VenueStateDatabase;
  /**
   * Every address beyond the router/coordinator that the projector must also scan — today-mode's
   * operator-owned mech(es), per `decodeMarketplaceLogs`'s per-log `isAuthorizedMechOrigin` check.
   * `ChainLogSource.poll()` filters `getLogs` by a fixed address list, so any mech that predicate
   * would authorize but that isn't listed here is invisible to the projector. Production wiring
   * (`composition-root.ts`) currently authorizes exactly one address — the operator's own mech —
   * so this is a non-issue for today's single-mech-per-operator model; it becomes a real gap the
   * day `isAuthorizedMechOrigin` authorizes an address this list doesn't carry.
   */
  readonly mechAddresses: readonly Address[];
  readonly options?: ChainLogSourceOptions;
}

// `viem` is a direct `dependencies` entry of venue-base and every `packages/` tree is its own
// yarn project, so venue-base installs a physically separate copy of viem from client's. TypeScript
// compares `PublicClient`'s deeply recursive generic types by identity, not shape, and reports
// "two different types with this name exist, but they are unrelated" even though both copies
// resolve to the same pinned version and are byte-identical (finding E26, first hit in
// `composition-root.ts`'s `createBaseVenue` call; this is the same cast at a second boundary).
// The cast names the exact expected type rather than `as never`, documenting what is asserted.
type ChainLogSourceParams = Parameters<typeof createChainLogSource>[0];

/** Builds the `ChainLogSource` the projector reads from — see `ProjectorLoopConfig.logSource`. */
export function createProjectorLogSource(input: ProjectorLogSourceInput): ChainLogSource {
  const addresses = Array.from(
    new Set(
      [input.chain.jinnRouter, input.chain.taskCoordinator, ...input.mechAddresses].map(
        (address) => address.toLowerCase() as Address,
      ),
    ),
  );
  return createChainLogSource({
    chain: input.chain,
    publicClient: input.publicClient as unknown as ChainLogSourceParams['publicClient'],
    state: input.state,
    addresses,
    options: input.options,
  });
}

/**
 * Read-only "what does the chain currently report as its finalized block number" query, for
 * `ProjectorLoop.hasCaughtUp()` — the boot catch-up gate (`client/src/daemon/claim-gate.ts`)
 * polls this repeatedly and independently of `tick()`. Deliberately not `logSource.poll()`:
 * `poll()` is the one operation allowed to advance `ChainLogSource`'s own persisted scan cursor,
 * and calling it outside of `ProjectorLoop.tick()` would silently advance that cursor past logs
 * the loop's own enrich/reduce pipeline never saw.
 */
export function createFinalizedHeadReader(publicClient: PublicClient): () => Promise<bigint> {
  return async () => {
    const block = await publicClient.getBlock({ blockTag: 'finalized' });
    return block.number ?? 0n;
  };
}

/**
 * Read-only canonical block identity lookup for the projector's local reorg journal. This never
 * advances `ChainLogSource`; it only compares retained pre-fork provenance with the chain that
 * is now canonical at the same height.
 */
export function createCanonicalBlockHashReader(
  publicClient: PublicClient,
): (blockNumber: bigint) => Promise<Hex | undefined> {
  return async (blockNumber) => {
    const block = await publicClient.getBlock({ blockNumber });
    return block.hash ?? undefined;
  };
}
