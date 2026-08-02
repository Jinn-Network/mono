import type { Store } from '../store/store.js';
import { documentDigest, serializeCanonicalJson } from '@jinn-network/task-execution-protocol';
import {
  claimOperationId,
  engagementId,
  type NativeOperationId,
} from './native-operation-identity.js';

export const NATIVE_OPERATOR_STATE_SCHEMA_VERSION = 1 as const;

export const NATIVE_OPERATOR_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS native_operator_state_metadata (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_engagements (
  engagement_id       TEXT PRIMARY KEY,
  chain_id            TEXT NOT NULL,
  coordinator         TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  role                TEXT NOT NULL,
  operator_agent      TEXT NOT NULL,
  task_digest         TEXT NOT NULL,
  submission_uri      TEXT NOT NULL,
  submission_digest   TEXT NOT NULL,
  state               TEXT NOT NULL,
  attempt_index       INTEGER,
  attempt_uri         TEXT,
  request_id          TEXT,
  policy_json         TEXT NOT NULL,
  capability_json     TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (chain_id, coordinator, task_id, role, operator_agent)
);
CREATE INDEX IF NOT EXISTS idx_native_engagements_state
  ON native_engagements (state, created_at);

CREATE TABLE IF NOT EXISTS native_operations (
  operation_id       TEXT PRIMARY KEY,
  engagement_id      TEXT NOT NULL REFERENCES native_engagements(engagement_id),
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  tx_hash            TEXT,
  prior_tx_hash      TEXT,
  block_hash         TEXT,
  block_number       TEXT,
  detail_json        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (engagement_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_native_operations_status
  ON native_operations (status, created_at);

CREATE TABLE IF NOT EXISTS native_publication_outbox (
  publication_key   TEXT PRIMARY KEY,
  engagement_id     TEXT NOT NULL REFERENCES native_engagements(engagement_id),
  source_id         TEXT NOT NULL,
  role              TEXT NOT NULL,
  record_digest     TEXT NOT NULL,
  availability      TEXT NOT NULL,
  status            TEXT NOT NULL,
  detail_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (source_id, role, record_digest, availability)
);

CREATE TABLE IF NOT EXISTS native_audit_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id    TEXT,
  operation_id     TEXT,
  kind             TEXT NOT NULL,
  detail_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_audit_engagement
  ON native_audit_events (engagement_id, id);

CREATE TABLE IF NOT EXISTS native_worker_leases (
  role             TEXT NOT NULL,
  chain_id         TEXT NOT NULL,
  coordinator      TEXT NOT NULL,
  operator_agent   TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  acquired_at      TEXT NOT NULL,
  renewed_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  PRIMARY KEY (role, chain_id, coordinator, operator_agent)
);

CREATE TABLE IF NOT EXISTS native_source_processing (
  source_agent      TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  sequence          TEXT NOT NULL,
  entry_digest      TEXT NOT NULL,
  announcement_id  TEXT NOT NULL,
  card_id           INTEGER NOT NULL UNIQUE,
  input_fingerprint TEXT NOT NULL,
  decision          TEXT NOT NULL,
  engagement_id     TEXT,
  processed_at      TEXT NOT NULL,
  PRIMARY KEY (source_agent, source_name, sequence, entry_digest, announcement_id)
);
`;

export class NativeOperatorStateConflictError extends Error {
  override readonly name = 'NativeOperatorStateConflictError';
}

export class NativeWorkerLeaseError extends Error {
  override readonly name = 'NativeWorkerLeaseError';
}

export type NativeEngagementState =
  | 'claim-pending'
  | 'claim-finalized'
  | 'eligible'
  | 'lost'
  | 'failed';

export type NativeOperationStatus =
  | 'intent'
  | 'broadcast'
  | 'observed-safe'
  | 'finalized'
  | 'replaced'
  | 'orphaned'
  | 'failed-terminal';

export interface NativeEngagementRow {
  readonly engagementId: NativeOperationId;
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: bigint;
  readonly role: 'solver';
  readonly operatorAgent: string;
  readonly taskDigest: `sha256:${string}`;
  readonly submissionUri: `urn:uuid:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly state: NativeEngagementState;
  readonly attemptIndex: number | null;
  readonly attemptUri: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeOperationRow {
  readonly operationId: NativeOperationId;
  readonly engagementId: NativeOperationId;
  readonly kind: string;
  readonly status: NativeOperationStatus;
  readonly txHash: string | null;
  readonly priorTxHash: string | null;
  readonly blockHash: string | null;
  readonly blockNumber: bigint | null;
  readonly detail: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeAuditEvent {
  readonly id: number;
  readonly engagementId: NativeOperationId | null;
  readonly operationId: NativeOperationId | null;
  readonly kind: string;
  readonly detail: string;
  readonly createdAt: string;
}

export interface NativeSourceProcessingInput {
  readonly cardId: number;
  readonly agent: string;
  readonly name: string;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly announcementId: string;
}

export type NativeAdmissionDecision =
  | {
      readonly ok: true;
      readonly capability: Readonly<Record<string, unknown>>;
      readonly policy: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly capability: Readonly<Record<string, unknown>>;
      readonly policy: Readonly<Record<string, unknown>>;
    };

export interface NativeAdmissionInput {
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: bigint;
  readonly operatorAgent: string;
  readonly taskDigest: `sha256:${string}`;
  readonly submissionUri: `urn:uuid:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly source: NativeSourceProcessingInput;
  readonly decision: NativeAdmissionDecision;
}

interface RawEngagement {
  engagement_id: NativeOperationId;
  chain_id: string;
  coordinator: string;
  task_id: string;
  role: 'solver';
  operator_agent: string;
  task_digest: `sha256:${string}`;
  submission_uri: `urn:uuid:${string}`;
  submission_digest: `sha256:${string}`;
  state: NativeEngagementState;
  attempt_index: number | null;
  attempt_uri: string | null;
  request_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RawOperation {
  operation_id: NativeOperationId;
  engagement_id: NativeOperationId;
  kind: string;
  status: NativeOperationStatus;
  tx_hash: string | null;
  prior_tx_hash: string | null;
  block_hash: string | null;
  block_number: string | null;
  detail_json: string;
  created_at: string;
  updated_at: string;
}

interface RawAudit {
  id: number;
  engagement_id: NativeOperationId | null;
  operation_id: NativeOperationId | null;
  kind: string;
  detail_json: string;
  created_at: string;
}

function engagementRow(row: RawEngagement): NativeEngagementRow {
  return {
    engagementId: row.engagement_id,
    chainId: Number(row.chain_id),
    coordinator: row.coordinator,
    taskId: BigInt(row.task_id),
    role: row.role,
    operatorAgent: row.operator_agent,
    taskDigest: row.task_digest,
    submissionUri: row.submission_uri,
    submissionDigest: row.submission_digest,
    state: row.state,
    attemptIndex: row.attempt_index,
    attemptUri: row.attempt_uri,
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function operationRow(row: RawOperation): NativeOperationRow {
  return {
    operationId: row.operation_id,
    engagementId: row.engagement_id,
    kind: row.kind,
    status: row.status,
    txHash: row.tx_hash,
    priorTxHash: row.prior_tx_hash,
    blockHash: row.block_hash,
    blockNumber: row.block_number === null ? null : BigInt(row.block_number),
    detail: JSON.parse(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditRow(row: RawAudit): NativeAuditEvent {
  return {
    id: row.id,
    engagementId: row.engagement_id,
    operationId: row.operation_id,
    kind: row.kind,
    detail: row.detail_json,
    createdAt: row.created_at,
  };
}

function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new TypeError('coordinator must be an EVM address');
  return value.toLowerCase();
}

function requireTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('lease ttlMs must be a positive safe integer');
  return ttlMs;
}

export class NativeOperatorStateRepository {
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    input: { readonly now?: () => Date } = {},
  ) {
    this.now = input.now ?? (() => new Date());
    this.store.db.exec(NATIVE_OPERATOR_STATE_SCHEMA);
    const createdAt = this.timestamp();
    this.store.db.prepare(
      `INSERT OR IGNORE INTO native_operator_state_metadata (singleton, schema_version, created_at)
       VALUES (1, ?, ?)`,
    ).run(NATIVE_OPERATOR_STATE_SCHEMA_VERSION, createdAt);
    const version = this.schemaVersion();
    if (version !== NATIVE_OPERATOR_STATE_SCHEMA_VERSION) {
      throw new Error(`unsupported native operator state schema version ${version}`);
    }
  }

  private timestamp(): string {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error('native operator clock returned an invalid time');
    return now.toISOString();
  }

  schemaVersion(): number {
    const row = this.store.db.prepare(
      `SELECT schema_version FROM native_operator_state_metadata WHERE singleton = 1`,
    ).get() as { schema_version: number };
    return row.schema_version;
  }

  recordDecision(input: NativeAdmissionInput):
    | { readonly kind: 'admitted'; readonly engagementId: NativeOperationId; readonly claimOperationId: NativeOperationId }
    | { readonly kind: 'duplicate'; readonly engagementId: NativeOperationId; readonly claimOperationId: NativeOperationId }
    | { readonly kind: 'refused'; readonly reason: string } {
    const coordinator = canonicalAddress(input.coordinator);
    const engagement = engagementId(input);
    const claim = claimOperationId(engagement);
    const now = this.timestamp();
    const fingerprint = documentDigest(serializeCanonicalJson({
      engagementId: engagement,
      taskDigest: input.taskDigest,
      submissionUri: input.submissionUri,
      submissionDigest: input.submissionDigest,
    }));

    const outcome = this.store.db.transaction(() => {
      const queued = this.store.db.prepare(
        `SELECT source_agent, source_name, sequence, entry_digest, announcement_id
           FROM native_discovery_cards WHERE id = ?`,
      ).get(input.source.cardId) as {
        source_agent: string;
        source_name: string;
        sequence: string;
        entry_digest: string;
        announcement_id: string;
      } | undefined;
      const expected = [
        input.source.agent,
        input.source.name,
        input.source.sequence,
        input.source.entryDigest,
        input.source.announcementId,
      ];
      if (queued === undefined || [
        queued.source_agent,
        queued.source_name,
        queued.sequence,
        queued.entry_digest,
        queued.announcement_id,
      ].some((value, index) => value !== expected[index])) {
        throw new NativeOperatorStateConflictError('queued discovery card provenance does not match admission input');
      }

      const processed = this.store.db.prepare(
        `SELECT decision, engagement_id, input_fingerprint
           FROM native_source_processing WHERE card_id = ?`,
      ).get(input.source.cardId) as {
        decision: string;
        engagement_id: NativeOperationId | null;
        input_fingerprint: string;
      } | undefined;
      if (processed !== undefined) {
        if (processed.engagement_id === engagement && processed.input_fingerprint === fingerprint) {
          return { kind: 'duplicate' as const, engagementId: engagement, claimOperationId: claim };
        }
        throw new NativeOperatorStateConflictError('discovery card was already processed with different sealed inputs');
      }

      if (!input.decision.ok) {
        this.insertSourceProcessing(input.source, fingerprint, `refused:${input.decision.reason}`, null, now);
        this.insertAudit(null, null, 'admission-refused', input.decision, now);
        this.acknowledge(input.source.cardId, now);
        return { kind: 'refused' as const, reason: input.decision.reason };
      }

      const existing = this.store.db.prepare(
        `SELECT * FROM native_engagements WHERE engagement_id = ?`,
      ).get(engagement) as RawEngagement | undefined;
      if (existing !== undefined) {
        const sameInputs = existing.task_digest === input.taskDigest
          && existing.submission_digest === input.submissionDigest
          && existing.submission_uri === input.submissionUri;
        if (!sameInputs) {
          this.insertSourceProcessing(input.source, fingerprint, 'refused:sealed-input-conflict', engagement, now);
          this.insertAudit(engagement, claim, 'sealed-input-conflict', {
            expected: {
              taskDigest: existing.task_digest,
              submissionDigest: existing.submission_digest,
              submissionUri: existing.submission_uri,
            },
            received: {
              taskDigest: input.taskDigest,
              submissionDigest: input.submissionDigest,
              submissionUri: input.submissionUri,
            },
          }, now);
          this.acknowledge(input.source.cardId, now);
          return { kind: 'conflict' as const };
        }
        this.insertSourceProcessing(input.source, fingerprint, 'duplicate', engagement, now);
        this.insertAudit(engagement, claim, 'discovery-duplicate', input.source, now);
        this.acknowledge(input.source.cardId, now);
        return { kind: 'duplicate' as const, engagementId: engagement, claimOperationId: claim };
      }

      this.store.db.prepare(
        `INSERT INTO native_engagements
          (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
           submission_uri, submission_digest, state, policy_json, capability_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'solver', ?, ?, ?, ?, 'claim-pending', ?, ?, ?, ?)`,
      ).run(
        engagement,
        String(input.chainId),
        coordinator,
        input.taskId.toString(10),
        input.operatorAgent,
        input.taskDigest,
        input.submissionUri,
        input.submissionDigest,
        JSON.stringify(input.decision.policy),
        JSON.stringify(input.decision.capability),
        now,
        now,
      );
      this.store.db.prepare(
        `INSERT INTO native_operations
          (operation_id, engagement_id, kind, status, detail_json, created_at, updated_at)
         VALUES (?, ?, 'claim', 'intent', '{}', ?, ?)`,
      ).run(claim, engagement, now, now);
      this.insertSourceProcessing(input.source, fingerprint, 'admitted', engagement, now);
      this.insertAudit(engagement, claim, 'claim-intent', { source: input.source }, now);
      this.acknowledge(input.source.cardId, now);
      return { kind: 'admitted' as const, engagementId: engagement, claimOperationId: claim };
    })();
    if (outcome.kind === 'conflict') {
      throw new NativeOperatorStateConflictError('stable engagement identity was reused with different sealed inputs');
    }
    return outcome;
  }

  private insertSourceProcessing(
    source: NativeSourceProcessingInput,
    inputFingerprint: `sha256:${string}`,
    decision: string,
    engagement: NativeOperationId | null,
    now: string,
  ): void {
    this.store.db.prepare(
      `INSERT INTO native_source_processing
        (source_agent, source_name, sequence, entry_digest, announcement_id, card_id, input_fingerprint,
         decision, engagement_id, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      source.agent,
      source.name,
      source.sequence,
      source.entryDigest,
      source.announcementId,
      source.cardId,
      inputFingerprint,
      decision,
      engagement,
      now,
    );
  }

  private acknowledge(cardId: number, now: string): void {
    const changed = this.store.db.prepare(
      `UPDATE native_discovery_cards SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
    ).run(now, cardId).changes;
    if (changed !== 1) {
      throw new NativeOperatorStateConflictError('native discovery card was already acknowledged outside atomic admission');
    }
  }

  private insertAudit(
    engagement: NativeOperationId | null,
    operation: NativeOperationId | null,
    kind: string,
    detail: unknown,
    now: string,
  ): void {
    this.store.db.prepare(
      `INSERT INTO native_audit_events
        (engagement_id, operation_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(engagement, operation, kind, JSON.stringify(detail), now);
  }

  getEngagement(id: NativeOperationId): NativeEngagementRow | undefined {
    const row = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
      .get(id) as RawEngagement | undefined;
    return row === undefined ? undefined : engagementRow(row);
  }

  listEngagements(): NativeEngagementRow[] {
    return (this.store.db.prepare(`SELECT * FROM native_engagements ORDER BY created_at, engagement_id`)
      .all() as RawEngagement[]).map(engagementRow);
  }

  getOperation(id: NativeOperationId): NativeOperationRow | undefined {
    const row = this.store.db.prepare(`SELECT * FROM native_operations WHERE operation_id = ?`)
      .get(id) as RawOperation | undefined;
    return row === undefined ? undefined : operationRow(row);
  }

  listOperations(engagement?: NativeOperationId): NativeOperationRow[] {
    const rows = engagement === undefined
      ? this.store.db.prepare(`SELECT * FROM native_operations ORDER BY created_at, operation_id`).all()
      : this.store.db.prepare(
        `SELECT * FROM native_operations WHERE engagement_id = ? ORDER BY created_at, operation_id`,
      ).all(engagement);
    return (rows as RawOperation[]).map(operationRow);
  }

  listAuditEvents(engagement?: NativeOperationId): NativeAuditEvent[] {
    const rows = engagement === undefined
      ? this.store.db.prepare(`SELECT * FROM native_audit_events ORDER BY id`).all()
      : this.store.db.prepare(
        `SELECT * FROM native_audit_events WHERE engagement_id = ? ORDER BY id`,
      ).all(engagement);
    return (rows as RawAudit[]).map(auditRow);
  }

  acquireLease(input: {
    readonly role: string;
    readonly chainId: number;
    readonly coordinator: string;
    readonly operatorAgent: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  }): { readonly ownerId: string; readonly expiresAt: string } {
    const ttlMs = requireTtl(input.ttlMs);
    const now = this.timestamp();
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const coordinator = canonicalAddress(input.coordinator);
    return this.store.db.transaction(() => {
      const current = this.store.db.prepare(
        `SELECT owner_id, expires_at FROM native_worker_leases
          WHERE role = ? AND chain_id = ? AND coordinator = ? AND operator_agent = ?`,
      ).get(input.role, String(input.chainId), coordinator, input.operatorAgent) as {
        owner_id: string;
        expires_at: string;
      } | undefined;
      if (current !== undefined && Date.parse(current.expires_at) > Date.parse(now) && current.owner_id !== input.ownerId) {
        throw new NativeWorkerLeaseError(`native worker lease is already held by ${current.owner_id}`);
      }
      this.store.db.prepare(
        `INSERT INTO native_worker_leases
          (role, chain_id, coordinator, operator_agent, owner_id, acquired_at, renewed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(role, chain_id, coordinator, operator_agent) DO UPDATE SET
           owner_id = excluded.owner_id,
           acquired_at = excluded.acquired_at,
           renewed_at = excluded.renewed_at,
           expires_at = excluded.expires_at`,
      ).run(
        input.role,
        String(input.chainId),
        coordinator,
        input.operatorAgent,
        input.ownerId,
        now,
        now,
        expiresAt,
      );
      return { ownerId: input.ownerId, expiresAt };
    })();
  }

  renewLease(input: {
    readonly role: string;
    readonly chainId: number;
    readonly coordinator: string;
    readonly operatorAgent: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  }): { readonly ownerId: string; readonly expiresAt: string } {
    const ttlMs = requireTtl(input.ttlMs);
    const now = this.timestamp();
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const changed = this.store.db.prepare(
      `UPDATE native_worker_leases SET renewed_at = ?, expires_at = ?
        WHERE role = ? AND chain_id = ? AND coordinator = ? AND operator_agent = ?
          AND owner_id = ? AND expires_at > ?`,
    ).run(
      now,
      expiresAt,
      input.role,
      String(input.chainId),
      canonicalAddress(input.coordinator),
      input.operatorAgent,
      input.ownerId,
      now,
    ).changes;
    if (changed !== 1) throw new NativeWorkerLeaseError('native worker lease is expired or not owned by this worker');
    return { ownerId: input.ownerId, expiresAt };
  }
}
