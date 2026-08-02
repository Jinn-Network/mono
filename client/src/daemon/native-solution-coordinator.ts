import type {
  TaskExecutionBackend,
  TwoPartyEngagement,
} from '@jinn-network/task-execution-backend';
import type { EvidenceRecordReference } from '@jinn-network/evidence-repository';
import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  serializeCanonicalJson,
  type DeliveryRecord,
  type DispatchContext,
  type ResourceDescriptor,
} from '@jinn-network/task-execution-protocol';
import {
  NativeOperatorStateRepository,
  type NativeEngagementRow,
  type NativeOperationRow,
  type NativePublicationRow,
  type NativeSolutionArtifactRow,
} from './native-operator-state.js';
import type { NativeOperationId } from './native-operation-identity.js';
import type { NativeSealedClaimDocuments } from './native-claim-coordinator.js';

export interface NativeSolutionVerificationInput {
  readonly engagement: NativeEngagementRow;
  readonly effectiveTime: string;
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly delivery: DeliveryRecord;
  readonly deliveryBytes: Uint8Array;
  readonly deliveryEnvelopeBytes: Uint8Array;
  readonly outputs: readonly NativeSolutionArtifactRow[];
  readonly evidence: readonly NativeSolutionArtifactRow[];
}

export interface NativeSolutionVerificationPort {
  verify(input: NativeSolutionVerificationInput): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface NativeSolutionPublisherPort {
  readonly sourceId: string;
  publish(input: {
    readonly publication: NativePublicationRow;
    readonly artifact: NativeSolutionArtifactRow;
    readonly bytes: Uint8Array;
  }): Promise<{
    readonly location: string;
    readonly sequence: string;
    readonly entryDigest: `sha256:${string}`;
  }>;
}

export type NativeSolutionSettlementCanonicalFact =
  | { readonly kind: 'absent'; readonly checkedAtBlock: bigint }
  | { readonly kind: 'broadcast'; readonly txHash: `0x${string}` }
  | { readonly kind: 'replaced'; readonly priorTxHash: `0x${string}`; readonly txHash: `0x${string}` }
  | { readonly kind: 'orphaned'; readonly txHash: `0x${string}`; readonly reason: string }
  | {
      readonly kind: 'finalized';
      readonly txHash: `0x${string}`;
      readonly blockHash: `0x${string}`;
      readonly blockNumber: bigint;
    };

export interface NativeSolutionSettlementPort {
  broadcast(input: {
    readonly operationId: NativeOperationId;
    readonly engagement: NativeEngagementRow;
    readonly deliveryBytes: Uint8Array;
  }): Promise<{ readonly txHash: `0x${string}` }>;
  readCanonical(input: {
    readonly operation: NativeOperationRow;
    readonly engagement: NativeEngagementRow;
  }): Promise<NativeSolutionSettlementCanonicalFact>;
}

export type NativeSolutionCoordinatorResult =
  | { readonly kind: 'executing' }
  | { readonly kind: 'solution-ready' }
  | { readonly kind: 'solution-published' }
  | { readonly kind: 'solution-settlement-pending' }
  | { readonly kind: 'solution-settled'; readonly operationId: NativeOperationId }
  | { readonly kind: 'failed'; readonly reason: string };

class NativeSolutionFailure extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ?? reason);
    this.name = 'NativeSolutionFailure';
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function exactJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new NativeSolutionFailure('invalid-exact-document', `${label} is not valid UTF-8 JSON: ${String(error)}`);
  }
}

function submissionFromExactBytes(bytes: Uint8Array) {
  const parsed = SubmissionRecordSchema.safeParse(exactJson(bytes, 'Submission'));
  if (!parsed.success || !bytesEqual(sealSubmission(parsed.data), bytes)) {
    throw new NativeSolutionFailure('invalid-submission', 'Submission bytes are not an exact canonical native seal');
  }
  return parsed.data;
}

function deliveryFromExactBytes(bytes: Uint8Array): DeliveryRecord {
  const parsed = DeliveryRecordSchema.safeParse(exactJson(bytes, 'Delivery'));
  if (!parsed.success || !bytesEqual(sealDelivery(parsed.data), bytes)) {
    throw new NativeSolutionFailure('invalid-delivery', 'Delivery bytes are not an exact canonical native seal');
  }
  if (parsed.data.executionIds === undefined || parsed.data.executionIds.length === 0) {
    throw new NativeSolutionFailure('missing-execution-ids');
  }
  if (parsed.data.evidenceRecords === undefined || parsed.data.evidenceRecords.length === 0) {
    throw new NativeSolutionFailure('missing-evidence-records');
  }
  return parsed.data;
}

function sha256Descriptor(descriptor: ResourceDescriptor): `sha256:${string}` {
  const sha256 = descriptor.digest?.sha256;
  if (typeof sha256 !== 'string') throw new NativeSolutionFailure('output-digest-missing');
  return `sha256:${sha256}`;
}

export class NativeSolutionCoordinator {
  constructor(private readonly input: {
    readonly state: NativeOperatorStateRepository;
    readonly backend: TaskExecutionBackend;
    readonly documents: {
      resolve(engagement: NativeEngagementRow): Promise<NativeSealedClaimDocuments>;
    };
    readonly deliverySignature: {
      get(deliveryDigest: `sha256:${string}`): Uint8Array | undefined;
    };
    readonly evidence: {
      awaitIndexed(reference: EvidenceRecordReference): Promise<{ readonly status: string }>;
      getRecord(reference: EvidenceRecordReference): Promise<Uint8Array | null>;
    };
    readonly verification: NativeSolutionVerificationPort;
    readonly publisher: NativeSolutionPublisherPort;
    readonly settlement: NativeSolutionSettlementPort;
  }) {}

  async reconcileStartup(): Promise<readonly NativeSolutionCoordinatorResult[]> {
    const outcomes: NativeSolutionCoordinatorResult[] = [];
    for (const engagement of this.input.state.listSolutionEngagements()) {
      outcomes.push(await this.reconcileEngagement(engagement.engagementId));
    }
    return outcomes;
  }

  async reconcileEngagement(engagementId: NativeOperationId): Promise<NativeSolutionCoordinatorResult> {
    try {
      return await this.drive(engagementId);
    } catch (error) {
      const reason = error instanceof NativeSolutionFailure ? error.reason : 'solution-dependency-failed';
      this.input.state.recordSolutionFailed(engagementId, {
        reason,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'failed', reason };
    }
  }

  private engagement(id: NativeOperationId): NativeEngagementRow {
    const engagement = this.input.state.getEngagement(id);
    if (engagement === undefined) throw new NativeSolutionFailure('engagement-missing');
    return engagement;
  }

  private async prepareExecution(engagement: NativeEngagementRow): Promise<void> {
    const documents = await this.input.documents.resolve(engagement);
    const submission = submissionFromExactBytes(documents.submissionBytes);
    const dispatchContext: DispatchContext = {
      taskDigest: engagement.taskDigest,
      submission: engagement.submissionUri,
      nonce: submission.nonce,
      attempt: engagement.attemptUri as `urn:uuid:${string}`,
    };
    const dispatchContextBytes = serializeCanonicalJson(
      dispatchContext as Parameters<typeof serializeCanonicalJson>[0],
    );
    this.input.state.beginSolutionExecution(engagement.engagementId, {
      taskBytes: documents.taskBytes,
      submissionBytes: documents.submissionBytes,
      dispatchContextBytes,
    });
  }

  private async execute(engagementId: NativeOperationId): Promise<'executing' | 'ready'> {
    const engagement = this.engagement(engagementId);
    const execution = this.input.state.getSolutionExecution(engagementId);
    if (execution === undefined) throw new NativeSolutionFailure('execution-intent-missing');
    const dispatch = exactJson(execution.dispatchContextBytes, 'DispatchContext') as DispatchContext;
    const twoParty: TwoPartyEngagement = {
      attemptUri: execution.attemptUri as `urn:uuid:${string}`,
      dispatchContext: dispatch,
    };
    const recovery = await this.input.backend.recover(twoParty.attemptUri);
    if (recovery.classification === 'contradictory') {
      throw new NativeSolutionFailure('backend-contradictory', recovery.detail);
    }
    if (recovery.classification === 'absent') {
      const acknowledgement = await this.input.backend.submit(
        execution.taskBytes,
        execution.submissionBytes,
        twoParty,
      );
      if (!acknowledgement.accepted) {
        throw new NativeSolutionFailure('backend-rejected', acknowledgement.error.detail);
      }
    }
    this.input.state.recordBackendSubmissionAccepted(execution.operationId);
    const snapshot = await this.input.backend.observe(twoParty.attemptUri);
    if (!snapshot.descriptor.derived.terminal) return 'executing';
    if (snapshot.descriptor.derived.state !== 'delivered') {
      throw new NativeSolutionFailure('backend-terminal-failure', snapshot.descriptor.derived.state);
    }
    await this.resolveSolutionGraph(engagementId);
    return 'ready';
  }

  private async resolveSolutionGraph(engagementId: NativeOperationId): Promise<void> {
    const engagement = this.engagement(engagementId);
    const execution = this.input.state.getSolutionExecution(engagementId)!;
    const references = await this.input.backend.deliveries(execution.attemptUri as `urn:uuid:${string}`);
    if (references.length !== 1) throw new NativeSolutionFailure('delivery-cardinality');
    const reference = references[0]!;
    const deliveryBytes = await this.input.backend.fetchDelivery(reference);
    if (documentDigest(deliveryBytes) !== reference.digest) throw new NativeSolutionFailure('delivery-digest-mismatch');
    const delivery = deliveryFromExactBytes(deliveryBytes);
    if (delivery.attempt !== execution.attemptUri || delivery.task !== engagement.taskDigest) {
      throw new NativeSolutionFailure('delivery-reference-mismatch');
    }
    const deliveryEnvelopeBytes = this.input.deliverySignature.get(reference.digest);
    if (deliveryEnvelopeBytes === undefined) throw new NativeSolutionFailure('delivery-envelope-missing');

    const artifacts: Array<{
      role: 'output' | 'evidence' | 'delivery' | 'delivery-envelope';
      family: string;
      name?: string;
      digest: `sha256:${string}`;
      bytes: Uint8Array;
    }> = [];
    for (const evidenceReference of delivery.evidenceRecords ?? []) {
      const referenceValue = evidenceReference as EvidenceRecordReference;
      const indexed = await this.input.evidence.awaitIndexed(referenceValue);
      if (indexed.status !== 'indexed') throw new NativeSolutionFailure('evidence-not-indexed', indexed.status);
      const bytes = await this.input.evidence.getRecord(referenceValue);
      if (bytes === null) throw new NativeSolutionFailure('evidence-unavailable');
      if (documentDigest(bytes) !== referenceValue.digest) throw new NativeSolutionFailure('evidence-digest-mismatch');
      artifacts.push({
        role: 'evidence',
        family: referenceValue.family,
        digest: referenceValue.digest,
        bytes,
      });
    }
    if (this.input.backend.fetchArtifact === undefined && delivery.outputs.length > 0) {
      throw new NativeSolutionFailure('output-retrieval-unavailable');
    }
    for (const output of delivery.outputs) {
      const bytes = await this.input.backend.fetchArtifact!(output);
      const digest = sha256Descriptor(output);
      if (documentDigest(bytes) !== digest) throw new NativeSolutionFailure('output-digest-mismatch');
      artifacts.push({
        role: 'output',
        family: output.mediaType ?? 'application/octet-stream',
        name: output.name,
        digest,
        bytes,
      });
    }
    artifacts.push({ role: 'delivery', family: 'delivery', digest: reference.digest, bytes: deliveryBytes });
    artifacts.push({
      role: 'delivery-envelope',
      family: 'delivery-envelope',
      digest: documentDigest(deliveryEnvelopeBytes),
      bytes: deliveryEnvelopeBytes,
    });

    const artifactRows = artifacts.map((artifact) => ({
      engagementId,
      ...artifact,
      name: artifact.name ?? null,
      createdAt: delivery.createdAt,
    }));
    const verification = await this.input.verification.verify({
      engagement,
      effectiveTime: delivery.createdAt,
      taskBytes: execution.taskBytes,
      submissionBytes: execution.submissionBytes,
      dispatchContextBytes: execution.dispatchContextBytes,
      delivery,
      deliveryBytes,
      deliveryEnvelopeBytes,
      outputs: artifactRows.filter(({ role }) => role === 'output'),
      evidence: artifactRows.filter(({ role }) => role === 'evidence'),
    });
    if (!verification.ok) throw new NativeSolutionFailure(verification.reason);
    this.input.state.recordSolutionReady(engagementId, {
      sourceId: this.input.publisher.sourceId,
      artifacts,
    });
  }

  private async publish(engagementId: NativeOperationId): Promise<void> {
    const artifacts = this.input.state.listSolutionArtifacts(engagementId);
    for (const publication of this.input.state.listPendingPublications()
      .filter((candidate) => candidate.engagementId === engagementId)) {
      const artifact = artifacts.find(
        (candidate) => candidate.role === publication.role && candidate.digest === publication.recordDigest,
      );
      if (artifact === undefined) throw new NativeSolutionFailure('publication-artifact-missing');
      const receipt = await this.input.publisher.publish({
        publication,
        artifact,
        bytes: artifact.bytes,
      });
      this.input.state.recordPublicationPublished(publication.publicationKey, receipt);
    }
  }

  private async settle(engagementId: NativeOperationId): Promise<NativeSolutionCoordinatorResult> {
    const engagement = this.engagement(engagementId);
    const intent = this.input.state.beginSolutionSettlement(engagementId);
    let operation = this.input.state.getOperation(intent.operationId)!;
    let fact = await this.input.settlement.readCanonical({ operation, engagement });
    if (fact.kind === 'finalized') {
      this.input.state.recordSolutionSettlementFinalized(intent.operationId, fact);
      return { kind: 'solution-settled', operationId: intent.operationId };
    }
    if (fact.kind === 'replaced') {
      this.input.state.recordSolutionSettlementReplacement(intent.operationId, fact.priorTxHash, fact.txHash);
      return { kind: 'solution-settlement-pending' };
    }
    if (fact.kind === 'orphaned') {
      this.input.state.recordSolutionSettlementOrphaned(intent.operationId, fact);
      return { kind: 'solution-published' };
    }
    if (fact.kind === 'broadcast') {
      this.input.state.recordSolutionSettlementBroadcast(intent.operationId, fact.txHash);
      return { kind: 'solution-settlement-pending' };
    }
    if (operation.status !== 'intent') return { kind: 'solution-settlement-pending' };
    const delivery = this.input.state.listSolutionArtifacts(engagementId)
      .find(({ role }) => role === 'delivery');
    if (delivery === undefined) throw new NativeSolutionFailure('settlement-delivery-missing');
    const broadcast = await this.input.settlement.broadcast({
      operationId: intent.operationId,
      engagement,
      deliveryBytes: delivery.bytes,
    });
    this.input.state.recordSolutionSettlementBroadcast(intent.operationId, broadcast.txHash);
    operation = this.input.state.getOperation(intent.operationId)!;
    fact = await this.input.settlement.readCanonical({ operation, engagement });
    if (fact.kind === 'finalized') {
      this.input.state.recordSolutionSettlementFinalized(intent.operationId, fact);
      return { kind: 'solution-settled', operationId: intent.operationId };
    }
    if (fact.kind === 'replaced') {
      this.input.state.recordSolutionSettlementReplacement(intent.operationId, fact.priorTxHash, fact.txHash);
    } else if (fact.kind === 'orphaned') {
      this.input.state.recordSolutionSettlementOrphaned(intent.operationId, fact);
      return { kind: 'solution-published' };
    }
    return { kind: 'solution-settlement-pending' };
  }

  private async drive(engagementId: NativeOperationId): Promise<NativeSolutionCoordinatorResult> {
    let engagement = this.engagement(engagementId);
    if (engagement.state === 'claim-finalized') {
      await this.prepareExecution(engagement);
      engagement = this.engagement(engagementId);
    }
    if (engagement.state === 'executing') {
      const outcome = await this.execute(engagementId);
      if (outcome === 'executing') return { kind: 'executing' };
      engagement = this.engagement(engagementId);
    }
    if (engagement.state === 'solution-ready') {
      await this.publish(engagementId);
      engagement = this.engagement(engagementId);
      if (engagement.state === 'solution-ready') return { kind: 'solution-ready' };
    }
    if (engagement.state === 'solution-published' || engagement.state === 'solution-settlement-pending') {
      return this.settle(engagementId);
    }
    if (engagement.state === 'solution-settled') {
      const operation = this.input.state.listOperations(engagementId)
        .find(({ kind }) => kind === 'solution-settlement');
      if (operation === undefined) throw new NativeSolutionFailure('settlement-operation-missing');
      return { kind: 'solution-settled', operationId: operation.operationId };
    }
    if (engagement.state === 'failed') return { kind: 'failed', reason: 'failed-terminal' };
    return { kind: 'solution-settlement-pending' };
  }
}
