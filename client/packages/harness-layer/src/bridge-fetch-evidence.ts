/**
 * The bridge's `fetchEvidence` adapter (spec/2026-07-06-distillation-v1.md §8, D5).
 *
 * Implements the VERIFIED verdict→solution join (pure HTTP, no RPC) that reaches
 * the SOLVER's coding patch — the reference implementation is `fetchEvidence` in
 * client/scripts/distill-run-live.ts:
 *
 *   verdict envelope (ref.verdictManifestCid)  → .task.cid
 *     → task doc (IPFS)  → .restorationRequestId          (the SOLVE request)
 *     → attemptEnvelopeMetas(requestId = restorationRequestId) → .manifestCid   (solution envelope)
 *     → solution envelope (IPFS)  → .payload.patch          (the coding diff)
 *   problem statement = task doc .description ?? .spec.problem_statement
 *
 * The predecessor joined `attemptEnvelopeMeta(requestId = verdict.requestId)`,
 * which returns empty on the real ledger (the on-chain verdict.requestId is not
 * the solve requestId). The link runs through the task doc's
 * `restorationRequestId` instead.
 *
 * Both I/O boundaries are injected ports (`ipfs`, `gql`) so this stays
 * unit-testable — the production caller passes an autonolas-gateway `ipfs(cid)`
 * and a Ponder `gql(query)` (see distill-run-live.ts); tests inject fakes. The
 * returned function is directly usable as `BridgeDeps.fetchEvidence`.
 */

import { type AttemptRef, type BridgeEvidence, repoFromInstanceId } from './bridge.js';

/** Cap the fetched patch / problem so one huge diff does not blow the prompt. */
const MAX_PATCH_CHARS = 6000;
const MAX_PROBLEM_CHARS = 1500;
/** Cap the compressed solver trace (§8, v0.5) so a long run does not blow the prompt. */
const MAX_TRACE_CHARS = 4000;

export interface EvidenceFetcherPorts {
  /** Fetch + JSON-parse an IPFS object by CID (autonolas gateway in production). */
  ipfs: (cid: string) => Promise<any>;
  /** Run a GraphQL query string against the Ponder indexer, returning `data`. */
  gql: (query: string) => Promise<any>;
}

/**
 * Resolve the solver's trajectory-doc CID off a solution envelope: prefer the
 * top-level `trajectory.sources[].cid`, else the first artifact's
 * `metadata.producedBy.trajectoryCid` (client/src/types/envelope.ts). Returns
 * `undefined` when neither is present.
 */
function trajectoryCidOf(solutionEnv: any): string | undefined {
  const top = solutionEnv?.trajectory?.sources?.[0]?.cid;
  if (typeof top === 'string' && top) return top;
  const arts = solutionEnv?.artifacts;
  if (Array.isArray(arts)) {
    for (const a of arts) {
      const cid = a?.metadata?.producedBy?.trajectoryCid;
      if (typeof cid === 'string' && cid) return cid;
    }
  }
  return undefined;
}

/**
 * Compress a `jinn.trajectory.v1` doc into a compact decision-path trace — one
 * line per span (`- <name> [<jinn.span.kind>]`), capped at `MAX_TRACE_CHARS`.
 * Hash-chain / signature plumbing is dropped; only the reasoning shape is kept.
 * Returns `undefined` when the doc carries no usable spans.
 */
function compressTrajectory(doc: any): string | undefined {
  const spans = doc?.spans;
  if (!Array.isArray(spans) || spans.length === 0) return undefined;
  const lines: string[] = [];
  for (const s of spans) {
    const name = typeof s?.name === 'string' ? s.name.trim() : '';
    if (!name) continue;
    const kind = typeof s?.attributes?.['jinn.span.kind'] === 'string' ? s.attributes['jinn.span.kind'] : 'span';
    lines.push(`- ${name} [${kind}]`);
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n').slice(0, MAX_TRACE_CHARS);
}

/**
 * Fetch + compress the solver's trajectory for one solution envelope (§8, v0.5).
 * Best-effort: ANY failure (no ref, unresolvable CID, malformed doc, fetch
 * error) degrades to `undefined` — the trajectory is enrichment, never a gate
 * on the evidence fetch. Absence is later recorded as a `patch-only` tag.
 */
async function fetchStepTrace(
  ipfs: (cid: string) => Promise<any>,
  solutionEnv: any,
): Promise<string | undefined> {
  try {
    const cid = trajectoryCidOf(solutionEnv);
    if (!cid) return undefined;
    const doc = await ipfs(cid);
    return compressTrajectory(doc);
  } catch {
    return undefined;
  }
}

/**
 * Build the bridge's `fetchEvidence`. Consumes injected `ipfs` / `gql` ports
 * (fakes in tests; a gateway + indexer in production). Throws a clear error at
 * each missing hop so a per-instance miss is diagnosable and skipped, not silent.
 */
export function createEvidenceFetcher(
  ports: EvidenceFetcherPorts,
): (ref: AttemptRef) => Promise<BridgeEvidence> {
  return async (ref: AttemptRef): Promise<BridgeEvidence> => {
    const verdictCid = ref.verdictManifestCid;
    if (!verdictCid) {
      throw new Error(`AttemptRef ${ref.instanceId} has no verdictManifestCid (join entry point)`);
    }

    // Hop 1: verdict envelope → task doc CID.
    const verdictEnv = await ports.ipfs(verdictCid);
    const taskCid = verdictEnv?.task?.cid;
    if (!taskCid || typeof taskCid !== 'string') {
      throw new Error(`no task.cid on verdict envelope ${verdictCid}`);
    }

    // Hop 2: task doc → the SOLVE request id.
    const taskDoc = await ports.ipfs(taskCid);
    const solveReq = taskDoc?.restorationRequestId;
    if (!solveReq || typeof solveReq !== 'string') {
      throw new Error(`no restorationRequestId in task doc ${taskCid}`);
    }

    // Hop 3a: attempt-meta for the solve request → the solution envelope CID.
    const query = `{ attemptEnvelopeMetas(where:{requestId:"${solveReq}"}){ items { manifestCid } } }`;
    const data = await ports.gql(query);
    const solutionCid = data?.attemptEnvelopeMetas?.items?.[0]?.manifestCid;
    if (!solutionCid || typeof solutionCid !== 'string') {
      throw new Error(`no attemptEnvelopeMeta for solve requestId ${solveReq.slice(0, 12)}…`);
    }

    // Hop 3b: solution envelope → the coding patch.
    const solutionEnv = await ports.ipfs(solutionCid);
    const patch = solutionEnv?.payload?.patch;
    if (!patch || typeof patch !== 'string') {
      throw new Error(`no payload.patch on solution envelope ${solutionCid}`);
    }

    // Hop 4 (best-effort, §8 v0.5): the solver's own trajectory off the SAME
    // solution envelope. Never throws — absence is recorded as `patch-only`.
    const stepTrace = await fetchStepTrace(ports.ipfs, solutionEnv);

    const problem = String(taskDoc?.description ?? taskDoc?.spec?.problem_statement ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROBLEM_CHARS);
    const repo = repoFromInstanceId(ref.instanceId) ?? undefined;
    return {
      taskSummary: problem || ref.instanceId,
      patch: patch.slice(0, MAX_PATCH_CHARS),
      ...(repo ? { repo } : {}),
      ...(stepTrace ? { stepTrace } : {}),
    };
  };
}
