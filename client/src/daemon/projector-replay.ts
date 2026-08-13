/**
 * Operator-run re-projection of an already-swept block range (defect #47).
 *
 * WHY THIS EXISTS. A `ProjectorLoop` tick drops any event whose signed record cannot be honestly
 * resolved that tick (`projector-enrich.ts`), and that drop is PERMANENT: `ChainLogSource.poll()`
 * commits its advanced block cursor inside its own transaction *before* it returns the logs
 * (`packages/marketplace/venue-base/src/log-source/chain-log-source.ts`), so every log is offered
 * to `enrich` exactly once, ever. When a resolver defect drops a gate-relevant event, no amount of
 * waiting brings it back — the operator must deliberately re-offer the range.
 *
 * WHY NOT JUST DELETE THE CURSOR ROW. `poll()`'s cold-start branch reads
 * `options.startBlock ?? finalized.blockNumber`, and NOTHING in this repository ever sets
 * `startBlock` (the field is declared on `ChainLogSourceOptions` and referenced only by that one
 * default). So a wiped `log_cursors` row does not replay from genesis, or from the deployment
 * block, or from anywhere useful — it jumps straight to the CURRENT finalized head and the missing
 * range is skipped a second time, silently. Deleting the row is the one recovery that provably
 * cannot work.
 *
 * WHAT THIS DOES INSTEAD. It REWINDS the existing row to a caller-chosen `(blockNumber, blockHash)`
 * pair below the range, with the hash read live off the chain so the next `poll()` takes the
 * ordinary catch-up path rather than mistaking the rewind for a reorg. The next tick then re-fetches
 * `(rewindBlock, finalized]` — the missing events included — and re-offers every one of them to the
 * fixed `enrich`.
 *
 * WHAT THE REWIND ITSELF WRITES. Exactly one row: `log_cursors` WHERE `stream = <stream>`, columns
 * `live_block_number`, `live_block_hash`, `finalized_block_number`, `finalized_block_hash`,
 * `updated_at_ms`. Nothing else — not `scanned_block_hashes` (a rewound cursor whose hash matches
 * the chain never consults the displaced-suffix set), not `orphaned_blocks`, not the projector's
 * own `projector_cursor` / `projector_observations` / `projector_canonical_events` /
 * `projector_availability_journal` tables, and NO signed material of any kind. Block cursors are
 * operational state — a record of how far a scan got — not attestations; rewinding one asserts
 * nothing and re-derives everything from the chain. `projector_cursor` is deliberately left alone
 * so the announcement head chain (`sequence`, `entry_digest`, `head_json`) stays append-only and
 * correctly linked across the replay, and so already-published canonical events are still suppressed
 * by `hasCanonicalEvent` rather than double-announced.
 *
 * WHAT THE REPLAY IT CAUSES WRITES — a strictly larger set, and the distinction matters. The
 * rewind is inert until the daemon restarts; from then on it is an ORDINARY tick over a range that
 * has already been swept once, and every writer downstream of `poll()` runs again over it:
 *
 *   - `teeNativeMarketplaceEvents` (`native-solution-corrections.ts`, wired in
 *     `composition-root.ts`) decorates the projector's log source and writes
 *     `native_marketplace_events` INSIDE `poll()`, before the projector sees a single log. It is
 *     therefore the FIRST writer the replay reaches, not a downstream one. Its rows carry the
 *     finality tier the log was first fetched at, and a replayed range is refetched below
 *     `finalized`, so the re-offer routinely promotes `safe` → `finalized`. `apply()` upgrades the
 *     tier in place for that case; it used to throw, and since `apply()` is one transaction the
 *     throw discarded the whole batch — the new post-cursor blocks included, which are never
 *     re-listed. See the `NativeMarketplaceEventRepository` comment.
 *   - The projector loop journals canonical events for the re-offered range and advances
 *     `projector_cursor`, so this replay is ONE-SHOT per range: `hasCanonicalEvent` suppresses a
 *     second announcement of anything already published, and `projector-loop.ts` journals events
 *     even when `projectAnnouncements` throws (its announce-failure catch path). A range that
 *     journals but fails to announce is spent — it must be rewound again to retry.
 *   - Whatever the re-offered observations then drive: `anchorCheckedMaterial` and the requester
 *     adoption path have no per-record try/catch, so one bad record aborts the rest of that tick's
 *     records.
 *
 * None of that is signed material written BY the rewind. It is signed material the daemon may now
 * publish because it can finally see the events — which is the point of the procedure, and also why
 * the narrowest workable `--to-block` is the recommended one.
 *
 * BOTH marks are set to the rewind point because the schema's own CHECK refuses a finalized mark
 * ahead of the live cursor. The LIVE regression is transient: `poll()` recomputes
 * `checkpoint = finalized > persisted.finalized ? finalized : persisted.finalized` on the very next
 * tick and restores the live finalized height. The FINALIZED regression is the reason `toBlock` must
 * sit below the persisted finalized mark — that same monotone recompute would make an advance of it
 * permanent (see the guard below).
 */
import type { Hex } from 'viem';

/** The subset of `VenueStateDatabase` this needs — kept narrow so tests can drive a bare handle. */
export interface ProjectorReplayDatabase {
  readonly db: {
    prepare(sql: string): {
      get(...params: readonly unknown[]): unknown;
      run(...params: readonly unknown[]): unknown;
    };
  };
  transaction<T>(fn: () => T): T;
}

export interface ChainLogCursorRow {
  readonly liveBlockNumber: bigint;
  readonly liveBlockHash: Hex;
  readonly finalizedBlockNumber: bigint;
  readonly finalizedBlockHash: Hex;
}

export interface RewindChainLogCursorInput {
  readonly state: ProjectorReplayDatabase;
  /** `venue:<chainId>:<jinnRouter lowercased>` unless the host overrode `options.stream`. */
  readonly stream: string;
  /** The block the next poll resumes ABOVE. Must be strictly below the current live cursor. */
  readonly toBlock: bigint;
  /** Live chain read; the rewind refuses rather than write a hash it could not confirm. */
  readonly readCanonicalBlockHash: (blockNumber: bigint) => Promise<Hex | undefined>;
  /** Dry run by default — an explicit `true` is required before any row is written. */
  readonly apply?: boolean;
  readonly now?: () => number;
}

export interface RewindChainLogCursorResult {
  readonly stream: string;
  readonly before: ChainLogCursorRow;
  readonly after: ChainLogCursorRow;
  /** Blocks the next poll will re-offer: `(toBlock, previous live]` at minimum. */
  readonly replayFromBlock: bigint;
  readonly replayThroughBlock: bigint;
  readonly applied: boolean;
}

/** Refuses rather than guesses. Every message names the row and the reason. */
export class ProjectorReplayError extends Error {
  override readonly name = 'ProjectorReplayError';
}

const SELECT_SQL =
  'SELECT live_block_number, live_block_hash, finalized_block_number, finalized_block_hash'
  + ' FROM log_cursors WHERE stream = ?';

const UPDATE_SQL =
  'UPDATE log_cursors SET live_block_number = ?, live_block_hash = ?,'
  + ' finalized_block_number = ?, finalized_block_hash = ?, updated_at_ms = ?'
  + ' WHERE stream = ?';

interface RawCursorRow {
  readonly live_block_number: number;
  readonly live_block_hash: string;
  readonly finalized_block_number: number;
  readonly finalized_block_hash: string;
}

export function readChainLogCursor(
  state: ProjectorReplayDatabase,
  stream: string,
): ChainLogCursorRow | undefined {
  const row = state.db.prepare(SELECT_SQL).get(stream) as RawCursorRow | undefined;
  if (row === undefined) return undefined;
  return {
    liveBlockNumber: BigInt(row.live_block_number),
    liveBlockHash: row.live_block_hash as Hex,
    finalizedBlockNumber: BigInt(row.finalized_block_number),
    finalizedBlockHash: row.finalized_block_hash as Hex,
  };
}

/**
 * Rewinds one stream's chain-log cursor so the next `ProjectorLoop.tick()` re-offers the range.
 * Fails closed on every ambiguity: an absent row (deleting it would jump to head — see the module
 * comment), a non-backwards target, or a block hash the chain would not confirm.
 */
export async function rewindChainLogCursor(
  input: RewindChainLogCursorInput,
): Promise<RewindChainLogCursorResult> {
  const before = readChainLogCursor(input.state, input.stream);
  if (before === undefined) {
    throw new ProjectorReplayError(
      `no log_cursors row for stream "${input.stream}" — refusing to create one. A missing row `
      + 'makes the next poll cold-start at the CURRENT finalized head (chain-log-source.ts\'s '
      + '`options.startBlock ?? finalized.blockNumber`, and startBlock is never wired), which '
      + 'skips the range instead of replaying it. Check the stream key against '
      + '`venue:<chainId>:<jinnRouter>`.',
    );
  }
  if (input.toBlock < 0n) {
    throw new ProjectorReplayError(`rewind target ${input.toBlock} is not a block number`);
  }
  if (input.toBlock >= before.liveBlockNumber) {
    throw new ProjectorReplayError(
      `rewind target ${input.toBlock} is not below the live cursor ${before.liveBlockNumber} for `
      + `stream "${input.stream}" — a rewind must go backwards, and advancing the cursor here `
      + 'would skip unscanned blocks outright.',
    );
  }
  // The finalized mark is MONOTONE in `poll()` ("a provider that regresses its `finalized` tag
  // never moves it back": `checkpoint = finalized > persisted.finalized ? finalized : persisted`).
  // This rewind writes BOTH marks to `toBlock`, so a target at or above the persisted finalized
  // mark does not rewind that mark — it ADVANCES it, on the operator's say-so, and monotonicity
  // then makes the advance permanent: every block in (old finalized, toBlock] becomes
  // unrollbackable, so a later reorg touching that span can no longer roll back through it and its
  // announcements can never be retracted. Refuse; a replay is meant to re-read history, never to
  // assert finality about it.
  if (input.toBlock >= before.finalizedBlockNumber) {
    throw new ProjectorReplayError(
      `rewind target ${input.toBlock} is not below the finalized mark ${before.finalizedBlockNumber} `
      + `for stream "${input.stream}" — this rewind writes both marks, so that target would ADVANCE `
      + 'the durable finalized checkpoint instead of rewinding it, and `poll()` never moves that '
      + 'mark back. Pick a target below the finalized mark.',
    );
  }
  const blockHash = await input.readCanonicalBlockHash(input.toBlock);
  if (blockHash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new ProjectorReplayError(
      `could not read a canonical block hash for block ${input.toBlock} — refusing to write a `
      + 'cursor hash the chain did not confirm (the next poll would read it as a reorg).',
    );
  }
  const after: ChainLogCursorRow = {
    liveBlockNumber: input.toBlock,
    liveBlockHash: blockHash.toLowerCase() as Hex,
    finalizedBlockNumber: input.toBlock,
    finalizedBlockHash: blockHash.toLowerCase() as Hex,
  };
  const result: RewindChainLogCursorResult = {
    stream: input.stream,
    before,
    after,
    replayFromBlock: input.toBlock + 1n,
    replayThroughBlock: before.liveBlockNumber,
    applied: input.apply === true,
  };
  if (input.apply !== true) return result;
  const now = (input.now ?? Date.now)();
  input.state.transaction(() => {
    input.state.db.prepare(UPDATE_SQL).run(
      Number(after.liveBlockNumber),
      after.liveBlockHash,
      Number(after.finalizedBlockNumber),
      after.finalizedBlockHash,
      now,
      input.stream,
    );
  });
  return result;
}
