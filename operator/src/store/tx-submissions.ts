import type Database from 'better-sqlite3';
import type { TxSubmissionKey, TxSubmissionLedgerEntry } from '../tx-retry.js';

export class TxSubmissionsStore {
  constructor(private readonly db: Database.Database) {}

  recordTxSubmission(entry: TxSubmissionLedgerEntry): void {
    this.db.prepare(
      `INSERT INTO tx_submissions
         (chain_id, from_address, nonce, hash, logical_tx, submitted_at_ms,
          max_fee_per_gas, max_priority_fee_per_gas, gas_price, to_address, value_wei, data, resolved_at_ms)
       VALUES
         (@chainId, @fromAddress, @nonce, @hash, @logicalTx, @submittedAtMs,
          @maxFeePerGas, @maxPriorityFeePerGas, @gasPrice, @toAddress, @valueWei, @data, @resolvedAtMs)
       ON CONFLICT(chain_id, from_address, nonce) DO UPDATE SET
         hash = excluded.hash,
         logical_tx = excluded.logical_tx,
         submitted_at_ms = excluded.submitted_at_ms,
         max_fee_per_gas = excluded.max_fee_per_gas,
         max_priority_fee_per_gas = excluded.max_priority_fee_per_gas,
         gas_price = excluded.gas_price,
         to_address = excluded.to_address,
         value_wei = excluded.value_wei,
         data = excluded.data,
         resolved_at_ms = excluded.resolved_at_ms`,
    ).run({
      chainId: entry.chainId,
      fromAddress: entry.from.toLowerCase(),
      nonce: entry.nonce,
      hash: entry.hash ?? null,
      logicalTx: entry.logicalTx ?? null,
      submittedAtMs: entry.submittedAtMs,
      maxFeePerGas: entry.fees.maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: entry.fees.maxPriorityFeePerGas?.toString() ?? null,
      gasPrice: entry.fees.gasPrice?.toString() ?? null,
      toAddress: entry.to?.toLowerCase() ?? null,
      valueWei: entry.value?.toString() ?? null,
      data: entry.data ?? null,
      resolvedAtMs: entry.resolvedAtMs ?? null,
    });
  }

  getTxSubmission(key: TxSubmissionKey): TxSubmissionLedgerEntry | null {
    const row = this.db.prepare(
      `SELECT chain_id, from_address, nonce, hash, logical_tx, submitted_at_ms,
              max_fee_per_gas, max_priority_fee_per_gas, gas_price,
              to_address, value_wei, data, resolved_at_ms
       FROM tx_submissions
       WHERE chain_id = @chainId
         AND from_address = @fromAddress
         AND nonce = @nonce`,
    ).get({
      chainId: key.chainId,
      fromAddress: key.from.toLowerCase(),
      nonce: key.nonce,
    }) as {
      chain_id: number;
      from_address: string;
      nonce: number;
      hash: string | null;
      logical_tx: string | null;
      submitted_at_ms: number;
      max_fee_per_gas: string | null;
      max_priority_fee_per_gas: string | null;
      gas_price: string | null;
      to_address: string | null;
      value_wei: string | null;
      data: string | null;
      resolved_at_ms: number | null;
    } | undefined;
    if (!row) return null;
    return {
      chainId: row.chain_id,
      from: row.from_address as TxSubmissionLedgerEntry['from'],
      nonce: row.nonce,
      hash: row.hash as TxSubmissionLedgerEntry['hash'],
      logicalTx: row.logical_tx ?? undefined,
      submittedAtMs: row.submitted_at_ms,
      fees: {
        ...(row.max_fee_per_gas !== null ? { maxFeePerGas: BigInt(row.max_fee_per_gas) } : {}),
        ...(row.max_priority_fee_per_gas !== null
          ? { maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas) }
          : {}),
        ...(row.gas_price !== null ? { gasPrice: BigInt(row.gas_price) } : {}),
      },
      to: row.to_address as TxSubmissionLedgerEntry['to'],
      value: row.value_wei === null ? undefined : BigInt(row.value_wei),
      data: row.data as TxSubmissionLedgerEntry['data'],
      resolvedAtMs: row.resolved_at_ms,
    };
  }

  markTxSubmissionResolved(key: TxSubmissionKey & { resolvedAtMs: number }): void {
    this.db.prepare(
      `UPDATE tx_submissions
         SET resolved_at_ms = @resolvedAtMs
       WHERE chain_id = @chainId
         AND from_address = @fromAddress
         AND nonce = @nonce`,
    ).run({
      chainId: key.chainId,
      fromAddress: key.from.toLowerCase(),
      nonce: key.nonce,
      resolvedAtMs: key.resolvedAtMs,
    });
  }
}
