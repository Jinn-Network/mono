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
  createdAtTx: `0x${string}`;
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
  /**
   * The indexer's `attemptIndex` projection. Unlike `projectedTaskId` and
   * `projectedEvaluator` — whose schema defaults (`''` / `'0x'`) are filtered
   * out on ingest — this column defaults to `0` (`t.integer().notNull()
   * .default(0)`), and `0` is a legitimate attempt index. A present `0` here
   * therefore means "the envelope said attempt 0" OR "the envelope said
   * nothing"; the two are indistinguishable. Never treat it as evidence.
   */
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

/** The leg an unplaceable authoritative row arrived on. */
export type UnplaceableLifecycleLeg = 'attempts' | 'verdicts';

export function assembleTaskLifecycleEvidence(input: {
  tasks: RawTaskRow[];
  attempts: RawAttemptRow[];
  verdicts: RawVerdictRow[];
  attemptCandidates?: AttemptEnvelopeCandidate[];
  verdictCandidates?: VerdictEnvelopeCandidate[];
  /**
   * Called with the leg and identity of the first authoritative row that has
   * no place on the spine, immediately before the whole result is withdrawn.
   * Kept as a callback so this module stays `console`-free; the reader wires
   * it to the same warning its own row rejections emit.
   */
  onUnplaceableRow?: (leg: UnplaceableLifecycleLeg, identity: string) => void;
}): Map<string, TaskLifecycleEvidence> {
  /**
   * Absence beats a partial lie. An attempt or verdict row the read cannot
   * place is an AUTHORITATIVE row going missing — the caller would be handed a
   * spine that looks complete and is not, with no marker saying otherwise — so
   * the whole result is withdrawn rather than answered in part.
   */
  function withdraw(
    leg: UnplaceableLifecycleLeg,
    identity: string,
  ): Map<string, TaskLifecycleEvidence> {
    input.onUnplaceableRow?.(leg, identity);
    return new Map();
  }

  const out = new Map<string, TaskLifecycleEvidence>();
  for (const task of input.tasks) {
    out.set(task.taskId, {
      taskId: task.taskId,
      authoritative: { task: { ...task }, attempts: [] },
    });
  }

  // Attempts land straight on the task they belong to. Two rows have no place:
  // one whose task is absent from the spine, and one whose chainId contradicts
  // its own task's — `out` is keyed by taskId ALONE (task's primary key is `id`
  // alone), so without the second check a chain-B attempt would attach to a
  // chain-A task and the result would claim a cross-chain lifecycle.
  for (const a of input.attempts) {
    const evidence = out.get(a.taskId);
    if (!evidence || evidence.authoritative.task.chainId !== a.chainId) {
      return withdraw(
        'attempts',
        `taskId=${a.taskId} attemptIndex=${a.attemptIndex} chainId=${a.chainId}`,
      );
    }
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

  // A verdict whose (taskId, attemptIndex, chainId) has no attempt row is the
  // same kind of loss. It is not hypothetical: the legs are separate HTTP reads
  // with no block-height pin, so an indexer that advances between the attempts
  // read and the verdicts read returns a verdict for an attempt this spine
  // never saw.
  const verdictsByAttempt = new Map<string, AuthoritativeVerdictRow[]>();
  for (const v of input.verdicts) {
    const key = attemptKey(v.taskId, v.attemptIndex, v.chainId);
    if (!attemptIndex.has(key)) {
      return withdraw(
        'verdicts',
        `taskId=${v.taskId} attemptIndex=${v.attemptIndex} `
          + `verdictIndex=${v.verdictIndex} chainId=${v.chainId}`,
      );
    }
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

// ── Provenance separation (AC3) ──────────────────────────────────────────
// The guarantee is carried by the ASSEMBLER'S STRUCTURE, not by the compiler: a
// candidate is only ever PUSHED onto a `*EnvelopeCandidates` array hanging off a
// spine row that already exists, so no projection can create a spine row or
// rewrite a field on one. Every assertion about AC3 rests on that.
//
// The type block below adds a guard against exactly ONE class of naming
// mistake on top of that structure: re-declaring an authoritative column on a
// candidate type, which is the shape that makes `spine.x = candidate.x` a
// plausible thing to write at all. `verdictEnvelopeMeta` does carry taskId /
// attemptIndex / verdictIndex / evaluator on the wire; they are renamed to
// `projected*` on ingest, so those names are absent here and the assignment
// does not compile.
//
// What it deliberately does NOT catch, because no type can: an assignment that
// copies a DIFFERENTLY-named candidate field over an authoritative one
// (`v.verdictCode = c.projectedVerdictIndex`). The behavioral test in
// `operator/test/discovery-client/task-lifecycle-evidence.test.ts` — spine
// fields byte-identical to their input rows after a contradictory candidate
// attaches — is what covers that half.
type Assert<T extends true> = T;

/**
 * Every authoritative column, minus the ones a candidate legitimately carries:
 * `requestId` + `chainId` ARE the candidate join key, and the three array
 * fields are spine containers, not columns. Derived rather than hand-listed so
 * a new authoritative column is protected the moment it is declared.
 */
type SpineIdentityColumn = Exclude<
  keyof AuthoritativeTaskRow | keyof AuthoritativeAttemptRow | keyof AuthoritativeVerdictRow,
  'requestId' | 'chainId' | 'verdicts' | 'attemptEnvelopeCandidates' | 'verdictEnvelopeCandidates'
>;

type CarriesNoSpineIdentity<C> =
  [Extract<keyof C, SpineIdentityColumn>] extends [never] ? true : false;

type _AttemptCandidateCarriesNoSpineIdentity =
  Assert<CarriesNoSpineIdentity<AttemptEnvelopeCandidate>>;
type _VerdictCandidateCarriesNoSpineIdentity =
  Assert<CarriesNoSpineIdentity<VerdictEnvelopeCandidate>>;
