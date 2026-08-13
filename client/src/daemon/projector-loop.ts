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
import type { Address, Hex } from 'viem';
import {
  cloneMarketplaceProjectionState,
  createMarketplaceProjectionState,
  decodeMarketplaceLogs,
  finalityPolicy,
  marketplaceEventOriginAuthority,
  appendSignedReorgCorrections,
  projectAnnouncements,
  reduceMarketplaceProjection,
  type FinalityTier,
  type MarketplaceEvent,
  type MarketplaceProjectionState,
  type MarketplaceProjectionTransition,
  type ObservationMarketplaceEvent,
  type ProjectedAnnouncement,
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
  /** Canonical hash lookup used only to recover a reorg after a process crashed mid-correction. */
  readonly readCanonicalBlockHash: (blockNumber: bigint) => Promise<Hex | undefined>;
}

export class ProjectorLoop {
  private stopped = false;

  constructor(private readonly config: ProjectorLoopConfig) {}

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
    const cursorHead = cursor?.headJson === null || cursor?.headJson === undefined
      ? undefined
      : JSON.parse(cursor.headJson);
    const cursorSequence = cursor?.sequence ?? NO_ANNOUNCEMENTS_SEQUENCE;
    const readbackPorts = buildAnnouncementProjectionPorts(this.config.ports, {
      previousHead: cursorHead,
      previousEntryDigest: cursor?.entryDigest ?? null,
      initialSequence: cursor?.entryDigest != null ? BigInt(cursor.sequence) + 1n : undefined,
    });
    const published = await readbackPorts.readPublishedArchive?.();
    const recoveredHead = published?.head !== undefined
      && BigInt(published.head.sequence) > BigInt(cursorSequence)
      ? published.head
      : undefined;
    const recoveredEntries = recoveredHead === undefined
      ? []
      : (published?.entries ?? []).filter((entry) => BigInt(entry.sequence) > BigInt(cursorSequence));
    const recoveredAnnouncements = recoveredEntries.flatMap(
      (entry) => entry.announcements as ProjectedAnnouncement[],
    );
    const recoveredEventKeys = new Set(recoveredAnnouncements.map(derivationKey));

    // `ChainLogSource` owns normal reorg detection. This second, read-only comparison is only a
    // crash-recovery guard: source state may already have advanced to the replacement fork while
    // a prior process died before atomically recording the rebuilt projector state/retractions.
    const localCursorDiverged = batch.reorg === undefined && cursor !== undefined
      && (await this.config.readCanonicalBlockHash(cursor.liveBlockNumber))?.toLowerCase()
        !== cursor.liveBlockHash.toLowerCase();
    const rebuildBoundary = batch.reorg?.canonicalRebuildBoundary
      ?? (localCursorDiverged ? batch.finalizedCheckpoint : undefined);
    const displacedHashes = new Set<`0x${string}`>([
      ...(batch.reorg?.orphanedBlockHashes ?? []),
      ...([...this.config.logSource.orphanedBlockHashes()] as `0x${string}`[]),
    ].map((hash) => hash.toLowerCase() as `0x${string}`));
    if (localCursorDiverged) {
      this.config.logger?.warn(
        `[projector] recovering reorg correction after cursor divergence at block ${cursor!.liveBlockNumber}`,
      );
    }

    const authority = marketplaceEventOriginAuthority(this.config.chain, this.config.isAuthorizedMechOrigin);
    const decoded = decodeMarketplaceLogs(batch.logs, authority);

    const enriched = (await Promise.all(decoded.map((event) => this.config.enrich(event))))
      .filter((event): event is ObservationMarketplaceEvent => event !== undefined);

    const admitted = enriched.filter(
      (event) => finalityPolicy(event.derivation, { announceAt: this.config.announceAt }).announce,
    );

    const previousState = rebuildBoundary === undefined
      ? parseProjectionState(cursor)
      : this.config.cursorStore.rebuildCanonicalStateThrough(rebuildBoundary.blockNumber);
    const transition = reduceMarketplaceProjection(admitted, previousState);
    // Replaying from a finalized boundary reconstructs state from both preserved and replacement
    // logs. Only replacement/new provenance may produce new source entries: a retained canonical
    // event has already been published and re-announcing it would duplicate availability work.
    const publicationEvents = transition.events.filter(
      (event) => !this.config.cursorStore.hasCanonicalEvent(event) && !recoveredEventKeys.has(derivationKey(event)),
    );
    const publicationEventKeys = new Set(publicationEvents.map(derivationKey));
    const publicationTransition: MarketplaceProjectionTransition = {
      ...transition,
      events: publicationEvents,
      observations: transition.observations.filter(
        (observation) => publicationEventKeys.has(derivationKey(observation)),
      ),
    };

    let correctionResult: Awaited<ReturnType<typeof appendSignedReorgCorrections>> | undefined;
    if (rebuildBoundary !== undefined) {
      const retracted = new Set(
        recoveredAnnouncements
          .filter((announcement) => announcement.action === 'withdrawn')
          .map((announcement) => announcement.retracts),
      );
      const priors = this.config.cursorStore
        .activeAvailabilitiesForOrphanedBlocks([...displacedHashes])
        .filter((announcement) => !retracted.has(announcement.announcementId));
      if (priors.length > 0) {
        const correctionPorts = buildAnnouncementProjectionPorts(this.config.ports, {
          previousHead: recoveredHead ?? cursorHead,
          previousEntryDigest: recoveredHead?.entry ?? cursor?.entryDigest ?? null,
          initialSequence: recoveredHead !== undefined
            ? BigInt(recoveredHead.sequence) + 1n
            : (cursor?.entryDigest != null ? BigInt(cursor.sequence) + 1n : undefined),
        });
        // This intentionally remains fatal. If a retraction cannot be signed/appended, writing
        // the rebuilt canonical state would make the invalidated availability silently vanish.
        correctionResult = await appendSignedReorgCorrections({ priors, ports: correctionPorts });
      }
    }

    const priorHead = correctionResult?.head ?? recoveredHead ?? cursorHead;
    const priorEntryDigest = correctionResult?.head?.entry ?? recoveredHead?.entry ?? cursor?.entryDigest ?? null;
    const ports = buildAnnouncementProjectionPorts(this.config.ports, {
      previousHead: priorHead,
      previousEntryDigest: priorEntryDigest,
      initialSequence: priorEntryDigest !== null ? BigInt(priorHead!.sequence) + 1n : undefined,
    });
    // Announcement publication can refuse or throw — a record the serving plane cannot supply, a
    // role the composition has not wired. A throw must not discard the reducer's observations or
    // leave the chain-log cursor ahead of the projection cursor — that would permanently drop
    // TaskCreated facts the work loop needs for the next claim.
    //
    // But it must not be QUIET either (defect #45, the #33/#36/#43 opacity class): the cursor
    // advances below and `hasCanonicalEvent` then filters these events out of every later tick's
    // `publicationEvents`, so the announcements this tick would have published are dropped for
    // good — including a decision-grade verdict announcement, which the ratified DR-2026-08-05
    // G-loop criterion requires. The log therefore names the cause (native refusals carry role +
    // on-chain anchor digest + reason in their message) AND the loss.
    let result: Awaited<ReturnType<typeof projectAnnouncements>>;
    try {
      result = await projectAnnouncements(publicationTransition, ports);
    } catch (err) {
      const cause = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.config.logger?.warn(
        `[projector] announcement publication failed (non-fatal): ${cause}; `
          + `dropped announcements for ${publicationEvents.length} publication event(s) `
          + `[${[...new Set(publicationEvents.map((event) => event.event))].join(', ')}] `
          + 'at blocks '
          + `${[...new Set(publicationEvents.map((event) => String(event.derivation.blockNumber)))].join(', ')}`,
      );
      result = { announcements: [], entries: [], pages: [], refusals: [] };
    }
    // `announce.ts` now scopes a `resolveRecord` throw to the record that threw it, so the tick's
    // other announcements survive (`AnnouncementRecordUnresolvedRefusal`). That must not make the
    // refusal QUIET -- refusals are otherwise only counted, and defect #45's whole point is that a
    // dropped announcement names its cause. This is the same loss the catch above reports, one
    // record at a time: the event is journalled below regardless, so `hasCanonicalEvent` suppresses
    // it from here on and only another rewind can republish it.
    for (const refusal of result.refusals) {
      if (refusal.kind !== 'announcement-record-unresolved') continue;
      this.config.logger?.warn(
        `[projector] announcement record unresolved (non-fatal): role=${refusal.role} `
          + `${refusal.reason}; dropped the "${refusal.role}" announcement for `
          + `${refusal.derivation.event} at block ${refusal.derivation.blockNumber} `
          + '-- the event is journalled, so republishing it needs another rewind',
      );
    }
    // `writeArchivePages` is the genesis/full-history primitive and deliberately knows nothing
    // about this daemon's continuation counter. Seed that counter exactly once after genesis so
    // every later correction/normal incremental page appends instead of reusing page one.
    if (cursor?.entryDigest === null || cursor === undefined) {
      if (result.pages.length > 0) {
        this.config.ports.writePageCount(this.config.ports.readPageCount() + result.pages.length);
      }
    }

    const emittedHead = result.head ?? correctionResult?.head;
    const nextSequence = emittedHead?.sequence ?? cursor?.sequence ?? NO_ANNOUNCEMENTS_SEQUENCE;
    const nextEntryDigest = emittedHead?.entry ?? cursor?.entryDigest ?? null;
    const nextHeadJson = emittedHead !== undefined ? JSON.stringify(emittedHead) : (cursor?.headJson ?? null);

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
    const persistedEventKeys = new Set([...publicationEventKeys, ...recoveredEventKeys]);
    this.config.cursorStore.write(nextCursor, transition.observations.filter(
      (observation) => persistedEventKeys.has(derivationKey(observation)),
    ), {
      events: transition.events,
      announcements: [
        ...recoveredAnnouncements,
        ...(correctionResult?.announcements ?? []),
        ...result.announcements,
      ],
      orphanedBlockHashes: rebuildBoundary === undefined ? [] : [...displacedHashes],
    });

    return {
      announcements: (correctionResult?.announcements.length ?? 0) + result.announcements.length,
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

function derivationKey(event: { readonly derivation: {
  readonly chainId: number;
  readonly contract: string;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
} }): string {
  const { derivation } = event;
  return [
    derivation.chainId,
    derivation.contract.toLowerCase(),
    derivation.blockHash.toLowerCase(),
    derivation.txHash.toLowerCase(),
    derivation.logIndex,
  ].join(':');
}
