/**
 * Signed reorg corrections for published solution deliveries — one reconciler, two callers
 * (one-swap M3, umbrella #2461).
 *
 * A delivery announcement is published from a pre-finality block. When that block is later
 * orphaned, the announcement is corrected APPEND-ONLY: a signed withdrawal retracting it, and a
 * fresh signed availability if the delivery returns on the canonical chain. Nothing is ever
 * rewritten — that is `chain-log-source.ts`'s stated contract ("announcements already emitted from
 * pre-finality blocks are corrected append-only through signed retractions (binding §8), never
 * rewritten"), and this is the solver-side implementation of it.
 *
 * Extracted verbatim from `native-solver-production.ts`'s `reconcileSignedReorgCorrections`.
 * M2 pinned by test that the table this reads, `native_solution_discovery_corrections`, was
 * created by an inline `store.db.exec` in that host and was therefore ABSENT on the fleet path,
 * so that M3 would have to port the reconciliation deliberately, with its DDL, rather than assume
 * the table was there. The DDL now lives in `NATIVE_OPERATOR_STATE_SCHEMA`, which the shared
 * `Store` constructor runs, so both paths get the table from `Store` and neither creates it
 * ad hoc; the pin is inverted to assert presence on both paths.
 */
import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import type { ChainLogSource } from '@jinn-network/marketplace-venue-base';
import type { Address } from 'viem';
import {
  applyNativeMarketplaceBatch,
  type NativeMarketplaceEventRepository,
} from './native-canonical-observations.js';
import { publicationKey } from './native-operation-identity.js';
import type { NativeSolutionPublisher } from './native-solution-publisher.js';
import type { Store } from '../store/store.js';

/** Structured event kind emitted when a teed batch cannot be applied to the read model. */
export const NATIVE_MARKETPLACE_TEE_FAILURE_KIND = 'native_marketplace_batch_apply_failed';

/**
 * Feeds the marketplace-event read model off the projector's OWN batches, without a second
 * *cursor-advancing* poller.
 *
 * `reconcile()` reads `native_marketplace_events`, which only exists because something applied
 * decoded log batches to it. The native solver host polls its own dedicated raw log source for
 * that. The fleet daemon cannot: `venue.logSource` is a single-consumer durable cursor and the
 * projector loop is the only caller that ADVANCES it (`projector-loop.ts`'s module comment is
 * explicit that two cursors making the same reorg judgment "is precisely the kind of disagreement
 * that corrupts a fail-closed system"). So the fleet path decorates the source handed to the
 * projector — one advancing `poll()`, one cursor, one reorg judgment, two readers.
 *
 * **It is not the only reader.** venue-base's finality waiter reads the UNDECORATED source (via
 * `logsInRange`, and its own polling of the raw handle), so events observed only inside that
 * window and never re-listed by a subsequent projector `poll()` are systematically absent from
 * this read model. That is pre-existing and shared with the solver host, whose raw source has the
 * same split; it bounds what `reconcile()` can see, and closing it means a read model fed from the
 * projector's durable observation stream rather than from raw batches. Named here so the next
 * reader does not mistake "one advancing poller" for "one reader".
 *
 * Deliberately NOT a second `createChainLogSource` with a distinct `stream`: that would work, but
 * it doubles this daemon's `eth_getLogs` volume for a read model that is a strict subset of what
 * the projector already fetches.
 *
 * **The tee can never fail the projector's delivery.** `poll()` durably advances the cursor INSIDE
 * itself, before returning. If this decorator rethrew, the projector would never receive a batch
 * whose cursor is already committed, and those chain events would be permanently invisible to the
 * signed-announcement chain — trading a settlement-critical, non-re-derivable path for a lagging,
 * idempotent, re-derivable one. Reachable throws are real, not hypothetical: `apply`'s
 * `changed bytes` guard fires when a venue-state reset (cursor lives in `venueStateDbPath`, the
 * journal in the shared `dbPath`) replays blocks re-tiered `observed-safe` → `finalized`, i.e. the
 * same event key with different bytes; and any `SQLITE_BUSY` past the busy timeout throws too.
 *
 * So the failure is caught, logged LOUDLY with a named event kind, and the batch is returned
 * regardless. This is deliberately not a silent swallow: the read-model gap is an operator-visible
 * condition, and `reconcile()` degrades to "corrects fewer announcements than it should", which is
 * recoverable, rather than "the projector stopped".
 */
export function teeNativeMarketplaceEvents(input: {
  readonly source: ChainLogSource;
  readonly repository: NativeMarketplaceEventRepository;
  readonly chain: MarketplaceChainConfig;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
  readonly logger?: { warn(message: string): void };
}): ChainLogSource {
  const warn = (message: string): void => {
    if (input.logger === undefined) console.warn(message);
    else input.logger.warn(message);
  };
  return {
    ...input.source,
    poll: async () => {
      const batch = await input.source.poll();
      try {
        applyNativeMarketplaceBatch({
          batch,
          repository: input.repository,
          chain: input.chain,
          isAuthorizedMechOrigin: input.isAuthorizedMechOrigin,
        });
      } catch (cause) {
        warn(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          component: 'native-marketplace-tee',
          kind: NATIVE_MARKETPLACE_TEE_FAILURE_KIND,
          msg: 'native marketplace read model did not ingest a projector batch; '
            + 'signed reorg corrections may miss these events until they are re-listed',
          cursor: batch.cursor.blockNumber.toString(10),
          logCount: batch.logs.length,
          reorg: batch.reorg !== undefined,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      }
      return batch;
    },
    // Explicitly re-bound: `ChainLogSource` is a closure-backed object literal, so the spread
    // above copies its methods by value and they stay bound to their own closures. Named here so a
    // reader does not have to prove that from the spread.
    cursor: () => input.source.cursor(),
    finalizedCheckpoint: () => input.source.finalizedCheckpoint(),
    logsInRange: (fromBlock, toBlock) => input.source.logsInRange(fromBlock, toBlock),
    orphanedBlockHashes: () => input.source.orphanedBlockHashes(),
    close: () => input.source.close(),
  };
}

interface DeliveryPublicationRow {
  engagement_id: `sha256:${string}`;
  record_digest: `sha256:${string}`;
  media_type: string;
  family: string;
  name: string | null;
  exact_bytes: Uint8Array;
  publication_key: `sha256:${string}`;
  source_id: string;
}

export interface NativeSolutionCorrections {
  /**
   * One idempotent pass: withdraw every published delivery whose settlement event is now
   * orphaned, and re-announce every one that came back canonical after such a withdrawal.
   *
   * Idempotence is keyed on `(event_key, action)`: a pass that already emitted the correction for
   * a given chain event skips it, so re-running after a crash mid-publish cannot double-announce.
   */
  reconcile(): Promise<void>;
}

export function buildNativeSolutionCorrections(input: {
  readonly store: Store;
  readonly publisher: Pick<NativeSolutionPublisher, 'publish' | 'withdraw'>;
  readonly marketplaceEvents: NativeMarketplaceEventRepository;
}): NativeSolutionCorrections {
  const { store, publisher, marketplaceEvents } = input;

  const deliveryPublicationFor = (
    event: ReturnType<NativeMarketplaceEventRepository['solutionCandidates']>[number],
  ): DeliveryPublicationRow | undefined => {
    const facts = event.facts as { readonly taskId: bigint; readonly attemptIndex: number };
    return store.db.prepare(
      `SELECT a.engagement_id, a.record_digest, a.media_type, a.family, a.name, a.exact_bytes,
              p.publication_key, p.source_id
         FROM native_engagements e
         JOIN native_solution_artifacts a ON a.engagement_id = e.engagement_id AND a.role = 'delivery'
         JOIN native_publication_outbox p ON p.engagement_id = e.engagement_id
           AND p.role = 'delivery' AND p.record_digest = a.record_digest AND p.status = 'published'
        WHERE e.task_id = ? AND e.attempt_index = ?`,
    ).get(facts.taskId.toString(10), facts.attemptIndex) as DeliveryPublicationRow | undefined;
  };

  return {
    async reconcile(): Promise<void> {
      for (const orphan of marketplaceEvents.orphanedSolutionCandidates()) {
        const exists = store.db.prepare(
          `SELECT 1 FROM native_solution_discovery_corrections WHERE event_key = ? AND action = 'withdrawn'`,
        ).get(orphan.eventKey);
        if (exists !== undefined) continue;
        const delivery = deliveryPublicationFor(orphan.event);
        if (delivery === undefined) continue;
        const latestAvailable = store.db.prepare(
          `SELECT announcement_id FROM native_solution_discovery_corrections
            WHERE delivery_digest = ? AND action = 'available' ORDER BY rowid DESC LIMIT 1`,
        ).get(delivery.record_digest) as { announcement_id: string } | undefined;
        const withdrawalKey = publicationKey({
          sourceId: delivery.source_id,
          role: 'delivery',
          recordDigest: delivery.record_digest,
          availabilityState: `withdrawn:${orphan.event.derivation.blockHash.toLowerCase()}`,
        });
        const receipt = await publisher.withdraw({
          withdrawalKey,
          targetAnnouncementId: latestAvailable?.announcement_id ?? delivery.publication_key,
          recordDigest: delivery.record_digest,
          bytes: delivery.exact_bytes,
          mediaType: delivery.media_type,
          timestamp: orphan.orphanedAt,
          reason: 'reorged',
        });
        store.db.prepare(
          `INSERT INTO native_solution_discovery_corrections
            (event_key, action, delivery_digest, announcement_id, source_sequence, entry_digest, created_at)
           VALUES (?, 'withdrawn', ?, ?, ?, ?, ?)`,
        ).run(orphan.eventKey, delivery.record_digest, withdrawalKey, receipt.sequence, receipt.entryDigest, orphan.orphanedAt);
      }
      for (const event of marketplaceEvents.solutionCandidates()) {
        const delivery = deliveryPublicationFor(event);
        if (delivery === undefined) continue;
        const hadWithdrawal = store.db.prepare(
          `SELECT 1 FROM native_solution_discovery_corrections
            WHERE delivery_digest = ? AND action = 'withdrawn' LIMIT 1`,
        ).get(delivery.record_digest);
        if (hadWithdrawal === undefined) continue;
        const key = [event.derivation.chainId, event.derivation.contract.toLowerCase(),
          event.derivation.blockHash.toLowerCase(), event.derivation.txHash.toLowerCase(),
          event.derivation.logIndex].join(':');
        const exists = store.db.prepare(
          `SELECT 1 FROM native_solution_discovery_corrections WHERE event_key = ? AND action = 'available'`,
        ).get(key);
        if (exists !== undefined) continue;
        const announcementId = publicationKey({
          sourceId: delivery.source_id,
          role: 'delivery',
          recordDigest: delivery.record_digest,
          availabilityState: `available:${event.derivation.blockHash.toLowerCase()}`,
        });
        const timestamp = new Date().toISOString();
        const receipt = await publisher.publish({
          publication: {
            publicationKey: announcementId,
            engagementId: delivery.engagement_id,
            sourceId: delivery.source_id,
            role: 'delivery',
            recordDigest: delivery.record_digest,
            availability: 'available',
            status: 'intent',
            detail: { canonicalBlockHash: event.derivation.blockHash },
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          artifact: {
            engagementId: delivery.engagement_id,
            role: 'delivery',
            family: delivery.family,
            mediaType: delivery.media_type,
            name: delivery.name,
            digest: delivery.record_digest,
            bytes: delivery.exact_bytes,
            createdAt: timestamp,
          },
          bytes: delivery.exact_bytes,
        });
        store.db.prepare(
          `INSERT INTO native_solution_discovery_corrections
            (event_key, action, delivery_digest, announcement_id, source_sequence, entry_digest, created_at)
           VALUES (?, 'available', ?, ?, ?, ?, ?)`,
        ).run(key, delivery.record_digest, announcementId, receipt.sequence, receipt.entryDigest, timestamp);
      }
    },
  };
}
