import { documentDigest, serializeCanonicalJson } from "@jinn-network/task-execution-protocol";
import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import type { EvaluationOpportunity } from "../evaluator/opportunities.js";
import type { ExactSubjectArtifact, SubjectMaterial } from "../evaluator/subject-material.js";
import type { Store } from "../store/store.js";
import {
  evaluationBackendSubmissionOperationId,
  evaluationClaimOperationId,
  evaluationId,
  evaluationMarketplaceDeliveryOperationId,
  publicationKey,
  verdictSettlementId,
  type NativeOperationId,
} from "./native-operation-identity.js";
import { NATIVE_OPERATOR_STATE_SCHEMA_VERSION } from "./native-operator-state.js";

export const NATIVE_EVALUATOR_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS native_evaluations (
  evaluation_id                TEXT PRIMARY KEY,
  chain_id                    TEXT NOT NULL,
  coordinator                 TEXT NOT NULL,
  task_id                     TEXT NOT NULL,
  solution_attempt_index      INTEGER NOT NULL,
  solution_request_id         TEXT NOT NULL,
  solution_operator           TEXT NOT NULL,
  evaluator_agent             TEXT NOT NULL,
  source                      TEXT NOT NULL,
  source_sequence             TEXT NOT NULL,
  source_entry_digest         TEXT NOT NULL,
  canonical_event_identity    TEXT NOT NULL UNIQUE,
  block_hash                  TEXT NOT NULL,
  block_number                TEXT NOT NULL,
  transaction_hash            TEXT NOT NULL,
  log_index                   INTEGER NOT NULL,
  subject_task_digest         TEXT NOT NULL,
  advertised_delivery_digest TEXT NOT NULL,
  subject_graph_digest        TEXT NOT NULL,
  state                       TEXT NOT NULL,
  evaluation_attempt_uri      TEXT,
  evaluation_request_id       TEXT,
  verdict_code                INTEGER,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  UNIQUE (source, source_sequence, source_entry_digest)
);
CREATE INDEX IF NOT EXISTS idx_native_evaluations_state
  ON native_evaluations (state, created_at);

CREATE TABLE IF NOT EXISTS native_evaluation_subject_artifacts (
  evaluation_id TEXT NOT NULL REFERENCES native_evaluations(evaluation_id),
  role          TEXT NOT NULL,
  name          TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  exact_bytes   BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (evaluation_id, role, name, record_digest)
);

CREATE TABLE IF NOT EXISTS native_evaluation_source_checkpoints (
  source       TEXT PRIMARY KEY,
  sequence     TEXT NOT NULL,
  entry_digest TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_evaluation_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id  TEXT,
  kind           TEXT NOT NULL,
  detail_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_evaluation_executions (
  evaluation_id      TEXT PRIMARY KEY REFERENCES native_evaluations(evaluation_id),
  task_digest        TEXT NOT NULL,
  submission_digest  TEXT NOT NULL,
  submission_uri     TEXT NOT NULL,
  attempt_uri        TEXT,
  task_bytes         BLOB NOT NULL,
  submission_bytes   BLOB NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_evaluation_operations (
  operation_id  TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES native_evaluations(evaluation_id),
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  tx_hash       TEXT,
  prior_tx_hash TEXT,
  block_hash    TEXT,
  block_number  TEXT,
  detail_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (evaluation_id, kind)
);

CREATE TABLE IF NOT EXISTS native_evaluation_artifacts (
  evaluation_id TEXT NOT NULL REFERENCES native_evaluations(evaluation_id),
  role          TEXT NOT NULL,
  name          TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  exact_bytes   BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (evaluation_id, role, name, record_digest)
);

CREATE TABLE IF NOT EXISTS native_evaluation_publication_outbox (
  publication_key TEXT PRIMARY KEY,
  evaluation_id   TEXT NOT NULL REFERENCES native_evaluations(evaluation_id),
  source_id       TEXT NOT NULL,
  role            TEXT NOT NULL,
  record_digest   TEXT NOT NULL,
  status          TEXT NOT NULL,
  detail_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (source_id, role, record_digest)
);

CREATE TABLE IF NOT EXISTS native_evaluation_authority (
  evaluation_id       TEXT PRIMARY KEY REFERENCES native_evaluations(evaluation_id),
  authority_json      TEXT NOT NULL,
  verification_digest TEXT NOT NULL,
  verified_at         TEXT NOT NULL
);
`;

export class NativeEvaluatorStateConflictError extends Error {
  override readonly name = "NativeEvaluatorStateConflictError";
}

export type NativeEvaluationState =
  | "evaluation-pending"
  | "evaluation-claim-pending"
  | "evaluation-finalized"
  | "evaluating"
  | "verdict-ready"
  | "verdict-published"
  | "verdict-settlement-pending"
  | "complete"
  | "paused"
  | "withdrawn"
  | "lost"
  | "failed";

export interface NativeEvaluationRow {
  readonly evaluationId: NativeOperationId;
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: bigint;
  readonly solutionAttemptIndex: number;
  readonly solutionRequestId: `0x${string}`;
  readonly solutionOperator: string;
  readonly evaluatorAgent: string;
  readonly source: string;
  readonly sourceSequence: string;
  readonly sourceEntryDigest: `sha256:${string}`;
  readonly canonicalEventIdentity: string;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
  readonly subjectTaskDigest: `sha256:${string}`;
  readonly advertisedDeliveryDigest: `sha256:${string}`;
  readonly subjectGraphDigest: `sha256:${string}`;
  readonly state: NativeEvaluationState;
  readonly evaluationAttemptUri: string | null;
  readonly evaluationRequestId: string | null;
  readonly verdictCode: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeEvaluationArtifactRow extends ExactSubjectArtifact {
  readonly evaluationId: NativeOperationId;
  readonly role: string;
  readonly createdAt: string;
}

export type NativeEvaluationOperationStatus =
  | "intent" | "broadcast" | "replaced" | "observed-safe" | "finalized" | "orphaned" | "failed-terminal";

export interface NativeEvaluationOperationRow {
  readonly operationId: NativeOperationId;
  readonly evaluationId: NativeOperationId;
  readonly kind: "evaluation-claim" | "evaluation-backend-submit" | "evaluation-marketplace-delivery" | "verdict-settlement";
  readonly status: NativeEvaluationOperationStatus;
  readonly txHash: string | null;
  readonly priorTxHash: string | null;
  readonly blockHash: string | null;
  readonly blockNumber: bigint | null;
  readonly detail: unknown;
}

export interface NativeEvaluationPublicationRow {
  readonly publicationKey: NativeOperationId;
  readonly evaluationId: NativeOperationId;
  readonly sourceId: string;
  readonly role: string;
  readonly recordDigest: `sha256:${string}`;
  readonly status: "intent" | "published";
  readonly detail: unknown;
  readonly createdAt: string;
}

export interface NativeEvaluationAuthority {
  readonly requester: { readonly signerKey: string; readonly sealingTime: string };
  readonly admission: { readonly signerKey: string; readonly effectiveTime: string };
  readonly executor: {
    readonly signerKey: string;
    readonly agent: string;
    readonly declarationKey: string;
    readonly effectiveTime: string;
    readonly address: string;
  };
  readonly evaluator: {
    readonly signerKey: string;
    readonly agent: string;
    readonly declarationKey: string;
    readonly address: string;
  };
  readonly verificationDigest: `sha256:${string}`;
}

interface RawEvaluation {
  evaluation_id: NativeOperationId;
  chain_id: string;
  coordinator: string;
  task_id: string;
  solution_attempt_index: number;
  solution_request_id: `0x${string}`;
  solution_operator: string;
  evaluator_agent: string;
  source: string;
  source_sequence: string;
  source_entry_digest: `sha256:${string}`;
  canonical_event_identity: string;
  block_hash: `0x${string}`;
  block_number: string;
  transaction_hash: `0x${string}`;
  log_index: number;
  subject_task_digest: `sha256:${string}`;
  advertised_delivery_digest: `sha256:${string}`;
  subject_graph_digest: `sha256:${string}`;
  state: NativeEvaluationState;
  evaluation_attempt_uri: string | null;
  evaluation_request_id: string | null;
  verdict_code: number | null;
  created_at: string;
  updated_at: string;
}

function row(value: RawEvaluation): NativeEvaluationRow {
  return {
    evaluationId: value.evaluation_id,
    chainId: Number(value.chain_id),
    coordinator: value.coordinator,
    taskId: BigInt(value.task_id),
    solutionAttemptIndex: value.solution_attempt_index,
    solutionRequestId: value.solution_request_id,
    solutionOperator: value.solution_operator,
    evaluatorAgent: value.evaluator_agent,
    source: value.source,
    sourceSequence: value.source_sequence,
    sourceEntryDigest: value.source_entry_digest,
    canonicalEventIdentity: value.canonical_event_identity,
    blockHash: value.block_hash,
    blockNumber: BigInt(value.block_number),
    transactionHash: value.transaction_hash,
    logIndex: value.log_index,
    subjectTaskDigest: value.subject_task_digest,
    advertisedDeliveryDigest: value.advertised_delivery_digest,
    subjectGraphDigest: value.subject_graph_digest,
    state: value.state,
    evaluationAttemptUri: value.evaluation_attempt_uri,
    evaluationRequestId: value.evaluation_request_id,
    verdictCode: value.verdict_code,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function artifacts(material: SubjectMaterial): readonly { readonly role: string; readonly artifact: ExactSubjectArtifact }[] {
  return [
    { role: "task", artifact: material.task },
    { role: "submission", artifact: material.submission },
    { role: "requester-envelope", artifact: material.requesterEnvelope },
    { role: "admission-receipt", artifact: material.admissionReceipt },
    { role: "solution-delivery", artifact: material.delivery },
    { role: "solution-delivery-envelope", artifact: material.deliveryEnvelope },
    ...material.evidenceRecords.map((artifact) => ({ role: "solution-evidence", artifact })),
    ...material.results.map((artifact) => ({ role: "solution-result", artifact })),
    { role: "evaluation-spec", artifact: material.evaluationSpec },
  ];
}

function graphDigest(material: SubjectMaterial): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(artifacts(material).map(({ role, artifact }) => ({
    role,
    name: artifact.name,
    digest: artifact.digest,
  }))));
}

function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new TypeError("coordinator must be an EVM address");
  return value.toLowerCase();
}

function requireHash(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new TypeError(`${label} must be a 32-byte hex value`);
  return value as `0x${string}`;
}

export class NativeEvaluatorStateRepository {
  private readonly now: () => Date;

  constructor(private readonly store: Store, input: { readonly now?: () => Date } = {}) {
    this.now = input.now ?? (() => new Date());
    this.store.db.exec(NATIVE_EVALUATOR_STATE_SCHEMA);
    const metadata = this.store.db.prepare(
      "SELECT schema_version FROM native_operator_state_metadata WHERE singleton = 1",
    ).get() as { schema_version: number } | undefined;
    if (metadata === undefined) {
      this.store.db.prepare(
        "INSERT INTO native_operator_state_metadata (singleton, schema_version, created_at) VALUES (1, ?, ?)",
      ).run(NATIVE_OPERATOR_STATE_SCHEMA_VERSION, this.timestamp());
    } else if (metadata.schema_version === 2) {
      this.store.db.prepare(
        "UPDATE native_operator_state_metadata SET schema_version = ? WHERE singleton = 1 AND schema_version = 2",
      ).run(NATIVE_OPERATOR_STATE_SCHEMA_VERSION);
    } else if (metadata.schema_version !== NATIVE_OPERATOR_STATE_SCHEMA_VERSION) {
      throw new Error(`unsupported native operator state schema version ${metadata.schema_version}`);
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("native evaluator clock returned an invalid time");
    return value.toISOString();
  }

  schemaVersion(): number {
    return (this.store.db.prepare(
      "SELECT schema_version FROM native_operator_state_metadata WHERE singleton = 1",
    ).get() as { schema_version: number }).schema_version;
  }

  admitOpportunity(input: {
    readonly opportunity: EvaluationOpportunity;
    readonly evaluatorAgent: string;
    readonly coordinator: string;
    readonly material: SubjectMaterial;
    readonly reopenWithdrawn?: boolean;
  }): { readonly kind: "admitted" | "duplicate" | "reopened"; readonly evaluationId: NativeOperationId } {
    if (input.opportunity.finality !== "finalized" || !input.opportunity.canonical) {
      throw new NativeEvaluatorStateConflictError("evaluation opportunity is not canonical and finalized");
    }
    if (input.opportunity.advertisedDeliveryDigest !== input.material.delivery.digest) {
      throw new NativeEvaluatorStateConflictError("advertised Delivery digest does not equal exact subject Delivery");
    }
    for (const { artifact } of artifacts(input.material)) {
      if (documentDigest(artifact.bytes) !== artifact.digest) {
        throw new NativeEvaluatorStateConflictError(`exact subject artifact digest mismatch: ${artifact.name}`);
      }
    }
    const id = evaluationId({
      subjectTaskDigest: input.material.task.digest,
      subjectDeliveryDigest: input.material.delivery.digest,
      evaluatorAgent: input.evaluatorAgent,
    });
    const fingerprint = graphDigest(input.material);
    const now = this.timestamp();
    return this.store.db.transaction(() => {
      const existing = this.store.db.prepare(
        "SELECT * FROM native_evaluations WHERE evaluation_id = ? OR canonical_event_identity = ?",
      ).get(id, input.opportunity.canonicalEventIdentity) as RawEvaluation | undefined;
      if (existing !== undefined) {
        if (existing.evaluation_id !== id || existing.subject_graph_digest !== fingerprint) {
          throw new NativeEvaluatorStateConflictError("evaluation identity was reused with changed subject facts");
        }
        const sameProvenance = existing.source === input.opportunity.source
          && existing.source_sequence === input.opportunity.sourceSequence
          && existing.source_entry_digest === input.opportunity.sourceEntryDigest
          && existing.canonical_event_identity === input.opportunity.canonicalEventIdentity;
        if (sameProvenance) return { kind: "duplicate" as const, evaluationId: id };
        const checkpoint = this.sourceCheckpoint(input.opportunity.source);
        if (
          existing.state !== "withdrawn"
          || input.reopenWithdrawn !== true
          || (checkpoint !== undefined && BigInt(input.opportunity.sourceSequence) <= BigInt(checkpoint.sequence))
        ) throw new NativeEvaluatorStateConflictError("canonical replacement is not eligible to reopen evaluation");
        this.store.db.prepare(
          `UPDATE native_evaluations SET source = ?, source_sequence = ?, source_entry_digest = ?,
             canonical_event_identity = ?, block_hash = ?, block_number = ?, transaction_hash = ?, log_index = ?,
             state = 'evaluation-pending', updated_at = ? WHERE evaluation_id = ?`,
        ).run(
          input.opportunity.source,
          input.opportunity.sourceSequence,
          input.opportunity.sourceEntryDigest,
          input.opportunity.canonicalEventIdentity,
          input.opportunity.blockHash,
          input.opportunity.blockNumber.toString(10),
          input.opportunity.transactionHash,
          input.opportunity.logIndex,
          now,
          id,
        );
        this.upsertCheckpoint(
          input.opportunity.source,
          input.opportunity.sourceSequence,
          input.opportunity.sourceEntryDigest,
          now,
        );
        this.audit(id, "evaluation-opportunity-reopened", {
          canonicalEventIdentity: input.opportunity.canonicalEventIdentity,
        }, now);
        return { kind: "reopened" as const, evaluationId: id };
      }
      const checkpoint = this.sourceCheckpoint(input.opportunity.source);
      if (checkpoint !== undefined && BigInt(input.opportunity.sourceSequence) <= BigInt(checkpoint.sequence)) {
        throw new NativeEvaluatorStateConflictError("evaluation source sequence did not advance");
      }
      this.store.db.prepare(
        `INSERT INTO native_evaluations
          (evaluation_id, chain_id, coordinator, task_id, solution_attempt_index,
           solution_request_id, solution_operator, evaluator_agent, source, source_sequence,
           source_entry_digest, canonical_event_identity, block_hash, block_number, transaction_hash, log_index,
           subject_task_digest, advertised_delivery_digest, subject_graph_digest, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'evaluation-pending', ?, ?)`,
      ).run(
        id,
        String(input.opportunity.chainId),
        canonicalAddress(input.coordinator),
        input.opportunity.taskId.toString(10),
        input.opportunity.attemptIndex,
        input.opportunity.solutionRequestId,
        input.opportunity.operatorAddress,
        input.evaluatorAgent,
        input.opportunity.source,
        input.opportunity.sourceSequence,
        input.opportunity.sourceEntryDigest,
        input.opportunity.canonicalEventIdentity,
        input.opportunity.blockHash,
        input.opportunity.blockNumber.toString(10),
        input.opportunity.transactionHash,
        input.opportunity.logIndex,
        input.material.task.digest,
        input.material.delivery.digest,
        fingerprint,
        now,
        now,
      );
      const insertArtifact = this.store.db.prepare(
        `INSERT INTO native_evaluation_subject_artifacts
          (evaluation_id, role, name, record_digest, exact_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const { role, artifact } of artifacts(input.material)) {
        insertArtifact.run(id, role, artifact.name, artifact.digest, artifact.bytes, now);
      }
      this.upsertCheckpoint(input.opportunity.source, input.opportunity.sourceSequence, input.opportunity.sourceEntryDigest, now);
      this.audit(id, "evaluation-opportunity-admitted", {
        canonicalEventIdentity: input.opportunity.canonicalEventIdentity,
        subjectGraphDigest: fingerprint,
      }, now);
      return { kind: "admitted" as const, evaluationId: id };
    })();
  }

  retractOpportunity(input: {
    readonly source: string;
    readonly sourceSequence: string;
    readonly sourceEntryDigest: `sha256:${string}`;
    readonly canonicalEventIdentity: string;
    readonly reason: string;
  }): void {
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const current = this.store.db.prepare(
        "SELECT * FROM native_evaluations WHERE source = ? AND canonical_event_identity = ?",
      ).get(input.source, input.canonicalEventIdentity) as RawEvaluation | undefined;
      if (current === undefined) throw new NativeEvaluatorStateConflictError("retraction has no admitted evaluation opportunity");
      const checkpoint = this.sourceCheckpoint(input.source);
      if (checkpoint !== undefined && BigInt(input.sourceSequence) <= BigInt(checkpoint.sequence)) {
        throw new NativeEvaluatorStateConflictError("retraction source sequence did not advance");
      }
      const nextState: NativeEvaluationState = ["evaluation-pending", "evaluation-claim-pending"]
        .includes(current.state) ? "withdrawn" : "paused";
      this.store.db.prepare(
        "UPDATE native_evaluations SET state = ?, updated_at = ? WHERE evaluation_id = ?",
      ).run(nextState, now, current.evaluation_id);
      this.upsertCheckpoint(input.source, input.sourceSequence, input.sourceEntryDigest, now);
      this.audit(current.evaluation_id, "evaluation-opportunity-retracted", { reason: input.reason }, now);
    })();
  }

  getEvaluation(id: NativeOperationId): NativeEvaluationRow | undefined {
    const value = this.store.db.prepare("SELECT * FROM native_evaluations WHERE evaluation_id = ?")
      .get(id) as RawEvaluation | undefined;
    return value === undefined ? undefined : row(value);
  }

  listEvaluations(): readonly NativeEvaluationRow[] {
    return (this.store.db.prepare("SELECT * FROM native_evaluations ORDER BY created_at, evaluation_id").all() as RawEvaluation[])
      .map(row);
  }

  listSubjectArtifacts(id: NativeOperationId): readonly NativeEvaluationArtifactRow[] {
    const rows = this.store.db.prepare(
      "SELECT * FROM native_evaluation_subject_artifacts WHERE evaluation_id = ? ORDER BY role, name, record_digest",
    ).all(id) as Array<{
      evaluation_id: NativeOperationId;
      role: string;
      name: string;
      record_digest: `sha256:${string}`;
      exact_bytes: Uint8Array;
      created_at: string;
    }>;
    return rows.map((value) => ({
      evaluationId: value.evaluation_id,
      role: value.role,
      name: value.name,
      digest: value.record_digest,
      bytes: new Uint8Array(value.exact_bytes),
      createdAt: value.created_at,
    }));
  }

  sourceCheckpoint(source: string): { readonly sequence: string; readonly entryDigest: `sha256:${string}` } | undefined {
    const value = this.store.db.prepare(
      "SELECT sequence, entry_digest FROM native_evaluation_source_checkpoints WHERE source = ?",
    ).get(source) as { sequence: string; entry_digest: `sha256:${string}` } | undefined;
    return value === undefined ? undefined : { sequence: value.sequence, entryDigest: value.entry_digest };
  }

  private upsertCheckpoint(source: string, sequence: string, entryDigest: `sha256:${string}`, now: string): void {
    this.store.db.prepare(
      `INSERT INTO native_evaluation_source_checkpoints (source, sequence, entry_digest, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET sequence = excluded.sequence,
         entry_digest = excluded.entry_digest, updated_at = excluded.updated_at`,
    ).run(source, sequence, entryDigest, now);
  }

  private audit(id: NativeOperationId, kind: string, detail: unknown, now: string): void {
    this.store.db.prepare(
      "INSERT INTO native_evaluation_audit (evaluation_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, kind, JSON.stringify(detail), now);
  }

  recordDerivedEvaluation(evaluation: NativeOperationId, input: {
    readonly taskBytes: Uint8Array;
    readonly taskDigest: `sha256:${string}`;
    readonly submissionBytes: Uint8Array;
    readonly submissionDigest: `sha256:${string}`;
    readonly submissionUri: `urn:uuid:${string}`;
  }): void {
    if (documentDigest(input.taskBytes) !== input.taskDigest
      || documentDigest(input.submissionBytes) !== input.submissionDigest) {
      throw new NativeEvaluatorStateConflictError("derived evaluation exact bytes do not match their digests");
    }
    const current = this.getEvaluation(evaluation);
    if (current === undefined) throw new NativeEvaluatorStateConflictError("unknown evaluation aggregate");
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const existing = this.store.db.prepare(
        "SELECT * FROM native_evaluation_executions WHERE evaluation_id = ?",
      ).get(evaluation) as {
        task_digest: string; submission_digest: string; submission_uri: string; attempt_uri: string | null;
        task_bytes: Uint8Array; submission_bytes: Uint8Array;
      } | undefined;
      if (existing !== undefined) {
        const matches = existing.task_digest === input.taskDigest
          && existing.submission_digest === input.submissionDigest
          && existing.submission_uri === input.submissionUri
          && existing.attempt_uri === null
          && Buffer.from(existing.task_bytes).equals(Buffer.from(input.taskBytes))
          && Buffer.from(existing.submission_bytes).equals(Buffer.from(input.submissionBytes));
        if (!matches) throw new NativeEvaluatorStateConflictError("derived evaluation changed after sealing");
        return;
      }
      if (current.state !== "evaluation-pending") {
        throw new NativeEvaluatorStateConflictError(`cannot derive evaluation from ${current.state}`);
      }
      this.store.db.prepare(
        `INSERT INTO native_evaluation_executions
          (evaluation_id, task_digest, submission_digest, submission_uri, attempt_uri,
           task_bytes, submission_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        evaluation, input.taskDigest, input.submissionDigest, input.submissionUri, null,
        Buffer.from(input.taskBytes), Buffer.from(input.submissionBytes), now, now,
      );
      this.store.db.prepare(
        "UPDATE native_evaluations SET updated_at = ? WHERE evaluation_id = ?",
      ).run(now, evaluation);
      this.audit(evaluation, "evaluation-pair-sealed", {
        taskDigest: input.taskDigest,
        submissionDigest: input.submissionDigest,
      }, now);
    })();
  }

  getDerivedEvaluation(evaluation: NativeOperationId): {
    readonly taskBytes: Uint8Array;
    readonly taskDigest: `sha256:${string}`;
    readonly submissionBytes: Uint8Array;
    readonly submissionDigest: `sha256:${string}`;
    readonly submissionUri: `urn:uuid:${string}`;
    readonly attemptUri: `urn:uuid:${string}` | null;
  } | undefined {
    const value = this.store.db.prepare(
      "SELECT * FROM native_evaluation_executions WHERE evaluation_id = ?",
    ).get(evaluation) as {
      task_digest: `sha256:${string}`; submission_digest: `sha256:${string}`;
      submission_uri: `urn:uuid:${string}`; attempt_uri: `urn:uuid:${string}` | null;
      task_bytes: Uint8Array; submission_bytes: Uint8Array;
    } | undefined;
    return value === undefined ? undefined : {
      taskBytes: new Uint8Array(value.task_bytes),
      taskDigest: value.task_digest,
      submissionBytes: new Uint8Array(value.submission_bytes),
      submissionDigest: value.submission_digest,
      submissionUri: value.submission_uri,
      attemptUri: value.attempt_uri,
    };
  }

  private createOperation(
    evaluation: NativeOperationId,
    operationId: NativeOperationId,
    kind: NativeEvaluationOperationRow["kind"],
    detail: unknown,
  ): { readonly operationId: NativeOperationId } {
    if (this.getEvaluation(evaluation) === undefined) throw new NativeEvaluatorStateConflictError("unknown evaluation aggregate");
    const now = this.timestamp();
    this.store.db.prepare(
      `INSERT OR IGNORE INTO native_evaluation_operations
        (operation_id, evaluation_id, kind, status, detail_json, created_at, updated_at)
       VALUES (?, ?, ?, 'intent', ?, ?, ?)`,
    ).run(operationId, evaluation, kind, JSON.stringify(detail), now, now);
    const existing = this.store.db.prepare(
      "SELECT operation_id, kind FROM native_evaluation_operations WHERE evaluation_id = ? AND kind = ?",
    ).get(evaluation, kind) as { operation_id: string; kind: string };
    if (existing.operation_id !== operationId) {
      throw new NativeEvaluatorStateConflictError(`${kind} operation identity changed`);
    }
    return { operationId };
  }

  beginEvaluationClaim(evaluation: NativeOperationId, evaluationTaskCidDigest: `0x${string}`): { readonly operationId: NativeOperationId } {
    requireHash(evaluationTaskCidDigest, "evaluation Task CID digest");
    const current = this.getEvaluation(evaluation);
    if (current === undefined || this.getDerivedEvaluation(evaluation) === undefined) {
      throw new NativeEvaluatorStateConflictError("evaluation claim requires a sealed pair");
    }
    if (this.getAdmissionAuthority(evaluation) === undefined) {
      throw new NativeEvaluatorStateConflictError("evaluation claim requires verified subject authority");
    }
    const result = this.createOperation(
      evaluation,
      evaluationClaimOperationId(evaluation),
      "evaluation-claim",
      { evaluationTaskCidDigest },
    );
    const now = this.timestamp();
    this.store.db.prepare(
      "UPDATE native_evaluations SET state = 'evaluation-claim-pending', updated_at = ? WHERE evaluation_id = ? AND state = 'evaluation-pending'",
    ).run(now, evaluation);
    return result;
  }

  recordAdmissionVerified(evaluation: NativeOperationId, authority: NativeEvaluationAuthority): void {
    if (this.getEvaluation(evaluation) === undefined) throw new NativeEvaluatorStateConflictError("unknown evaluation aggregate");
    if (!/^sha256:[0-9a-f]{64}$/u.test(authority.verificationDigest)) {
      throw new NativeEvaluatorStateConflictError("subject authority verification digest is invalid");
    }
    if (authority.executor.agent === authority.evaluator.agent
      || authority.executor.address.toLowerCase() === authority.evaluator.address.toLowerCase()) {
      throw new NativeEvaluatorStateConflictError("solver and evaluator authority are not distinct");
    }
    const now = this.timestamp();
    const json = JSON.stringify(authority);
    const existing = this.store.db.prepare(
      "SELECT authority_json, verification_digest FROM native_evaluation_authority WHERE evaluation_id = ?",
    ).get(evaluation) as { authority_json: string; verification_digest: string } | undefined;
    if (existing !== undefined) {
      if (existing.authority_json !== json || existing.verification_digest !== authority.verificationDigest) {
        throw new NativeEvaluatorStateConflictError("verified subject authority changed after persistence");
      }
      return;
    }
    this.store.db.prepare(
      `INSERT INTO native_evaluation_authority
        (evaluation_id, authority_json, verification_digest, verified_at) VALUES (?, ?, ?, ?)`,
    ).run(evaluation, json, authority.verificationDigest, now);
    this.audit(evaluation, "evaluation-subject-authority-verified", {
      verificationDigest: authority.verificationDigest,
    }, now);
  }

  getAdmissionAuthority(evaluation: NativeOperationId): NativeEvaluationAuthority | undefined {
    const value = this.store.db.prepare(
      "SELECT authority_json FROM native_evaluation_authority WHERE evaluation_id = ?",
    ).get(evaluation) as { authority_json: string } | undefined;
    return value === undefined ? undefined : JSON.parse(value.authority_json) as NativeEvaluationAuthority;
  }

  recordOperationBroadcast(operationId: NativeOperationId, txHash?: `0x${string}`): void {
    const hash = txHash === undefined ? null : requireHash(txHash, "transaction hash");
    const operation = this.requireOperation(operationId);
    if (!["intent", "broadcast"].includes(operation.status)) {
      throw new NativeEvaluatorStateConflictError(`cannot broadcast ${operation.kind} from ${operation.status}`);
    }
    if (operation.txHash !== null && hash !== null && operation.txHash !== hash) {
      throw new NativeEvaluatorStateConflictError("changed transaction hash requires replacement");
    }
    this.store.db.prepare(
      "UPDATE native_evaluation_operations SET status = 'broadcast', tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE operation_id = ?",
    ).run(hash, this.timestamp(), operationId);
  }

  recordOperationReplacement(operationId: NativeOperationId, prior: `0x${string}`, next: `0x${string}`): void {
    requireHash(prior, "prior transaction hash");
    requireHash(next, "replacement transaction hash");
    const operation = this.requireOperation(operationId);
    if (!["broadcast", "replaced"].includes(operation.status) || operation.txHash !== prior || prior === next) {
      throw new NativeEvaluatorStateConflictError("replacement does not extend current evaluation operation");
    }
    this.store.db.prepare(
      "UPDATE native_evaluation_operations SET status = 'replaced', prior_tx_hash = ?, tx_hash = ?, updated_at = ? WHERE operation_id = ?",
    ).run(prior, next, this.timestamp(), operationId);
  }

  recordEvaluationClaimFinalized(operationId: NativeOperationId, fact: {
    readonly txHash: `0x${string}`;
    readonly blockHash: `0x${string}`;
    readonly blockNumber: bigint;
    readonly requestId: `0x${string}`;
    readonly verdictIndex: number;
    readonly evaluatorAddress: `0x${string}`;
  }): void {
    const operation = this.requireOperation(operationId);
    if (operation.kind !== "evaluation-claim") throw new NativeEvaluatorStateConflictError("operation is not evaluation claim");
    requireHash(fact.txHash, "transaction hash");
    requireHash(fact.blockHash, "block hash");
    requireHash(fact.requestId, "request id");
    if (operation.txHash !== null && operation.txHash !== fact.txHash) {
      throw new NativeEvaluatorStateConflictError("canonical evaluation claim names a different transaction");
    }
    if (fact.blockNumber < 0n || !Number.isSafeInteger(fact.verdictIndex) || fact.verdictIndex < 0) {
      throw new NativeEvaluatorStateConflictError("canonical evaluation claim identity is invalid");
    }
    const current = this.getEvaluation(operation.evaluationId)!;
    const attemptUri = deriveMarketplaceAttemptUri({
      chainId: current.chainId,
      coordinator: current.coordinator as `0x${string}`,
      taskId: BigInt(fact.requestId),
      attemptIndex: fact.verdictIndex,
    });
    const now = this.timestamp();
    this.store.db.transaction(() => {
      this.store.db.prepare(
        `UPDATE native_evaluation_operations SET status = 'finalized', tx_hash = ?, block_hash = ?,
         block_number = ?, detail_json = ?, updated_at = ? WHERE operation_id = ?`,
      ).run(fact.txHash, fact.blockHash, fact.blockNumber.toString(10), JSON.stringify({
        ...fact, blockNumber: fact.blockNumber.toString(10),
      }), now, operationId);
      this.store.db.prepare(
        `UPDATE native_evaluations SET state = 'evaluation-finalized', evaluation_request_id = ?,
         evaluation_attempt_uri = ?, updated_at = ? WHERE evaluation_id = ?`,
      ).run(fact.requestId, attemptUri, now, operation.evaluationId);
      this.store.db.prepare(
        "UPDATE native_evaluation_executions SET attempt_uri = ?, updated_at = ? WHERE evaluation_id = ?",
      ).run(attemptUri, now, operation.evaluationId);
    })();
  }

  beginEvaluationExecution(evaluation: NativeOperationId): { readonly operationId: NativeOperationId } {
    const current = this.getEvaluation(evaluation);
    const derived = this.getDerivedEvaluation(evaluation);
    if (current?.state !== "evaluation-finalized" || derived === undefined || derived.attemptUri === null) {
      throw new NativeEvaluatorStateConflictError("evaluation backend requires finalized claim and sealed pair");
    }
    return this.createOperation(
      evaluation,
      evaluationBackendSubmissionOperationId({ evaluationId: evaluation, attempt: derived.attemptUri }),
      "evaluation-backend-submit",
      { attempt: derived.attemptUri, taskDigest: derived.taskDigest, submissionDigest: derived.submissionDigest },
    );
  }

  recordEvaluationBackendAccepted(operationId: NativeOperationId): void {
    const operation = this.requireOperation(operationId);
    if (operation.kind !== "evaluation-backend-submit") throw new NativeEvaluatorStateConflictError("operation is not evaluator backend submit");
    const now = this.timestamp();
    this.store.db.transaction(() => {
      this.store.db.prepare(
        "UPDATE native_evaluation_operations SET status = 'finalized', updated_at = ? WHERE operation_id = ?",
      ).run(now, operationId);
      this.store.db.prepare(
        "UPDATE native_evaluations SET state = 'evaluating', updated_at = ? WHERE evaluation_id = ?",
      ).run(now, operation.evaluationId);
    })();
  }

  recordVerdictReady(evaluation: NativeOperationId, input: {
    readonly sourceId: string;
    readonly verdictCode: number;
    readonly artifacts: readonly {
      readonly role: string;
      readonly name: string;
      readonly digest: `sha256:${string}`;
      readonly bytes: Uint8Array;
    }[];
  }): void {
    const current = this.getEvaluation(evaluation);
    if (current?.state !== "evaluating" && current?.state !== "verdict-ready") {
      throw new NativeEvaluatorStateConflictError("verdict artifacts require evaluating state");
    }
    if (!input.artifacts.some(({ role }) => role === "verdict")
      || !input.artifacts.some(({ role }) => role === "evaluation-delivery")) {
      throw new NativeEvaluatorStateConflictError("verdict graph requires exact verdict and evaluation Delivery");
    }
    const now = this.timestamp();
    this.store.db.transaction(() => {
      for (const artifact of input.artifacts) {
        if (documentDigest(artifact.bytes) !== artifact.digest) {
          throw new NativeEvaluatorStateConflictError(`evaluation artifact digest mismatch: ${artifact.name}`);
        }
        this.store.db.prepare(
          `INSERT OR IGNORE INTO native_evaluation_artifacts
            (evaluation_id, role, name, record_digest, exact_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(evaluation, artifact.role, artifact.name, artifact.digest, Buffer.from(artifact.bytes), now);
        const key = publicationKey({
          sourceId: input.sourceId,
          role: artifact.role,
          recordDigest: artifact.digest,
          availabilityState: "available",
        });
        this.store.db.prepare(
          `INSERT OR IGNORE INTO native_evaluation_publication_outbox
            (publication_key, evaluation_id, source_id, role, record_digest, status, detail_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'intent', '{}', ?, ?)`,
        ).run(key, evaluation, input.sourceId, artifact.role, artifact.digest, now, now);
      }
      this.store.db.prepare(
        "UPDATE native_evaluations SET state = 'verdict-ready', verdict_code = ?, updated_at = ? WHERE evaluation_id = ?",
      ).run(input.verdictCode, now, evaluation);
    })();
  }

  listEvaluationArtifacts(evaluation: NativeOperationId): readonly NativeEvaluationArtifactRow[] {
    return (this.store.db.prepare(
      "SELECT * FROM native_evaluation_artifacts WHERE evaluation_id = ? ORDER BY role, name",
    ).all(evaluation) as Array<{
      evaluation_id: NativeOperationId; role: string; name: string;
      record_digest: `sha256:${string}`; exact_bytes: Uint8Array; created_at: string;
    }>).map((value) => ({
      evaluationId: value.evaluation_id,
      role: value.role,
      name: value.name,
      digest: value.record_digest,
      bytes: new Uint8Array(value.exact_bytes),
      createdAt: value.created_at,
    }));
  }

  listPendingEvaluationPublications(): readonly NativeEvaluationPublicationRow[] {
    return (this.store.db.prepare(
      "SELECT * FROM native_evaluation_publication_outbox WHERE status = 'intent' ORDER BY rowid",
    ).all() as Array<{
      publication_key: NativeOperationId; evaluation_id: NativeOperationId; source_id: string;
      role: string; record_digest: `sha256:${string}`; status: "intent"; detail_json: string; created_at: string;
    }>).map((value) => ({
      publicationKey: value.publication_key,
      evaluationId: value.evaluation_id,
      sourceId: value.source_id,
      role: value.role,
      recordDigest: value.record_digest,
      status: value.status,
      detail: JSON.parse(value.detail_json),
      createdAt: value.created_at,
    }));
  }

  recordEvaluationPublicationPublished(publication: NativeOperationId, detail: unknown): void {
    const now = this.timestamp();
    this.store.db.transaction(() => {
      const value = this.store.db.prepare(
        "SELECT evaluation_id, status FROM native_evaluation_publication_outbox WHERE publication_key = ?",
      ).get(publication) as { evaluation_id: NativeOperationId; status: string } | undefined;
      if (value === undefined) throw new NativeEvaluatorStateConflictError("unknown evaluation publication");
      this.store.db.prepare(
        "UPDATE native_evaluation_publication_outbox SET status = 'published', detail_json = ?, updated_at = ? WHERE publication_key = ?",
      ).run(JSON.stringify(detail), now, publication);
      const pending = (this.store.db.prepare(
        "SELECT COUNT(*) AS count FROM native_evaluation_publication_outbox WHERE evaluation_id = ? AND status = 'intent'",
      ).get(value.evaluation_id) as { count: number }).count;
      if (pending === 0) this.store.db.prepare(
        "UPDATE native_evaluations SET state = 'verdict-published', updated_at = ? WHERE evaluation_id = ?",
      ).run(now, value.evaluation_id);
    })();
  }

  beginEvaluationMarketplaceDelivery(evaluation: NativeOperationId): { readonly operationId: NativeOperationId } {
    const current = this.getEvaluation(evaluation);
    const delivery = this.listEvaluationArtifacts(evaluation).find(({ role }) => role === "evaluation-delivery");
    if (current?.state !== "verdict-published" || delivery === undefined || current.evaluationAttemptUri === null) {
      throw new NativeEvaluatorStateConflictError("marketplace Deliver requires published evaluation Delivery");
    }
    return this.createOperation(evaluation, evaluationMarketplaceDeliveryOperationId({
      evaluationAttempt: current.evaluationAttemptUri,
      evaluationDeliveryDigest: delivery.digest,
    }), "evaluation-marketplace-delivery", { deliveryDigest: delivery.digest });
  }

  beginVerdictSettlement(evaluation: NativeOperationId): { readonly operationId: NativeOperationId } {
    const current = this.getEvaluation(evaluation);
    const delivery = this.listEvaluationArtifacts(evaluation).find(({ role }) => role === "evaluation-delivery");
    const marketplaceDelivery = this.listEvaluationOperations(evaluation)
      .find(({ kind }) => kind === "evaluation-marketplace-delivery");
    if (current === undefined || delivery === undefined || current.evaluationAttemptUri === null || current.verdictCode === null) {
      throw new NativeEvaluatorStateConflictError("verdict settlement requires exact evaluation Delivery and verdict code");
    }
    if (marketplaceDelivery?.status !== "finalized") {
      throw new NativeEvaluatorStateConflictError("verdict settlement requires finalized marketplace Deliver");
    }
    const result = this.createOperation(evaluation, verdictSettlementId({
      evaluationAttempt: current.evaluationAttemptUri,
      evaluationDeliveryDigest: delivery.digest,
      verdictCode: current.verdictCode,
    }), "verdict-settlement", { deliveryDigest: delivery.digest, verdictCode: current.verdictCode });
    this.store.db.prepare(
      "UPDATE native_evaluations SET state = 'verdict-settlement-pending', updated_at = ? WHERE evaluation_id = ?",
    ).run(this.timestamp(), evaluation);
    return result;
  }

  recordEvaluationMarketplaceDeliveryFinalized(operationId: NativeOperationId, fact: {
    readonly txHash: `0x${string}`;
    readonly blockHash: `0x${string}`;
    readonly blockNumber: bigint;
  }): void {
    const operation = this.requireOperation(operationId);
    if (operation.kind !== "evaluation-marketplace-delivery") {
      throw new NativeEvaluatorStateConflictError("operation is not evaluation marketplace Deliver");
    }
    this.finalizeOperation(operation, fact);
  }

  recordVerdictSettlementFinalized(operationId: NativeOperationId, fact: {
    readonly txHash: `0x${string}`;
    readonly blockHash: `0x${string}`;
    readonly blockNumber: bigint;
  }): void {
    const operation = this.requireOperation(operationId);
    if (operation.kind !== "verdict-settlement") {
      throw new NativeEvaluatorStateConflictError("operation is not verdict settlement");
    }
    const now = this.timestamp();
    this.store.db.transaction(() => {
      this.finalizeOperation(operation, fact, now);
      this.store.db.prepare(
        "UPDATE native_evaluations SET state = 'complete', updated_at = ? WHERE evaluation_id = ?",
      ).run(now, operation.evaluationId);
      this.audit(operation.evaluationId, "verdict-settlement-finalized", {
        operationId,
        txHash: fact.txHash,
        blockHash: fact.blockHash,
        blockNumber: fact.blockNumber.toString(10),
      }, now);
    })();
  }

  recordEvaluationOperationOrphaned(operationId: NativeOperationId, reason: string): void {
    const operation = this.requireOperation(operationId);
    const now = this.timestamp();
    const rollback: NativeEvaluationState = operation.kind === "evaluation-claim"
      ? "evaluation-pending"
      : "verdict-published";
    this.store.db.transaction(() => {
      this.store.db.prepare(
        "UPDATE native_evaluation_operations SET status = 'orphaned', detail_json = ?, updated_at = ? WHERE operation_id = ?",
      ).run(JSON.stringify({ reason }), now, operationId);
      this.store.db.prepare(
        `UPDATE native_evaluations SET state = ?,
           evaluation_attempt_uri = CASE WHEN ? = 'evaluation-claim' THEN NULL ELSE evaluation_attempt_uri END,
           evaluation_request_id = CASE WHEN ? = 'evaluation-claim' THEN NULL ELSE evaluation_request_id END,
           updated_at = ? WHERE evaluation_id = ?`,
      ).run(rollback, operation.kind, operation.kind, now, operation.evaluationId);
      if (operation.kind === "evaluation-claim") this.store.db.prepare(
        "UPDATE native_evaluation_executions SET attempt_uri = NULL, updated_at = ? WHERE evaluation_id = ?",
      ).run(now, operation.evaluationId);
      this.audit(operation.evaluationId, "evaluation-operation-orphaned", { operationId, reason }, now);
    })();
  }

  recordEvaluationPaused(evaluation: NativeOperationId, reason: string): void {
    if (this.getEvaluation(evaluation) === undefined) throw new NativeEvaluatorStateConflictError("unknown evaluation aggregate");
    const now = this.timestamp();
    this.store.db.prepare(
      "UPDATE native_evaluations SET state = 'paused', updated_at = ? WHERE evaluation_id = ?",
    ).run(now, evaluation);
    this.audit(evaluation, "evaluation-paused", { reason }, now);
  }

  private finalizeOperation(
    operation: NativeEvaluationOperationRow,
    fact: { readonly txHash: `0x${string}`; readonly blockHash: `0x${string}`; readonly blockNumber: bigint },
    now = this.timestamp(),
  ): void {
    requireHash(fact.txHash, "transaction hash");
    requireHash(fact.blockHash, "block hash");
    if (fact.blockNumber < 0n) throw new NativeEvaluatorStateConflictError("finalized block number is invalid");
    if (operation.txHash !== null && operation.txHash !== fact.txHash) {
      throw new NativeEvaluatorStateConflictError("canonical operation names a different transaction");
    }
    this.store.db.prepare(
      `UPDATE native_evaluation_operations SET status = 'finalized', tx_hash = ?, block_hash = ?,
       block_number = ?, updated_at = ? WHERE operation_id = ?`,
    ).run(fact.txHash, fact.blockHash, fact.blockNumber.toString(10), now, operation.operationId);
  }

  listEvaluationOperations(evaluation?: NativeOperationId): readonly NativeEvaluationOperationRow[] {
    const values = (evaluation === undefined
      ? this.store.db.prepare("SELECT * FROM native_evaluation_operations ORDER BY rowid").all()
      : this.store.db.prepare("SELECT * FROM native_evaluation_operations WHERE evaluation_id = ? ORDER BY rowid").all(evaluation)) as Array<{
        operation_id: NativeOperationId; evaluation_id: NativeOperationId; kind: NativeEvaluationOperationRow["kind"];
        status: NativeEvaluationOperationStatus; tx_hash: string | null; prior_tx_hash: string | null;
        block_hash: string | null; block_number: string | null; detail_json: string;
      }>;
    return values.map((value) => ({
      operationId: value.operation_id,
      evaluationId: value.evaluation_id,
      kind: value.kind,
      status: value.status,
      txHash: value.tx_hash,
      priorTxHash: value.prior_tx_hash,
      blockHash: value.block_hash,
      blockNumber: value.block_number === null ? null : BigInt(value.block_number),
      detail: JSON.parse(value.detail_json),
    }));
  }

  getEvaluationOperation(operation: NativeOperationId): NativeEvaluationOperationRow | undefined {
    return this.listEvaluationOperations().find(({ operationId }) => operationId === operation);
  }

  private requireOperation(operation: NativeOperationId): NativeEvaluationOperationRow {
    const value = this.getEvaluationOperation(operation);
    if (value === undefined) throw new NativeEvaluatorStateConflictError("unknown evaluation operation");
    return value;
  }
}
