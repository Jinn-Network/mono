import type {
  EnvelopeProjection,
  EnvelopeProjectionMetadata,
  EnvelopeProjectionMetadataValue,
} from './types.js';
import { normalizeEnvelopeRole, type SignedEnvelope } from '../types/envelope.js';
import type { Task } from '../types/task.js';

const SOLUTION_TASK_CID_CONTEXT_KEY = 'solutionTaskCid';
const LEGACY_RESTORATION_TASK_CID_CONTEXT_KEY = 'restorationTaskCid';

export interface ProjectEnvelopeOptions {
  envelopeCid?: string | null;
  envelopeSha256?: string | null;
  task?: Task | null;
  taskCid?: string | null;
  taskId?: string | null;
  metadata?: EnvelopeProjectionMetadata;
}

export function projectEnvelope(
  envelope: SignedEnvelope,
  options: ProjectEnvelopeOptions = {},
): EnvelopeProjection {
  const metadata: EnvelopeProjectionMetadata = {};
  const role = normalizeEnvelopeRole(envelope.role);

  setMetadata(metadata, 'participant.safeAddress', envelope.participant.safeAddress);
  setMetadata(metadata, 'participant.agentEoa', envelope.participant.agentEoa);
  setMetadata(metadata, 'executor.implName', envelope.executor.implName);
  setMetadata(metadata, 'executor.implVersion', envelope.executor.implVersion);
  setMetadata(metadata, 'executor.runtimeBundleDigest', envelope.executor.runtimeBundleDigest);
  setMetadata(
    metadata,
    'executor.plugins',
    JSON.stringify(envelope.executor.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      cid: plugin.cid ?? null,
      sha256: plugin.sha256,
    }))),
  );

  const projectedTaskCid = resolveProjectedTaskCid(envelope, options);
  const projectedTaskId = options.taskId ?? options.task?.id ?? null;
  setMetadata(metadata, 'taskCid', projectedTaskCid);
  setMetadata(metadata, 'requestId', envelope.task?.requestId ?? null);
  setMetadata(metadata, 'taskId', projectedTaskId);

  if (envelope.solverType === 'prediction.v1') {
    projectPredictionV1Fields(metadata, envelope, options.task);
  }

  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    setMetadata(metadata, key, value);
  }

  const solutionEnvelopeCid = stringFromMetadata(metadata, 'solutionEnvelope.cid');
  const solutionEnvelopeSha256 = stringFromMetadata(metadata, 'solutionEnvelope.sha256');
  const solutionEnvelopeRef = solutionEnvelopeCid
    ?? solutionEnvelopeSha256
    ?? (envelope.role === 'verdict' ? envelope.signature.hash : null);
  const envelopeCid = options.envelopeCid ?? null;
  const envelopeSha256 = options.envelopeSha256 ?? null;
  const envelopeId = envelopeCid ?? envelopeSha256 ?? envelope.signature.hash;

  return {
    envelopeId,
    envelopeCid,
    envelopeSha256,
    signatureHash: envelope.signature.hash,
    solverType: envelope.solverType,
    role,
    taskCid: projectedTaskCid,
    taskId: projectedTaskId,
    requestId: envelope.task?.requestId ?? null,
    generatedAt: envelope.generatedAt,
    evidenceTier: envelope.evidenceTier,
    participantSafeAddress: envelope.participant.safeAddress,
    participantAgentEoa: envelope.participant.agentEoa,
    executorImplName: envelope.executor.implName,
    executorImplVersion: envelope.executor.implVersion,
    executorRuntimeBundleDigest: envelope.executor.runtimeBundleDigest,
    executorPlugins: envelope.executor.plugins.map((plugin) => plugin.name),
    solutionEnvelopeCid,
    solutionEnvelopeSha256,
    solutionEnvelopeRef,
    metadata,
  };
}

function projectPredictionV1Fields(
  metadata: EnvelopeProjectionMetadata,
  envelope: SignedEnvelope,
  task?: Task | null,
): void {
  const taskSpec = record(task?.spec);
  const taskSource = record(taskSpec?.source);
  const taskIdentifiers = record(taskSource?.identifiers);
  const taskQuestion = record(taskSpec?.question);
  const payload = record(envelope.payload);
  const resolutionSource = record(payload?.resolutionSource);
  const payloadTask = record(payload?.task);
  const scores = record(payload?.scores);
  const solutionEnvelope = record(payload?.solutionEnvelope) ?? record(payload?.restorationEnvelope);

  setMetadata(metadata, 'solverType', envelope.solverType);
  setMetadata(metadata, 'role', normalizeEnvelopeRole(envelope.role));
  setMetadata(metadata, 'source.venue', stringValue(taskSource?.venue) ?? stringValue(resolutionSource?.venue));
  setMetadata(metadata, 'source.marketId', stringValue(taskIdentifiers?.marketId) ?? stringValue(resolutionSource?.marketId));
  setMetadata(
    metadata,
    'source.conditionId',
    stringValue(taskIdentifiers?.conditionId) ?? stringValue(resolutionSource?.conditionId),
  );
  setMetadata(metadata, 'question.kind', stringValue(taskQuestion?.kind));
  setMetadata(metadata, 'verdict', stringValue(payload?.verdict));
  setMetadata(metadata, 'scores.solverBrier', stringValue(scores?.solverBrier));
  setMetadata(metadata, 'scores.consensusBrier', stringValue(scores?.consensusBrier));
  setMetadata(metadata, 'scores.brierSpread', stringValue(scores?.brierSpread));
  setMetadata(metadata, 'solutionEnvelope.cid', stringValue(solutionEnvelope?.cid));
  setMetadata(metadata, 'solutionEnvelope.sha256', stringValue(solutionEnvelope?.sha256));
  setMetadata(metadata, 'payload.task.cid', stringValue(payloadTask?.cid));
}

function resolveProjectedTaskCid(
  envelope: SignedEnvelope,
  options: ProjectEnvelopeOptions,
): string | null {
  if (options.taskCid) return options.taskCid;
  const solutionTaskCid = options.task?.context?.[SOLUTION_TASK_CID_CONTEXT_KEY];
  if (typeof solutionTaskCid === 'string' && solutionTaskCid.length > 0) {
    return solutionTaskCid;
  }
  const legacyTaskCid = options.task?.context?.[LEGACY_RESTORATION_TASK_CID_CONTEXT_KEY];
  if (typeof legacyTaskCid === 'string' && legacyTaskCid.length > 0) {
    return legacyTaskCid;
  }
  const payloadTask = record(record(envelope.payload)?.task);
  const payloadTaskCid = stringValue(payloadTask?.cid);
  return payloadTaskCid ?? envelope.task?.cid ?? null;
}

function setMetadata(
  metadata: EnvelopeProjectionMetadata,
  key: string,
  value: EnvelopeProjectionMetadataValue | null | undefined,
): void {
  if (value === undefined || value === null) return;
  metadata[key] = value;
}

function stringFromMetadata(metadata: EnvelopeProjectionMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
