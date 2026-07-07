import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Address, Hex } from 'viem';
import { redactSecrets } from './redact.js';
import type { ClaimSnapshot } from './types.js';

export type TicketStatus = 'observed' | 'fixture_set' | 'claimed' | 'skipped' | 'failed' | 'retryable';

export interface DeploymentIdentity {
  l1Network: string;
  l1ChainId: number;
  l2Network: string;
  l2ChainId: number;
  claimEmitter: Address;
  distributor: Address;
  messenger: Address;
}

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
  private deploymentId = 'unscoped';

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  setDeploymentIdentity(identity: DeploymentIdentity): void {
    this.deploymentId = deploymentIdentityKey(identity);
    this.db.prepare(`
      INSERT INTO deployments (id, description, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        updated_at = excluded.updated_at
    `).run(this.deploymentId, JSON.stringify(identity));
  }

  getCheckpoint(startBlock: bigint): bigint {
    const row = this.db.prepare(`
      SELECT value FROM checkpoint
      WHERE deployment_id = ? AND key = ?
    `).get(this.deploymentId, 'last_scanned_block') as { value: string } | undefined;
    return row ? BigInt(row.value) : startBlock - 1n;
  }

  setCheckpoint(blockNumber: bigint): void {
    this.db.prepare(`
      INSERT INTO checkpoint (deployment_id, key, value, updated_at)
      VALUES (?, 'last_scanned_block', ?, datetime('now'))
      ON CONFLICT(deployment_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(this.deploymentId, blockNumber.toString());
  }

  upsertObserved(snapshot: ClaimSnapshot): TicketStatus | null {
    const existing = this.getTicketStatus(snapshot.claimId);
    this.db.prepare(`
      INSERT INTO tickets (
        deployment_id, claim_id, service_id, task_creation_weight, solution_delivery_weight,
        verdict_delivery_weight, multisig, claimer, l2_block_number,
        l2_log_index, l2_tx_hash, status, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', datetime('now'))
      ON CONFLICT(deployment_id, claim_id) DO UPDATE SET
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
      this.deploymentId,
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
      WHERE deployment_id = ? AND claim_id = ?
    `).run(txHash, this.deploymentId, claimId.toString());
  }

  markClaimed(claimId: bigint, txHash: Hex): void {
    this.db.prepare(`
      UPDATE tickets
      SET claim_tx_hash = ?,
          status = 'claimed',
          error = NULL,
          updated_at = datetime('now')
      WHERE deployment_id = ? AND claim_id = ?
    `).run(txHash, this.deploymentId, claimId.toString());
  }

  markSkipped(claimId: bigint, reason: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET status = 'skipped',
          error = ?,
          updated_at = datetime('now')
      WHERE deployment_id = ? AND claim_id = ?
    `).run(redactSecrets(reason), this.deploymentId, claimId.toString());
  }

  markFailed(claimId: bigint, error: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET status = 'failed',
          error = ?,
          updated_at = datetime('now')
      WHERE deployment_id = ? AND claim_id = ?
    `).run(redactSecrets(error), this.deploymentId, claimId.toString());
  }

  markRetryable(claimId: bigint, error: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET status = 'retryable',
          error = ?,
          updated_at = datetime('now')
      WHERE deployment_id = ? AND claim_id = ?
    `).run(redactSecrets(error), this.deploymentId, claimId.toString());
  }

  getTicketStatus(claimId: bigint): TicketStatus | null {
    const row = this.db.prepare(`
      SELECT status FROM tickets
      WHERE deployment_id = ? AND claim_id = ?
    `).get(this.deploymentId, claimId.toString()) as { status: TicketStatus } | undefined;
    return row?.status ?? null;
  }

  countByStatus(): Record<TicketStatus, number> {
    const result: Record<TicketStatus, number> = {
      observed: 0,
      fixture_set: 0,
      claimed: 0,
      skipped: 0,
      failed: 0,
      retryable: 0,
    };
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM tickets
      WHERE deployment_id = ?
      GROUP BY status
    `).all(this.deploymentId) as Array<{ status: TicketStatus; count: number }>;
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  listTickets(limit = 20): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT * FROM tickets
      WHERE deployment_id = ?
      ORDER BY CAST(l2_block_number AS INTEGER) DESC, l2_log_index DESC
      LIMIT ?
    `).all(this.deploymentId, limit) as TicketRow[];
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
      error: row.error ? redactSecrets(row.error) : null,
      updatedAt: row.updated_at,
    }));
  }

  private migrate(): void {
    this.rebuildCheckpointIfNeeded();
    this.rebuildTicketsIfNeeded();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoint (
        deployment_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, key)
      );

      CREATE TABLE IF NOT EXISTS tickets (
        deployment_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
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
        status TEXT NOT NULL CHECK(status IN ('observed', 'fixture_set', 'claimed', 'skipped', 'failed', 'retryable')),
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, claim_id)
      );

      CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(deployment_id, status);
      CREATE INDEX IF NOT EXISTS tickets_l2_position_idx ON tickets(deployment_id, l2_block_number, l2_log_index);
    `);
  }

  private rebuildCheckpointIfNeeded(): void {
    const columns = this.tableColumns('checkpoint');
    if (columns.length === 0 || columns.includes('deployment_id')) return;

    this.db.exec(`
      ALTER TABLE checkpoint RENAME TO checkpoint_legacy;

      CREATE TABLE checkpoint (
        deployment_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, key)
      );

      INSERT INTO checkpoint (deployment_id, key, value, updated_at)
      SELECT 'legacy', key, value, updated_at FROM checkpoint_legacy;

      DROP TABLE checkpoint_legacy;
    `);
  }

  private rebuildTicketsIfNeeded(): void {
    const columns = this.tableColumns('tickets');
    if (columns.length === 0) return;

    const row = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'tickets'
    `).get() as { sql: string } | undefined;
    const needsDeployment = !columns.includes('deployment_id');
    const needsRetryable = !row?.sql.includes("'retryable'");
    if (!needsDeployment && !needsRetryable) return;

    const deploymentExpr = columns.includes('deployment_id') ? 'deployment_id' : "'legacy'";
    this.db.exec(`
      ALTER TABLE tickets RENAME TO tickets_legacy;

      CREATE TABLE tickets (
        deployment_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
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
        status TEXT NOT NULL CHECK(status IN ('observed', 'fixture_set', 'claimed', 'skipped', 'failed', 'retryable')),
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, claim_id)
      );

      INSERT INTO tickets (
        deployment_id, claim_id, service_id, task_creation_weight,
        solution_delivery_weight, verdict_delivery_weight, multisig, claimer,
        l2_block_number, l2_log_index, l2_tx_hash, fixture_tx_hash,
        claim_tx_hash, status, error, updated_at
      )
      SELECT
        ${deploymentExpr}, claim_id, service_id, task_creation_weight,
        solution_delivery_weight, verdict_delivery_weight, multisig, claimer,
        l2_block_number, l2_log_index, l2_tx_hash, fixture_tx_hash,
        claim_tx_hash, status, error, updated_at
      FROM tickets_legacy;

      DROP TABLE tickets_legacy;
    `);
  }

  private tableColumns(tableName: string): string[] {
    const rows = this.db.pragma(`table_info(${tableName})`) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }
}

export function deploymentIdentityKey(identity: DeploymentIdentity): string {
  return [
    'v1',
    `l1=${identity.l1Network}:${identity.l1ChainId}`,
    `l2=${identity.l2Network}:${identity.l2ChainId}`,
    `claimEmitter=${identity.claimEmitter.toLowerCase()}`,
    `distributor=${identity.distributor.toLowerCase()}`,
    `messenger=${identity.messenger.toLowerCase()}`,
  ].join('|');
}
