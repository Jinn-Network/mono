import type Database from 'better-sqlite3';

export interface Erc8004AnchorInput {
  envelopeId: string;
  envelopeCid: string;
  contentKind: string;
  metadataKey: string;
  agentId: string;
  chainId: number;
  identityRegistryAddress: string;
  txHash: string;
  blockNumber: number | null;
  payloadHex: string;
  anchoredAt: number;
  gasUsed?: string | null;
  feeWei?: string | null;
}

export interface Erc8004AnchorRow extends Omit<Erc8004AnchorInput, 'gasUsed' | 'feeWei'> {
  id: number;
  gasUsed: string | null;
  feeWei: string | null;
}

export class Erc8004AnchorsStore {
  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureGasColumns();
    this.ensureFinalizationIndex();
  }

  private ensureGasColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(erc8004_anchors)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('gas_used')) {
      this.db.exec(`ALTER TABLE erc8004_anchors ADD COLUMN gas_used TEXT`);
    }
    if (!names.has('fee_wei')) {
      this.db.exec(`ALTER TABLE erc8004_anchors ADD COLUMN fee_wei TEXT`);
    }
  }

  private ensureFinalizationIndex(): void {
    this.db.exec(`
      DELETE FROM erc8004_anchors
       WHERE id NOT IN (
         SELECT MIN(id)
           FROM erc8004_anchors
          GROUP BY chain_id, identity_registry_address, metadata_key, tx_hash
       );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_erc8004_anchors_finalization
        ON erc8004_anchors (
          chain_id,
          identity_registry_address,
          metadata_key,
          tx_hash
        );
    `);
  }

  saveErc8004Anchor(input: Erc8004AnchorInput): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO erc8004_anchors
         (envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
          chain_id, identity_registry_address, tx_hash, block_number,
          payload_hex, anchored_at, gas_used, fee_wei)
       VALUES
         (@envelopeId, @envelopeCid, @contentKind, @metadataKey, @agentId,
          @chainId, @identityRegistryAddress, @txHash, @blockNumber,
          @payloadHex, @anchoredAt, @gasUsed, @feeWei)`,
    ).run({
      envelopeId: input.envelopeId,
      envelopeCid: input.envelopeCid,
      contentKind: input.contentKind,
      metadataKey: input.metadataKey,
      agentId: input.agentId,
      chainId: input.chainId,
      identityRegistryAddress: input.identityRegistryAddress,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      payloadHex: input.payloadHex,
      anchoredAt: input.anchoredAt,
      gasUsed: input.gasUsed ?? null,
      feeWei: input.feeWei ?? null,
    });
  }

  listErc8004AnchorsByEnvelopeCids(envelopeCids: readonly string[]): Erc8004AnchorRow[] {
    if (envelopeCids.length === 0) return [];
    const placeholders = envelopeCids.map((_, i) => `@cid${i}`).join(', ');
    const params: Record<string, string> = {};
    envelopeCids.forEach((cid, i) => { params[`cid${i}`] = cid; });
    const rows = this.db.prepare(
      `SELECT id, envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
              chain_id, identity_registry_address, tx_hash, block_number,
              payload_hex, anchored_at, gas_used, fee_wei
         FROM erc8004_anchors
         WHERE envelope_cid IN (${placeholders})
         ORDER BY anchored_at ASC, id ASC`,
    ).all(params) as Array<{
      id: number;
      envelope_id: string;
      envelope_cid: string;
      content_kind: string;
      metadata_key: string;
      agent_id: string;
      chain_id: number;
      identity_registry_address: string;
      tx_hash: string;
      block_number: number | null;
      payload_hex: string;
      anchored_at: number;
      gas_used: string | null;
      fee_wei: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      envelopeId: r.envelope_id,
      envelopeCid: r.envelope_cid,
      contentKind: r.content_kind,
      metadataKey: r.metadata_key,
      agentId: r.agent_id,
      chainId: r.chain_id,
      identityRegistryAddress: r.identity_registry_address,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      payloadHex: r.payload_hex,
      anchoredAt: r.anchored_at,
      gasUsed: r.gas_used,
      feeWei: r.fee_wei,
    }));
  }

  loadManifestBatchJournal(batchKey: string): string | null {
    const row = this.db.prepare(
      `SELECT state_json
         FROM manifest_batch_journal
        WHERE batch_key = ?`,
    ).get(batchKey) as { state_json: string } | undefined;
    return row?.state_json ?? null;
  }

  saveManifestBatchJournal(batchKey: string, stateJson: string): void {
    this.db.prepare(
      `INSERT INTO manifest_batch_journal (batch_key, state_json, updated_at)
       VALUES (@batchKey, @stateJson, datetime('now'))
       ON CONFLICT(batch_key) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run({ batchKey, stateJson });
  }

  compareAndSwapManifestBatchJournal(
    batchKey: string,
    expectedStateJson: string | null,
    nextStateJson: string,
  ): boolean {
    if (expectedStateJson === null) {
      const result = this.db.prepare(
        `INSERT INTO manifest_batch_journal (batch_key, state_json, updated_at)
         VALUES (@batchKey, @nextStateJson, datetime('now'))
         ON CONFLICT(batch_key) DO NOTHING`,
      ).run({ batchKey, nextStateJson });
      return result.changes === 1;
    }
    const result = this.db.prepare(
      `UPDATE manifest_batch_journal
          SET state_json = @nextStateJson,
              updated_at = datetime('now')
        WHERE batch_key = @batchKey
          AND state_json = @expectedStateJson`,
    ).run({ batchKey, expectedStateJson, nextStateJson });
    return result.changes === 1;
  }
}
