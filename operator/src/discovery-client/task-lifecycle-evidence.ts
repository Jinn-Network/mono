/**
 * Task lifecycle evidence — types + pure assembler (#2044).
 *
 * The authoritative spine is built ONLY from task/attempt/verdict rows.
 * Envelope-meta rows never enter the spine: they attach last, joined by
 * (requestId, chainId), into the `*EnvelopeCandidates` arrays, and a candidate
 * can never create a row — each attach loop walks only the spine rows that
 * already exist under that key, so an unmatched candidate is dropped.
 *
 * That separation is what issue #2044's AC3 asks for now that Wave-4 D4 deleted
 * the on-chain floor and its `withFallback` precedence: the indexer is the only
 * source, so the guarantee is provenance separation WITHIN one response, not
 * source precedence between two. Every field under `authoritative` is a
 * projection of a chain event and carries the identity a consumer needs to
 * re-derive it independently against an RPC (requestId, chainId,
 * createdAtBlock, createdAtTx). Every `*EnvelopeCandidates` entry is an
 * IPFS-body projection the indexer inferred, and is untrusted.
 *
 * This read makes NO authentication claim.
 */

/** Top-level evidence for one posted task (#2044). */
export interface TaskLifecycleEvidence {
  taskId: string;
  /** Chain-derived facts only. Never populated from *EnvelopeMeta. */
  authoritative: AuthoritativeTaskLifecycle;
}

export interface AuthoritativeTaskLifecycle {
  task: AuthoritativeTaskRow;
  /** Sorted by attemptIndex ascending. */
  attempts: AuthoritativeAttemptRow[];
}

export interface AuthoritativeTaskRow {
  taskId: string;
  chainId: number;
  manifestDigest: `0x${string}`;
  taskCidDigest: `0x${string}`;
  creator: `0x${string}`;
  maxClaims: number;
  requiredVerdicts: number;
  createdAtBlock: number;
  createdAtTx?: `0x${string}`;
  finalized: boolean;
  refunded: boolean;
}

export interface AuthoritativeAttemptRow {
  taskId: string;
  chainId: number;
  attemptIndex: number;
  /** MechMarketplace SOLVE requestId. */
  requestId: `0x${string}`;
  operator: `0x${string}`;
  priorityMech: `0x${string}`;
  deliveryRate: string;
  createdAtBlock: number;
  /** Sorted by verdictIndex ascending. */
  verdicts: AuthoritativeVerdictRow[];
  attemptEnvelopeCandidates: AttemptEnvelopeCandidate[];
}

export interface AuthoritativeVerdictRow {
  taskId: string;
  chainId: number;
  attemptIndex: number;
  verdictIndex: number;
  /** MechMarketplace EVAL requestId (not equal to attempt.requestId). */
  requestId: `0x${string}`;
  evaluator: `0x${string}`;
  /** On-chain VerdictCode 0..4 only — not envelope actualPassed. */
  verdictCode: number;
  createdAtBlock: number;
  verdictEnvelopeCandidates: VerdictEnvelopeCandidate[];
}

export interface AttemptEnvelopeCandidate {
  requestId: `0x${string}`;
  chainId: number;
  manifestCid: string;
  publisherAgentId: string;
  manifestHash: `0x${string}`;
  enrichedAtBlock: number;
  solverType?: string;
  implName?: string;
  implVersion?: string;
  codeDigest?: string;
  mode?: string;
  pluginsJson?: string;
  model?: string;
  evidenceTier?: string;
  sourcePublished?: boolean;
  enrichmentStatus?: string;
}

export interface VerdictEnvelopeCandidate {
  requestId: `0x${string}`;
  chainId: number;
  manifestCid: string;
  publisherAgentId: string;
  manifestHash: `0x${string}`;
  enrichedAtBlock: number;
  solverType?: string;
  evidenceTier?: string;
  actualPassed?: boolean;
  actualScore?: string;
  evaluatorVerdict?: string;
  solutionRequestId?: string;
  instanceId?: string;
  solverNetManifestCid?: string;
  enrichmentStatus?: string;
  projectedTaskId?: string;
  projectedAttemptIndex?: number;
  projectedVerdictIndex?: number;
  projectedEvaluator?: `0x${string}`;
}

export type RawTaskRow = AuthoritativeTaskRow;
export type RawAttemptRow = Omit<AuthoritativeAttemptRow, 'verdicts' | 'attemptEnvelopeCandidates'>;
export type RawVerdictRow = Omit<AuthoritativeVerdictRow, 'verdictEnvelopeCandidates'>;

function attemptKey(taskId: string, attemptIndex: number, chainId: number): string {
  return `${taskId}|${attemptIndex}|${chainId}`;
}

function reqKey(requestId: string, chainId: number): string {
  return `${requestId.toLowerCase()}|${chainId}`;
}

/** Append to a map-of-lists, creating the list on first use. */
function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function assembleTaskLifecycleEvidence(input: {
  tasks: RawTaskRow[];
  attempts: RawAttemptRow[];
  verdicts: RawVerdictRow[];
  attemptCandidates?: AttemptEnvelopeCandidate[];
  verdictCandidates?: VerdictEnvelopeCandidate[];
}): Map<string, TaskLifecycleEvidence> {
  const out = new Map<string, TaskLifecycleEvidence>();
  for (const task of input.tasks) {
    out.set(task.taskId, {
      taskId: task.taskId,
      authoritative: { task: { ...task }, attempts: [] },
    });
  }

  // Attempts land straight on the task they belong to; an attempt whose task
  // is not in the spine has nothing to attach to and is dropped.
  for (const a of input.attempts) {
    const evidence = out.get(a.taskId);
    if (!evidence) continue;
    evidence.authoritative.attempts.push({
      ...a,
      requestId: a.requestId.toLowerCase() as `0x${string}`,
      operator: a.operator.toLowerCase() as `0x${string}`,
      priorityMech: a.priorityMech.toLowerCase() as `0x${string}`,
      verdicts: [],
      attemptEnvelopeCandidates: [],
    });
  }

  // One pass to order each task's attempts and to build the two lookups the
  // verdict and candidate joins need.
  const attemptIndex = new Map<string, AuthoritativeAttemptRow>();
  const attemptsByReq = new Map<string, AuthoritativeAttemptRow[]>();
  for (const evidence of out.values()) {
    evidence.authoritative.attempts.sort((x, y) => x.attemptIndex - y.attemptIndex);
    for (const row of evidence.authoritative.attempts) {
      attemptIndex.set(attemptKey(row.taskId, row.attemptIndex, row.chainId), row);
      pushInto(attemptsByReq, reqKey(row.requestId, row.chainId), row);
    }
  }

  const verdictsByAttempt = new Map<string, AuthoritativeVerdictRow[]>();
  for (const v of input.verdicts) {
    const key = attemptKey(v.taskId, v.attemptIndex, v.chainId);
    if (!attemptIndex.has(key)) continue;
    pushInto(verdictsByAttempt, key, {
      ...v,
      requestId: v.requestId.toLowerCase() as `0x${string}`,
      evaluator: v.evaluator.toLowerCase() as `0x${string}`,
      verdictEnvelopeCandidates: [],
    });
  }

  const verdictsByReq = new Map<string, AuthoritativeVerdictRow[]>();
  for (const [key, list] of verdictsByAttempt) {
    list.sort((x, y) => x.verdictIndex - y.verdictIndex);
    attemptIndex.get(key)!.verdicts = list;
    for (const v of list) pushInto(verdictsByReq, reqKey(v.requestId, v.chainId), v);
  }

  // Candidates attach last, and only ever onto a spine row that already exists.
  for (const c of input.attemptCandidates ?? []) {
    for (const a of attemptsByReq.get(reqKey(c.requestId, c.chainId)) ?? []) {
      a.attemptEnvelopeCandidates.push({ ...c });
    }
  }
  for (const c of input.verdictCandidates ?? []) {
    for (const v of verdictsByReq.get(reqKey(c.requestId, c.chainId)) ?? []) {
      v.verdictEnvelopeCandidates.push({ ...c });
    }
  }

  return out;
}

// ── Provenance separation, enforced by the compiler (AC3) ────────────────
// `verdictEnvelopeMeta` carries taskId / attemptIndex / verdictIndex / evaluator
// — the columns most likely to be mistaken for spine identity. They are renamed
// to projected* on ingest, so `spine.evaluator = candidate.evaluator` does not
// compile: the field does not exist on the candidate type.
//
// The check is stated once, over BOTH candidate types, as "this type declares
// none of the spine's identity columns". That subsumes the earlier per-field
// `keyof` aliases and, unlike an assignability check, it actually bites: adding
// any one of these names to either candidate fails `yarn typecheck`.
type Assert<T extends true> = T;

/** Identity columns only the authoritative spine may carry. */
type SpineIdentityColumn =
  'taskId' | 'attemptIndex' | 'verdictIndex' | 'evaluator' | 'operator';

type CarriesNoSpineIdentity<C> =
  [Extract<keyof C, SpineIdentityColumn>] extends [never] ? true : false;

type _AttemptCandidateCarriesNoSpineIdentity =
  Assert<CarriesNoSpineIdentity<AttemptEnvelopeCandidate>>;
type _VerdictCandidateCarriesNoSpineIdentity =
  Assert<CarriesNoSpineIdentity<VerdictEnvelopeCandidate>>;
