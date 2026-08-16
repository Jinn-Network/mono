/**
 * Shared, dependency-free parsers for evaluation (verdict) envelope enrichment.
 *
 * Extracted out of `handlers.ts` (#779) so BOTH the in-handler enrichment path
 * (`handleMetadataSet`'s evaluation branch) AND the standalone enrichment worker
 * (`packages/indexer-enrichment/`) import ONE definition of each parser and the
 * swe-rebench-v2 task-body resolver — they cannot drift. The IPFS *fetch* stays
 * at the call sites (`fetchIpfsJson` from `./ipfs.js`); only the *parsing* of
 * the already-fetched body lives here.
 *
 * Behaviour here is byte-for-byte identical to the code that previously lived in
 * `handlers.ts` — this is a behaviour-preserving extraction, not a change.
 */

/** Defensive string read: non-string → ''. Shared by every parser here and the
 * other lite parsers that stay in `handlers.ts` (which import it back). */
export function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeInt(v: unknown, def = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === 'bigint') return Number(v);
  return def;
}

function normalizeVerdict(
  raw: unknown,
): 'PASS' | 'FAIL' | 'INVALID' | 'INDETERMINATE' | 'UNKNOWN' {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const v = raw.trim().toUpperCase();
  if (v === 'PASS' || v === 'SCORED' || v === 'OK') return 'PASS';
  if (v === 'FAIL' || v === 'REJECTED' || v === 'FAILED') return 'FAIL';
  if (v === 'INVALID') return 'INVALID';
  if (v === 'INDETERMINATE' || v === 'UNRESOLVED' || v === 'UNKNOWN') return 'INDETERMINATE';
  return 'UNKNOWN';
}

// ── Verdict envelope lite parser ──────────────────────────────────────────────
// For evaluation envelopes (role='verdict' or kind='evaluation'). Reads the
// ACTUAL evaluator outcome — the on-chain VerdictDeliveryClaimed.verdictCode
// defaults to Pass(1) for failed evaluations (daemon bug), so the off-chain
// envelope is the source of truth.
//
// SWE-rebench v2: payload.{passed_match,score}. Other solverTypes: payload.verdict.
// Returns null if body isn't a recognisable jinn.execution.v1 verdict envelope.

export interface VerdictEnvelopeLite {
  requestId: string;
  verdictIndex: number;
  attemptIndex: number;
  taskId: string;
  /** IPFS CID of the task body (envelope.task.cid). Used by the swe-rebench-v2
   *  enrichment branch to fetch spec.instance_id (#669). Empty when absent. */
  taskCid: string;
  evaluator: string;
  solverType: string;
  evidenceTier: string;
  actualPassed: boolean;
  actualScore: string;
  passedCount: number;
  totalCount: number;
  evaluatorVerdict: 'PASS' | 'FAIL' | 'INVALID' | 'INDETERMINATE' | 'UNKNOWN';
}

export function parseVerdictEnvelopeLite(body: unknown): VerdictEnvelopeLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // role must be 'verdict' for an evaluation envelope (execution envelopes are role='restoration').
  // We're permissive: also accept envelopes that lack role but have task.requestId + a parseable payload.
  // task.requestId is the join key — required.
  const task = b['task'];
  if (task === null || typeof task !== 'object') return null;
  const taskObj = task as Record<string, unknown>;
  const requestId = safeStr(taskObj['requestId']);
  if (!requestId) return null;

  const attemptIndex = safeInt(taskObj['attemptIndex'], 0);
  const taskId = safeStr(taskObj['taskId']) || String(taskObj['taskId'] ?? '');
  // Capture the task body CID so the swe-rebench-v2 enrichment branch can
  // resolve spec.instance_id via a follow-up IPFS fetch (#669). Optional;
  // empty when the envelope omits it.
  const taskCid = safeStr(taskObj['cid']);
  // verdictIndex may be at the top level or under task. It is diagnostic only
  // for older envelopes that omit it; requestId is the stable verdict join key.
  const verdictIndex = safeInt(b['verdictIndex'] ?? taskObj['verdictIndex'], 0);

  const solverType = safeStr(b['solverType']);
  const evidenceTier = safeStr(b['evidenceTier']);

  // participant.safeAddress → evaluator
  let evaluator = '0x';
  const participant = b['participant'];
  if (participant !== null && typeof participant === 'object') {
    const p = participant as Record<string, unknown>;
    const s = safeStr(p['safeAddress']);
    if (s) evaluator = s;
  }

  // Payload — read the verdict.
  const payload = b['payload'];
  const payloadObj: Record<string, unknown> =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  let actualPassed = false;
  let actualScore = '';
  let passedCount = 0;
  let totalCount = 0;
  let evaluatorVerdict: VerdictEnvelopeLite['evaluatorVerdict'] = 'UNKNOWN';

  // SWE-rebench v2 (solverType prefix): payload.passed_match + payload.score.
  if (solverType.startsWith('swe-rebench-v2')) {
    const passedRaw =
      payloadObj['passed_match'] ?? payloadObj['passedMatch'] ?? payloadObj['passed'];
    if (typeof passedRaw === 'boolean') {
      actualPassed = passedRaw;
    } else if (typeof passedRaw === 'string') {
      actualPassed = passedRaw.toLowerCase() === 'true' || passedRaw === '1';
    }
    const scoreRaw = payloadObj['score'];
    if (typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)) {
      actualScore = scoreRaw.toString();
    } else if (typeof scoreRaw === 'string') {
      actualScore = scoreRaw;
    }
    const pc = payloadObj['passedCount'] ?? payloadObj['passed_count'];
    const tc = payloadObj['totalCount'] ?? payloadObj['total_count'];
    passedCount = Math.max(0, safeInt(pc, 0));
    totalCount = Math.max(0, safeInt(tc, 0));
    evaluatorVerdict = actualPassed ? 'PASS' : 'FAIL';
  } else {
    // Generic: payload.verdict (uppercase normalize).
    const norm = normalizeVerdict(payloadObj['verdict']);
    evaluatorVerdict = norm;
    actualPassed = norm === 'PASS';
  }

  return {
    requestId,
    verdictIndex,
    attemptIndex,
    taskId,
    taskCid,
    evaluator,
    solverType,
    evidenceTier,
    actualPassed,
    actualScore,
    passedCount,
    totalCount,
    evaluatorVerdict,
  };
}

// ── swe-rebench-v2 task-body resolver ─────────────────────────────────────────
// Given an already-fetched task.v1 body (operator/src/types/task-document.ts),
// resolve the enrichment fields the indexer reads off the task body:
//   - spec.instance_id                — launcher getInstanceSuccessCounts (#669)
//   - top-level solverNetManifestCid  — manifest-scoped success counts (#669)
//   - top-level restorationRequestId  — the SOLVE-request id, persisted so the
//                                       (task, solution, verdict) tuple joins
//                                       first-class (#1433)
// All default to '' when absent/non-string. Pure — the IPFS fetch is the
// caller's job (handler + worker), so this function cannot drift between them.

export interface InstanceFields {
  instanceId: string;
  solverNetManifestCid: string;
  /**
   * The SOLVE-request id — the task body's top-level `restorationRequestId`
   * (task.v1 schema; see operator/src/types/task.ts). Equals the solution
   * attempt's `attemptEnvelopeMeta.requestId`, so persisting it makes
   * `verdictEnvelopeMeta.solutionRequestId = attemptEnvelopeMeta.requestId`
   * a single GraphQL join (#1433).
   */
  solutionRequestId: string;
}

export function resolveInstanceFields(taskBody: unknown): InstanceFields {
  let instanceId = '';
  let solverNetManifestCid = '';
  let solutionRequestId = '';
  if (taskBody && typeof taskBody === 'object') {
    const spec = (taskBody as Record<string, unknown>)['spec'];
    if (spec && typeof spec === 'object') {
      const raw = (spec as Record<string, unknown>)['instance_id'];
      if (typeof raw === 'string' && raw.length > 0) instanceId = raw;
    }
    const cidRaw = (taskBody as Record<string, unknown>)['solverNetManifestCid'];
    if (typeof cidRaw === 'string' && cidRaw.length > 0) {
      solverNetManifestCid = cidRaw;
    }
    const solveRaw = (taskBody as Record<string, unknown>)['restorationRequestId'];
    if (typeof solveRaw === 'string' && solveRaw.length > 0) {
      solutionRequestId = solveRaw;
    }
  }
  return { instanceId, solverNetManifestCid, solutionRequestId };
}
