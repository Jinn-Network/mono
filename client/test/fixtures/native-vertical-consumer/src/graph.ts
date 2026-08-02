import {
  LOCATION_PROFILE_HTTPS,
  RECORD_KINDS,
  parseAnnouncementEntry,
  recordPath,
  type AvailableAnnouncement,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  DiscoveryQueryClient,
  type Transport,
} from '@jinn-network/record-discovery-client';
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  TASK_MEDIA_TYPE,
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import {
  EVALUATION_SPEC_MEDIA_TYPE,
  bytesEqual,
  parseEvaluationSpec,
  sealEvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  EXECUTION_EVIDENCE_MEDIA_TYPE,
  validateExecutionEvidence,
} from '@jinn-network/evidence-protocol';
import {
  DSSE_ENVELOPE_MEDIA_TYPE,
  parseExactDsseEnvelope,
} from '@jinn-network/trust-core';
import { deriveEvaluationTask } from '@jinn-network/task-execution-profiles';
import { ConsumerState } from './state.js';

const REQUESTER_ASSOCIATION_FACT = 'https://jinn.network/facts/native-requester-association/1.0';
const DELIVERY_ENVELOPE_KIND = 'https://jinn.network/records/delivery-envelope/1.0';
const VERDICT_MEDIA_TYPE = 'application/vnd.in-toto+json';
const UINT256_MAX = (1n << 256n) - 1n;

export class NativeGraphError extends Error {
  override readonly name = 'NativeGraphError';
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

export interface PublicSourceConfiguration {
  readonly source: SourceIdentity;
  readonly publicBaseUrl: string;
}

export interface LocatedRecordRoot {
  readonly digest: `sha256:${string}`;
  readonly kind: string;
  readonly mediaType: string;
  readonly locator: string;
}

export interface NativeGraphRoots {
  readonly runId: string;
  readonly requester: {
    readonly source: PublicSourceConfiguration;
    readonly submission: LocatedRecordRoot;
    readonly taskDigest: `sha256:${string}`;
    readonly requesterEnvelopeDigest: `sha256:${string}`;
    readonly admissionReceiptDigest: `sha256:${string}`;
    readonly submissionUri: `urn:uuid:${string}`;
    readonly nonce: string;
    readonly postingTerms: {
      readonly solutionMaxDeliveryRateWei: string;
      readonly verdictMaxDeliveryRateWei: string;
      readonly responseTimeoutSeconds: string;
      readonly allowSolverSelfEvaluation: false;
    };
    readonly intendedSpendWei: string;
    readonly chain: {
      readonly chainId: number;
      readonly coordinator: `0x${string}`;
      readonly taskId: string;
    };
  };
  readonly solution: {
    readonly source: PublicSourceConfiguration;
    readonly engagementId: `sha256:${string}`;
    readonly solverAgent: string;
    readonly delivery: LocatedRecordRoot;
    readonly deliveryEnvelope: LocatedRecordRoot;
  };
  readonly evaluation: {
    readonly source: PublicSourceConfiguration;
    readonly evaluationId: `sha256:${string}`;
    readonly evaluatorAgent: string;
    readonly task: LocatedRecordRoot;
    readonly submission: LocatedRecordRoot;
    readonly verdict: LocatedRecordRoot;
    readonly delivery: LocatedRecordRoot;
    readonly deliveryEnvelope: LocatedRecordRoot;
    readonly evidence: readonly LocatedRecordRoot[];
  };
}

export interface ExactPublicArtifact {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface NativePublicGraph {
  readonly roots: NativeGraphRoots;
  readonly task: ExactPublicArtifact;
  readonly submission: ExactPublicArtifact;
  readonly evaluationSpec: ExactPublicArtifact;
  readonly admissionReceipt: ExactPublicArtifact;
  readonly requesterEnvelope: ExactPublicArtifact;
  readonly solution: {
    readonly delivery: ExactPublicArtifact;
    readonly deliveryEnvelope: ExactPublicArtifact;
    readonly outputs: readonly ExactPublicArtifact[];
    readonly evidence: readonly ExactPublicArtifact[];
  };
  readonly evaluation: {
    readonly task: ExactPublicArtifact;
    readonly submission: ExactPublicArtifact;
    readonly verdict: ExactPublicArtifact;
    readonly delivery: ExactPublicArtifact;
    readonly deliveryEnvelope: ExactPublicArtifact;
    readonly evidence: readonly ExactPublicArtifact[];
  };
  readonly all: readonly ExactPublicArtifact[];
}

interface ActiveAnnouncement {
  readonly announcement: AvailableAnnouncement;
  readonly facts: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function publicBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new NativeGraphError('public-source-base-invalid'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new NativeGraphError('public-source-base-invalid');
  }
  if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/iu.test(url.hostname)) {
    throw new NativeGraphError('public-source-base-private');
  }
  return value.replace(/\/+$/u, '');
}

function activeAnnouncements(state: ConsumerState, source: SourceIdentity): ActiveAnnouncement[] {
  if (state.checkpoint(source) === undefined) throw new NativeGraphError('source-not-synced', source.name);
  const available = new Map<string, ActiveAnnouncement>();
  const retracted = new Set<string>();
  for (const row of state.entries(source).filter((value) => value.active)) {
    let entry;
    try { entry = parseAnnouncementEntry(JSON.parse(row.entryJson)); }
    catch { throw new NativeGraphError('verified-source-entry-corrupt', row.digest); }
    if (entry.source.agent !== source.agent || entry.source.name !== source.name) {
      throw new NativeGraphError('verified-source-entry-mismatch', row.digest);
    }
    for (const announcement of entry.announcements) {
      if (announcement.action === 'withdrawn') {
        retracted.add(announcement.retracts);
        available.delete(announcement.retracts);
      } else if (!retracted.has(announcement.announcementId)) {
        available.set(announcement.announcementId, {
          announcement,
          facts: record(announcement.facts) ?? {},
        });
      }
    }
  }
  return [...available.values()];
}

function exactlyOne<T>(values: readonly T[], reason: string): T {
  if (values.length !== 1) throw new NativeGraphError(reason, `expected 1, got ${values.length}`);
  return values[0]!;
}

function located(
  value: ActiveAnnouncement,
  source: PublicSourceConfiguration,
  expected: { readonly kind: string; readonly mediaType?: string },
): LocatedRecordRoot {
  const base = publicBase(source.publicBaseUrl);
  const { record: ref, locations } = value.announcement;
  if (ref.kind !== expected.kind || ref.mediaType === undefined
    || (expected.mediaType !== undefined && ref.mediaType !== expected.mediaType)) {
    throw new NativeGraphError('public-record-shape-mismatch');
  }
  const expectedLocator = `${base}${recordPath(ref.digest)}`;
  const matching = (locations ?? []).filter((candidate) =>
    candidate.profile === LOCATION_PROFILE_HTTPS && candidate.locator === expectedLocator,
  );
  if (matching.length !== 1) throw new NativeGraphError('public-record-location-missing', ref.digest);
  return { digest: ref.digest, kind: ref.kind, mediaType: ref.mediaType, locator: expectedLocator };
}

function stringFact(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new NativeGraphError('public-record-fact-invalid', label);
  return value;
}

function digestFact(value: unknown, label: string): `sha256:${string}` {
  const digest = stringFact(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new NativeGraphError('public-record-fact-invalid', label);
  return digest as `sha256:${string}`;
}

function uint256Fact(value: unknown, label: string): { readonly wire: string; readonly value: bigint } {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new NativeGraphError('public-record-fact-invalid', label);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new NativeGraphError('public-record-fact-invalid', label);
  return { wire: value, value: parsed };
}

function postingTermsFact(value: unknown): NativeGraphRoots['requester']['postingTerms'] {
  const terms = record(value);
  const keys = [
    'allowSolverSelfEvaluation',
    'responseTimeoutSeconds',
    'solutionMaxDeliveryRateWei',
    'verdictMaxDeliveryRateWei',
  ];
  if (terms === undefined || Object.keys(terms).sort().join('|') !== keys.join('|')
    || terms.allowSolverSelfEvaluation !== false) {
    throw new NativeGraphError('public-record-fact-invalid', 'postingTerms');
  }
  return {
    solutionMaxDeliveryRateWei: uint256Fact(terms.solutionMaxDeliveryRateWei, 'solutionMaxDeliveryRateWei').wire,
    verdictMaxDeliveryRateWei: uint256Fact(terms.verdictMaxDeliveryRateWei, 'verdictMaxDeliveryRateWei').wire,
    responseTimeoutSeconds: uint256Fact(terms.responseTimeoutSeconds, 'responseTimeoutSeconds').wire,
    allowSolverSelfEvaluation: false,
  };
}

function stableOperationId(value: Parameters<typeof serializeCanonicalJson>[0]): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(value));
}

/** Independently re-derives the Tier 4 engagement identity; announcement facts are only joins. */
export function deriveConsumerEngagementId(input: {
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: string;
  readonly solverAgent: string;
}): `sha256:${string}` {
  if (!/^\d+$/u.test(input.taskId) || input.solverAgent.length === 0) {
    throw new NativeGraphError('public-record-fact-invalid', 'engagement identity');
  }
  return stableOperationId({
    v: 1,
    chainId: String(input.chainId),
    coordinator: input.coordinator.toLowerCase(),
    taskId: BigInt(input.taskId).toString(10),
    role: 'solver',
    agent: input.solverAgent,
  });
}

/** Independently re-derives the Tier 4 evaluation identity after the solution Delivery is fixed. */
export function deriveConsumerEvaluationId(input: {
  readonly taskDigest: `sha256:${string}`;
  readonly solutionDeliveryDigest: `sha256:${string}`;
  readonly evaluatorAgent: string;
}): `sha256:${string}` {
  if (input.evaluatorAgent.length === 0) throw new NativeGraphError('actor-agent-invalid', 'evaluator');
  return stableOperationId({
    v: 1,
    kind: 'evaluation',
    subjectTaskDigest: input.taskDigest,
    subjectDeliveryDigest: input.solutionDeliveryDigest,
    evaluatorAgent: input.evaluatorAgent,
  });
}

/** Builds roots exclusively from the active, already source-chain-verified announcement history. */
export function discoverNativeGraphRoots(input: {
  readonly state: ConsumerState;
  readonly runId: string;
  readonly sources: {
    readonly requester: PublicSourceConfiguration;
    readonly solver: PublicSourceConfiguration;
    readonly evaluator: PublicSourceConfiguration;
  };
  readonly actors: {
    readonly solverAgent: string;
    readonly evaluatorAgent: string;
  };
}): NativeGraphRoots {
  if (input.runId.length === 0) throw new NativeGraphError('run-id-invalid');
  const requesterAnnouncements = activeAnnouncements(input.state, input.sources.requester.source);
  const requesterMatch = exactlyOne(requesterAnnouncements.filter((candidate) => {
    const association = record(candidate.facts[REQUESTER_ASSOCIATION_FACT]);
    return candidate.announcement.record.kind === RECORD_KINDS.submission && association?.runId === input.runId;
  }), 'requester-root-ambiguous');
  const association = record(requesterMatch.facts[REQUESTER_ASSOCIATION_FACT])!;
  const associationMembers = [
    'admissionReceiptDigest', 'chainId', 'coordinator', 'intendedSpendWei', 'nonce',
    'postingTerms', 'requesterEnvelopeDigest', 'runId', 'submission', 'taskDigest', 'taskId',
  ];
  if (Object.keys(association).sort().join('|') !== associationMembers.sort().join('|')) {
    throw new NativeGraphError('public-record-fact-invalid', 'requester association members');
  }
  const chainId = association.chainId;
  const coordinator = stringFact(association.coordinator, 'coordinator');
  if (!Number.isSafeInteger(chainId) || (chainId as number) < 0 || !/^0x[a-fA-F0-9]{40}$/u.test(coordinator)) {
    throw new NativeGraphError('public-record-fact-invalid', 'chain identity');
  }
  const taskDigest = digestFact(association.taskDigest, 'taskDigest');
  const taskId = uint256Fact(association.taskId, 'taskId').wire;
  const submissionUri = stringFact(association.submission, 'submission');
  const nonce = stringFact(association.nonce, 'nonce');
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(submissionUri)) {
    throw new NativeGraphError('public-record-fact-invalid', 'submission');
  }
  const postingTerms = postingTermsFact(association.postingTerms);
  const intendedSpend = uint256Fact(association.intendedSpendWei, 'intendedSpendWei');
  if (intendedSpend.value !== BigInt(postingTerms.solutionMaxDeliveryRateWei)
      + BigInt(postingTerms.verdictMaxDeliveryRateWei)) {
    throw new NativeGraphError('public-record-fact-invalid', 'intendedSpendWei');
  }
  const engagementId = deriveConsumerEngagementId({
    chainId: chainId as number,
    coordinator,
    taskId,
    solverAgent: input.actors.solverAgent,
  });

  const solutionAnnouncements = activeAnnouncements(input.state, input.sources.solver.source);
  const deliveries = solutionAnnouncements.filter((candidate) =>
    candidate.facts.role === 'delivery' && candidate.facts.engagementId === engagementId,
  );
  const deliveryMatch = exactlyOne(deliveries, 'solution-delivery-root-ambiguous');
  const solutionEnvelope = exactlyOne(solutionAnnouncements.filter((candidate) =>
    candidate.facts.role === 'delivery-envelope' && candidate.facts.engagementId === engagementId,
  ), 'solution-envelope-root-ambiguous');

  const evaluatorAnnouncements = activeAnnouncements(input.state, input.sources.evaluator.source);
  const evaluationId = deriveConsumerEvaluationId({
    taskDigest,
    solutionDeliveryDigest: deliveryMatch.announcement.record.digest,
    evaluatorAgent: input.actors.evaluatorAgent,
  });
  const evaluationDeliveries = evaluatorAnnouncements.filter((candidate) =>
    candidate.facts.role === 'evaluation-delivery' && candidate.facts.evaluationId === evaluationId,
  );
  const evaluationDelivery = exactlyOne(evaluationDeliveries, 'evaluation-delivery-root-ambiguous');
  const evaluationRole = (role: string) => evaluatorAnnouncements.filter((candidate) =>
    candidate.facts.role === role && candidate.facts.evaluationId === evaluationId,
  );

  return {
    runId: input.runId,
    requester: {
      source: { ...input.sources.requester, publicBaseUrl: publicBase(input.sources.requester.publicBaseUrl) },
      submission: located(requesterMatch, input.sources.requester, { kind: RECORD_KINDS.submission, mediaType: SUBMISSION_MEDIA_TYPE }),
      taskDigest,
      requesterEnvelopeDigest: digestFact(association.requesterEnvelopeDigest, 'requesterEnvelopeDigest'),
      admissionReceiptDigest: digestFact(association.admissionReceiptDigest, 'admissionReceiptDigest'),
      submissionUri: submissionUri as `urn:uuid:${string}`,
      nonce,
      postingTerms,
      intendedSpendWei: intendedSpend.wire,
      chain: {
        chainId: chainId as number,
        coordinator: coordinator as `0x${string}`,
        taskId,
      },
    },
    solution: {
      source: { ...input.sources.solver, publicBaseUrl: publicBase(input.sources.solver.publicBaseUrl) },
      engagementId,
      solverAgent: input.actors.solverAgent,
      delivery: located(deliveryMatch, input.sources.solver, { kind: RECORD_KINDS.delivery, mediaType: DELIVERY_MEDIA_TYPE }),
      deliveryEnvelope: located(solutionEnvelope, input.sources.solver, { kind: DELIVERY_ENVELOPE_KIND, mediaType: DSSE_ENVELOPE_MEDIA_TYPE }),
    },
    evaluation: {
      source: { ...input.sources.evaluator, publicBaseUrl: publicBase(input.sources.evaluator.publicBaseUrl) },
      evaluationId,
      evaluatorAgent: input.actors.evaluatorAgent,
      task: located(exactlyOne(evaluationRole('evaluation-task'), 'evaluation-task-root-ambiguous'), input.sources.evaluator, {
        kind: RECORD_KINDS.task, mediaType: TASK_MEDIA_TYPE,
      }),
      submission: located(exactlyOne(evaluationRole('evaluation-submission'), 'evaluation-submission-root-ambiguous'), input.sources.evaluator, {
        kind: RECORD_KINDS.submission, mediaType: SUBMISSION_MEDIA_TYPE,
      }),
      verdict: located(exactlyOne(evaluationRole('verdict'), 'verdict-root-ambiguous'), input.sources.evaluator, {
        kind: RECORD_KINDS.resultEvaluation, mediaType: VERDICT_MEDIA_TYPE,
      }),
      delivery: located(evaluationDelivery, input.sources.evaluator, {
        kind: RECORD_KINDS.delivery, mediaType: DELIVERY_MEDIA_TYPE,
      }),
      deliveryEnvelope: located(exactlyOne(evaluationRole('evaluation-delivery-envelope'), 'evaluation-envelope-root-ambiguous'), input.sources.evaluator, {
        kind: DELIVERY_ENVELOPE_KIND, mediaType: DSSE_ENVELOPE_MEDIA_TYPE,
      }),
      evidence: evaluationRole('evaluation-evidence').map((candidate) => located(candidate, input.sources.evaluator, {
        kind: RECORD_KINDS.executionEvidence, mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE,
      })).sort((left, right) => left.digest.localeCompare(right.digest)),
    },
  };
}

function exactJson<T>(input: {
  readonly artifact: ExactPublicArtifact;
  readonly parse: (value: unknown) => T;
  readonly seal: (value: T) => Uint8Array;
}): T {
  let parsed: T;
  try {
    parsed = input.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.artifact.bytes)));
  } catch (cause) {
    throw new NativeGraphError('public-record-invalid', `${input.artifact.name}: ${String(cause)}`);
  }
  if (!bytesEqual(input.seal(parsed), input.artifact.bytes)) {
    throw new NativeGraphError('public-record-noncanonical', input.artifact.name);
  }
  return parsed;
}

function descriptorDigest(value: { readonly digest?: { readonly sha256?: string } }): `sha256:${string}` {
  const hex = value.digest?.sha256;
  if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/u.test(hex)) {
    throw new NativeGraphError('record-graph-digest-missing');
  }
  return `sha256:${hex}`;
}

function annotationDigest(submission: ReturnType<typeof SubmissionRecordSchema.parse>): `sha256:${string}` | undefined {
  const value = submission.annotations?.['https://jinn.network/annotations/admission-receipt/1.0'] as
    | { readonly digest?: { readonly sha256?: string } }
    | undefined;
  const hex = value?.digest?.sha256;
  return typeof hex === 'string' && /^[a-f0-9]{64}$/u.test(hex) ? `sha256:${hex}` : undefined;
}

function annotationDescriptor(submission: ReturnType<typeof SubmissionRecordSchema.parse>): Record<string, unknown> | undefined {
  return record(submission.annotations?.['https://jinn.network/annotations/admission-receipt/1.0']);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireEnvelope(input: {
  readonly artifact: ExactPublicArtifact;
  readonly payloadType: string;
  readonly payloadBytes?: Uint8Array;
}): void {
  let parsed;
  try { parsed = parseExactDsseEnvelope(input.artifact.bytes); }
  catch (cause) { throw new NativeGraphError('public-envelope-invalid', `${input.artifact.name}: ${String(cause)}`); }
  if (parsed.payloadType !== input.payloadType) {
    throw new NativeGraphError('public-envelope-payload-type-mismatch', input.artifact.name);
  }
  if (input.payloadBytes !== undefined && !equalBytes(parsed.payloadBytes, input.payloadBytes)) {
    throw new NativeGraphError('public-envelope-payload-mismatch', input.artifact.name);
  }
}

function deterministicUuid(id: `sha256:${string}`): `urn:uuid:${string}` {
  const value = id.slice('sha256:'.length, 'sha256:'.length + 32).split('');
  value[12] = '5';
  value[16] = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = value.join('');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireExecutionEvidence(artifact: ExactPublicArtifact): void {
  const report = validateExecutionEvidence(artifact.bytes);
  if (!report.conforms) {
    throw new NativeGraphError(
      'execution-evidence-invalid',
      `${artifact.name}: ${report.diagnostics.map(({ code }) => code).join(',')}`,
    );
  }
}

function evidenceReferences(value: unknown): readonly string[] | undefined {
  const values = Array.isArray(value) ? value : [value];
  const references = values.map((candidate) => record(candidate)?.['@id']);
  return references.every((candidate): candidate is string => typeof candidate === 'string') ? references : undefined;
}

function executionIdsFromEvidence(artifact: ExactPublicArtifact): readonly string[] {
  let document: unknown;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes)); }
  catch (cause) { throw new NativeGraphError('execution-evidence-invalid', `${artifact.name}: ${String(cause)}`); }
  const graph = record(document)?.['@graph'];
  if (!Array.isArray(graph)) throw new NativeGraphError('execution-evidence-join-invalid', artifact.name);
  const root = graph.map(record).find((entity) => entity?.['@id'] === './');
  const mentioned = evidenceReferences(root?.mentions);
  const ids = new Set(graph.map(record).map((entity) => entity?.['@id'])
    .filter((value): value is string => typeof value === 'string'));
  if (mentioned === undefined || mentioned.length === 0 || mentioned.some((value) => !ids.has(value))) {
    throw new NativeGraphError('execution-evidence-join-invalid', artifact.name);
  }
  return mentioned;
}

export function verifyExecutionEvidenceJoin(input: {
  readonly delivery: ReturnType<typeof DeliveryRecordSchema.parse>;
  readonly evidence: readonly ExactPublicArtifact[];
  readonly label: string;
}): void {
  const declared = new Set(input.delivery.executionIds ?? []);
  const evidenced = new Set(input.evidence.flatMap(executionIdsFromEvidence));
  if (declared.size === 0 || declared.size !== evidenced.size
    || [...declared].some((executionId) => !evidenced.has(executionId))) {
    throw new NativeGraphError('execution-evidence-join-invalid', input.label);
  }
}

async function fetchArtifact(input: {
  readonly client: DiscoveryQueryClient;
  readonly state: ConsumerState;
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly mediaType: string;
}): Promise<ExactPublicArtifact> {
  let bytes: Uint8Array;
  try {
    bytes = await input.client.getRecord(input.digest);
  } catch (cause) {
    const detail = String(cause);
    throw new NativeGraphError(
      detail.includes('content-corruption') ? 'public-record-digest-mismatch' : 'public-record-unavailable',
      `${input.name}: ${detail}`,
    );
  }
  if (documentDigest(bytes) !== input.digest) throw new NativeGraphError('public-record-digest-mismatch', input.name);
  await input.state.putRecord({ digest: input.digest, bytes, mediaType: input.mediaType });
  return { name: input.name, digest: input.digest, mediaType: input.mediaType, bytes };
}

/** Retrieves and joins the complete byte graph through content-addressed public source endpoints. */
export async function retrieveNativePublicGraph(input: {
  readonly roots: NativeGraphRoots;
  readonly state: ConsumerState;
  readonly transports: {
    readonly requester: Transport;
    readonly solver: Transport;
    readonly evaluator: Transport;
  };
}): Promise<NativePublicGraph> {
  const clients = {
    requester: new DiscoveryQueryClient({
      baseUrl: input.roots.requester.source.publicBaseUrl,
      transport: input.transports.requester,
    }),
    solver: new DiscoveryQueryClient({
      baseUrl: input.roots.solution.source.publicBaseUrl,
      transport: input.transports.solver,
    }),
    evaluator: new DiscoveryQueryClient({
      baseUrl: input.roots.evaluation.source.publicBaseUrl,
      transport: input.transports.evaluator,
    }),
  };
  const requester = (name: string, digest: `sha256:${string}`, mediaType: string) =>
    fetchArtifact({ client: clients.requester, state: input.state, name, digest, mediaType });
  const solver = (name: string, digest: `sha256:${string}`, mediaType: string) =>
    fetchArtifact({ client: clients.solver, state: input.state, name, digest, mediaType });
  const evaluator = (name: string, digest: `sha256:${string}`, mediaType: string) =>
    fetchArtifact({ client: clients.evaluator, state: input.state, name, digest, mediaType });

  const submission = await requester('submission', input.roots.requester.submission.digest, SUBMISSION_MEDIA_TYPE);
  const submissionDocument = exactJson({ artifact: submission, parse: (value) => SubmissionRecordSchema.parse(value), seal: sealSubmission });
  if (descriptorDigest(submissionDocument.task) !== input.roots.requester.taskDigest) {
    throw new NativeGraphError('submission-task-graph-mismatch');
  }
  if (
    submissionDocument.submission !== input.roots.requester.submissionUri
    || submissionDocument.nonce !== input.roots.requester.nonce
    || (submissionDocument.attempts?.maxTotal ?? 1) !== 1
    || (submissionDocument.attempts?.maxConcurrent ?? 1) !== 1
  ) throw new NativeGraphError('submission-association-graph-mismatch');
  if (annotationDigest(submissionDocument) !== input.roots.requester.admissionReceiptDigest) {
    throw new NativeGraphError('submission-admission-graph-mismatch');
  }
  const task = await requester('task', input.roots.requester.taskDigest, TASK_MEDIA_TYPE);
  const taskDocument = exactJson({ artifact: task, parse: (value) => TaskSpecificationSchema.parse(value), seal: sealTask });
  const evaluationSpecDigest = descriptorDigest(taskDocument.evaluation ?? {});
  const evaluationSpec = await requester('evaluation-spec', evaluationSpecDigest, EVALUATION_SPEC_MEDIA_TYPE);
  try {
    const parsed = parseEvaluationSpec(evaluationSpec.bytes);
    if (!bytesEqual(sealEvaluationSpec(parsed).bytes, evaluationSpec.bytes)) {
      throw new NativeGraphError('public-record-noncanonical', 'evaluation-spec');
    }
  } catch (cause) {
    if (cause instanceof NativeGraphError) throw cause;
    throw new NativeGraphError('public-record-invalid', `evaluation-spec: ${String(cause)}`);
  }
  const admissionReceipt = await requester(
    'admission-receipt', input.roots.requester.admissionReceiptDigest, DSSE_ENVELOPE_MEDIA_TYPE,
  );
  const requesterEnvelope = await requester(
    'requester-envelope', input.roots.requester.requesterEnvelopeDigest, DSSE_ENVELOPE_MEDIA_TYPE,
  );
  requireEnvelope({ artifact: requesterEnvelope, payloadType: SUBMISSION_MEDIA_TYPE, payloadBytes: submission.bytes });
  requireEnvelope({ artifact: admissionReceipt, payloadType: VERDICT_MEDIA_TYPE });

  const solutionDelivery = await solver(
    'solution-delivery', input.roots.solution.delivery.digest, input.roots.solution.delivery.mediaType,
  );
  const solutionDocument = exactJson({
    artifact: solutionDelivery, parse: (value) => DeliveryRecordSchema.parse(value), seal: sealDelivery,
  });
  if (solutionDocument.task !== task.digest) throw new NativeGraphError('solution-task-graph-mismatch');
  const solutionEnvelope = await solver(
    'solution-delivery-envelope', input.roots.solution.deliveryEnvelope.digest,
    input.roots.solution.deliveryEnvelope.mediaType,
  );
  requireEnvelope({ artifact: solutionEnvelope, payloadType: DELIVERY_MEDIA_TYPE, payloadBytes: solutionDelivery.bytes });
  const solutionOutputs = await Promise.all(solutionDocument.outputs.map((value) =>
    solver(`solution-output:${value.name}`, descriptorDigest(value), value.mediaType ?? 'application/octet-stream'),
  ));
  const solutionEvidence = await Promise.all((solutionDocument.evidenceRecords ?? []).map((value, index) =>
    solver(`solution-evidence:${index}`, value.digest as `sha256:${string}`, EXECUTION_EVIDENCE_MEDIA_TYPE),
  ));
  for (const artifact of solutionEvidence) requireExecutionEvidence(artifact);
  verifyExecutionEvidenceJoin({ delivery: solutionDocument, evidence: solutionEvidence, label: 'solution' });

  const evaluationTask = await evaluator(
    'evaluation-task', input.roots.evaluation.task.digest, input.roots.evaluation.task.mediaType,
  );
  exactJson({ artifact: evaluationTask, parse: (value) => TaskSpecificationSchema.parse(value), seal: sealTask });
  const receiptDescriptor = annotationDescriptor(submissionDocument);
  if (receiptDescriptor === undefined) throw new NativeGraphError('submission-admission-graph-mismatch');
  const expectedEvaluationTask = deriveEvaluationTask({
    subjectTask: { name: 'task', digest: task.digest },
    subjectDelivery: { name: 'delivery', digest: solutionDelivery.digest },
    subjectResults: solutionOutputs.map(({ name, digest }) => ({ name: name.replace(/^solution-output:/u, ''), digest })),
    evaluationSpecDigest: evaluationSpec.digest,
    admissionReceipt: receiptDescriptor,
  });
  if (!equalBytes(expectedEvaluationTask.bytes, evaluationTask.bytes)) {
    throw new NativeGraphError('evaluation-task-pair-mismatch');
  }
  const evaluationSubmission = await evaluator(
    'evaluation-submission', input.roots.evaluation.submission.digest, input.roots.evaluation.submission.mediaType,
  );
  const evaluationSubmissionDocument = exactJson({
    artifact: evaluationSubmission, parse: (value) => SubmissionRecordSchema.parse(value), seal: sealSubmission,
  });
  if (descriptorDigest(evaluationSubmissionDocument.task) !== evaluationTask.digest) {
    throw new NativeGraphError('evaluation-submission-task-graph-mismatch');
  }
  if (evaluationSubmissionDocument.requester !== input.roots.evaluation.evaluatorAgent
    || evaluationSubmissionDocument.idempotencyKey !== input.roots.evaluation.evaluationId
    || evaluationSubmissionDocument.nonce !== input.roots.evaluation.evaluationId
    || evaluationSubmissionDocument.submission !== deterministicUuid(input.roots.evaluation.evaluationId)
    || evaluationSubmissionDocument.capabilityGrants !== undefined) {
    throw new NativeGraphError('evaluation-submission-not-pair-fixed-grant-free');
  }
  const verdict = await evaluator('verdict', input.roots.evaluation.verdict.digest, input.roots.evaluation.verdict.mediaType);
  requireEnvelope({ artifact: verdict, payloadType: VERDICT_MEDIA_TYPE });
  const evaluationDelivery = await evaluator(
    'evaluation-delivery', input.roots.evaluation.delivery.digest, input.roots.evaluation.delivery.mediaType,
  );
  const evaluationDeliveryDocument = exactJson({
    artifact: evaluationDelivery, parse: (value) => DeliveryRecordSchema.parse(value), seal: sealDelivery,
  });
  if (evaluationDeliveryDocument.task !== evaluationTask.digest) {
    throw new NativeGraphError('evaluation-delivery-task-graph-mismatch');
  }
  const verdictOutputs = evaluationDeliveryDocument.outputs.filter((value) => value.name === 'verdict');
  if (verdictOutputs.length !== 1 || descriptorDigest(verdictOutputs[0]!) !== verdict.digest) {
    throw new NativeGraphError('evaluation-verdict-graph-mismatch');
  }
  const evaluationEnvelope = await evaluator(
    'evaluation-delivery-envelope', input.roots.evaluation.deliveryEnvelope.digest,
    input.roots.evaluation.deliveryEnvelope.mediaType,
  );
  requireEnvelope({ artifact: evaluationEnvelope, payloadType: DELIVERY_MEDIA_TYPE, payloadBytes: evaluationDelivery.bytes });
  const expectedEvidence = new Set((evaluationDeliveryDocument.evidenceRecords ?? []).map((value) => value.digest));
  if (expectedEvidence.size !== input.roots.evaluation.evidence.length
    || input.roots.evaluation.evidence.some((value) => !expectedEvidence.has(value.digest))) {
    throw new NativeGraphError('evaluation-evidence-graph-mismatch');
  }
  const evaluationEvidence = await Promise.all(input.roots.evaluation.evidence.map((value, index) =>
    evaluator(`evaluation-evidence:${index}`, value.digest, value.mediaType),
  ));
  for (const artifact of evaluationEvidence) requireExecutionEvidence(artifact);
  verifyExecutionEvidenceJoin({ delivery: evaluationDeliveryDocument, evidence: evaluationEvidence, label: 'evaluation' });

  const all = [
    task, submission, evaluationSpec, admissionReceipt, requesterEnvelope,
    solutionDelivery, solutionEnvelope, ...solutionOutputs, ...solutionEvidence,
    evaluationTask, evaluationSubmission, verdict, evaluationDelivery, evaluationEnvelope, ...evaluationEvidence,
  ];
  return {
    roots: input.roots,
    task,
    submission,
    evaluationSpec,
    admissionReceipt,
    requesterEnvelope,
    solution: {
      delivery: solutionDelivery,
      deliveryEnvelope: solutionEnvelope,
      outputs: solutionOutputs,
      evidence: solutionEvidence,
    },
    evaluation: {
      task: evaluationTask,
      submission: evaluationSubmission,
      verdict,
      delivery: evaluationDelivery,
      deliveryEnvelope: evaluationEnvelope,
      evidence: evaluationEvidence,
    },
    all,
  };
}
