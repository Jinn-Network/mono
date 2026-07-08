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
 *   step trace (hop 4, best-effort, #1472) = the solution's system_snapshot
 *     artifact → donation unwrap → gunzip+untar → the harness stdout
 *     transcript → outline (snapshot-transcript.ts + transcript-outline.ts)
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
import { extractSnapshotTranscript } from './snapshot-transcript.js';
import { outlineTranscript } from './transcript-outline.js';

/** Cap the fetched patch / problem so one huge diff does not blow the prompt. */
const MAX_PATCH_CHARS = 6000;
const MAX_PROBLEM_CHARS = 1500;
/** Cap the compressed solver trace (§8, #1472) so a long run does not blow the prompt. */
const MAX_TRACE_CHARS = 4000;

export interface EvidenceFetcherPorts {
  /** Fetch + JSON-parse an IPFS object by CID (autonolas gateway in production). */
  ipfs: (cid: string) => Promise<any>;
  /** Run a GraphQL query string against the Ponder indexer, returning `data`. */
  gql: (query: string) => Promise<any>;
}

/**
 * Fetch + outline the solver's reasoning for one solution envelope (§8, #1472).
 *
 * The decision path does NOT live in `jinn.trajectory.v1` (that carries only
 * the packaging step's 2 `jinn.artifact.emit` spans — #1473 tracks making it
 * truthful at solve time). It lives in the `system_snapshot` artifact: a
 * donation-wrapped gzipped tar of the solve working dir containing the
 * harness's raw stdout transcript. Resolve that artifact, unwrap (sha256-
 * verified), decompress (bomb-guarded), locate the transcript, and outline it
 * for the distiller.
 *
 * Best-effort: ANY failure (no snapshot, unresolvable CID, sha mismatch,
 * corrupt bytes, no transcript — e.g. hermes) degrades to `undefined` — the
 * trace is enrichment, never a gate on the evidence fetch. Absence is later
 * recorded as a `patch-only` tag.
 */
async function fetchStepTrace(
  ipfs: (cid: string) => Promise<any>,
  solutionEnv: any,
): Promise<string | undefined> {
  try {
    const arts = solutionEnv?.artifacts;
    if (!Array.isArray(arts)) return undefined;
    const snap = arts.find((a) => a?.artifactType === 'system_snapshot');
    const cid = snap?.sources?.[0]?.cid;
    const sha256 = typeof snap?.sha256 === 'string' ? snap.sha256 : snap?.sources?.[0]?.sha256;
    if (typeof cid !== 'string' || !cid || typeof sha256 !== 'string' || !sha256) return undefined;
    const wrapper = await ipfs(cid); // the donation wrapper is itself JSON
    const transcript = extractSnapshotTranscript(wrapper, sha256);
    if (!transcript) return undefined;
    const outline = outlineTranscript(transcript.harness, transcript.jsonl);
    return outline?.slice(0, MAX_TRACE_CHARS);
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
