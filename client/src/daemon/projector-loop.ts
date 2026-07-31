/**
 * The projector loop (cutover stage 1, Task 9): reads venue chain events, decodes and reduces
 * them into the marketplace projection state, and publishes signed announcements into a local
 * filesystem discovery archive. Local-only in stage 1; stage 4 mounts the archive for serving.
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
  type MarketplaceRawLog,
  type ObservationMarketplaceEvent,
} from '@jinn-network/marketplace-projector';
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
  readonly logSource: {
    fetchLogs(input: { fromBlock: bigint; toBlock: bigint }): Promise<MarketplaceRawLog[]>;
    heads(): Promise<{
      latest: { number: bigint; hash: `0x${string}` };
      finalized: { number: bigint; hash: `0x${string}` };
    }>;
  };
  readonly cursorStore: ProjectorCursorStore;
  readonly ports: ProjectorPortsInput;
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
}

export class ProjectorLoop {
  private stopped = false;

  constructor(private readonly config: ProjectorLoopConfig) {}

  /** One pass; exported so the boot catch-up gate can drive it synchronously. */
  async tick(): Promise<{ readonly announcements: number; readonly refusals: number; readonly caughtUp: boolean }> {
    const heads = await this.config.logSource.heads();
    let cursor = this.config.cursorStore.read();

    if (
      cursor !== undefined
      && heads.latest.number === cursor.liveBlockNumber
      && heads.latest.hash !== cursor.liveBlockHash
    ) {
      this.config.logger?.warn(
        `[projector] reorg detected at block ${cursor.liveBlockNumber}: `
          + `expected hash ${cursor.liveBlockHash}, chain now reports ${heads.latest.hash}`,
      );
      cursor = this.config.cursorStore.rollbackToFinalized();
    }

    const fromBlock = cursor === undefined ? heads.finalized.number : cursor.liveBlockNumber + 1n;
    const rawLogs = await this.config.logSource.fetchLogs({ fromBlock, toBlock: heads.latest.number });

    const authority = marketplaceEventOriginAuthority(this.config.chain, this.config.isAuthorizedMechOrigin);
    const decoded = decodeMarketplaceLogs(rawLogs, authority);

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
      liveBlockNumber: heads.latest.number,
      liveBlockHash: heads.latest.hash,
      finalizedBlockNumber: heads.finalized.number,
      finalizedBlockHash: heads.finalized.hash,
      sequence: nextSequence,
      entryDigest: nextEntryDigest,
      headJson: nextHeadJson,
      stateJson: serializeProjectionState(transition.state),
    };
    this.config.cursorStore.write(nextCursor);

    return {
      announcements: result.announcements.length,
      refusals: transition.refusals.length + result.refusals.length,
      caughtUp: nextCursor.finalizedBlockNumber >= heads.finalized.number,
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

  /** Contract 3: has the durable cursor reached the finalized chain head? */
  async hasCaughtUp(): Promise<boolean> {
    const heads = await this.config.logSource.heads();
    const cursor = this.config.cursorStore.read();
    return cursor !== undefined && cursor.finalizedBlockNumber >= heads.finalized.number;
  }
}

function parseProjectionState(cursor: ProjectorCursor | undefined): MarketplaceProjectionState {
  if (cursor === undefined) return createMarketplaceProjectionState();
  const parsed = deserializeProjectionState(cursor.stateJson) as Partial<MarketplaceProjectionState>;
  // Defensive: clone through the base shape so a partially-shaped persisted state (e.g. an
  // empty `{}` from a pre-genesis cursor row) never trips the reducer's array/record spreads.
  return cloneMarketplaceProjectionState({ ...createMarketplaceProjectionState(), ...parsed });
}
