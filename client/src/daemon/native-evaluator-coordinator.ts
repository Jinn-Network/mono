import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";
import { EXECUTION_EVIDENCE_MEDIA_TYPE } from "@jinn-network/evidence-protocol";
import type { VerdictCode } from "@jinn-network/marketplace-binding";
import type {
  CanonicalVerdictAttempt,
  CanonicalVerdictDelivery,
  CanonicalVerdictSettlement,
  VerdictPorts,
  VerdictTransactionIdentity,
} from "@jinn-network/marketplace-venue-base";
import type { TaskExecutionBackend, TwoPartyEngagement } from "@jinn-network/task-execution-backend";
import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  documentDigest,
  serializeCanonicalJson,
  type DeliveryRecord,
} from "@jinn-network/task-execution-protocol";
import { deriveNativeEvaluation } from "../evaluator/native-evaluation-derivation.js";
import {
  verifyNativeSubjectAuthority,
  type NativeSubjectAuthorityClaim,
  type NativeSubjectAuthorityDependencies,
} from "../evaluator/native-subject-authority.js";
import type { ExactSubjectArtifact, SubjectMaterial } from "../evaluator/subject-material.js";
import type { NativeOperationId } from "./native-operation-identity.js";
import {
  NativeEvaluatorStateRepository,
  NativeEvaluatorStateConflictError,
  type NativeEvaluationAuthority,
  type NativeEvaluationArtifactRow,
  type NativeEvaluationOperationRow,
  type NativeEvaluationPublicationRow,
  type NativeEvaluationRow,
} from "./native-evaluator-state.js";

export interface NativeEvaluatorPublisherPort {
  readonly sourceId: string;
  publish(input: {
    readonly publication: NativeEvaluationPublicationRow;
    readonly artifact: NativeEvaluationArtifactRow;
  }): Promise<{ readonly location: string; readonly sequence: string; readonly entryDigest: `sha256:${string}` }>;
}

export interface NativeEvaluatorVerdictVerificationInput {
  readonly evaluation: NativeEvaluationRow;
  readonly evaluationAuthority: NativeEvaluationAuthority;
  readonly subject: SubjectMaterial;
  readonly derived: NonNullable<ReturnType<NativeEvaluatorStateRepository["getDerivedEvaluation"]>>;
  readonly artifacts: readonly NativeEvaluationArtifactRow[];
  readonly canonical?: CanonicalVerdictSettlement;
}

export interface NativeEvaluatorVerdictVerificationPort {
  verify(input: NativeEvaluatorVerdictVerificationInput): Promise<
    | { readonly ok: true; readonly verdictCode: VerdictCode }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface NativeEvaluatorChainReconciliationPort {
  isFinalized(transaction: VerdictTransactionIdentity): Promise<boolean>;
  transactionStatus(txHash: `0x${string}`): Promise<
    | { readonly kind: "pending" | "canonical" }
    | { readonly kind: "orphaned"; readonly reason: string }
    | { readonly kind: "replaced"; readonly txHash: `0x${string}` }
  >;
}

export type NativeEvaluatorCoordinatorResult =
  | { readonly kind: "evaluation-pending" }
  | { readonly kind: "evaluation-claim-pending" }
  | { readonly kind: "evaluating" }
  | { readonly kind: "verdict-ready" }
  | { readonly kind: "verdict-published" }
  | { readonly kind: "verdict-settlement-pending" }
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "paused"; readonly reason: string };

class EvaluatorCoordinatorFailure extends Error {
  constructor(readonly reason: string, detail?: string, readonly retryable = false) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new EvaluatorCoordinatorFailure("invalid-exact-record", `${label}: ${String(cause)}`);
  }
}

function materialFromState(state: NativeEvaluatorStateRepository, id: NativeOperationId): SubjectMaterial {
  const rows = state.listSubjectArtifacts(id);
  const one = (role: string): ExactSubjectArtifact => {
    const candidates = rows.filter((row) => row.role === role);
    if (candidates.length !== 1) throw new EvaluatorCoordinatorFailure("subject-artifact-cardinality", role);
    return candidates[0]!;
  };
  return {
    task: one("task"),
    submission: one("submission"),
    requesterEnvelope: one("requester-envelope"),
    admissionReceipt: one("admission-receipt"),
    delivery: one("solution-delivery"),
    deliveryEnvelope: one("solution-delivery-envelope"),
    evidenceRecords: rows.filter(({ role }) => role === "solution-evidence"),
    results: rows.filter(({ role }) => role === "solution-result"),
    evaluationSpec: one("evaluation-spec"),
  };
}

function sha256Bytes32(digest: `sha256:${string}`): `0x${string}` {
  const hex = digest.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new EvaluatorCoordinatorFailure("invalid-sha256-digest");
  return `0x${hex}`;
}

function delivery(bytes: Uint8Array): DeliveryRecord {
  const parsed = DeliveryRecordSchema.safeParse(parseJson(bytes, "evaluation Delivery"));
  if (!parsed.success) throw new EvaluatorCoordinatorFailure("evaluation-delivery-invalid");
  return parsed.data;
}

function digestOfOutput(record: DeliveryRecord, name: string): `sha256:${string}` {
  const matches = record.outputs.filter((output) => output.name === name);
  const sha256 = matches[0]?.digest?.sha256;
  if (matches.length !== 1 || sha256 === undefined) {
    throw new EvaluatorCoordinatorFailure("verdict-output-cardinality");
  }
  return `sha256:${sha256}`;
}

export class NativeEvaluatorCoordinator {
  constructor(private readonly input: {
    readonly state: NativeEvaluatorStateRepository;
    readonly backend: TaskExecutionBackend;
    readonly authority: {
      claim(evaluation: NativeEvaluationRow): Promise<NativeSubjectAuthorityClaim>;
      dependencies: NativeSubjectAuthorityDependencies;
    };
    readonly deadline: (evaluation: NativeEvaluationRow) => string;
    readonly evaluatorAddress: `0x${string}`;
    readonly verdictPorts: VerdictPorts;
    readonly chain: NativeEvaluatorChainReconciliationPort;
    readonly deliverySignature: { get(deliveryDigest: `sha256:${string}`): Uint8Array | undefined };
    readonly evidence: {
      awaitIndexed(reference: EvidenceRecordReference): Promise<{ readonly status: string }>;
      getRecord(reference: EvidenceRecordReference): Promise<Uint8Array | null>;
    };
    readonly publisher: NativeEvaluatorPublisherPort;
    readonly verification: NativeEvaluatorVerdictVerificationPort;
    readonly retry?: {
      readonly now?: () => Date;
      readonly delayMs?: number;
      readonly maxAttempts?: number;
    };
  }) {}

  async reconcileStartup(): Promise<readonly NativeEvaluatorCoordinatorResult[]> {
    const outcomes: NativeEvaluatorCoordinatorResult[] = [];
    for (const evaluation of this.input.state.listEvaluations()
      .filter(({ state }) => !["complete", "withdrawn", "lost", "failed"].includes(state))) {
      outcomes.push(await this.reconcileEvaluation(evaluation.evaluationId));
    }
    return outcomes;
  }

  async reconcileEvaluation(id: NativeOperationId): Promise<NativeEvaluatorCoordinatorResult> {
    try {
      const current = this.input.state.getEvaluation(id);
      if (current?.state === "paused") {
        const now = this.input.retry?.now?.() ?? new Date();
        const resumed = this.input.state.resumeEvaluationRetry(id, now.toISOString());
        if (resumed === "waiting") return { kind: "paused", reason: "retry-not-due" };
        if (resumed === "failed") return { kind: "failed", reason: "evaluator-retry-deadline" };
      }
      return await this.drive(id);
    } catch (cause) {
      const reason = cause instanceof EvaluatorCoordinatorFailure
        ? cause.reason
        : "evaluator-dependency-failed";
      if ((cause instanceof EvaluatorCoordinatorFailure && !cause.retryable)
        || cause instanceof NativeEvaluatorStateConflictError
        || cause instanceof TypeError) {
        this.input.state.recordEvaluationFailed(id, reason);
        return { kind: "failed", reason };
      }
      const evaluation = this.input.state.getEvaluation(id);
      if (evaluation === undefined) return { kind: "failed", reason };
      const now = this.input.retry?.now?.() ?? new Date();
      const scheduled = this.input.state.recordEvaluationPaused(id, {
        reason,
        nextAttemptAt: new Date(now.getTime() + (this.input.retry?.delayMs ?? 1_000)).toISOString(),
        deadline: this.input.deadline(evaluation),
        maxAttempts: this.input.retry?.maxAttempts ?? 5,
      });
      return scheduled === "paused"
        ? { kind: "paused", reason }
        : { kind: "failed", reason: "evaluator-retry-exhausted" };
    }
  }

  private evaluation(id: NativeOperationId): NativeEvaluationRow {
    const value = this.input.state.getEvaluation(id);
    if (value === undefined) throw new EvaluatorCoordinatorFailure("evaluation-missing");
    return value;
  }

  private async prepareClaim(evaluation: NativeEvaluationRow): Promise<void> {
    const subject = materialFromState(this.input.state, evaluation.evaluationId);
    if (this.input.state.getAdmissionAuthority(evaluation.evaluationId) === undefined) {
      const authority = await verifyNativeSubjectAuthority({
        material: subject,
        claim: await this.input.authority.claim(evaluation),
        dependencies: this.input.authority.dependencies,
      });
      this.input.state.recordAdmissionVerified(evaluation.evaluationId, authority);
    }
    let derived = this.input.state.getDerivedEvaluation(evaluation.evaluationId);
    if (derived === undefined) {
      const sealed = deriveNativeEvaluation({
        evaluationId: evaluation.evaluationId,
        evaluatorAgent: evaluation.evaluatorAgent,
        material: subject,
        deadline: this.input.deadline(evaluation),
      });
      this.input.state.recordDerivedEvaluation(evaluation.evaluationId, sealed);
      derived = this.input.state.getDerivedEvaluation(evaluation.evaluationId)!;
    }
    this.input.state.beginEvaluationClaim(evaluation.evaluationId, sha256Bytes32(derived.taskDigest));
  }

  private async alignOperation(
    operation: NativeEvaluationOperationRow,
    canonicalHash: `0x${string}`,
  ): Promise<void> {
    if (operation.txHash !== null && operation.txHash !== canonicalHash) {
      this.input.state.recordOperationReplacement(
        operation.operationId,
        operation.txHash as `0x${string}`,
        canonicalHash,
      );
    } else if (operation.txHash === null) {
      this.input.state.recordOperationBroadcast(operation.operationId, canonicalHash);
    }
  }

  private async reconcileMissing(operation: NativeEvaluationOperationRow): Promise<boolean> {
    if (operation.txHash === null) return false;
    const status = await this.input.chain.transactionStatus(operation.txHash as `0x${string}`);
    if (status.kind === "replaced") {
      this.input.state.recordOperationReplacement(operation.operationId, operation.txHash as `0x${string}`, status.txHash);
      return true;
    }
    if (status.kind === "orphaned") {
      this.input.state.recordEvaluationOperationOrphaned(operation.operationId, status.reason);
      return true;
    }
    return true;
  }

  private async claim(evaluation: NativeEvaluationRow): Promise<NativeEvaluatorCoordinatorResult> {
    const operation = this.input.state.listEvaluationOperations(evaluation.evaluationId)
      .find(({ kind }) => kind === "evaluation-claim");
    if (operation === undefined) throw new EvaluatorCoordinatorFailure("evaluation-claim-intent-missing");
    let canonical = await this.input.verdictPorts.readCanonicalVerdictAttempt({
      taskId: evaluation.taskId,
      attemptIndex: evaluation.solutionAttemptIndex,
      fromBlock: evaluation.blockNumber,
      evaluator: this.input.evaluatorAddress,
    });
    if (canonical === undefined) {
      if (await this.reconcileMissing(operation)) return { kind: "evaluation-claim-pending" };
      const availability = await this.input.verdictPorts.canOpenVerdictAttempt({
        taskId: evaluation.taskId,
        attemptIndex: evaluation.solutionAttemptIndex,
      });
      if (!availability.ok) throw new EvaluatorCoordinatorFailure("evaluation-claim-refused", availability.reason);
      const derived = this.input.state.getDerivedEvaluation(evaluation.evaluationId)!;
      const opened = await this.input.verdictPorts.openVerdictAttempt({
        operationId: operation.operationId,
        taskId: evaluation.taskId,
        attemptIndex: evaluation.solutionAttemptIndex,
        evaluationTaskCidDigest: sha256Bytes32(derived.taskDigest),
        reconciliationFromBlock: evaluation.blockNumber,
      });
      this.input.state.recordOperationBroadcast(operation.operationId, opened.transaction.hash);
      canonical = await this.input.verdictPorts.readCanonicalVerdictAttempt({
        taskId: evaluation.taskId,
        attemptIndex: evaluation.solutionAttemptIndex,
        fromBlock: evaluation.blockNumber,
        evaluator: this.input.evaluatorAddress,
      });
      if (canonical === undefined) return { kind: "evaluation-claim-pending" };
    }
    await this.alignOperation(this.input.state.getEvaluationOperation(operation.operationId)!, canonical.transaction.hash);
    if (!await this.input.chain.isFinalized(canonical.transaction)) {
      return { kind: "evaluation-claim-pending" };
    }
    if (canonical.evaluator.toLowerCase() !== this.input.evaluatorAddress.toLowerCase()) {
      throw new EvaluatorCoordinatorFailure("canonical-evaluator-mismatch");
    }
    this.input.state.recordEvaluationClaimFinalized(operation.operationId, {
      txHash: canonical.transaction.hash,
      blockHash: canonical.transaction.blockHash,
      blockNumber: canonical.transaction.blockNumber,
      requestId: canonical.requestId,
      verdictIndex: canonical.verdictIndex,
      evaluatorAddress: canonical.evaluator,
    });
    return { kind: "evaluating" };
  }

  private async execute(evaluation: NativeEvaluationRow): Promise<NativeEvaluatorCoordinatorResult> {
    const derived = this.input.state.getDerivedEvaluation(evaluation.evaluationId);
    if (derived?.attemptUri === null || derived === undefined) {
      throw new EvaluatorCoordinatorFailure("evaluation-attempt-missing");
    }
    const operation = this.input.state.beginEvaluationExecution(evaluation.evaluationId);
    const submission = SubmissionRecordSchema.parse(parseJson(derived.submissionBytes, "evaluation Submission"));
    if (derived.dispatchContextBytes === null) {
      const sealedDispatch = serializeCanonicalJson({
        taskDigest: derived.taskDigest,
        submission: derived.submissionUri,
        nonce: submission.nonce,
        attempt: derived.attemptUri,
      });
      this.input.state.recordEvaluationDispatchContext(evaluation.evaluationId, sealedDispatch);
    }
    const recovered = this.input.state.getDerivedEvaluation(evaluation.evaluationId)!;
    if (recovered.dispatchContextBytes === null
      || documentDigest(recovered.dispatchContextBytes) !== recovered.dispatchContextDigest) {
      throw new EvaluatorCoordinatorFailure("evaluation-dispatch-context-missing");
    }
    const dispatchContext = parseJson(recovered.dispatchContextBytes, "evaluation DispatchContext") as TwoPartyEngagement["dispatchContext"];
    const engagement: TwoPartyEngagement = { attemptUri: derived.attemptUri, dispatchContext };
    const recovery = await this.input.backend.recover(derived.attemptUri);
    if (recovery.classification === "contradictory") {
      throw new EvaluatorCoordinatorFailure("evaluation-backend-contradictory", recovery.detail);
    }
    if (recovery.classification === "absent") {
      const acknowledgement = await this.input.backend.submit(derived.taskBytes, derived.submissionBytes, engagement);
      if (!acknowledgement.accepted) {
        throw new EvaluatorCoordinatorFailure("evaluation-backend-rejected", acknowledgement.error.detail);
      }
    }
    this.input.state.recordEvaluationBackendAccepted(operation.operationId);
    const snapshot = await this.input.backend.observe(derived.attemptUri);
    if (!snapshot.descriptor.derived.terminal) return { kind: "evaluating" };
    if (snapshot.descriptor.derived.state !== "delivered") {
      throw new EvaluatorCoordinatorFailure("evaluation-backend-terminal", snapshot.descriptor.derived.state);
    }
    await this.resolveVerdictGraph(evaluation.evaluationId);
    return { kind: "verdict-ready" };
  }

  private async resolveVerdictGraph(id: NativeOperationId): Promise<void> {
    const evaluation = this.evaluation(id);
    const derived = this.input.state.getDerivedEvaluation(id)!;
    const references = await this.input.backend.deliveries(derived.attemptUri!);
    if (references.length !== 1) throw new EvaluatorCoordinatorFailure("evaluation-delivery-cardinality");
    const reference = references[0]!;
    const deliveryBytes = await this.input.backend.fetchDelivery(reference);
    if (documentDigest(deliveryBytes) !== reference.digest) {
      throw new EvaluatorCoordinatorFailure("evaluation-delivery-digest-mismatch");
    }
    const record = delivery(deliveryBytes);
    if (record.task !== derived.taskDigest || record.attempt !== derived.attemptUri) {
      throw new EvaluatorCoordinatorFailure("evaluation-delivery-reference-mismatch");
    }
    const verdictDigest = digestOfOutput(record, "verdict");
    if (this.input.backend.fetchArtifact === undefined) {
      throw new EvaluatorCoordinatorFailure("verdict-retrieval-unavailable");
    }
    const verdictDescriptor = record.outputs.find(({ name }) => name === "verdict")!;
    const verdictBytes = await this.input.backend.fetchArtifact(verdictDescriptor);
    if (documentDigest(verdictBytes) !== verdictDigest) {
      throw new EvaluatorCoordinatorFailure("verdict-digest-mismatch");
    }
    const envelopeBytes = this.input.deliverySignature.get(reference.digest);
    if (envelopeBytes === undefined) throw new EvaluatorCoordinatorFailure("evaluation-delivery-envelope-missing", undefined, true);
    const artifacts: Array<{ role: string; name: string; mediaType: string; digest: `sha256:${string}`; bytes: Uint8Array }> = [
      {
        role: "evaluation-task", name: "evaluation-task",
        mediaType: "application/vnd.jinn.task-execution.task.v1+json",
        digest: derived.taskDigest, bytes: derived.taskBytes,
      },
      {
        role: "evaluation-submission", name: "evaluation-submission",
        mediaType: "application/vnd.jinn.task-execution.submission.v1+json",
        digest: derived.submissionDigest, bytes: derived.submissionBytes,
      },
      {
        role: "verdict", name: "verdict",
        mediaType: verdictDescriptor.mediaType ?? "application/vnd.in-toto+json",
        digest: verdictDigest, bytes: verdictBytes,
      },
      {
        role: "evaluation-delivery", name: "evaluation-delivery",
        mediaType: "application/vnd.jinn.task-execution.delivery.v1+json",
        digest: reference.digest, bytes: deliveryBytes,
      },
      {
        role: "evaluation-delivery-envelope",
        name: "evaluation-delivery-envelope",
        mediaType: "application/vnd.dsse.envelope.v1+json",
        digest: documentDigest(envelopeBytes),
        bytes: envelopeBytes,
      },
    ];
    for (const evidenceReference of record.evidenceRecords ?? []) {
      const typed = evidenceReference as EvidenceRecordReference;
      if ((await this.input.evidence.awaitIndexed(typed)).status !== "indexed") {
        throw new EvaluatorCoordinatorFailure("evaluation-evidence-not-indexed", undefined, true);
      }
      const bytes = await this.input.evidence.getRecord(typed);
      if (bytes === null || documentDigest(bytes) !== typed.digest) {
        if (bytes === null) throw new EvaluatorCoordinatorFailure("evaluation-evidence-unavailable", undefined, true);
        throw new EvaluatorCoordinatorFailure("evaluation-evidence-digest-mismatch");
      }
      artifacts.push({
        role: "evaluation-evidence",
        name: `evidence:${typed.family}`,
        mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE,
        digest: typed.digest,
        bytes,
      });
    }
    const transient = artifacts.map((artifact) => ({
      evaluationId: id,
      createdAt: record.createdAt,
      ...artifact,
    }));
    const verified = await this.input.verification.verify({
      evaluation,
      evaluationAuthority: this.input.state.getAdmissionAuthority(id)!,
      subject: materialFromState(this.input.state, id),
      derived,
      artifacts: transient,
    });
    if (!verified.ok) throw new EvaluatorCoordinatorFailure("verdict-gate-failed", verified.reason);
    this.input.state.recordVerdictReady(id, {
      sourceId: this.input.publisher.sourceId,
      verdictCode: verified.verdictCode,
      artifacts,
    });
  }

  private async publish(id: NativeOperationId): Promise<void> {
    const artifacts = this.input.state.listEvaluationArtifacts(id);
    for (const publication of this.input.state.listPendingEvaluationPublications()
      .filter(({ evaluationId }) => evaluationId === id)) {
      const artifact = artifacts.find(({ role, digest }) =>
        role === publication.role && digest === publication.recordDigest,
      );
      if (artifact === undefined) throw new EvaluatorCoordinatorFailure("evaluation-publication-artifact-missing");
      const receipt = await this.input.publisher.publish({ publication, artifact });
      this.input.state.recordEvaluationPublicationPublished(publication.publicationKey, receipt);
    }
  }

  private async ensureDecisionGrade(id: NativeOperationId, canonical?: CanonicalVerdictSettlement): Promise<VerdictCode> {
    const verified = await this.input.verification.verify({
      evaluation: this.evaluation(id),
      evaluationAuthority: this.input.state.getAdmissionAuthority(id)!,
      subject: materialFromState(this.input.state, id),
      derived: this.input.state.getDerivedEvaluation(id)!,
      artifacts: this.input.state.listEvaluationArtifacts(id),
      ...(canonical === undefined ? {} : { canonical }),
    });
    if (!verified.ok) throw new EvaluatorCoordinatorFailure("verdict-gate-failed", verified.reason);
    return verified.verdictCode;
  }

  private async deliver(id: NativeOperationId): Promise<NativeEvaluatorCoordinatorResult> {
    const evaluation = this.evaluation(id);
    const deliveryArtifact = this.input.state.listEvaluationArtifacts(id)
      .find(({ role }) => role === "evaluation-delivery");
    if (deliveryArtifact === undefined || evaluation.evaluationRequestId === null) {
      throw new EvaluatorCoordinatorFailure("evaluation-delivery-missing");
    }
    await this.ensureDecisionGrade(id);
    const intent = this.input.state.beginEvaluationMarketplaceDelivery(id);
    let operation = this.input.state.getEvaluationOperation(intent.operationId)!;
    let canonical: CanonicalVerdictDelivery | undefined = await this.input.verdictPorts.readCanonicalVerdictDelivery({
      requestId: evaluation.evaluationRequestId as `0x${string}`,
      deliveryDigest: sha256Bytes32(deliveryArtifact.digest),
      fromBlock: evaluation.blockNumber,
    });
    if (canonical === undefined && operation.txHash === null) {
      const result = await this.input.verdictPorts.deliverVerdictToMarketplace({
        operationId: operation.operationId,
        requestId: evaluation.evaluationRequestId as `0x${string}`,
        deliveryDigest: sha256Bytes32(deliveryArtifact.digest),
        reconciliationFromBlock: evaluation.blockNumber,
      });
      this.input.state.recordOperationBroadcast(operation.operationId, result.transaction.hash);
      canonical = await this.input.verdictPorts.readCanonicalVerdictDelivery({
        requestId: evaluation.evaluationRequestId as `0x${string}`,
        deliveryDigest: sha256Bytes32(deliveryArtifact.digest),
        fromBlock: evaluation.blockNumber,
      });
      operation = this.input.state.getEvaluationOperation(operation.operationId)!;
    }
    if (canonical === undefined) {
      await this.reconcileMissing(operation);
      return { kind: "verdict-published" };
    }
    await this.alignOperation(operation, canonical.transaction.hash);
    if (!await this.input.chain.isFinalized(canonical.transaction)) return { kind: "verdict-published" };
    this.input.state.recordEvaluationMarketplaceDeliveryFinalized(operation.operationId, {
      txHash: canonical.transaction.hash,
      blockHash: canonical.transaction.blockHash,
      blockNumber: canonical.transaction.blockNumber,
    });
    return { kind: "verdict-settlement-pending" };
  }

  private async settle(id: NativeOperationId): Promise<NativeEvaluatorCoordinatorResult> {
    const evaluation = this.evaluation(id);
    if (evaluation.evaluationRequestId === null || evaluation.verdictCode === null) {
      throw new EvaluatorCoordinatorFailure("verdict-settlement-identity-missing");
    }
    const verdictArtifact = this.input.state.listEvaluationArtifacts(id).find(({ role }) => role === "verdict");
    if (verdictArtifact === undefined) throw new EvaluatorCoordinatorFailure("verdict-artifact-missing");
    const intent = this.input.state.beginVerdictSettlement(id);
    let operation = this.input.state.getEvaluationOperation(intent.operationId)!;
    let canonical = await this.input.verdictPorts.readVerdictSettlement({
      requestId: evaluation.evaluationRequestId as `0x${string}`,
      fromBlock: evaluation.blockNumber,
    });
    if (canonical === undefined && operation.txHash === null) {
      await this.ensureDecisionGrade(id);
      const result = await this.input.verdictPorts.claimVerdictDelivery({
        operationId: operation.operationId,
        requestId: evaluation.evaluationRequestId as `0x${string}`,
        verdictDigest: sha256Bytes32(verdictArtifact.digest),
        verdictCode: evaluation.verdictCode as VerdictCode,
        reconciliationFromBlock: evaluation.blockNumber,
      });
      if (result.status === "rejected") throw new EvaluatorCoordinatorFailure("verdict-settlement-rejected");
      this.input.state.recordOperationBroadcast(operation.operationId, result.transaction.hash);
      canonical = await this.input.verdictPorts.readVerdictSettlement({
        requestId: evaluation.evaluationRequestId as `0x${string}`,
        fromBlock: evaluation.blockNumber,
      });
      operation = this.input.state.getEvaluationOperation(operation.operationId)!;
    }
    if (canonical === undefined) {
      await this.reconcileMissing(operation);
      return { kind: "verdict-settlement-pending" };
    }
    if (canonical.evaluator.toLowerCase() !== this.input.evaluatorAddress.toLowerCase()
      || canonical.taskId !== evaluation.taskId
      || canonical.attemptIndex !== evaluation.solutionAttemptIndex
      || canonical.verdictCode !== evaluation.verdictCode
      || canonical.verdictDigest.toLowerCase() !== sha256Bytes32(verdictArtifact.digest).toLowerCase()) {
      throw new EvaluatorCoordinatorFailure("canonical-verdict-correspondence-mismatch");
    }
    await this.alignOperation(operation, canonical.transaction.hash);
    if (!await this.input.chain.isFinalized(canonical.transaction)) {
      return { kind: "verdict-settlement-pending" };
    }
    const postFinality = await this.ensureDecisionGrade(id, canonical);
    if (postFinality !== canonical.verdictCode) {
      throw new EvaluatorCoordinatorFailure("post-finality-verdict-code-mismatch");
    }
    this.input.state.recordVerdictSettlementFinalized(operation.operationId, {
      txHash: canonical.transaction.hash,
      blockHash: canonical.transaction.blockHash,
      blockNumber: canonical.transaction.blockNumber,
    });
    return { kind: "complete" };
  }

  private async drive(id: NativeOperationId): Promise<NativeEvaluatorCoordinatorResult> {
    let evaluation = this.evaluation(id);
    if (evaluation.state === "evaluation-pending") {
      await this.prepareClaim(evaluation);
      evaluation = this.evaluation(id);
    }
    if (evaluation.state === "evaluation-claim-pending") {
      const result = await this.claim(evaluation);
      evaluation = this.evaluation(id);
      if (evaluation.state !== "evaluation-finalized") return result;
    }
    if (evaluation.state === "evaluation-finalized" || evaluation.state === "evaluating") {
      const result = await this.execute(evaluation);
      evaluation = this.evaluation(id);
      if (evaluation.state === "evaluating") return result;
    }
    if (evaluation.state === "verdict-ready") {
      await this.publish(id);
      evaluation = this.evaluation(id);
      if (evaluation.state === "verdict-ready") return { kind: "verdict-ready" };
    }
    if (evaluation.state === "verdict-published") {
      const delivery = this.input.state.listEvaluationOperations(id)
        .find(({ kind }) => kind === "evaluation-marketplace-delivery");
      if (delivery?.status !== "finalized") return this.deliver(id);
      return this.settle(id);
    }
    if (evaluation.state === "verdict-settlement-pending") return this.settle(id);
    if (evaluation.state === "complete") return { kind: "complete" };
    return { kind: "evaluation-pending" };
  }
}
