import type Database from 'better-sqlite3';
import type {
  EnvelopeProjection,
  EnvelopeProjectionMetadataValue,
  EnvelopeProjectionQuery,
} from '../corpus/types.js';
import { normalizeEnvelopeRole, type Role } from '../types/envelope.js';

interface EnvelopeProjectionRow {
  envelope_id: string;
  envelope_cid: string | null;
  envelope_sha256: string | null;
  signature_hash: string;
  solver_type: string;
  role: string;
  task_cid: string | null;
  task_id: string | null;
  request_id: string | null;
  generated_at: number;
  evidence_tier: 'self-signed' | 'committed' | 'attested';
  participant_safe_address: string | null;
  participant_agent_eoa: string | null;
  executor_impl_name: string | null;
  executor_impl_version: string | null;
  executor_runtime_bundle_digest: string | null;
  executor_plugins_json: string;
  solution_envelope_cid: string | null;
  solution_envelope_sha256: string | null;
  solution_envelope_ref: string | null;
  metadata_json: string;
}

export function metadataValueText(value: EnvelopeProjectionMetadataValue): string {
  return String(value);
}

export function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function parseMetadata(json: string): Record<string, EnvelopeProjectionMetadataValue> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, EnvelopeProjectionMetadataValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rowToEnvelopeProjection(row: EnvelopeProjectionRow): EnvelopeProjection {
  return {
    envelopeId: row.envelope_id,
    envelopeCid: row.envelope_cid,
    envelopeSha256: row.envelope_sha256,
    signatureHash: row.signature_hash,
    solverType: row.solver_type,
    role: normalizeEnvelopeRole(row.role) as Role,
    taskCid: row.task_cid,
    taskId: row.task_id,
    requestId: row.request_id,
    generatedAt: row.generated_at,
    evidenceTier: row.evidence_tier,
    participantSafeAddress: row.participant_safe_address,
    participantAgentEoa: row.participant_agent_eoa,
    executorImplName: row.executor_impl_name,
    executorImplVersion: row.executor_impl_version,
    executorRuntimeBundleDigest: row.executor_runtime_bundle_digest,
    executorPlugins: parseStringArray(row.executor_plugins_json),
    solutionEnvelopeCid: row.solution_envelope_cid,
    solutionEnvelopeSha256: row.solution_envelope_sha256,
    solutionEnvelopeRef: row.solution_envelope_ref,
    metadata: parseMetadata(row.metadata_json),
  };
}

export class EnvelopeProjectionsStore {
  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureEnvelopeProjectionColumns();
  }

  /** Older local DBs may have the projection table from before Task grouping fields landed. */
  private ensureEnvelopeProjectionColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(envelope_projections)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const addColumn = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE envelope_projections ADD COLUMN ${ddl}`);
    };

    addColumn('task_id', 'task_id TEXT');
    addColumn('executor_runtime_bundle_digest', 'executor_runtime_bundle_digest TEXT');
    addColumn('executor_plugins_json', `executor_plugins_json TEXT NOT NULL DEFAULT '[]'`);
    addColumn('solution_envelope_cid', 'solution_envelope_cid TEXT');
    addColumn('solution_envelope_sha256', 'solution_envelope_sha256 TEXT');
    addColumn('solution_envelope_ref', 'solution_envelope_ref TEXT');
    addColumn('metadata_json', `metadata_json TEXT NOT NULL DEFAULT '{}'`);

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_envelope_projections_task_id ON envelope_projections (task_id)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_envelope_projections_solution_ref ON envelope_projections (solution_envelope_ref)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_envelope_projections_generated ON envelope_projections (generated_at DESC)`,
    );
  }

  saveEnvelopeProjection(projection: EnvelopeProjection): void {
    const tx = this.db.transaction((p: EnvelopeProjection) => {
      this.db.prepare(
        `INSERT INTO envelope_projections
           (envelope_id, envelope_cid, envelope_sha256, signature_hash, solver_type, role,
            task_cid, task_id, request_id, generated_at, evidence_tier,
            participant_safe_address, participant_agent_eoa,
            executor_impl_name, executor_impl_version, executor_runtime_bundle_digest,
            executor_plugins_json, solution_envelope_cid, solution_envelope_sha256,
            solution_envelope_ref, metadata_json)
         VALUES
           (@envelopeId, @envelopeCid, @envelopeSha256, @signatureHash, @solverType, @role,
            @taskCid, @taskId, @requestId, @generatedAt, @evidenceTier,
            @participantSafeAddress, @participantAgentEoa,
            @executorImplName, @executorImplVersion, @executorRuntimeBundleDigest,
            @executorPluginsJson, @solutionEnvelopeCid, @solutionEnvelopeSha256,
            @solutionEnvelopeRef, @metadataJson)
         ON CONFLICT(envelope_id) DO UPDATE SET
           envelope_cid = excluded.envelope_cid,
           envelope_sha256 = excluded.envelope_sha256,
           signature_hash = excluded.signature_hash,
           solver_type = excluded.solver_type,
           role = excluded.role,
           task_cid = excluded.task_cid,
           task_id = excluded.task_id,
           request_id = excluded.request_id,
           generated_at = excluded.generated_at,
           evidence_tier = excluded.evidence_tier,
           participant_safe_address = excluded.participant_safe_address,
           participant_agent_eoa = excluded.participant_agent_eoa,
           executor_impl_name = excluded.executor_impl_name,
           executor_impl_version = excluded.executor_impl_version,
           executor_runtime_bundle_digest = excluded.executor_runtime_bundle_digest,
           executor_plugins_json = excluded.executor_plugins_json,
           solution_envelope_cid = excluded.solution_envelope_cid,
           solution_envelope_sha256 = excluded.solution_envelope_sha256,
           solution_envelope_ref = excluded.solution_envelope_ref,
           metadata_json = excluded.metadata_json`,
      ).run({
        envelopeId: p.envelopeId,
        envelopeCid: p.envelopeCid,
        envelopeSha256: p.envelopeSha256,
        signatureHash: p.signatureHash,
        solverType: p.solverType,
        role: normalizeEnvelopeRole(p.role),
        taskCid: p.taskCid,
        taskId: p.taskId,
        requestId: p.requestId,
        generatedAt: p.generatedAt,
        evidenceTier: p.evidenceTier,
        participantSafeAddress: p.participantSafeAddress,
        participantAgentEoa: p.participantAgentEoa,
        executorImplName: p.executorImplName,
        executorImplVersion: p.executorImplVersion,
        executorRuntimeBundleDigest: p.executorRuntimeBundleDigest,
        executorPluginsJson: JSON.stringify(p.executorPlugins),
        solutionEnvelopeCid: p.solutionEnvelopeCid,
        solutionEnvelopeSha256: p.solutionEnvelopeSha256,
        solutionEnvelopeRef: p.solutionEnvelopeRef,
        metadataJson: JSON.stringify(p.metadata),
      });

      this.db.prepare(`DELETE FROM envelope_projection_metadata WHERE envelope_id = ?`).run(p.envelopeId);
      const insertMetadata = this.db.prepare(
        `INSERT INTO envelope_projection_metadata (envelope_id, key, value_text, value_type)
         VALUES (@envelopeId, @key, @valueText, @valueType)`,
      );
      for (const [key, value] of Object.entries(p.metadata)) {
        insertMetadata.run({
          envelopeId: p.envelopeId,
          key,
          valueText: metadataValueText(value),
          valueType: typeof value,
        });
      }
    });
    tx(projection);
  }

  /**
   * Upgrade a previously-saved projection's evidence_tier in place (#1393
   * review finding 1). pack() saves projections as 'self-signed' regardless
   * of the envelope's own (aspirational) tier — a race-lost or failed
   * delivery must never leave a 'committed' projection outranking genuinely
   * delivered self-signed work. deliver() calls this to upgrade the tier
   * only once on-chain evidence actually exists (claimDelivery succeeded).
   * No-op if the envelope_id isn't found (defensive; never fatal to deliver()).
   */
  upgradeEnvelopeProjectionEvidenceTier(envelopeId: string, tier: EnvelopeProjection['evidenceTier']): void {
    this.db.prepare(
      `UPDATE envelope_projections SET evidence_tier = @tier WHERE envelope_id = @envelopeId`,
    ).run({ envelopeId, tier });
  }

  queryEnvelopeProjections(query: EnvelopeProjectionQuery = {}): EnvelopeProjection[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.envelopeRefs && query.envelopeRefs.length > 0) {
      const placeholders = query.envelopeRefs.map((ref, index) => {
        const key = `envelopeRef${index}`;
        params[key] = ref;
        return `@${key}`;
      }).join(', ');
      conditions.push(
        `(envelope_id IN (${placeholders})
          OR envelope_cid IN (${placeholders})
          OR envelope_sha256 IN (${placeholders})
          OR signature_hash IN (${placeholders}))`,
      );
    }
    if (query.solverType) {
      conditions.push('solver_type = @solverType');
      params['solverType'] = query.solverType;
    }
    if (query.role) {
      const role = normalizeEnvelopeRole(query.role) as Role;
      if (role === 'solution') {
        conditions.push('(role = @role OR role = @legacyRole)');
        params['legacyRole'] = 'restoration';
      } else {
        conditions.push('role = @role');
      }
      params['role'] = role;
    }
    if (query.taskCid) {
      conditions.push('task_cid = @taskCid');
      params['taskCid'] = query.taskCid;
    }
    if (query.taskId) {
      conditions.push('task_id = @taskId');
      params['taskId'] = query.taskId;
    }
    if (query.requestId) {
      conditions.push('request_id = @requestId');
      params['requestId'] = query.requestId;
    }
    if (query.participant?.safeAddress) {
      conditions.push('participant_safe_address = @participantSafeAddress');
      params['participantSafeAddress'] = query.participant.safeAddress;
    }
    if (query.participant?.agentEoa) {
      conditions.push('participant_agent_eoa = @participantAgentEoa');
      params['participantAgentEoa'] = query.participant.agentEoa;
    }
    if (query.solutionEnvelopeRef) {
      conditions.push('solution_envelope_ref = @solutionEnvelopeRef');
      params['solutionEnvelopeRef'] = query.solutionEnvelopeRef;
    }
    if (query.generatedAfter !== undefined) {
      conditions.push('generated_at >= @generatedAfter');
      params['generatedAfter'] = query.generatedAfter;
    }
    if (query.generatedBefore !== undefined) {
      conditions.push('generated_at <= @generatedBefore');
      params['generatedBefore'] = query.generatedBefore;
    }

    let metadataIndex = 0;
    for (const [key, value] of Object.entries(query.metadata ?? {})) {
      const keyParam = `metadataKey${metadataIndex}`;
      const valueParam = `metadataValue${metadataIndex}`;
      conditions.push(
        `EXISTS (
          SELECT 1 FROM envelope_projection_metadata m${metadataIndex}
          WHERE m${metadataIndex}.envelope_id = envelope_projections.envelope_id
            AND m${metadataIndex}.key = @${keyParam}
            AND m${metadataIndex}.value_text = @${valueParam}
        )`,
      );
      params[keyParam] = key;
      params[valueParam] = metadataValueText(value);
      metadataIndex += 1;
    }

    const limit = Math.max(0, Math.min(query.limit ?? 100, 1000));
    params['limit'] = limit;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT envelope_id, envelope_cid, envelope_sha256, signature_hash, solver_type, role,
              task_cid, task_id, request_id, generated_at, evidence_tier,
              participant_safe_address, participant_agent_eoa,
              executor_impl_name, executor_impl_version, executor_runtime_bundle_digest,
              executor_plugins_json, solution_envelope_cid, solution_envelope_sha256,
              solution_envelope_ref, metadata_json
       FROM envelope_projections
       ${where}
       ORDER BY generated_at DESC, envelope_id ASC
       LIMIT @limit`,
    ).all(params) as EnvelopeProjectionRow[];

    return rows.map(rowToEnvelopeProjection);
  }
}
