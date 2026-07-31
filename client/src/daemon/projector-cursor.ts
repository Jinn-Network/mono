/**
 * Durable projector cursor (cutover stage 1, Task 9). One row per keyed projector stream: the
 * live/finalized chain positions the log source has scanned to, plus the last emitted
 * announcement-entry sequence/digest and the serialized `MarketplaceProjectionState` — written
 * together in one SQLite transaction so the cursor and the projection state never diverge.
 */
import type { MarketplaceProjectionState } from '@jinn-network/marketplace-projector';
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

/** Serializes a projection state for the `state_json` column, encoding bigints losslessly. */
export function serializeProjectionState(state: MarketplaceProjectionState): string {
  return JSON.stringify(state, (_key, value: unknown) =>
    typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value,
  );
}

/** Inverse of `serializeProjectionState`. */
export function deserializeProjectionState(json: string): MarketplaceProjectionState {
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
  }) as MarketplaceProjectionState;
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

  /** Single SQLite transaction: cursor + projection state advance together or not at all. */
  write(cursor: ProjectorCursor): void {
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
    })();
  }

  /** Reorg handling: roll back to the durable finalized checkpoint. */
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
