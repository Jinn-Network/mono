import type Database from 'better-sqlite3';

export interface RewardClaimInput {
  ts: string;
  serviceIndex: number;
  serviceId?: number | null;
  stakingProxy: string;
  distributor: string;
  txHash: string;
  amountWei: string;
  asset?: string;
}

export class RewardClaimsStore {
  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureRewardClaimsTxIndex();
  }

  /** Idempotent: older DBs before idx_reward_claims_tx may lack the unique index. */
  private ensureRewardClaimsTxIndex(): void {
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_tx ON reward_claims (tx_hash)`,
    );
  }

  recordRewardClaim(claim: RewardClaimInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO reward_claims
         (ts, service_index, service_id, staking_proxy, distributor, tx_hash, amount_wei, asset)
         VALUES (@ts, @serviceIndex, @serviceId, @stakingProxy, @distributor, @txHash, @amountWei, @asset)`,
      )
      .run({
        ts: claim.ts,
        serviceIndex: claim.serviceIndex,
        serviceId: claim.serviceId ?? null,
        stakingProxy: claim.stakingProxy,
        distributor: claim.distributor,
        txHash: claim.txHash,
        amountWei: claim.amountWei,
        asset: claim.asset ?? 'reward',
      });
  }

  getClaimedRewardsLast24hWei(): string {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(
      `SELECT amount_wei FROM reward_claims WHERE ts >= ?`,
    ).all(cutoff) as Array<{ amount_wei: string }>;
    let total = 0n;
    for (const row of rows) {
      try {
        total += BigInt(row.amount_wei);
      } catch {
        /* ignore malformed legacy rows */
      }
    }
    return total.toString();
  }

  getClaimedRewardsByService(): Record<number, { total: string; lastAt: string; lastTxHash: string }> {
    const rows = this.db.prepare(
      `SELECT id, service_index, amount_wei, ts, tx_hash FROM reward_claims ORDER BY id ASC`,
    ).all() as Array<{
      id: number;
      service_index: number;
      amount_wei: string;
      ts: string;
      tx_hash: string;
    }>;
    const out: Record<number, { total: string; lastAt: string; lastTxHash: string }> = {};
    const lastId: Record<number, number> = {};
    for (const r of rows) {
      const current = out[r.service_index];
      const nextTotal = (current ? BigInt(current.total) : 0n) + BigInt(r.amount_wei);
      const isNewer = !current || r.id > (lastId[r.service_index] ?? 0);
      if (isNewer) {
        lastId[r.service_index] = r.id;
      }
      out[r.service_index] = {
        total: nextTotal.toString(),
        lastAt: isNewer || !current ? r.ts : current.lastAt,
        lastTxHash: isNewer || !current ? r.tx_hash : current.lastTxHash,
      };
    }
    return out;
  }
}
