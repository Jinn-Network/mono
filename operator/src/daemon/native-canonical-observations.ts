import type {
  MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import {
  decodeMarketplaceLogs,
  marketplaceEventOriginAuthority,
  type FinalityTier,
  type MarketplaceEvent,
  type MarketplaceProtocolObservation,
} from '@jinn-network/marketplace-projector';
import type { Address } from 'viem';
import type { NativeReadOnlyVenuePrimitives } from './native-infrastructure-bundle.js';
import type { Store } from '../store/store.js';

const BIGINT = '$bigint';

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { [BIGINT]: item.toString(10) } : item);
}

function decode(value: string): MarketplaceProtocolObservation {
  return JSON.parse(value, (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)
      && Object.keys(item).length === 1
      && typeof (item as Record<string, unknown>)[BIGINT] === 'string') {
      return BigInt((item as Record<string, string>)[BIGINT]!);
    }
    return item;
  }) as MarketplaceProtocolObservation;
}

/** Product-owned append-only projection read model supplied to the sole BaseVenue owner. */
export class NativeCanonicalObservationRepository {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS native_canonical_observations (
        observation_id TEXT PRIMARY KEY,
        observation_json TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      );
    `);
  }

  append(batch: readonly MarketplaceProtocolObservation[]): void {
    this.store.db.transaction(() => {
      const read = this.store.db.prepare(
        `SELECT observation_json FROM native_canonical_observations WHERE observation_id = ?`,
      );
      const insert = this.store.db.prepare(
        `INSERT INTO native_canonical_observations
          (observation_id, observation_json, accepted_at) VALUES (?, ?, ?)`,
      );
      for (const observation of batch) {
        const serialized = encode(observation);
        const existing = read.get(observation.id) as { observation_json: string } | undefined;
        if (existing !== undefined) {
          if (existing.observation_json !== serialized) {
            throw new Error(`canonical observation ${observation.id} conflicts with its durable bytes`);
          }
          continue;
        }
        insert.run(observation.id, serialized, new Date().toISOString());
      }
    })();
  }

  read(): readonly MarketplaceProtocolObservation[] {
    return (this.store.db.prepare(
      `SELECT observation_json FROM native_canonical_observations ORDER BY rowid`,
    ).all() as Array<{ observation_json: string }>).map(({ observation_json }) => decode(observation_json));
  }
}

function eventKey(event: MarketplaceEvent): string {
  return [
    event.derivation.chainId,
    event.derivation.contract.toLowerCase(),
    event.derivation.blockHash.toLowerCase(),
    event.derivation.txHash.toLowerCase(),
    event.derivation.logIndex,
  ].join(':');
}

function decodeEvent(value: string): MarketplaceEvent {
  return JSON.parse(value, (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)
      && Object.keys(item).length === 1
      && typeof (item as Record<string, unknown>)[BIGINT] === 'string') {
      return BigInt((item as Record<string, string>)[BIGINT]!);
    }
    return item;
  }) as MarketplaceEvent;
}

/**
 * Product-owned raw canonical event journal. Reorgs mark provenance; history is never deleted.
 *
 * FINALITY IS NOT A FACT ABOUT THE LOG (defect #47 review). `finalityTier` is not decoded from the
 * log — `chain-log-source.ts`'s `fetchChunked` computes it per fetch as
 * `blockNumber <= finalizedHeight ? "finalized" : "safe"`, i.e. it records how confident THIS
 * OBSERVER was at THIS fetch, not anything the chain said. Every other byte in a `MarketplaceEvent`
 * is derived from the log itself and must never change for a given `event_key`; the tier can and
 * legitimately does, because the finalized head advances.
 *
 * That difference is load-bearing on the replay path. `rewindChainLogCursor` (defect #47) moves the
 * cursor below an already-swept range; the next `poll()` takes the catch-up fast path, where every
 * refetched log below the finalized head decodes as `finalized` — while the rows already in this
 * table were written as `safe` when they were first seen near the tip. Treating that as a changed
 * fact threw out of `apply()`, and because `apply()` runs in ONE transaction the whole batch rolled
 * back — including the brand-new events above the old cursor, which are never re-listed. The
 * operator's recovery step silently punched a hole in the read model it was meant to repair.
 *
 * So a `safe` → `finalized` PROMOTION on otherwise byte-identical bytes upgrades the row in place
 * instead of throwing. The reverse (`finalized` → `safe`, reachable when a provider's `finalized`
 * tag regresses) is ignored rather than written back: the mark is monotone, matching
 * `chain-log-source.ts`'s own "a provider that regresses its `finalized` tag never moves it back".
 * ANY other divergence still throws — the guard keeps its whole fail-closed job over real facts.
 */
export class NativeMarketplaceEventRepository {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS native_marketplace_events (
        event_key     TEXT PRIMARY KEY,
        block_hash   TEXT NOT NULL,
        finality     TEXT NOT NULL,
        event_json   TEXT NOT NULL,
        orphaned_at  TEXT,
        accepted_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_native_marketplace_events_active
        ON native_marketplace_events(finality, orphaned_at, accepted_at);
    `);
  }

  apply(input: {
    readonly events: readonly MarketplaceEvent[];
    readonly orphanedBlockHashes?: readonly `0x${string}`[];
  }): void {
    this.store.db.transaction(() => {
      const now = new Date().toISOString();
      const orphan = this.store.db.prepare(
        `UPDATE native_marketplace_events SET orphaned_at = ?
          WHERE lower(block_hash) = ? AND orphaned_at IS NULL`,
      );
      for (const blockHash of input.orphanedBlockHashes ?? []) {
        orphan.run(now, blockHash.toLowerCase());
      }
      const read = this.store.db.prepare(
        `SELECT event_json, finality FROM native_marketplace_events WHERE event_key = ?`,
      );
      const insert = this.store.db.prepare(
        `INSERT INTO native_marketplace_events
          (event_key, block_hash, finality, event_json, accepted_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const promote = this.store.db.prepare(
        `UPDATE native_marketplace_events SET finality = ?, event_json = ? WHERE event_key = ?`,
      );
      for (const event of input.events) {
        const key = eventKey(event);
        const json = encode(event);
        const existing = read.get(key) as { event_json: string; finality: string } | undefined;
        if (existing !== undefined) {
          // Re-encode the incoming event AT THE STORED TIER and compare bytes. Identical to the
          // plain `encode(event)` comparison whenever the tiers agree, and it normalizes exactly
          // one field out of the check when they do not — no field list to drift, no decode of the
          // stored bytes, and a `finality` column value outside the union simply fails to match and
          // still throws.
          const atStoredTier = encode({
            ...event,
            derivation: { ...event.derivation, finalityTier: existing.finality as FinalityTier },
          });
          if (existing.event_json !== atStoredTier) {
            throw new Error(`native marketplace event ${key} changed bytes`);
          }
          if (existing.finality === 'safe' && event.derivation.finalityTier === 'finalized') {
            promote.run(event.derivation.finalityTier, json, key);
          }
          continue;
        }
        insert.run(key, event.derivation.blockHash, event.derivation.finalityTier, json, now);
      }
    })();
  }

  /** Active raw candidates; the bounded canonical reader supplies current finalized authority. */
  solutionCandidates(): readonly Extract<MarketplaceEvent, { readonly event: 'SolutionDeliveryClaimed' }>[] {
    const rows = this.store.db.prepare(
      `SELECT event_json FROM native_marketplace_events
        WHERE orphaned_at IS NULL ORDER BY rowid`,
    ).all() as Array<{ event_json: string }>;
    return rows.map(({ event_json }) => decodeEvent(event_json)).filter(
      (event): event is Extract<MarketplaceEvent, { readonly event: 'SolutionDeliveryClaimed' }> =>
        event.event === 'SolutionDeliveryClaimed',
    );
  }


  orphanedSolutionCandidates(): readonly {
    readonly eventKey: string;
    readonly event: Extract<MarketplaceEvent, { readonly event: 'SolutionDeliveryClaimed' }>;
    readonly orphanedAt: string;
  }[] {
    const rows = this.store.db.prepare(
      `SELECT event_key, event_json, orphaned_at FROM native_marketplace_events
        WHERE orphaned_at IS NOT NULL ORDER BY accepted_at, event_key`,
    ).all() as Array<{ event_key: string; event_json: string; orphaned_at: string }>;
    return rows.flatMap((row) => {
      const event = decodeEvent(row.event_json);
      return event.event === 'SolutionDeliveryClaimed'
        ? [{ eventKey: row.event_key, event, orphanedAt: row.orphaned_at }]
        : [];
    });
  }
}

/**
 * Applies ONE already-polled log batch to the marketplace-event read model.
 *
 * Split out of `syncNativeMarketplaceEvents` (one-swap M3, #2461) because the fleet daemon must
 * not poll for itself. `ChainLogSource.poll()` advances a durable per-stream cursor, so a second
 * caller polling the projector's source would split the log stream between them and each would
 * silently miss what the other consumed. On the fleet path the projector loop remains the ONE
 * poller and hands its batch here (`composition-root.ts`'s native branch); the solver host, which
 * owns its raw source outright, keeps polling through `syncNativeMarketplaceEvents` below.
 */
export function applyNativeMarketplaceBatch(input: {
  readonly batch: Pick<Awaited<ReturnType<NativeReadOnlyVenuePrimitives['rawLogSource']['poll']>>, 'logs' | 'reorg'>;
  readonly repository: NativeMarketplaceEventRepository;
  readonly chain: MarketplaceChainConfig;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
}): number {
  const events = decodeMarketplaceLogs(
    input.batch.logs,
    marketplaceEventOriginAuthority(input.chain, input.isAuthorizedMechOrigin),
  );
  input.repository.apply({
    events,
    orphanedBlockHashes: input.batch.reorg?.orphanedBlockHashes,
  });
  return events.length;
}

/** One canonical raw-venue pass shared by the solver/evaluator product graphs. */
export async function syncNativeMarketplaceEvents(input: {
  readonly venue: NativeReadOnlyVenuePrimitives;
  readonly repository: NativeMarketplaceEventRepository;
  readonly chain: MarketplaceChainConfig;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
}): Promise<number> {
  return applyNativeMarketplaceBatch({
    batch: await input.venue.rawLogSource.poll(),
    repository: input.repository,
    chain: input.chain,
    isAuthorizedMechOrigin: input.isAuthorizedMechOrigin,
  });
}
