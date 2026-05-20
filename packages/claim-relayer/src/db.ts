import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Address, Hex } from 'viem';
import type { ClaimSnapshot } from './types.js';

export type TicketStatus = 'observed' | 'fixture_set' | 'claimed' | 'skipped' | 'failed';

interface TicketRow {
  claim_id: string;
  service_id: string;
  task_creation_weight: string;
  solution_delivery_weight: string;
  verdict_delivery_weight: string;
  multisig: string;
  claimer: string;
  l2_block_number: string;
  l2_log_index: number;
  l2_tx_hash: string;
  fixture_tx_hash: string | null;
  claim_tx_hash: string | null;
  status: TicketStatus;
  error: string | null;
  updated_at: string;
}

export class ClaimRelayerStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getCheckpoint(startBlock: bigint): bigint {
    const row = this.db.prepare('SELECT value FROM checkpoint WHERE key = ?').get('last_scanned_block') as { value: string } | undefined;
    return row ? BigInt(row.value) : startBlock - 1n;
  }

  setCheckpoint(blockNumber: bigint): void {
    this.db.prepare(`
      INSERT INTO checkpoint (key, value, updated_at)
      VALUES ('last_scanned_block', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(blockNumber.toString());
  }

  upsertObserved(snapshot: ClaimSnapshot): TicketStatus | null {
    const existing = this.getTicketStatus(snapshot.claimId);
    this.db.prepare(`
      INSERT INTO tickets (
        claim_id, service_id, task_creation_weight, solution_delivery_weight,
        verdict_delivery_weight, multisig, claimer, l2_block_number,
        l2_log_index, l2_tx_hash, status, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', datetime('now'))
      ON CONFLICT(claim_id) DO UPDATE SET
        service_id = excluded.service_id,
        task_creation_weight = excluded.task_creation_weight,
        solution_delivery_weight = excluded.solution_delivery_weight,
        verdict_delivery_weight = excluded.verdict_delivery_weight,
        multisig = excluded.multisig,
        claimer = excluded.claimer,
        l2_block_number = excluded.l2_block_number,
        l2_log_index = excluded.l2_log_index,
        l2_tx_hash = excluded.l2_tx_hash,
        updated_at = excluded.updated_at
    `).run(
      snapshot.claimId.toString(),
      snapshot.serviceId.toString(),
      snapshot.taskCreationWeight.toString(),
      snapshot.solutionDeliveryWeight.toString(),
      snapshot.verdictDeliveryWeight.toString(),
      snapshot.multisig,
      snapshot.claimer,
      snapshot.l2BlockNumber.toString(),
      snapshot.l2LogIndex,
      snapshot.l2TxHash,
    );
    return existing;
  }

  markFixtureSet(claimId: bigint, txHash: Hex | null): void {
    this.db.prepare(`
      UPDATE tickets
      SET fixture_tx_hash = COALESCE(?, fixture_tx_hash),
          status = 'fixture_set',
          error = NULL,
          updated_at = datetime('now')
      WHERE claim_id = ?
    `).run(txHash, claimId.toString());
  }

  markClaimed(claimId: bigint, txHash: Hex): void {
    this.db.prepare(`
      UPDATE tickets
      SET claim_tx_hash = ?,
          status = 'claimed',
          error = NULL,
          updated_at = datetime('now')
      WHERE claim_id = ?
    `).run(txHash, claimId.toString());
  }

  markSkipped(claimId: bigint, reason: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET status = 'skipped',
          error = ?,
          updated_at = datetime('now')
      WHERE claim_id = ?
    `).run(reason, claimId.toString());
  }

  markFailed(claimId: bigint, error: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET status = 'failed',
          error = ?,
          updated_at = datetime('now')
      WHERE claim_id = ?
    `).run(error, claimId.toString());
  }

  getTicketStatus(claimId: bigint): TicketStatus | null {
    const row = this.db.prepare('SELECT status FROM tickets WHERE claim_id = ?').get(claimId.toString()) as { status: TicketStatus } | undefined;
    return row?.status ?? null;
  }

  countByStatus(): Record<TicketStatus, number> {
    const result: Record<TicketStatus, number> = {
      observed: 0,
      fixture_set: 0,
      claimed: 0,
      skipped: 0,
      failed: 0,
    };
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status').all() as Array<{ status: TicketStatus; count: number }>;
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  listTickets(limit = 20): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT * FROM tickets
      ORDER BY CAST(l2_block_number AS INTEGER) DESC, l2_log_index DESC
      LIMIT ?
    `).all(limit) as TicketRow[];
    return rows.map((row) => ({
      claimId: row.claim_id,
      serviceId: row.service_id,
      multisig: row.multisig as Address,
      l2BlockNumber: row.l2_block_number,
      l2LogIndex: row.l2_log_index,
      l2TxHash: row.l2_tx_hash,
      fixtureTxHash: row.fixture_tx_hash,
      claimTxHash: row.claim_tx_hash,
      status: row.status,
      error: row.error,
      updatedAt: row.updated_at,
    }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        claim_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        task_creation_weight TEXT NOT NULL,
        solution_delivery_weight TEXT NOT NULL,
        verdict_delivery_weight TEXT NOT NULL,
        multisig TEXT NOT NULL,
        claimer TEXT NOT NULL,
        l2_block_number TEXT NOT NULL,
        l2_log_index INTEGER NOT NULL,
        l2_tx_hash TEXT NOT NULL,
        fixture_tx_hash TEXT,
        claim_tx_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('observed', 'fixture_set', 'claimed', 'skipped', 'failed')),
        error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);
      CREATE INDEX IF NOT EXISTS tickets_l2_position_idx ON tickets(l2_block_number, l2_log_index);
    `);
  }
}
