import type { Store } from '../store/store.js';
import { documentDigest, serializeCanonicalJson } from '@jinn-network/task-execution-protocol';
import {
  backendSubmissionOperationId,
  claimOperationId,
  engagementId,
  publicationKey,
  solutionSettlementId,
  type NativeOperationId,
} from './native-operation-identity.js';
import { deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';

export const NATIVE_OPERATOR_STATE_SCHEMA_VERSION = 3 as const;

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

CREATE TABLE IF NOT EXISTS native_source_deferrals (
  source_agent      TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  sequence          TEXT NOT NULL,
  entry_digest      TEXT NOT NULL,
  announcement_id  TEXT NOT NULL,
  card_id           INTEGER NOT NULL UNIQUE,
  input_fingerprint TEXT NOT NULL,
  reason            TEXT NOT NULL,
  detail_json       TEXT NOT NULL,
  retry_count       INTEGER NOT NULL,
  first_deferred_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (source_agent, source_name, sequence, entry_digest, announcement_id)
);

CREATE TABLE IF NOT EXISTS native_solution_executions (
  engagement_id           TEXT PRIMARY KEY REFERENCES native_engagements(engagement_id),
  operation_id            TEXT NOT NULL UNIQUE REFERENCES native_operations(operation_id),
  attempt_uri             TEXT NOT NULL,
  task_digest             TEXT NOT NULL,
  submission_digest       TEXT NOT NULL,
  dispatch_context_digest TEXT NOT NULL,
  task_bytes              BLOB NOT NULL,
  submission_bytes        BLOB NOT NULL,
  dispatch_context_bytes  BLOB NOT NULL,
  status                  TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_solution_artifacts (
  engagement_id   TEXT NOT NULL REFERENCES native_engagements(engagement_id),
  role            TEXT NOT NULL,
  family          TEXT NOT NULL,
  name            TEXT NOT NULL,
  record_digest   TEXT NOT NULL,
  exact_bytes     BLOB NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (engagement_id, role, name, record_digest)
);
CREATE INDEX IF NOT EXISTS idx_native_solution_artifacts_digest
  ON native_solution_artifacts (record_digest);
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
  | 'executing'
  | 'solution-ready'
  | 'solution-published'
  | 'solution-settlement-pending'
  | 'solution-settled'
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

export type NativeSolutionArtifactRole =
  | 'output'
  | 'evidence'
  | 'delivery'
  | 'delivery-envelope';

export interface NativeSolutionExecutionRow {
  readonly engagementId: NativeOperationId;
  readonly operationId: NativeOperationId;
  readonly attemptUri: string;
  readonly taskDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly dispatchContextDigest: `sha256:${string}`;
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly status: 'intent' | 'accepted';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeSolutionArtifactInput {
  readonly role: NativeSolutionArtifactRole;
  readonly family: string;
  readonly name?: string;
  readonly digest: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

export interface NativeSolutionArtifactRow extends Omit<NativeSolutionArtifactInput, 'name'> {
  readonly engagementId: NativeOperationId;
  readonly name: string | null;
  readonly createdAt: string;
}

export interface NativePublicationRow {
  readonly publicationKey: NativeOperationId;
  readonly engagementId: NativeOperationId;
  readonly sourceId: string;
  readonly role: NativeSolutionArtifactRole;
  readonly recordDigest: `sha256:${string}`;
  readonly availability: string;
  readonly status: 'intent' | 'published';
  readonly detail: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface NativeDeferralInput extends Omit<NativeAdmissionInput, 'decision'> {
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface NativeClaimObservation {
  readonly txHash: `0x${string}`;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly attemptIndex: number;
  readonly requestId?: `0x${string}`;
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

interface RawSolutionExecution {
  engagement_id: NativeOperationId;
  operation_id: NativeOperationId;
  attempt_uri: string;
  task_digest: `sha256:${string}`;
  submission_digest: `sha256:${string}`;
  dispatch_context_digest: `sha256:${string}`;
  task_bytes: Uint8Array;
  submission_bytes: Uint8Array;
  dispatch_context_bytes: Uint8Array;
  status: 'intent' | 'accepted';
  created_at: string;
  updated_at: string;
}

interface RawSolutionArtifact {
  engagement_id: NativeOperationId;
  role: NativeSolutionArtifactRole;
  family: string;
  name: string;
  record_digest: `sha256:${string}`;
  exact_bytes: Uint8Array;
  created_at: string;
}

interface RawPublication {
  publication_key: NativeOperationId;
  engagement_id: NativeOperationId;
  source_id: string;
  role: NativeSolutionArtifactRole;
  record_digest: `sha256:${string}`;
  availability: string;
  status: 'intent' | 'published';
  detail_json: string;
  created_at: string;
  updated_at: string;
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

function exactBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function solutionExecutionRow(row: RawSolutionExecution): NativeSolutionExecutionRow {
  return {
    engagementId: row.engagement_id,
    operationId: row.operation_id,
    attemptUri: row.attempt_uri,
    taskDigest: row.task_digest,
    submissionDigest: row.submission_digest,
    dispatchContextDigest: row.dispatch_context_digest,
    taskBytes: exactBytes(row.task_bytes),
    submissionBytes: exactBytes(row.submission_bytes),
    dispatchContextBytes: exactBytes(row.dispatch_context_bytes),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function solutionArtifactRow(row: RawSolutionArtifact): NativeSolutionArtifactRow {
  return {
    engagementId: row.engagement_id,
    role: row.role,
    family: row.family,
    name: row.name === '' ? null : row.name,
    digest: row.record_digest,
    bytes: exactBytes(row.exact_bytes),
    createdAt: row.created_at,
  };
}

function publicationRow(row: RawPublication): NativePublicationRow {
  return {
    publicationKey: row.publication_key,
    engagementId: row.engagement_id,
    sourceId: row.source_id,
    role: row.role,
    recordDigest: row.record_digest,
    availability: row.availability,
    status: row.status,
    detail: JSON.parse(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function inputFingerprint(input: Pick<NativeAdmissionInput, 'chainId' | 'coordinator' | 'taskId' | 'operatorAgent' | 'taskDigest' | 'submissionUri' | 'submissionDigest'>): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson({
    engagementId: engagementId(input),
    taskDigest: input.taskDigest,
    submissionUri: input.submissionUri,
    submissionDigest: input.submissionDigest,
  }));
}

function requireHash(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new TypeError(`${label} must be a 32-byte hex value`);
  return value as `0x${string}`;
}

function requireAttemptIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('attemptIndex must be a non-negative safe integer');
  return value;
}

function detailJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString(10) : item);
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
    if (version === 1 || version === 2) {
      this.store.db.prepare(
        `UPDATE native_operator_state_metadata SET schema_version = ? WHERE singleton = 1 AND schema_version = ?`,
      ).run(NATIVE_OPERATOR_STATE_SCHEMA_VERSION, version);
    } else if (version !== NATIVE_OPERATOR_STATE_SCHEMA_VERSION) {
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
    const fingerprint = inputFingerprint(input);

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

      this.store.db.prepare(`DELETE FROM native_source_deferrals WHERE card_id = ?`).run(input.source.cardId);

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

  recordDeferral(input: NativeDeferralInput): void {
    if (input.reason.length === 0) throw new TypeError('deferral reason must not be empty');
    const fingerprint = inputFingerprint(input);
    const now = this.timestamp();
    this.store.db.transaction(() => {
      this.verifyQueuedSource(input.source, true);
      const existing = this.store.db.prepare(
        `SELECT input_fingerprint FROM native_source_deferrals WHERE card_id = ?`,
      ).get(input.source.cardId) as { input_fingerprint: string } | undefined;
      if (existing !== undefined && existing.input_fingerprint !== fingerprint) {
        throw new NativeOperatorStateConflictError('deferred discovery card was retried with different sealed inputs');
      }
      this.store.db.prepare(
        `INSERT INTO native_source_deferrals
          (source_agent, source_name, sequence, entry_digest, announcement_id, card_id, input_fingerprint,
           reason, detail_json, retry_count, first_deferred_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET
           reason = excluded.reason,
           detail_json = excluded.detail_json,
           retry_count = native_source_deferrals.retry_count + 1,
           updated_at = excluded.updated_at`,
      ).run(
        input.source.agent,
        input.source.name,
        input.source.sequence,
        input.source.entryDigest,
        input.source.announcementId,
        input.source.cardId,
        fingerprint,
        input.reason,
        detailJson(input.detail),
        now,
        now,
      );
      this.insertAudit(null, null, 'admission-deferred', { reason: input.reason, ...input.detail }, now);
    })();
  }

  private verifyQueuedSource(source: NativeSourceProcessingInput, requireUnacknowledged: boolean): void {
    const queued = this.store.db.prepare(
      `SELECT source_agent, source_name, sequence, entry_digest, announcement_id, acknowledged_at
         FROM native_discovery_cards WHERE id = ?`,
    ).get(source.cardId) as {
      source_agent: string;
      source_name: string;
      sequence: string;
      entry_digest: string;
      announcement_id: string;
      acknowledged_at: string | null;
    } | undefined;
    if (
      queued === undefined
      || queued.source_agent !== source.agent
      || queued.source_name !== source.name
      || queued.sequence !== source.sequence
      || queued.entry_digest !== source.entryDigest
      || queued.announcement_id !== source.announcementId
      || (requireUnacknowledged && queued.acknowledged_at !== null)
    ) throw new NativeOperatorStateConflictError('queued discovery card provenance does not match admission input');
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
    ).run(engagement, operation, kind, detailJson(detail), now);
  }

  private requireClaimOperation(id: NativeOperationId): { readonly operation: RawOperation; readonly engagement: RawEngagement } {
    const operation = this.store.db.prepare(`SELECT * FROM native_operations WHERE operation_id = ?`)
      .get(id) as RawOperation | undefined;
    if (operation === undefined || operation.kind !== 'claim') {
      throw new NativeOperatorStateConflictError(`unknown native claim operation ${id}`);
    }
    const engagement = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
      .get(operation.engagement_id) as RawEngagement | undefined;
    if (engagement === undefined) throw new NativeOperatorStateConflictError('claim operation has no engagement');
    return { operation, engagement };
  }

  recordClaimBroadcast(
    id: NativeOperationId,
    txHash?: `0x${string}`,
    detail: Readonly<Record<string, unknown>> = {},
  ): void {
    const hash = txHash === undefined ? null : requireHash(txHash, 'transaction hash');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireClaimOperation(id);
      if (!['intent', 'broadcast'].includes(operation.status)) {
        throw new NativeOperatorStateConflictError(`cannot broadcast claim from ${operation.status}`);
      }
      if (operation.tx_hash !== null && hash !== null && operation.tx_hash !== hash) {
        throw new NativeOperatorStateConflictError('changed transaction hash requires an explicit replacement');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'broadcast', tx_hash = COALESCE(?, tx_hash), detail_json = ?, updated_at = ?
          WHERE operation_id = ?`,
      ).run(hash, detailJson(detail), now, id);
      this.insertAudit(operation.engagement_id, id, hash === null ? 'claim-broadcast-uncertain' : 'claim-broadcast', {
        ...detail,
        ...(hash === null ? {} : { txHash: hash }),
      }, now);
    })();
  }

  recordClaimReplacement(id: NativeOperationId, priorTxHash: `0x${string}`, txHash: `0x${string}`): void {
    const prior = requireHash(priorTxHash, 'prior transaction hash');
    const replacement = requireHash(txHash, 'replacement transaction hash');
    if (prior === replacement) throw new NativeOperatorStateConflictError('replacement transaction must have a new hash');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireClaimOperation(id);
      if (!['broadcast', 'replaced'].includes(operation.status) || operation.tx_hash !== prior) {
        throw new NativeOperatorStateConflictError('replacement does not extend the current claim transaction');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'replaced', prior_tx_hash = ?, tx_hash = ?, detail_json = ?, updated_at = ?
          WHERE operation_id = ?`,
      ).run(prior, replacement, detailJson({ priorTxHash: prior, txHash: replacement }), now, id);
      this.insertAudit(operation.engagement_id, id, 'claim-transaction-replaced', { priorTxHash: prior, txHash: replacement }, now);
    })();
  }

  private validateClaimObservation(
    operation: RawOperation,
    engagement: RawEngagement,
    observation: NativeClaimObservation,
  ): { readonly txHash: `0x${string}`; readonly blockHash: `0x${string}`; readonly attemptUri: string } {
    const txHash = requireHash(observation.txHash, 'transaction hash');
    const blockHash = requireHash(observation.blockHash, 'block hash');
    if (observation.blockNumber < 0n) throw new RangeError('blockNumber must not be negative');
    const attemptIndex = requireAttemptIndex(observation.attemptIndex);
    if (operation.tx_hash !== null && operation.tx_hash !== txHash) {
      throw new NativeOperatorStateConflictError('canonical observation names a different transaction');
    }
    if (operation.block_hash !== null && operation.block_hash !== blockHash) {
      throw new NativeOperatorStateConflictError('canonical observation changed block hash without an orphan transition');
    }
    if (operation.block_number !== null && operation.block_number !== observation.blockNumber.toString(10)) {
      throw new NativeOperatorStateConflictError('canonical observation changed block number without an orphan transition');
    }
    if (engagement.attempt_index !== null && engagement.attempt_index !== attemptIndex) {
      throw new NativeOperatorStateConflictError('canonical observation changed attempt identity');
    }
    if (engagement.request_id !== null && engagement.request_id !== (observation.requestId ?? null)) {
      throw new NativeOperatorStateConflictError('canonical observation changed request identity');
    }
    const attemptUri = deriveMarketplaceAttemptUri({
      chainId: Number(engagement.chain_id),
      coordinator: engagement.coordinator as `0x${string}`,
      taskId: BigInt(engagement.task_id),
      attemptIndex,
    });
    if (engagement.attempt_uri !== null && engagement.attempt_uri !== attemptUri) {
      throw new NativeOperatorStateConflictError('canonical observation changed derived Attempt URI');
    }
    return { txHash, blockHash, attemptUri };
  }

  private recordClaimCanonical(
    id: NativeOperationId,
    observation: NativeClaimObservation,
    finalized: boolean,
  ): void {
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation, engagement } = this.requireClaimOperation(id);
      const allowed = finalized
        ? ['intent', 'broadcast', 'replaced', 'observed-safe', 'finalized']
        : ['broadcast', 'replaced', 'observed-safe'];
      if (!allowed.includes(operation.status)) {
        throw new NativeOperatorStateConflictError(`cannot record ${finalized ? 'finalized' : 'safe'} claim from ${operation.status}`);
      }
      const canonical = this.validateClaimObservation(operation, engagement, observation);
      const status = finalized ? 'finalized' : 'observed-safe';
      this.store.db.prepare(
        `UPDATE native_operations SET status = ?, tx_hash = ?, block_hash = ?, block_number = ?,
           detail_json = ?, updated_at = ? WHERE operation_id = ?`,
      ).run(
        status,
        canonical.txHash,
        canonical.blockHash,
        observation.blockNumber.toString(10),
        detailJson(observation),
        now,
        id,
      );
      this.store.db.prepare(
        `UPDATE native_engagements SET state = ?, attempt_index = ?, attempt_uri = ?, request_id = ?, updated_at = ?
          WHERE engagement_id = ?`,
      ).run(
        finalized ? 'claim-finalized' : 'claim-pending',
        observation.attemptIndex,
        canonical.attemptUri,
        observation.requestId ?? null,
        now,
        engagement.engagement_id,
      );
      this.insertAudit(
        engagement.engagement_id,
        id,
        finalized ? 'claim-finalized' : 'claim-observed-safe',
        { ...observation, attemptUri: canonical.attemptUri },
        now,
      );
    })();
  }

  recordClaimObservedSafe(id: NativeOperationId, observation: NativeClaimObservation): void {
    this.recordClaimCanonical(id, observation, false);
  }

  recordClaimFinalized(id: NativeOperationId, observation: NativeClaimObservation): void {
    this.recordClaimCanonical(id, observation, true);
  }

  recordClaimOrphaned(
    id: NativeOperationId,
    input: { readonly txHash: `0x${string}`; readonly reason: string },
  ): void {
    const txHash = requireHash(input.txHash, 'orphaned transaction hash');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireClaimOperation(id);
      if (operation.status === 'finalized' || operation.status === 'failed-terminal') {
        throw new NativeOperatorStateConflictError(`cannot orphan claim from ${operation.status}`);
      }
      if (operation.tx_hash !== null && operation.tx_hash !== txHash) {
        throw new NativeOperatorStateConflictError('orphan notice names a different transaction');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'orphaned', tx_hash = ?, detail_json = ?, updated_at = ?
          WHERE operation_id = ?`,
      ).run(txHash, detailJson(input), now, id);
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'eligible', attempt_index = NULL, attempt_uri = NULL,
          request_id = NULL, updated_at = ? WHERE engagement_id = ?`,
      ).run(now, operation.engagement_id);
      this.insertAudit(operation.engagement_id, id, 'claim-orphaned', input, now);
    })();
  }

  prepareClaimRetry(id: NativeOperationId): void {
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireClaimOperation(id);
      if (operation.status !== 'orphaned') throw new NativeOperatorStateConflictError('only an orphaned claim can be retried');
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'intent', tx_hash = NULL, prior_tx_hash = NULL,
          block_hash = NULL, block_number = NULL, detail_json = '{}', updated_at = ? WHERE operation_id = ?`,
      ).run(now, id);
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'claim-pending', updated_at = ? WHERE engagement_id = ?`,
      ).run(now, operation.engagement_id);
      this.insertAudit(operation.engagement_id, id, 'claim-retry-intent', {}, now);
    })();
  }

  recordClaimAbsent(id: NativeOperationId, input: { readonly checkedAtBlock: bigint }): void {
    if (input.checkedAtBlock < 0n) throw new RangeError('checkedAtBlock must not be negative');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireClaimOperation(id);
      if (!['intent', 'broadcast', 'replaced'].includes(operation.status)) {
        throw new NativeOperatorStateConflictError(`chain absence contradicts ${operation.status} claim state`);
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'intent', tx_hash = NULL, prior_tx_hash = NULL,
          block_hash = NULL, block_number = NULL, detail_json = ?, updated_at = ? WHERE operation_id = ?`,
      ).run(detailJson(input), now, id);
      this.insertAudit(operation.engagement_id, id, 'claim-absence-confirmed', input, now);
    })();
  }

  recordClaimLost(id: NativeOperationId, input: { readonly reason: string }): void {
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireClaimOperation(id);
      if (operation.status === 'finalized') throw new NativeOperatorStateConflictError('a finalized claim cannot become lost');
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'failed-terminal', detail_json = ?, updated_at = ? WHERE operation_id = ?`,
      ).run(detailJson(input), now, id);
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'lost', attempt_index = NULL, attempt_uri = NULL,
          request_id = NULL, updated_at = ? WHERE engagement_id = ?`,
      ).run(now, operation.engagement_id);
      this.insertAudit(operation.engagement_id, id, 'claim-lost', input, now);
    })();
  }

  listNonterminalClaimOperations(): NativeOperationRow[] {
    return (this.store.db.prepare(
      `SELECT * FROM native_operations
        WHERE kind = 'claim' AND status NOT IN ('finalized', 'failed-terminal')
        ORDER BY created_at, operation_id`,
    ).all() as RawOperation[]).map(operationRow);
  }

  beginSolutionExecution(
    engagementIdValue: NativeOperationId,
    input: {
      readonly taskBytes: Uint8Array;
      readonly submissionBytes: Uint8Array;
      readonly dispatchContextBytes: Uint8Array;
    },
  ): { readonly kind: 'created' | 'matching'; readonly operationId: NativeOperationId } {
    const now = this.timestamp();
    const engagement = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
      .get(engagementIdValue) as RawEngagement | undefined;
    if (engagement === undefined) throw new NativeOperatorStateConflictError(`unknown native engagement ${engagementIdValue}`);
    if (engagement.attempt_uri === null) {
      throw new NativeOperatorStateConflictError('solution execution requires a finalized marketplace Attempt');
    }
    const taskDigest = documentDigest(input.taskBytes);
    const submissionDigest = documentDigest(input.submissionBytes);
    if (taskDigest !== engagement.task_digest || submissionDigest !== engagement.submission_digest) {
      throw new NativeOperatorStateConflictError('solution execution bytes do not match the admitted Task and Submission digests');
    }
    let dispatch: unknown;
    try {
      dispatch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.dispatchContextBytes));
    } catch {
      throw new NativeOperatorStateConflictError('dispatch context is not valid UTF-8 JSON');
    }
    if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch)) {
      throw new NativeOperatorStateConflictError('dispatch context must be a JSON object');
    }
    const canonicalDispatch = serializeCanonicalJson(dispatch as Parameters<typeof serializeCanonicalJson>[0]);
    if (!bytesEqual(canonicalDispatch, input.dispatchContextBytes)) {
      throw new NativeOperatorStateConflictError('dispatch context bytes are not the exact canonical seal');
    }
    const fields = dispatch as Record<string, unknown>;
    if (
      fields.taskDigest !== engagement.task_digest
      || fields.submission !== engagement.submission_uri
      || fields.attempt !== engagement.attempt_uri
      || typeof fields.nonce !== 'string'
      || fields.nonce.length === 0
    ) {
      throw new NativeOperatorStateConflictError('dispatch context does not bind the finalized claim inputs');
    }
    const dispatchContextDigest = documentDigest(input.dispatchContextBytes);
    const operationId = backendSubmissionOperationId({
      engagementId: engagementIdValue,
      attempt: engagement.attempt_uri,
    });

    return this.store.db.transaction(() => {
      const existing = this.store.db.prepare(
        `SELECT * FROM native_solution_executions WHERE engagement_id = ?`,
      ).get(engagementIdValue) as RawSolutionExecution | undefined;
      if (existing !== undefined) {
        if (
          existing.operation_id !== operationId
          || existing.attempt_uri !== engagement.attempt_uri
          || existing.task_digest !== taskDigest
          || existing.submission_digest !== submissionDigest
          || existing.dispatch_context_digest !== dispatchContextDigest
          || !bytesEqual(existing.task_bytes, input.taskBytes)
          || !bytesEqual(existing.submission_bytes, input.submissionBytes)
          || !bytesEqual(existing.dispatch_context_bytes, input.dispatchContextBytes)
        ) {
          throw new NativeOperatorStateConflictError('solution execution intent already carries different exact bytes');
        }
        return { kind: 'matching' as const, operationId };
      }
      if (engagement.state !== 'claim-finalized') {
        throw new NativeOperatorStateConflictError(`cannot begin solution execution from ${engagement.state}`);
      }
      this.store.db.prepare(
        `INSERT INTO native_operations
          (operation_id, engagement_id, kind, status, detail_json, created_at, updated_at)
         VALUES (?, ?, 'backend-submit', 'intent', ?, ?, ?)`,
      ).run(operationId, engagementIdValue, detailJson({ attempt: engagement.attempt_uri }), now, now);
      this.store.db.prepare(
        `INSERT INTO native_solution_executions
          (engagement_id, operation_id, attempt_uri, task_digest, submission_digest,
           dispatch_context_digest, task_bytes, submission_bytes, dispatch_context_bytes,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
      ).run(
        engagementIdValue,
        operationId,
        engagement.attempt_uri,
        taskDigest,
        submissionDigest,
        dispatchContextDigest,
        Buffer.from(input.taskBytes),
        Buffer.from(input.submissionBytes),
        Buffer.from(input.dispatchContextBytes),
        now,
        now,
      );
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'executing', updated_at = ? WHERE engagement_id = ?`,
      ).run(now, engagementIdValue);
      this.insertAudit(engagementIdValue, operationId, 'backend-submit-intent', {
        attempt: engagement.attempt_uri,
        taskDigest,
        submissionDigest,
        dispatchContextDigest,
      }, now);
      return { kind: 'created' as const, operationId };
    })();
  }

  getSolutionExecution(engagement: NativeOperationId): NativeSolutionExecutionRow | undefined {
    const row = this.store.db.prepare(
      `SELECT * FROM native_solution_executions WHERE engagement_id = ?`,
    ).get(engagement) as RawSolutionExecution | undefined;
    return row === undefined ? undefined : solutionExecutionRow(row);
  }

  recordBackendSubmissionAccepted(operationId: NativeOperationId): void {
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const operation = this.store.db.prepare(`SELECT * FROM native_operations WHERE operation_id = ?`)
        .get(operationId) as RawOperation | undefined;
      if (operation === undefined || operation.kind !== 'backend-submit') {
        throw new NativeOperatorStateConflictError(`unknown backend submission operation ${operationId}`);
      }
      if (!['intent', 'finalized'].includes(operation.status)) {
        throw new NativeOperatorStateConflictError(`cannot accept backend submission from ${operation.status}`);
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'finalized', updated_at = ? WHERE operation_id = ?`,
      ).run(now, operationId);
      this.store.db.prepare(
        `UPDATE native_solution_executions SET status = 'accepted', updated_at = ? WHERE operation_id = ?`,
      ).run(now, operationId);
      this.insertAudit(operation.engagement_id, operationId, 'backend-submission-accepted', {}, now);
    })();
  }

  recordSolutionReady(
    engagementIdValue: NativeOperationId,
    input: {
      readonly sourceId: string;
      readonly artifacts: readonly NativeSolutionArtifactInput[];
    },
  ): void {
    if (input.sourceId.length === 0) throw new TypeError('solution publication sourceId must not be empty');
    if (input.artifacts.length === 0) throw new NativeOperatorStateConflictError('solution artifact graph must not be empty');
    const keys = new Set<string>();
    for (const artifact of input.artifacts) {
      if (artifact.family.length === 0) throw new TypeError('solution artifact family must not be empty');
      if (documentDigest(artifact.bytes) !== artifact.digest) {
        throw new NativeOperatorStateConflictError(`solution ${artifact.role} digest does not name its exact bytes`);
      }
      const key = `${artifact.role}\u0000${artifact.name ?? ''}\u0000${artifact.digest}`;
      if (keys.has(key)) throw new NativeOperatorStateConflictError('solution artifact graph contains a duplicate identity');
      keys.add(key);
    }
    const deliveries = input.artifacts.filter(({ role }) => role === 'delivery');
    const envelopes = input.artifacts.filter(({ role }) => role === 'delivery-envelope');
    if (deliveries.length !== 1 || envelopes.length !== 1) {
      throw new NativeOperatorStateConflictError('solution artifact graph requires exactly one Delivery and one Delivery envelope');
    }
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const execution = this.store.db.prepare(
        `SELECT * FROM native_solution_executions WHERE engagement_id = ?`,
      ).get(engagementIdValue) as RawSolutionExecution | undefined;
      if (execution === undefined || execution.status !== 'accepted') {
        throw new NativeOperatorStateConflictError('solution artifacts require an accepted backend submission');
      }
      const engagement = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
        .get(engagementIdValue) as RawEngagement | undefined;
      if (engagement === undefined || engagement.state !== 'executing') {
        throw new NativeOperatorStateConflictError(`cannot record solution artifacts from ${engagement?.state ?? 'missing'}`);
      }
      for (const artifact of input.artifacts) {
        this.store.db.prepare(
          `INSERT INTO native_solution_artifacts
            (engagement_id, role, family, name, record_digest, exact_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          engagementIdValue,
          artifact.role,
          artifact.family,
          artifact.name ?? '',
          artifact.digest,
          Buffer.from(artifact.bytes),
          now,
        );
        const publication = publicationKey({
          sourceId: input.sourceId,
          role: artifact.role,
          recordDigest: artifact.digest,
          availabilityState: 'available',
        });
        this.store.db.prepare(
          `INSERT INTO native_publication_outbox
            (publication_key, engagement_id, source_id, role, record_digest, availability,
             status, detail_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'available', 'intent', ?, ?, ?)`,
        ).run(
          publication,
          engagementIdValue,
          input.sourceId,
          artifact.role,
          artifact.digest,
          detailJson({ family: artifact.family, ...(artifact.name === undefined ? {} : { name: artifact.name }) }),
          now,
          now,
        );
      }
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'solution-ready', updated_at = ? WHERE engagement_id = ?`,
      ).run(now, engagementIdValue);
      this.insertAudit(engagementIdValue, execution.operation_id, 'solution-ready', {
        deliveryDigest: deliveries[0]!.digest,
        artifacts: input.artifacts.map(({ role, family, name, digest }) => ({ role, family, name, digest })),
      }, now);
    })();
  }

  listSolutionArtifacts(engagement: NativeOperationId): NativeSolutionArtifactRow[] {
    return (this.store.db.prepare(
      `SELECT * FROM native_solution_artifacts WHERE engagement_id = ? ORDER BY role, name, record_digest`,
    ).all(engagement) as RawSolutionArtifact[]).map(solutionArtifactRow);
  }

  getSolutionArtifactBytes(input: {
    readonly engagementId: NativeOperationId;
    readonly role: NativeSolutionArtifactRole;
    readonly digest: `sha256:${string}`;
  }): Uint8Array | undefined {
    const row = this.store.db.prepare(
      `SELECT exact_bytes FROM native_solution_artifacts
        WHERE engagement_id = ? AND role = ? AND record_digest = ?`,
    ).get(input.engagementId, input.role, input.digest) as { exact_bytes: Uint8Array } | undefined;
    return row === undefined ? undefined : exactBytes(row.exact_bytes);
  }

  listPendingPublications(): NativePublicationRow[] {
    return (this.store.db.prepare(
      `SELECT * FROM native_publication_outbox WHERE status = 'intent' ORDER BY created_at, publication_key`,
    ).all() as RawPublication[]).map(publicationRow);
  }

  recordPublicationPublished(
    key: NativeOperationId,
    input: {
      readonly location: string;
      readonly sequence: string;
      readonly entryDigest: `sha256:${string}`;
    },
  ): void {
    if (input.location.length === 0 || input.sequence.length === 0) {
      throw new TypeError('published solution location and sequence must not be empty');
    }
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const publication = this.store.db.prepare(
        `SELECT * FROM native_publication_outbox WHERE publication_key = ?`,
      ).get(key) as RawPublication | undefined;
      if (publication === undefined) throw new NativeOperatorStateConflictError(`unknown solution publication ${key}`);
      if (publication.status === 'published') return;
      this.store.db.prepare(
        `UPDATE native_publication_outbox SET status = 'published', detail_json = ?, updated_at = ?
          WHERE publication_key = ?`,
      ).run(detailJson(input), now, key);
      this.insertAudit(publication.engagement_id, null, 'solution-record-published', {
        publicationKey: key,
        role: publication.role,
        recordDigest: publication.record_digest,
        ...input,
      }, now);
      const remaining = this.store.db.prepare(
        `SELECT COUNT(*) AS count FROM native_publication_outbox
          WHERE engagement_id = ? AND status <> 'published'`,
      ).get(publication.engagement_id) as { count: number };
      if (remaining.count === 0) {
        this.store.db.prepare(
          `UPDATE native_engagements SET state = 'solution-published', updated_at = ?
            WHERE engagement_id = ? AND state = 'solution-ready'`,
        ).run(now, publication.engagement_id);
      }
    })();
  }

  beginSolutionSettlement(
    engagementIdValue: NativeOperationId,
  ): { readonly kind: 'created' | 'matching'; readonly operationId: NativeOperationId } {
    const now = this.timestamp();
    return this.store.db.transaction(() => {
      const engagement = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
        .get(engagementIdValue) as RawEngagement | undefined;
      if (engagement === undefined || engagement.attempt_uri === null) {
        throw new NativeOperatorStateConflictError('solution settlement requires a persisted marketplace Attempt');
      }
      const delivery = this.store.db.prepare(
        `SELECT record_digest FROM native_solution_artifacts
          WHERE engagement_id = ? AND role = 'delivery'`,
      ).get(engagementIdValue) as { record_digest: `sha256:${string}` } | undefined;
      if (delivery === undefined) throw new NativeOperatorStateConflictError('solution settlement requires exact Delivery bytes');
      const operationId = solutionSettlementId({
        attempt: engagement.attempt_uri,
        deliveryDigest: delivery.record_digest,
      });
      const existing = this.store.db.prepare(`SELECT * FROM native_operations WHERE operation_id = ?`)
        .get(operationId) as RawOperation | undefined;
      if (existing !== undefined) {
        if (existing.status === 'orphaned') {
          if (engagement.state !== 'solution-published') {
            throw new NativeOperatorStateConflictError(
              `cannot reopen orphaned solution settlement from ${engagement.state}`,
            );
          }
          this.store.db.prepare(
            `UPDATE native_operations
              SET status = 'intent', prior_tx_hash = tx_hash, tx_hash = NULL,
                block_hash = NULL, block_number = NULL, updated_at = ?
              WHERE operation_id = ?`,
          ).run(now, operationId);
          this.store.db.prepare(
            `UPDATE native_engagements SET state = 'solution-settlement-pending', updated_at = ?
              WHERE engagement_id = ?`,
          ).run(now, engagementIdValue);
          this.insertAudit(engagementIdValue, operationId, 'solution-settlement-reopened', {
            priorTxHash: existing.tx_hash,
          }, now);
        }
        return { kind: 'matching' as const, operationId };
      }
      if (engagement.state !== 'solution-published') {
        throw new NativeOperatorStateConflictError(`cannot begin solution settlement from ${engagement.state}`);
      }
      this.store.db.prepare(
        `INSERT INTO native_operations
          (operation_id, engagement_id, kind, status, detail_json, created_at, updated_at)
         VALUES (?, ?, 'solution-settlement', 'intent', ?, ?, ?)`,
      ).run(operationId, engagementIdValue, detailJson({
        attempt: engagement.attempt_uri,
        deliveryDigest: delivery.record_digest,
      }), now, now);
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'solution-settlement-pending', updated_at = ?
          WHERE engagement_id = ?`,
      ).run(now, engagementIdValue);
      this.insertAudit(engagementIdValue, operationId, 'solution-settlement-intent', {
        attempt: engagement.attempt_uri,
        deliveryDigest: delivery.record_digest,
      }, now);
      return { kind: 'created' as const, operationId };
    })();
  }

  listSolutionEngagements(): NativeEngagementRow[] {
    return (this.store.db.prepare(
      `SELECT * FROM native_engagements
        WHERE state IN (
          'claim-finalized', 'executing', 'solution-ready', 'solution-published',
          'solution-settlement-pending'
        )
        ORDER BY created_at, engagement_id`,
    ).all() as RawEngagement[]).map(engagementRow);
  }

  recordSolutionFailed(
    engagementIdValue: NativeOperationId,
    input: { readonly reason: string; readonly detail?: string },
  ): void {
    if (input.reason.length === 0) throw new TypeError('solution failure reason must not be empty');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const engagement = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
        .get(engagementIdValue) as RawEngagement | undefined;
      if (engagement === undefined) throw new NativeOperatorStateConflictError(`unknown native engagement ${engagementIdValue}`);
      if (engagement.state === 'solution-settled') {
        throw new NativeOperatorStateConflictError('a finalized solution settlement cannot become failed');
      }
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'failed', updated_at = ? WHERE engagement_id = ?`,
      ).run(now, engagementIdValue);
      const backendOperation = this.store.db.prepare(
        `SELECT operation_id, status FROM native_operations
          WHERE engagement_id = ? AND kind = 'backend-submit'`,
      ).get(engagementIdValue) as { operation_id: NativeOperationId; status: NativeOperationStatus } | undefined;
      if (backendOperation !== undefined && backendOperation.status !== 'finalized') {
        this.store.db.prepare(
          `UPDATE native_operations SET status = 'failed-terminal', detail_json = ?, updated_at = ?
            WHERE operation_id = ?`,
        ).run(detailJson(input), now, backendOperation.operation_id);
      }
      this.insertAudit(engagementIdValue, backendOperation?.operation_id ?? null, 'solution-failed', input, now);
    })();
  }

  private requireSolutionSettlementOperation(
    operationId: NativeOperationId,
  ): { readonly operation: RawOperation; readonly engagement: RawEngagement } {
    const operation = this.store.db.prepare(`SELECT * FROM native_operations WHERE operation_id = ?`)
      .get(operationId) as RawOperation | undefined;
    if (operation === undefined || operation.kind !== 'solution-settlement') {
      throw new NativeOperatorStateConflictError(`unknown solution settlement operation ${operationId}`);
    }
    const engagement = this.store.db.prepare(`SELECT * FROM native_engagements WHERE engagement_id = ?`)
      .get(operation.engagement_id) as RawEngagement | undefined;
    if (engagement === undefined) throw new NativeOperatorStateConflictError('solution settlement has no engagement');
    return { operation, engagement };
  }

  recordSolutionSettlementBroadcast(
    operationId: NativeOperationId,
    txHash?: `0x${string}`,
  ): void {
    const hash = txHash === undefined ? null : requireHash(txHash, 'solution settlement transaction hash');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireSolutionSettlementOperation(operationId);
      if (!['intent', 'broadcast'].includes(operation.status)) {
        throw new NativeOperatorStateConflictError(`cannot broadcast solution settlement from ${operation.status}`);
      }
      if (operation.tx_hash !== null && hash !== null && operation.tx_hash !== hash) {
        throw new NativeOperatorStateConflictError('changed solution settlement hash requires replacement');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'broadcast', tx_hash = COALESCE(?, tx_hash),
          updated_at = ? WHERE operation_id = ?`,
      ).run(hash, now, operationId);
      this.insertAudit(operation.engagement_id, operationId,
        hash === null ? 'solution-settlement-broadcast-uncertain' : 'solution-settlement-broadcast',
        hash === null ? {} : { txHash: hash }, now);
    })();
  }

  recordSolutionSettlementReplacement(
    operationId: NativeOperationId,
    priorTxHash: `0x${string}`,
    txHash: `0x${string}`,
  ): void {
    const prior = requireHash(priorTxHash, 'prior solution settlement transaction hash');
    const replacement = requireHash(txHash, 'replacement solution settlement transaction hash');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireSolutionSettlementOperation(operationId);
      if (!['broadcast', 'replaced'].includes(operation.status) || operation.tx_hash !== prior) {
        throw new NativeOperatorStateConflictError('solution settlement replacement does not extend the current transaction');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'replaced', prior_tx_hash = ?, tx_hash = ?,
          updated_at = ? WHERE operation_id = ?`,
      ).run(prior, replacement, now, operationId);
      this.insertAudit(operation.engagement_id, operationId, 'solution-settlement-replaced', {
        priorTxHash: prior,
        txHash: replacement,
      }, now);
    })();
  }

  recordSolutionSettlementFinalized(
    operationId: NativeOperationId,
    observation: {
      readonly txHash: `0x${string}`;
      readonly blockHash: `0x${string}`;
      readonly blockNumber: bigint;
    },
  ): void {
    const txHash = requireHash(observation.txHash, 'solution settlement transaction hash');
    const blockHash = requireHash(observation.blockHash, 'solution settlement block hash');
    if (observation.blockNumber < 0n) throw new RangeError('solution settlement block number must not be negative');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireSolutionSettlementOperation(operationId);
      if (!['intent', 'broadcast', 'replaced', 'observed-safe', 'finalized'].includes(operation.status)) {
        throw new NativeOperatorStateConflictError(`cannot finalize solution settlement from ${operation.status}`);
      }
      if (operation.tx_hash !== null && operation.tx_hash !== txHash) {
        throw new NativeOperatorStateConflictError('canonical solution settlement names a different transaction');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'finalized', tx_hash = ?, block_hash = ?, block_number = ?,
          detail_json = ?, updated_at = ? WHERE operation_id = ?`,
      ).run(txHash, blockHash, observation.blockNumber.toString(10), detailJson(observation), now, operationId);
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'solution-settled', updated_at = ? WHERE engagement_id = ?`,
      ).run(now, operation.engagement_id);
      this.insertAudit(operation.engagement_id, operationId, 'solution-settlement-finalized', observation, now);
    })();
  }

  recordSolutionSettlementOrphaned(
    operationId: NativeOperationId,
    input: { readonly txHash: `0x${string}`; readonly reason: string },
  ): void {
    const txHash = requireHash(input.txHash, 'orphaned solution settlement transaction hash');
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const { operation } = this.requireSolutionSettlementOperation(operationId);
      if (operation.status === 'finalized') {
        throw new NativeOperatorStateConflictError('cannot orphan a finalized solution settlement');
      }
      if (operation.tx_hash !== null && operation.tx_hash !== txHash) {
        throw new NativeOperatorStateConflictError('solution settlement orphan notice names a different transaction');
      }
      this.store.db.prepare(
        `UPDATE native_operations SET status = 'orphaned', tx_hash = ?, detail_json = ?, updated_at = ?
          WHERE operation_id = ?`,
      ).run(txHash, detailJson(input), now, operationId);
      this.store.db.prepare(
        `UPDATE native_engagements SET state = 'solution-published', updated_at = ? WHERE engagement_id = ?`,
      ).run(now, operation.engagement_id);
      this.insertAudit(operation.engagement_id, operationId, 'solution-settlement-orphaned', input, now);
    })();
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
