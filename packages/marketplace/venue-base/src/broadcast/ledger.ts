// SPDX-License-Identifier: MIT

// The persistent submission ledger of the relayer profile (design §7 ruling 1), backed by the
// `tx_submissions` table (Task 6 schema). Bigints are stored as decimal TEXT -- SQLite has no
// native 64/256-bit integer type wide enough for wei amounts and fee values -- and read back with
// `BigInt(...)`. `from`/`to` are lowercased on write so key lookups are case-stable regardless of
// the checksum casing the caller passes in.
import type { Address, Hex } from "viem";
import type { VenueStateDatabase } from "../state/database.js";
import type { FeeSnapshot } from "./fees.js";

export interface SubmissionKey {
  readonly chainId: number;
  readonly from: Address;
  readonly nonce: number;
}

export interface SubmissionRecord extends SubmissionKey {
  readonly txHash?: Hex;
  readonly logicalTx?: string;
  readonly to?: Address;
  readonly value?: bigint;
  readonly data?: Hex;
  readonly fees: FeeSnapshot;
  readonly submittedAtMs: number;
  readonly resolvedAtMs?: number;
}

export interface SubmissionLedger {
  get(key: SubmissionKey): SubmissionRecord | undefined;
  record(entry: SubmissionRecord): void;
  markResolved(key: SubmissionKey, resolvedAtMs: number): void;
  unresolvedBetween(
    chainId: number,
    from: Address,
    fromNonce: number,
    toNonce: number,
  ): readonly SubmissionRecord[];
}

interface SubmissionRow {
  chain_id: number;
  from_address: string;
  nonce: number;
  tx_hash: string | null;
  logical_tx: string | null;
  to_address: string | null;
  value_wei: string | null;
  data: string | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  gas_price: string | null;
  submitted_at_ms: number;
  resolved_at_ms: number | null;
}

function toRecord(row: SubmissionRow): SubmissionRecord {
  const fees: FeeSnapshot = {
    ...(row.max_fee_per_gas !== null ? { maxFeePerGas: BigInt(row.max_fee_per_gas) } : {}),
    ...(row.max_priority_fee_per_gas !== null
      ? { maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas) }
      : {}),
    ...(row.gas_price !== null ? { gasPrice: BigInt(row.gas_price) } : {}),
  };
  return {
    chainId: row.chain_id,
    from: row.from_address as Address,
    nonce: row.nonce,
    ...(row.tx_hash !== null ? { txHash: row.tx_hash as Hex } : {}),
    ...(row.logical_tx !== null ? { logicalTx: row.logical_tx } : {}),
    ...(row.to_address !== null ? { to: row.to_address as Address } : {}),
    ...(row.value_wei !== null ? { value: BigInt(row.value_wei) } : {}),
    ...(row.data !== null ? { data: row.data as Hex } : {}),
    fees,
    submittedAtMs: row.submitted_at_ms,
    ...(row.resolved_at_ms !== null ? { resolvedAtMs: row.resolved_at_ms } : {}),
  };
}

export function createSubmissionLedger(state: VenueStateDatabase): SubmissionLedger {
  const getStmt = state.db.prepare(
    "SELECT chain_id, from_address, nonce, tx_hash, logical_tx, to_address, value_wei, data,"
    + " max_fee_per_gas, max_priority_fee_per_gas, gas_price, submitted_at_ms, resolved_at_ms"
    + " FROM tx_submissions WHERE chain_id = @chainId AND from_address = @from AND nonce = @nonce",
  );
  const upsertStmt = state.db.prepare(
    "INSERT INTO tx_submissions"
    + " (chain_id, from_address, nonce, tx_hash, logical_tx, to_address, value_wei, data,"
    + "  max_fee_per_gas, max_priority_fee_per_gas, gas_price, submitted_at_ms, resolved_at_ms)"
    + " VALUES (@chainId, @from, @nonce, @txHash, @logicalTx, @to, @value, @data,"
    + "  @maxFeePerGas, @maxPriorityFeePerGas, @gasPrice, @submittedAtMs, @resolvedAtMs)"
    + " ON CONFLICT (chain_id, from_address, nonce) DO UPDATE SET"
    + "   tx_hash = excluded.tx_hash,"
    + "   logical_tx = excluded.logical_tx,"
    + "   to_address = excluded.to_address,"
    + "   value_wei = excluded.value_wei,"
    + "   data = excluded.data,"
    + "   max_fee_per_gas = excluded.max_fee_per_gas,"
    + "   max_priority_fee_per_gas = excluded.max_priority_fee_per_gas,"
    + "   gas_price = excluded.gas_price,"
    + "   submitted_at_ms = excluded.submitted_at_ms,"
    + "   resolved_at_ms = excluded.resolved_at_ms",
  );
  const markResolvedStmt = state.db.prepare(
    "UPDATE tx_submissions SET resolved_at_ms = @resolvedAtMs"
    + " WHERE chain_id = @chainId AND from_address = @from AND nonce = @nonce",
  );
  const unresolvedBetweenStmt = state.db.prepare(
    "SELECT chain_id, from_address, nonce, tx_hash, logical_tx, to_address, value_wei, data,"
    + " max_fee_per_gas, max_priority_fee_per_gas, gas_price, submitted_at_ms, resolved_at_ms"
    + " FROM tx_submissions"
    + " WHERE chain_id = @chainId AND from_address = @from"
    + "   AND nonce >= @fromNonce AND nonce < @toNonce"
    + "   AND resolved_at_ms IS NULL"
    + " ORDER BY nonce ASC",
  );

  return {
    get(key) {
      const row = getStmt.get({
        chainId: key.chainId,
        from: key.from.toLowerCase(),
        nonce: key.nonce,
      }) as SubmissionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    record(entry) {
      upsertStmt.run({
        chainId: entry.chainId,
        from: entry.from.toLowerCase(),
        nonce: entry.nonce,
        txHash: entry.txHash ?? null,
        logicalTx: entry.logicalTx ?? null,
        to: entry.to === undefined ? null : entry.to.toLowerCase(),
        value: entry.value === undefined ? null : entry.value.toString(),
        data: entry.data ?? null,
        maxFeePerGas: entry.fees.maxFeePerGas === undefined ? null : entry.fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: entry.fees.maxPriorityFeePerGas === undefined
          ? null
          : entry.fees.maxPriorityFeePerGas.toString(),
        gasPrice: entry.fees.gasPrice === undefined ? null : entry.fees.gasPrice.toString(),
        submittedAtMs: entry.submittedAtMs,
        resolvedAtMs: entry.resolvedAtMs ?? null,
      });
    },
    markResolved(key, resolvedAtMs) {
      markResolvedStmt.run({
        chainId: key.chainId,
        from: key.from.toLowerCase(),
        nonce: key.nonce,
        resolvedAtMs,
      });
    },
    unresolvedBetween(chainId, from, fromNonce, toNonce) {
      const rows = unresolvedBetweenStmt.all({
        chainId,
        from: from.toLowerCase(),
        fromNonce,
        toNonce,
      }) as SubmissionRow[];
      return rows.map(toRecord);
    },
  };
}
