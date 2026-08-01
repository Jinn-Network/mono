/**
 * The projector loop (cutover stage 1, Task 9; production event feed added at finding E20 /
 * close-out plan §C3): reads venue chain events, decodes and reduces them into the marketplace
 * projection state, and publishes signed announcements into a local filesystem discovery
 * archive. Local-only in stage 1; stage 4 mounts the archive for serving.
 *
 * `enrich` (finding E20 / close-out plan §C4) is built via `createProjectorEnrich`
 * (`projector-enrich.ts`) -- it resolves the host-injected `ObservationProjectionContext` for
 * each decoded event (Submission/Task digest join, deterministic block timestamp, dispatch
 * context, today-mode delivery correspondence), failing closed (returning `undefined`, which
 * `tick()` already filters out below) rather than ever fabricating a field. See that module's
 * header for the full field-sourcing model.
 *
 * Design decision (§C3): `logSource` is venue-base's own `ChainLogSource`
 * (`packages/marketplace/venue-base/src/log-source/chain-log-source.ts`), consumed directly
 * rather than adapted into a second `{fetchLogs, heads}` shape with its own reorg detection. The
 * old shape duplicated exactly the judgment `ChainLogSource.poll()` already makes — a
 * hash-verified `(blockNumber, blockHash)` comparison at the cursor position, rolling back to the
 * durable finalized checkpoint and recording orphaned hashes on divergence — and two independent
 * cursors making that same call is precisely the kind of disagreement that corrupts a fail-closed
 * pipeline. Now only `ChainLogSource`'s own store decides what a reorg is and where to roll back
 * to; this loop's `ProjectorCursorStore` mirrors whatever `poll()` reports (`nextCursor.live*` /
 * `finalized*` below) purely for its own two jobs `ChainLogSource` has no notion of: the
 * `MarketplaceProjectionState` and the announcement-chain head/sequence/digest. Built via
 * `createProjectorLogSource` (`projector-log-source.ts`).
 */
import type { Address } from 'viem';
import {
  cloneMarketplaceProjectionState,
  createMarketplaceProjectionState,
  decodeMarketplaceLogs,
  finalityPolicy,
  marketplaceEventOriginAuthority,
  projectAnnouncements,
  reduceMarketplaceProjection,
  type FinalityTier,
  type MarketplaceEvent,
  type MarketplaceProjectionState,
  type ObservationMarketplaceEvent,
} from '@jinn-network/marketplace-projector';
import type { ChainLogSource } from '@jinn-network/marketplace-venue-base';
import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import type { Store } from '../store/store.js';
import { runLoop } from './loop-heartbeat.js';
import {
  ProjectorCursorStore,
  deserializeProjectionState,
  serializeProjectionState,
  type ProjectorCursor,
} from './projector-cursor.js';
import { buildAnnouncementProjectionPorts, type ProjectorPortsInput } from './projector-ports.js';

/** Cursor sequence floor before any announcement has ever been emitted (16-digit zero form). */
const NO_ANNOUNCEMENTS_SEQUENCE = '0000000000000000';

export interface ProjectorLoopConfig {
  readonly chain: MarketplaceChainConfig;
  /** venue-base's `ChainLogSource` — see the module comment's design decision. */
  readonly logSource: ChainLogSource;
  readonly cursorStore: ProjectorCursorStore;
  readonly ports: ProjectorPortsInput;
  /**
   * Resolves the `ObservationProjectionContext` for a decoded event. Production wiring builds
   * this via `createProjectorEnrich` (`projector-enrich.ts`); returns `undefined` (dropped, never
   * fabricated) when the signed record it needs cannot be honestly resolved this tick.
   */
  readonly enrich: (event: MarketplaceEvent) => Promise<ObservationMarketplaceEvent | undefined>;
  readonly pollIntervalMs: number;
  readonly store: Store;
  readonly logger?: { info(m: string): void; warn(m: string): void };
  /**
   * Host-supplied authorized-Mech membership predicate — required by
   * `decodeMarketplaceLogs`'s real `MarketplaceEventOriginAuthority` shape, which the plan's
   * Consumes block omitted (see the Task 9 execution report). Router-origin events (the only
   * kind this loop's own tests exercise) never consult this predicate.
   */
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
  /** Default `'safe'` (finalityPolicy's own default): the announcement-publication threshold. */
  readonly announceAt?: FinalityTier;
  /**
   * Live "what does the chain report as finalized right now" query for `hasCaughtUp()` only.
   * Never `logSource.poll()` — see the module comment. Built via `createFinalizedHeadReader`
   * (`projector-log-source.ts`).
   */
  readonly readFinalizedBlockNumber: () => Promise<bigint>;
}

export class ProjectorLoop {
  private stopped = false;
  private readonly observationHandlers = new Set<(event: ObservationMarketplaceEvent) => void>();

  constructor(private readonly config: ProjectorLoopConfig) {}

  subscribeObservations(
    handler: (event: ObservationMarketplaceEvent) => void,
  ): () => void {
    this.observationHandlers.add(handler);
    return () => {
      this.observationHandlers.delete(handler);
    };
  }

  /** One pass; exported so the boot catch-up gate can drive it synchronously. */
  async tick(): Promise<{ readonly announcements: number; readonly refusals: number; readonly caughtUp: boolean }> {
    // `poll()` owns the reorg decision entirely: it hash-verifies its own persisted cursor,
    // rolls back to the durable finalized checkpoint on divergence, records orphaned hashes, and
    // returns logs re-scanned from the (possibly rolled-back) checkpoint forward. This loop makes
    // no reorg judgment of its own — see the module comment's design decision.
    const batch = await this.config.logSource.poll();
    if (batch.reorg !== undefined) {
      this.config.logger?.warn(
        `[projector] reorg detected: rolled back to block ${batch.reorg.rolledBackTo.blockNumber} `
          + `(hash ${batch.reorg.rolledBackTo.blockHash}); `
          + `orphaned ${batch.reorg.orphanedBlockHashes.length} block hash(es)`,
      );
    }

    const cursor = this.config.cursorStore.read();

    const authority = marketplaceEventOriginAuthority(this.config.chain, this.config.isAuthorizedMechOrigin);
    const decoded = decodeMarketplaceLogs(batch.logs, authority);

    const enriched = (await Promise.all(decoded.map((event) => this.config.enrich(event))))
      .filter((event): event is ObservationMarketplaceEvent => event !== undefined);

    const admitted = enriched.filter(
      (event) => finalityPolicy(event.derivation, { announceAt: this.config.announceAt }).announce,
    );

    const previousState = parseProjectionState(cursor);
    const transition = reduceMarketplaceProjection(admitted, previousState);

    const ports = buildAnnouncementProjectionPorts(this.config.ports, {
      previousHead: cursor?.headJson === null || cursor?.headJson === undefined
        ? undefined
        : JSON.parse(cursor.headJson),
      previousEntryDigest: cursor?.entryDigest ?? null,
      initialSequence: cursor?.entryDigest != null ? BigInt(cursor.sequence) + 1n : undefined,
    });
    const result = await projectAnnouncements(transition, ports);

    const nextSequence = result.head?.sequence ?? cursor?.sequence ?? NO_ANNOUNCEMENTS_SEQUENCE;
    const nextEntryDigest = result.head?.entry ?? cursor?.entryDigest ?? null;
    const nextHeadJson = result.head !== undefined ? JSON.stringify(result.head) : (cursor?.headJson ?? null);

    const nextCursor: ProjectorCursor = {
      liveBlockNumber: batch.cursor.blockNumber,
      liveBlockHash: batch.cursor.blockHash,
      finalizedBlockNumber: batch.finalizedCheckpoint.blockNumber,
      finalizedBlockHash: batch.finalizedCheckpoint.blockHash,
      sequence: nextSequence,
      entryDigest: nextEntryDigest,
      headJson: nextHeadJson,
      stateJson: serializeProjectionState(transition.state),
    };
    // Cursor + state + every observation this tick projected all move together (finding E20 /
    // close-out plan §C5) -- previously `transition.observations` was computed and discarded, so
    // `BaseVenueConfig.observations` had nothing durable to read from.
    this.config.cursorStore.write(nextCursor, transition.observations);
    for (const observation of transition.observations) {
      for (const handler of this.observationHandlers) {
        handler(observation as unknown as ObservationMarketplaceEvent);
      }
    }

    return {
      announcements: result.announcements.length,
      refusals: transition.refusals.length + result.refusals.length,
      caughtUp: nextCursor.finalizedBlockNumber >= batch.finalizedCheckpoint.blockNumber,
    };
  }

  async run(): Promise<void> {
    await runLoop({
      name: 'projector',
      store: this.config.store,
      tick: () => this.tick().then(() => undefined),
      intervalMs: this.config.pollIntervalMs,
      stopSignal: () => this.stopped,
      emitSource: 'projector',
      onError: (err) => {
        this.config.logger?.warn(
          `[projector] tick failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Contract 3: has the durable cursor reached the finalized chain head? Polled independently of
   * `tick()` by the boot catch-up gate (`claim-gate.ts`), so this needs a live read of the
   * chain's current finalized head — deliberately not `logSource.poll()`; see the module comment.
   */
  async hasCaughtUp(): Promise<boolean> {
    const cursor = this.config.cursorStore.read();
    if (cursor === undefined) return false;
    const liveFinalized = await this.config.readFinalizedBlockNumber();
    return cursor.finalizedBlockNumber >= liveFinalized;
  }
}

function parseProjectionState(cursor: ProjectorCursor | undefined): MarketplaceProjectionState {
  if (cursor === undefined) return createMarketplaceProjectionState();
  const parsed = deserializeProjectionState(cursor.stateJson) as Partial<MarketplaceProjectionState>;
  // Defensive: clone through the base shape so a partially-shaped persisted state (e.g. an
  // empty `{}` from a pre-genesis cursor row) never trips the reducer's array/record spreads.
  return cloneMarketplaceProjectionState({ ...createMarketplaceProjectionState(), ...parsed });
}
