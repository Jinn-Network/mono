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

import { type AttemptRef, type BridgeEvidence } from './bridge.js';
import { extractSnapshotTranscript } from './snapshot-transcript.js';
import { outlineTranscript } from './transcript-outline.js';

/** Cap the fetched patch / problem so one huge diff does not blow the prompt. */
const MAX_PATCH_CHARS = 6000;
const MAX_PROBLEM_CHARS = 1500;
/** Cap the compressed solver trace (§8, #1472) so a long run does not blow the prompt. */
const MAX_TRACE_CHARS = 4000;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string =>
    typeof item === 'string' && item.length > 0);
  return strings.length === value.length ? strings : undefined;
}

function generatorModel(value: unknown): BridgeEvidence['generatorModel'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = nonEmptyString(raw['id']);
  const source = raw['source'];
  if (!id || (source !== 'stream' && source !== 'config')) return undefined;
  const provider = nonEmptyString(raw['provider']);
  const openWeights = typeof raw['openWeights'] === 'boolean'
    ? raw['openWeights']
    : undefined;
  return {
    id,
    source,
    ...(provider ? { provider } : {}),
    ...(openWeights !== undefined ? { openWeights } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactSweTaskType(taskDoc: unknown): boolean {
  const outer = record(taskDoc);
  const task = record(outer?.['signedTask']) ?? outer;
  return task?.['solverType'] === 'swe-rebench-v2.v1';
}

export interface AuthenticatedTaskProvenance {
  solverType: string;
  instanceId: string;
  repo: string;
  baseCommit: string;
  createdAt: number;
}

export interface VerifierFacts {
  failToPass: string[];
  passToPass: string[];
  evalSemanticsVersion: string;
  task: AuthenticatedTaskProvenance;
}

export type VerifierFactsResolver = (
  taskDoc: unknown,
  expectedInstanceId: string,
) => Promise<VerifierFacts>;

function validateVerifierFacts(value: unknown, instanceId: string): VerifierFacts {
  const facts = record(value);
  if (!facts) {
    throw new Error(`authenticated verifier facts for ${instanceId} must be an object`);
  }
  const failToPass = stringArray(facts['failToPass']);
  const passToPass = stringArray(facts['passToPass']);
  const evalSemanticsVersion = nonEmptyString(facts['evalSemanticsVersion']);
  if (!failToPass || !passToPass || !evalSemanticsVersion) {
    throw new Error(
      `authenticated verifier facts for ${instanceId} require exact failToPass, passToPass, and evalSemanticsVersion`,
    );
  }
  const rawTask = record(facts['task']);
  const solverType = rawTask?.['solverType'];
  const authenticatedInstanceId = nonEmptyString(rawTask?.['instanceId']);
  const repo = nonEmptyString(rawTask?.['repo']);
  const baseCommit = nonEmptyString(rawTask?.['baseCommit']);
  const createdAt = rawTask?.['createdAt'];
  if (
    solverType !== 'swe-rebench-v2.v1'
    || !authenticatedInstanceId
    || !repo
    || !baseCommit
    || !Number.isInteger(createdAt)
    || (createdAt as number) < 0
  ) {
    throw new Error(
      `authenticated verifier facts for ${instanceId} require an exact task provenance tuple`,
    );
  }
  return {
    failToPass,
    passToPass,
    evalSemanticsVersion,
    task: {
      solverType,
      instanceId: authenticatedInstanceId,
      repo,
      baseCommit,
      createdAt: createdAt as number,
    },
  };
}

function assertMatchingTaskProvenance(
  sourceName: string,
  value: unknown,
  authenticated: AuthenticatedTaskProvenance,
): void {
  const source = record(value);
  if (!source) return;
  for (const field of [
    'solverType',
    'instanceId',
    'repo',
    'baseCommit',
  ] as const) {
    const candidate = source[field];
    if (candidate !== undefined && candidate !== authenticated[field]) {
      throw new Error(
        `authenticated task provenance mismatch at ${sourceName}.${field}: `
        + `expected ${JSON.stringify(authenticated[field])}, got ${JSON.stringify(candidate)}`,
      );
    }
  }
}

export interface EvidenceFetcherPorts {
  /**
   * Fetch + JSON-parse an IPFS object by CID (autonolas gateway in production).
   * Callers that authenticate smaller artifacts may request a tighter ceiling.
   */
  ipfs: (cid: string, maxBytes?: number) => Promise<any>;
  /** Run a GraphQL query string against the Ponder indexer, returning `data`. */
  gql: (query: string) => Promise<any>;
  /** Resolve one atomic, authenticated verifier proof for an identified SWE task. */
  resolveVerifierFacts?: VerifierFactsResolver;
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

    const outerTaskDocument = record(taskDoc) ?? {};
    const signedTaskDocument =
      record(outerTaskDocument['signedTask']) ?? outerTaskDocument;
    const signedTaskSpec = record(signedTaskDocument['spec']) ?? {};
    const problem = String(
      signedTaskDocument['description']
      ?? signedTaskSpec['problem_statement']
      ?? '',
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROBLEM_CHARS);
    let verifier: VerifierFacts | undefined;
    if (ports.resolveVerifierFacts) {
      if (!hasExactSweTaskType(taskDoc)) {
        throw new Error(
          `verifier resolution for ${ref.instanceId} requires an exact swe-rebench-v2.v1 task type`,
        );
      }
      verifier = validateVerifierFacts(
        await ports.resolveVerifierFacts(taskDoc, ref.instanceId),
        ref.instanceId,
      );
    } else if (hasExactSweTaskType(taskDoc)) {
      throw new Error(
        `identified SWE task ${ref.instanceId} requires authenticated verifier facts`,
      );
    }

    if (verifier) {
      // Execution-envelope task.createdAt is the on-chain TaskCreated block
      // timestamp (epoch seconds), while the authenticated tuple carries the
      // signed TaskV1 creation time (epoch milliseconds). They are distinct
      // events, so envelope createdAt is deliberately ignored rather than
      // compared or allowed to override the authenticated signed-task value.
      assertMatchingTaskProvenance('attemptRef', ref, verifier.task);
      assertMatchingTaskProvenance('verdictEnvelope', verdictEnv, verifier.task);
      assertMatchingTaskProvenance('verdictEnvelope.task', verdictEnv?.task, verifier.task);
      assertMatchingTaskProvenance('solutionEnvelope', solutionEnv, verifier.task);
      assertMatchingTaskProvenance('solutionEnvelope.task', solutionEnv?.task, verifier.task);
    }

    const model = generatorModel(solutionEnv?.executor?.generatorModel);
    const distributionClass =
      solutionEnv?.distributionClass === 'open'
      || solutionEnv?.distributionClass === 'restricted-tos'
      || solutionEnv?.distributionClass === 'unknown'
        ? solutionEnv.distributionClass
        : undefined;
    return {
      taskSummary: problem || ref.instanceId,
      patch: patch.slice(0, MAX_PATCH_CHARS),
      ...(verifier
        ? {
            repo: verifier.task.repo,
            baseCommit: verifier.task.baseCommit,
            taskCreatedAt: verifier.task.createdAt,
            instanceId: verifier.task.instanceId,
          }
        : {}),
      ...(model ? { generatorModel: model } : {}),
      ...(distributionClass ? { distributionClass } : {}),
      ...(verifier
        ? {
            verifier: {
              failToPass: verifier.failToPass,
              passToPass: verifier.passToPass,
              evalSemanticsVersion: verifier.evalSemanticsVersion,
            },
          }
        : {}),
      ...(stepTrace ? { stepTrace } : {}),
    };
  };
}
