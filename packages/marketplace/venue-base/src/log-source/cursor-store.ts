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
