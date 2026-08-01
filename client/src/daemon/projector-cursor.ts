/**
 * Durable projector cursor (cutover stage 1, Task 9). One row per keyed projector stream: the
 * live/finalized chain positions the log source has scanned to, plus the last emitted
 * announcement-entry sequence/digest and the serialized `MarketplaceProjectionState` — written
 * together in one SQLite transaction so the cursor and the projection state never diverge.
 *
 * Finding E20 / close-out plan §C5 adds a third thing that moves in that same transaction: an
 * append-only durable table of every `MarketplaceProtocolObservation` `ProjectorLoop.tick()`
 * projects. Before this, `tick()` computed `transition.observations` and discarded it, so
 * `BaseVenueConfig.observations` (venue-base's "every observation ever projected" read) had
 * nothing durable to read from. See `readObservations()` below — the accessor `BaseVenueConfig`
 * wants (C8 wires it in; not this module's job).
 */
import type {
  MarketplaceProjectionState,
  MarketplaceProtocolObservation,
} from '@jinn-network/marketplace-projector';
import type { Store } from '../store/store.js';

/**
 * Tag for a `bigint` encoded into the cursor's `state_json` column.
 *
 * `MarketplaceProjectionState` carries `bigint` on every claim/delivery-derived record —
 * `requestIdBindings[].taskId` / `.nonce` / `.deliveryRate`, `attemptEngagements[].taskId`,
 * `evaluationEngagements`, `pendingMechDeliveries`. Plain `JSON.stringify` throws
 * `TypeError: Do not know how to serialize a BigInt` on any of them, which would let the
 * projector run cleanly over `TaskCreated` traffic (a task projection holds no bigints) and then
 * crash the first time anyone claimed an attempt.
 *
 * The tag is a single-key object rather than a string prefix so it cannot be confused with a
 * legitimate decimal string — `sequenceBySourceSubject` holds 16-digit sequence strings that a
 * "looks like a number" heuristic would corrupt into bigints on the way back.
 */
const BIGINT_TAG = '$bigint';

/** Encodes bigints losslessly via `BIGINT_TAG`; shared by every column this module persists. */
function serializeBigintAware(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? { [BIGINT_TAG]: v.toString() } : v,
  );
}

/** Inverse of `serializeBigintAware`. */
function deserializeBigintAware<T>(json: string): T {
  return JSON.parse(json, (_key, value: unknown) => {
    if (
      typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && Object.keys(value).length === 1
      && typeof (value as Record<string, unknown>)[BIGINT_TAG] === 'string'
    ) {
      return BigInt((value as Record<string, string>)[BIGINT_TAG]!);
    }
    return value;
  }) as T;
}

/** Serializes a projection state for the `state_json` column, encoding bigints losslessly. */
export function serializeProjectionState(state: MarketplaceProjectionState): string {
  return serializeBigintAware(state);
}

/** Inverse of `serializeProjectionState`. */
export function deserializeProjectionState(json: string): MarketplaceProjectionState {
  return deserializeBigintAware<MarketplaceProjectionState>(json);
}

/**
 * Serializes one observation for the `projector_observations.observation_json` column, via the
 * same tagged codec as the projection state.
 *
 * Verified (do not assume the state codec's coverage transfers, per the close-out plan): as
 * `reduceMarketplaceProjection`'s `emit()` actually constructs a `MarketplaceProtocolObservation`
 * (`packages/marketplace/projector/src/observe.ts`), it carries **no bigints** — every bigint
 * chain fact (`event.facts.taskId`, etc.) is `.toString()`'d before it reaches `data`, and the
 * frozen TEP `ProtocolObservationSchema` (`packages/task-execution/protocol/src/schemas/
 * observation.ts`) types every field as string/number/enum, never `z.bigint()`. Plain
 * `JSON.stringify` already round-trips a real observation unchanged (see
 * `projector-cursor.test.ts`'s "observation codec" suite, and `finality.test.ts:287`, which
 * relies on exactly this). The codec is reused here anyway, defensively: `data` and
 * `ResourceDescriptor.annotations` are typed `Record<string, unknown>`, not statically guaranteed
 * bigint-free, and observations are never schema-validated before this module persists them (see
 * `observe.ts`'s `as MarketplaceProtocolObservation` cast) — so a future emit call site or a
 * host-injected dispatch-context annotation carrying a bigint fails closed (a thrown
 * `TypeError`) rather than silently, with zero cost to reuse the same tagged codec already proven
 * for the state column.
 */
export function serializeObservation(observation: MarketplaceProtocolObservation): string {
  return serializeBigintAware(observation);
}

/** Inverse of `serializeObservation`. */
export function deserializeObservation(json: string): MarketplaceProtocolObservation {
  return deserializeBigintAware<MarketplaceProtocolObservation>(json);
}

export const PROJECTOR_CURSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS projector_cursor (
  key                     TEXT PRIMARY KEY,
  live_block_number       TEXT NOT NULL,
  live_block_hash         TEXT NOT NULL,
  finalized_block_number  TEXT NOT NULL,
  finalized_block_hash    TEXT NOT NULL,
  sequence                TEXT NOT NULL,
  entry_digest            TEXT,
  head_json               TEXT,
  state_json              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
`;

/**
 * Append-only: rows are never updated or deleted, including on `rollbackToFinalized()` (reorg
 * corrections are signed retractions appended to the stream, never a rewrite — see the module
 * comment and `MarketplaceProtocolObservation.correction`). `id` is the projection-order key.
 */
export const PROJECTOR_OBSERVATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS projector_observations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  key                TEXT NOT NULL,
  observation_json   TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projector_observations_key_id ON projector_observations(key, id);
`;

export interface ProjectorCursor {
  readonly liveBlockNumber: bigint;
  readonly liveBlockHash: `0x${string}`;
  readonly finalizedBlockNumber: bigint;
  readonly finalizedBlockHash: `0x${string}`;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}` | null;
  readonly headJson: string | null;
  readonly stateJson: string;
}

interface RawRow {
  key: string;
  live_block_number: string;
  live_block_hash: string;
  finalized_block_number: string;
  finalized_block_hash: string;
  sequence: string;
  entry_digest: string | null;
  head_json: string | null;
  state_json: string;
  updated_at: string;
}

function toCursor(raw: RawRow): ProjectorCursor {
  return {
    liveBlockNumber: BigInt(raw.live_block_number),
    liveBlockHash: raw.live_block_hash as `0x${string}`,
    finalizedBlockNumber: BigInt(raw.finalized_block_number),
    finalizedBlockHash: raw.finalized_block_hash as `0x${string}`,
    sequence: raw.sequence,
    entryDigest: raw.entry_digest as `sha256:${string}` | null,
    headJson: raw.head_json,
    stateJson: raw.state_json,
  };
}

export class ProjectorCursorStore {
  constructor(
    private readonly store: Store,
    private readonly key: string,
  ) {}

  read(): ProjectorCursor | undefined {
    const raw = this.store.db
      .prepare(`SELECT * FROM projector_cursor WHERE key = ?`)
      .get(this.key) as RawRow | undefined;
    return raw === undefined ? undefined : toCursor(raw);
  }

  /**
   * Single SQLite transaction: cursor + projection state + newly-projected observations all
   * advance together, or none do (finding E20 / close-out plan §C5). `observations` are appended
   * to `projector_observations` — an append-only table, never rewritten by `write()` itself; a
   * crash between the cursor advancing and its observations landing would desynchronize the
   * venue's view of the chain from the projector's, which is exactly what this transaction rules
   * out.
   */
  write(cursor: ProjectorCursor, observations: readonly MarketplaceProtocolObservation[] = []): void {
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO projector_cursor
             (key, live_block_number, live_block_hash, finalized_block_number,
              finalized_block_hash, sequence, entry_digest, head_json, state_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             live_block_number = excluded.live_block_number,
             live_block_hash = excluded.live_block_hash,
             finalized_block_number = excluded.finalized_block_number,
             finalized_block_hash = excluded.finalized_block_hash,
             sequence = excluded.sequence,
             entry_digest = excluded.entry_digest,
             head_json = excluded.head_json,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.key,
          cursor.liveBlockNumber.toString(),
          cursor.liveBlockHash,
          cursor.finalizedBlockNumber.toString(),
          cursor.finalizedBlockHash,
          cursor.sequence,
          cursor.entryDigest,
          cursor.headJson,
          cursor.stateJson,
          new Date().toISOString(),
        );

      if (observations.length === 0) return;
      const insertObservation = this.store.db.prepare(
        `INSERT INTO projector_observations (key, observation_json, created_at) VALUES (?, ?, ?)`,
      );
      const insertedAt = new Date().toISOString();
      for (const observation of observations) {
        insertObservation.run(this.key, serializeObservation(observation), insertedAt);
      }
    })();
  }

  /**
   * Every observation ever projected for this stream's key, in projection order. This is the
   * accessor `BaseVenueConfig.observations` (`() => Promise<readonly ProtocolObservation[]>`,
   * `packages/marketplace/venue-base/src/config.ts:30`) wants — C8 wires it in
   * (`async () => cursorStore.readObservations()`), not this module's job.
   */
  readObservations(): MarketplaceProtocolObservation[] {
    const rows = this.store.db
      .prepare(`SELECT observation_json FROM projector_observations WHERE key = ? ORDER BY id ASC`)
      .all(this.key) as { observation_json: string }[];
    return rows.map((row) => deserializeObservation(row.observation_json));
  }

  /**
   * Reorg handling: roll back to the durable finalized checkpoint. Note (close-out plan §C3):
   * `ProjectorLoop.tick()` no longer calls this — since the loop switched to consuming
   * venue-base's own `ChainLogSource` directly, `ChainLogSource.poll()` owns the reorg decision
   * entirely (see `projector-loop.ts`'s module comment), and this method has no production call
   * site left. Kept for its own coverage and any future non-loop caller; not exercised end-to-end
   * from `tick()`. Never deletes rows from `projector_observations` either way — see that table's
   * append-only contract above.
   */
  rollbackToFinalized(): ProjectorCursor | undefined {
    const current = this.read();
    if (current === undefined) return undefined;
    // Announcements already emitted are corrected append-only through signed retractions
    // (spec §7.2); only projector *state*'s live position rolls back. Sequence and entry digest
    // are the append-only announcement chain's own position and never rewind.
    const rolled: ProjectorCursor = {
      ...current,
      liveBlockNumber: current.finalizedBlockNumber,
      liveBlockHash: current.finalizedBlockHash,
    };
    this.write(rolled);
    return rolled;
  }
}
