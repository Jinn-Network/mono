/**
 * Domain-neutral reader: authenticate envelope candidates from
 * TaskLifecycleEvidence and bind them to the authoritative spine (#2045).
 *
 * Crypto stays in authenticateExecutionEnvelope; this module owns role /
 * requestId / Safe / publisher / manifestHash / taskCidDigest / closeBoundary
 * checks and exactly-one slot classification. Payload is never interpreted.
 */
import { cidToDigestHex } from '../adapters/mech/ipfs.js';
import { authenticateExecutionEnvelope } from '../conformance/execution-envelope-authenticator.js';
import { normalizeEnvelopeRole, type SignedEnvelope } from '../types/envelope.js';
import type {
  AttemptEnvelopeCandidate,
  AuthoritativeTaskRow,
  TaskLifecycleEvidence,
  VerdictEnvelopeCandidate,
} from './types.js';

export type IpfsJsonPort = (
  cid: string,
  maxBytes?: number,
) => Promise<unknown>;

/** ERC-8004 publisher agent → Safe at the MetadataSet / enrichment block. */
export type PublisherSafeResolver = (
  chainId: number,
  publisherAgentId: string,
  atBlock: bigint,
) => Promise<`0x${string}`>;

export interface PostedTaskEvidencePorts {
  ipfs: IpfsJsonPort;
  resolvePublisherSafe: PublisherSafeResolver;
  /** Defaults to `authenticateExecutionEnvelope`. Injected for tests. */
  authenticateEnvelope?: (
    value: unknown,
    sourceName: string,
  ) => Promise<SignedEnvelope>;
}

export interface CloseBoundary {
  /** Exclusive upper bound: candidate with enrichedAtBlock > blockNumber fails. */
  blockNumber?: number;
  /** Exclusive upper bound on envelope.generatedAt (unix seconds), if supplied. */
  timestampSeconds?: number;
}

export interface PostedTaskEvidenceOptions {
  closeBoundary?: CloseBoundary;
  /** v1 only mode — required for AC3. */
  selectionMode?: 'exactly-one'; // default: 'exactly-one'
  maxEnvelopeBytes?: number; // default: 2_000_000
}

export interface RejectedCandidate {
  manifestCid: string;
  publisherAgentId: string;
  enrichedAtBlock: number;
  reason: string;
}

export interface AuthenticatedOpaqueCarrier {
  envelopeCid: string;
  manifestHash: `0x${string}`;
  publisherAgentId: string;
  enrichedAtBlock: number;
  /** Fully authenticated signed envelope; payload remains Record<string, unknown>. */
  envelope: SignedEnvelope;
  binding: {
    role: 'solution' | 'verdict';
    requestId: `0x${string}`;
    chainId: number;
    taskCid: string;
    taskCidDigest: `0x${string}`;
    participantSafe: `0x${string}`;
    participantEoa: `0x${string}`;
    onchainRole: 'operator' | 'evaluator';
    onchainRoleAddress: `0x${string}`;
  };
}

export type CarrierSlotResult =
  | {
      status: 'valid';
      selected: AuthenticatedOpaqueCarrier;
      rejected: RejectedCandidate[];
    }
  | {
      status: 'invalid';
      reason: string;
      rejected: RejectedCandidate[];
    }
  | {
      status: 'missing';
      reason: string;
    }
  | {
      status: 'ambiguous';
      reason: string;
      valid: AuthenticatedOpaqueCarrier[];
      rejected: RejectedCandidate[];
    };

export interface PostedTaskEvidenceReport {
  taskId: string;
  chainId: number;
  /** Spine reference only — not re-derived from envelopes. */
  authoritativeTask: AuthoritativeTaskRow;
  attempts: Array<{
    attemptIndex: number;
    requestId: `0x${string}`;
    operator: `0x${string}`;
    execution: CarrierSlotResult;
    verdicts: Array<{
      verdictIndex: number;
      requestId: `0x${string}`;
      evaluator: `0x${string}`;
      verdictCode: number;
      verdict: CarrierSlotResult;
    }>;
  }>;
}

const DEFAULT_MAX_ENVELOPE_BYTES = 2_000_000;

type SlotKind = 'execution' | 'verdict';

type Candidate = AttemptEnvelopeCandidate | VerdictEnvelopeCandidate;

function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function eqHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function reject(
  candidate: Candidate,
  reason: string,
): RejectedCandidate {
  return {
    manifestCid: candidate.manifestCid,
    publisherAgentId: candidate.publisherAgentId,
    enrichedAtBlock: candidate.enrichedAtBlock,
    reason,
  };
}

function classifyExactlyOne(
  valid: AuthenticatedOpaqueCarrier[],
  rejected: RejectedCandidate[],
  candidateCount: number,
): CarrierSlotResult {
  if (candidateCount === 0) {
    return { status: 'missing', reason: 'zero candidates attached to the spine row' };
  }
  if (valid.length === 0) {
    return {
      status: 'invalid',
      reason: 'no candidate passed authentication and binding checks',
      rejected,
    };
  }
  if (valid.length === 1) {
    return { status: 'valid', selected: valid[0]!, rejected };
  }
  return {
    status: 'ambiguous',
    reason: 'more than one candidate passed authentication and binding checks',
    valid,
    rejected,
  };
}

async function authenticateCandidate(args: {
  candidate: Candidate;
  slot: SlotKind;
  task: AuthoritativeTaskRow;
  onchainRoleAddress: `0x${string}`;
  spineRequestId: `0x${string}`;
  spineChainId: number;
  ports: PostedTaskEvidencePorts;
  authenticateEnvelope: (
    value: unknown,
    sourceName: string,
  ) => Promise<SignedEnvelope>;
  maxEnvelopeBytes: number;
  closeBoundary?: CloseBoundary;
}): Promise<
  | { ok: true; carrier: AuthenticatedOpaqueCarrier }
  | { ok: false; rejected: RejectedCandidate }
> {
  const {
    candidate,
    slot,
    task,
    onchainRoleAddress,
    spineRequestId,
    spineChainId,
    ports,
    authenticateEnvelope,
    maxEnvelopeBytes,
    closeBoundary,
  } = args;

  let raw: unknown;
  try {
    raw = await ports.ipfs(candidate.manifestCid, maxEnvelopeBytes);
  } catch {
    return { ok: false, rejected: reject(candidate, 'ipfs-fetch-failed') };
  }

  let envelope: SignedEnvelope;
  try {
    envelope = await authenticateEnvelope(raw, candidate.manifestCid);
  } catch {
    return { ok: false, rejected: reject(candidate, 'crypto-auth-failed') };
  }

  const expectedRole = slot === 'execution' ? 'solution' : 'verdict';
  const normalizedRole = normalizeEnvelopeRole(envelope.role);
  if (normalizedRole !== expectedRole) {
    return { ok: false, rejected: reject(candidate, 'wrong-role') };
  }

  const envRequestId = envelope.task?.requestId;
  if (
    typeof envRequestId !== 'string'
    || !eqHex(envRequestId, spineRequestId)
  ) {
    return { ok: false, rejected: reject(candidate, 'request-id-mismatch') };
  }

  if (
    candidate.chainId !== task.chainId
    || candidate.chainId !== spineChainId
  ) {
    return { ok: false, rejected: reject(candidate, 'chain-id-mismatch') };
  }

  if (!eqAddr(envelope.participant.safeAddress, onchainRoleAddress)) {
    return { ok: false, rejected: reject(candidate, 'participant-safe-mismatch') };
  }

  let publisherSafe: `0x${string}`;
  try {
    publisherSafe = await ports.resolvePublisherSafe(
      task.chainId,
      candidate.publisherAgentId,
      BigInt(candidate.enrichedAtBlock),
    );
  } catch {
    return { ok: false, rejected: reject(candidate, 'publisher-safe-mismatch') };
  }
  if (!eqAddr(publisherSafe, onchainRoleAddress)) {
    return { ok: false, rejected: reject(candidate, 'publisher-safe-mismatch') };
  }

  if (!eqHex(envelope.signature.hash, candidate.manifestHash)) {
    return { ok: false, rejected: reject(candidate, 'manifest-hash-mismatch') };
  }

  const taskCid = envelope.task?.cid;
  if (typeof taskCid !== 'string' || taskCid.length === 0) {
    return { ok: false, rejected: reject(candidate, 'missing-task-cid') };
  }
  let digest: `0x${string}`;
  try {
    digest = cidToDigestHex(taskCid);
  } catch {
    return { ok: false, rejected: reject(candidate, 'task-cid-digest-mismatch') };
  }
  if (!eqHex(digest, task.taskCidDigest)) {
    return { ok: false, rejected: reject(candidate, 'task-cid-digest-mismatch') };
  }

  if (
    closeBoundary?.blockNumber !== undefined
    && candidate.enrichedAtBlock > closeBoundary.blockNumber
  ) {
    return { ok: false, rejected: reject(candidate, 'post-close-boundary-block') };
  }
  if (
    closeBoundary?.timestampSeconds !== undefined
    && envelope.generatedAt > closeBoundary.timestampSeconds
  ) {
    return { ok: false, rejected: reject(candidate, 'post-close-boundary-time') };
  }

  const onchainRole = slot === 'execution' ? 'operator' : 'evaluator';
  const carrier: AuthenticatedOpaqueCarrier = {
    envelopeCid: candidate.manifestCid,
    manifestHash: candidate.manifestHash,
    publisherAgentId: candidate.publisherAgentId,
    enrichedAtBlock: candidate.enrichedAtBlock,
    envelope,
    binding: {
      role: expectedRole,
      requestId: spineRequestId.toLowerCase() as `0x${string}`,
      chainId: task.chainId,
      taskCid,
      taskCidDigest: task.taskCidDigest,
      participantSafe: envelope.participant.safeAddress,
      participantEoa: envelope.participant.agentEoa,
      onchainRole,
      onchainRoleAddress,
    },
  };
  return { ok: true, carrier };
}

async function classifySlot(args: {
  candidates: Candidate[];
  slot: SlotKind;
  task: AuthoritativeTaskRow;
  onchainRoleAddress: `0x${string}`;
  spineRequestId: `0x${string}`;
  spineChainId: number;
  ports: PostedTaskEvidencePorts;
  authenticateEnvelope: (
    value: unknown,
    sourceName: string,
  ) => Promise<SignedEnvelope>;
  maxEnvelopeBytes: number;
  closeBoundary?: CloseBoundary;
}): Promise<CarrierSlotResult> {
  const valid: AuthenticatedOpaqueCarrier[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of args.candidates) {
    const result = await authenticateCandidate({
      candidate,
      slot: args.slot,
      task: args.task,
      onchainRoleAddress: args.onchainRoleAddress,
      spineRequestId: args.spineRequestId,
      spineChainId: args.spineChainId,
      ports: args.ports,
      authenticateEnvelope: args.authenticateEnvelope,
      maxEnvelopeBytes: args.maxEnvelopeBytes,
      closeBoundary: args.closeBoundary,
    });
    if (result.ok) {
      valid.push(result.carrier);
    } else {
      rejected.push(result.rejected);
    }
  }

  return classifyExactlyOne(valid, rejected, args.candidates.length);
}

export async function authenticatePostedTaskEvidence(args: {
  evidence: TaskLifecycleEvidence;
  ports: PostedTaskEvidencePorts;
  options?: PostedTaskEvidenceOptions;
}): Promise<PostedTaskEvidenceReport> {
  const maxBytes = args.options?.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES;
  const auth = args.ports.authenticateEnvelope ?? authenticateExecutionEnvelope;
  const closeBoundary = args.options?.closeBoundary;
  const task = args.evidence.authoritative.task;

  const attempts = [];
  for (const attempt of args.evidence.authoritative.attempts) {
    const execution = await classifySlot({
      candidates: attempt.attemptEnvelopeCandidates,
      slot: 'execution',
      task,
      onchainRoleAddress: attempt.operator,
      spineRequestId: attempt.requestId,
      spineChainId: attempt.chainId,
      ports: args.ports,
      authenticateEnvelope: auth,
      maxEnvelopeBytes: maxBytes,
      closeBoundary,
    });

    const verdicts = [];
    for (const v of attempt.verdicts) {
      const verdict = await classifySlot({
        candidates: v.verdictEnvelopeCandidates,
        slot: 'verdict',
        task,
        onchainRoleAddress: v.evaluator,
        spineRequestId: v.requestId,
        spineChainId: v.chainId,
        ports: args.ports,
        authenticateEnvelope: auth,
        maxEnvelopeBytes: maxBytes,
        closeBoundary,
      });
      verdicts.push({
        verdictIndex: v.verdictIndex,
        requestId: v.requestId,
        evaluator: v.evaluator,
        verdictCode: v.verdictCode,
        verdict,
      });
    }

    attempts.push({
      attemptIndex: attempt.attemptIndex,
      requestId: attempt.requestId,
      operator: attempt.operator,
      execution,
      verdicts,
    });
  }

  return {
    taskId: args.evidence.taskId,
    chainId: task.chainId,
    authoritativeTask: task,
    attempts,
  };
}
