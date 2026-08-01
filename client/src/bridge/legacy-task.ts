/**
 * Bridge-era legacy task derivation (cutover Finding 4). Pure reconstruction of a subject Task
 * document from anchored legacy SignedTaskV1 bytes. Shared by solver dispatch and evaluator
 * subject-material reconstruction — two operators observing the same chain facts MUST produce
 * byte-identical output.
 */
import { createHash } from 'node:crypto';
import { recordDigest } from '@jinn-network/record-discovery-protocol';

export interface LegacyTaskAnchor {
  readonly chainId: number;
  readonly taskCoordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly creator: `0x${string}`;
  readonly manifestDigest: `0x${string}`;
  readonly taskCidDigest: `0x${string}`;
  readonly maxClaims: number;
  readonly solutionBudgetWei: bigint;
  readonly verdictBudgetWei: bigint;
}

export interface LegacyTaskDocument {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export interface BridgeTaskDerivation {
  readonly taskBytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly profileUri: string;
  readonly workKind: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly derivation: 'legacy';
}

export type BridgeDerivationRefusal =
  | 'document-unparsable'
  | 'document-digest-mismatch'
  | 'missing-solver-type'
  | 'missing-task-payload';

export type DeriveBridgeTaskResult =
  | { readonly ok: true; readonly task: BridgeTaskDerivation }
  | { readonly ok: false; readonly reason: BridgeDerivationRefusal };

const TASK_PROTOCOL = 'https://jinn.network/task-execution/1.0';
const REPOSITORY_WORK_PROFILE = 'https://jinn.network/task-profiles/repository-work/1.0';
/** Fixed namespace for bridge Submission URIs. Never regenerate this constant. */
const BRIDGE_SUBMISSION_NAMESPACE = 'd9c05a5e-1f0f-52b4-9f0b-3f2a7b6c4d81';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Recursive key sort so serialization order never depends on insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (record === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = canonicalize(record[key]);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

export function deriveBridgeTask(
  anchor: LegacyTaskAnchor,
  document: LegacyTaskDocument,
): DeriveBridgeTaskResult {
  if (recordDigest(document.bytes) !== document.digest) {
    return { ok: false, reason: 'document-digest-mismatch' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.bytes));
  } catch {
    return { ok: false, reason: 'document-unparsable' };
  }
  const legacy = asRecord(parsed);
  if (legacy === undefined) return { ok: false, reason: 'document-unparsable' };

  const solverType = legacy['solverType'];
  if (typeof solverType !== 'string' || solverType.length === 0) {
    return { ok: false, reason: 'missing-solver-type' };
  }

  const spec = asRecord(legacy['spec']);
  const description = legacy['description'];
  if (spec === undefined && typeof description !== 'string') {
    return { ok: false, reason: 'missing-task-payload' };
  }

  const payload: Record<string, unknown> = { ...(spec ?? {}) };
  if (typeof description === 'string') payload['description'] = description;

  const requirements: Record<string, unknown> = {};
  const runPinning = asRecord(legacy['runPinning']);
  if (runPinning !== undefined) requirements['runPinning'] = canonicalize(runPinning);

  const task = {
    protocol: TASK_PROTOCOL,
    author: `did:pkh:eip155:${anchor.chainId}:${anchor.creator.toLowerCase()}`,
    profile: { uri: REPOSITORY_WORK_PROFILE },
    payload,
    provenance: {
      bridge: 'legacy',
      chainId: anchor.chainId,
      taskCoordinator: anchor.taskCoordinator.toLowerCase(),
      taskId: anchor.taskId.toString(10),
      taskCidDigest: anchor.taskCidDigest.toLowerCase(),
    },
  };

  const taskBytes = encode(task);
  return {
    ok: true,
    task: {
      taskBytes,
      taskDigest: recordDigest(taskBytes),
      profileUri: REPOSITORY_WORK_PROFILE,
      workKind: solverType,
      requirements,
      derivation: 'legacy',
    },
  };
}

/** UUIDv5 over the engagement identity, so every operator names it identically. */
export function deriveBridgeSubmissionUri(anchor: LegacyTaskAnchor): `urn:uuid:${string}` {
  const name = [
    anchor.chainId.toString(10),
    anchor.taskCoordinator.toLowerCase(),
    anchor.taskId.toString(10),
  ].join('|');
  const namespaceBytes = Uint8Array.from(
    (BRIDGE_SUBMISSION_NAMESPACE.replace(/-/g, '').match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)),
  );
  const hash = createHash('sha1')
    .update(Buffer.from(namespaceBytes))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `urn:uuid:${uuid}`;
}
