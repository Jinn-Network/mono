// SPDX-License-Identifier: MIT

// The dual-mark chain cursor and orphaned-block set (design §7 ruling 2), backed by the
// `log_cursors` and `orphaned_blocks` tables (Task 6 schema). Block numbers are stored as
// INTEGER -- the schema's own CHECK already refuses a finalized mark ahead of the live cursor --
// and hashes are lowercased on write so a later case-insensitive comparison never has to guess.
import type { Hex } from "viem";
import type { VenueStateDatabase } from "../state/database.js";

export interface ChainLogCursor {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export interface CursorStore {
  read(stream: string): { readonly live: ChainLogCursor; readonly finalized: ChainLogCursor } | undefined;
  write(stream: string, chainId: number, live: ChainLogCursor, finalized: ChainLogCursor): void;
  /** Persist every scanned canonical block, including blocks which carried no relevant logs. */
  recordScanned(stream: string, chainId: number, blocks: readonly ChainLogCursor[]): void;
  /** The exact previously-canonical suffix beyond a reorg rebuild boundary. */
  displacedSince(stream: string, boundary: bigint): readonly ChainLogCursor[];
  /** Marks the prior suffix non-canonical without rewriting or deleting its provenance. */
  markDisplaced(stream: string, blocks: readonly ChainLogCursor[]): void;
  /** Never prune above this finalized boundary; a caller may omit pruning entirely. */
  pruneThroughFinalized(stream: string, boundary: bigint): void;
  recordOrphaned(chainId: number, blocks: readonly ChainLogCursor[]): void;
  orphanedHashes(chainId: number): ReadonlySet<string>;
}

interface CursorRow {
  live_block_number: number;
  live_block_hash: string;
  finalized_block_number: number;
  finalized_block_hash: string;
}

export function createCursorStore(state: VenueStateDatabase): CursorStore {
  const readStmt = state.db.prepare(
    "SELECT live_block_number, live_block_hash, finalized_block_number, finalized_block_hash"
    + " FROM log_cursors WHERE stream = ?",
  );
  const writeStmt = state.db.prepare(
    "INSERT INTO log_cursors"
    + " (stream, chain_id, live_block_number, live_block_hash, finalized_block_number, finalized_block_hash, updated_at_ms)"
    + " VALUES (@stream, @chainId, @liveBlockNumber, @liveBlockHash, @finalizedBlockNumber, @finalizedBlockHash, @updatedAtMs)"
    + " ON CONFLICT (stream) DO UPDATE SET"
    + "   chain_id = excluded.chain_id,"
    + "   live_block_number = excluded.live_block_number,"
    + "   live_block_hash = excluded.live_block_hash,"
    + "   finalized_block_number = excluded.finalized_block_number,"
    + "   finalized_block_hash = excluded.finalized_block_hash,"
    + "   updated_at_ms = excluded.updated_at_ms",
  );
  const recordOrphanedStmt = state.db.prepare(
    "INSERT INTO orphaned_blocks (chain_id, block_hash, block_number, observed_at_ms)"
    + " VALUES (@chainId, @blockHash, @blockNumber, @observedAtMs)"
    + " ON CONFLICT (chain_id, block_hash) DO NOTHING",
  );
  const orphanedHashesStmt = state.db.prepare(
    "SELECT block_hash AS blockHash FROM orphaned_blocks WHERE chain_id = ?",
  );
  const recordScannedStmt = state.db.prepare(
    "INSERT INTO scanned_block_hashes (stream, chain_id, block_number, block_hash, orphaned_at_ms)"
    + " VALUES (@stream, @chainId, @blockNumber, @blockHash, NULL)"
    + " ON CONFLICT (stream, block_number, block_hash) DO UPDATE SET orphaned_at_ms = NULL",
  );
  const displacedSinceStmt = state.db.prepare(
    "SELECT block_number AS blockNumber, block_hash AS blockHash FROM scanned_block_hashes"
    + " WHERE stream = ? AND block_number > ? AND orphaned_at_ms IS NULL"
    + " ORDER BY block_number ASC",
  );
  const markDisplacedStmt = state.db.prepare(
    "UPDATE scanned_block_hashes SET orphaned_at_ms = ?"
    + " WHERE stream = ? AND block_number = ? AND block_hash = ? AND orphaned_at_ms IS NULL",
  );
  const pruneThroughFinalizedStmt = state.db.prepare(
    "DELETE FROM scanned_block_hashes WHERE stream = ? AND block_number < ?",
  );

  return {
    read(stream) {
      const row = readStmt.get(stream) as CursorRow | undefined;
      if (row === undefined) return undefined;
      return {
        live: { blockNumber: BigInt(row.live_block_number), blockHash: row.live_block_hash as Hex },
        finalized: { blockNumber: BigInt(row.finalized_block_number), blockHash: row.finalized_block_hash as Hex },
      };
    },
    write(stream, chainId, live, finalized) {
      writeStmt.run({
        stream,
        chainId,
        liveBlockNumber: Number(live.blockNumber),
        liveBlockHash: live.blockHash.toLowerCase(),
        finalizedBlockNumber: Number(finalized.blockNumber),
        finalizedBlockHash: finalized.blockHash.toLowerCase(),
        updatedAtMs: Date.now(),
      });
    },
    recordScanned(stream, chainId, blocks) {
      for (const block of blocks) {
        recordScannedStmt.run({
          stream,
          chainId,
          blockNumber: Number(block.blockNumber),
          blockHash: block.blockHash.toLowerCase(),
        });
      }
    },
    displacedSince(stream, boundary) {
      const rows = displacedSinceStmt.all(stream, Number(boundary)) as Array<{
        blockNumber: number;
        blockHash: string;
      }>;
      return rows.map((row) => ({
        blockNumber: BigInt(row.blockNumber),
        blockHash: row.blockHash as Hex,
      }));
    },
    markDisplaced(stream, blocks) {
      const observedAtMs = Date.now();
      for (const block of blocks) {
        markDisplacedStmt.run(
          observedAtMs,
          stream,
          Number(block.blockNumber),
          block.blockHash.toLowerCase(),
        );
      }
    },
    pruneThroughFinalized(stream, boundary) {
      // A reorg may only affect blocks strictly above the finalized checkpoint. Keeping the
      // boundary itself preserves the exact checkpoint provenance; older rows are no longer
      // needed for suffix enumeration. `orphaned_blocks` remains the permanent audit trail.
      pruneThroughFinalizedStmt.run(stream, Number(boundary));
    },
    recordOrphaned(chainId, blocks) {
      for (const block of blocks) {
        recordOrphanedStmt.run({
          chainId,
          blockHash: block.blockHash.toLowerCase(),
          blockNumber: Number(block.blockNumber),
          observedAtMs: Date.now(),
        });
      }
    },
    orphanedHashes(chainId) {
      const rows = orphanedHashesStmt.all(chainId) as { blockHash: string }[];
      return new Set(rows.map((row) => row.blockHash));
    },
  };
}
