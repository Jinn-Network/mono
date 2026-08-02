import {
  documentDigest,
  serializeCanonicalJson,
  type JsonValue,
} from '@jinn-network/task-execution-protocol';

export type NativeOperationId = `sha256:${string}`;

function requireNonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

function decimalInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return String(value);
}

function decimalBigint(value: bigint, label: string): string {
  if (value < 0n) throw new RangeError(`${label} must be non-negative`);
  return value.toString(10);
}

function normalizedCoordinator(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new TypeError('coordinator must be a 20-byte EVM address');
  }
  return value.toLowerCase();
}

function digest(value: JsonValue): NativeOperationId {
  return documentDigest(serializeCanonicalJson(value));
}

export function engagementIdentityDocument(input: {
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: bigint;
  readonly operatorAgent: string;
}): JsonValue {
  return {
    v: 1,
    chainId: decimalInteger(input.chainId, 'chainId'),
    coordinator: normalizedCoordinator(input.coordinator),
    taskId: decimalBigint(input.taskId, 'taskId'),
    role: 'solver',
    agent: requireNonEmpty(input.operatorAgent, 'operatorAgent'),
  };
}

export function engagementId(input: Parameters<typeof engagementIdentityDocument>[0]): NativeOperationId {
  return digest(engagementIdentityDocument(input));
}

export function claimOperationId(engagement: NativeOperationId): NativeOperationId {
  return digest({ v: 1, kind: 'claim', engagementId: engagement });
}

export function solutionSettlementId(input: {
  readonly attempt: string;
  readonly deliveryDigest: `sha256:${string}`;
}): NativeOperationId {
  return digest({
    v: 1,
    kind: 'solution-settlement',
    attempt: requireNonEmpty(input.attempt, 'attempt'),
    deliveryDigest: input.deliveryDigest,
  });
}

export function evaluationId(input: {
  readonly subjectTaskDigest: `sha256:${string}`;
  readonly subjectDeliveryDigest: `sha256:${string}`;
  readonly evaluatorAgent: string;
}): NativeOperationId {
  return digest({
    v: 1,
    kind: 'evaluation',
    subjectTaskDigest: input.subjectTaskDigest,
    subjectDeliveryDigest: input.subjectDeliveryDigest,
    evaluatorAgent: requireNonEmpty(input.evaluatorAgent, 'evaluatorAgent'),
  });
}

export function verdictSettlementId(input: {
  readonly evaluationAttempt: string;
  readonly evaluationDeliveryDigest: `sha256:${string}`;
  readonly verdictCode: number;
}): NativeOperationId {
  return digest({
    v: 1,
    kind: 'verdict-settlement',
    evaluationAttempt: requireNonEmpty(input.evaluationAttempt, 'evaluationAttempt'),
    evaluationDeliveryDigest: input.evaluationDeliveryDigest,
    verdictCode: decimalInteger(input.verdictCode, 'verdictCode'),
  });
}

export function publicationKey(input: {
  readonly sourceId: string;
  readonly role: string;
  readonly recordDigest: `sha256:${string}`;
  readonly availabilityState: string;
}): NativeOperationId {
  return digest({
    v: 1,
    sourceId: requireNonEmpty(input.sourceId, 'sourceId'),
    role: requireNonEmpty(input.role, 'role'),
    recordDigest: input.recordDigest,
    availabilityState: requireNonEmpty(input.availabilityState, 'availabilityState'),
  });
}
