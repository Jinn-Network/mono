/**
 * Neutral task-run row + state types (#1584).
 *
 * `PersistedTaskRun` is the canonical persisted-row shape read by both the
 * engine persistence layer and the API read path. It lives here — in the
 * neutral `types/` layer — so the API can type-import it without depending on
 * `harnesses/engine/persistence`. `harnesses/engine/persistence.ts` re-exports
 * it for back-compat. `TaskRunState` is re-exported from
 * `harnesses/engine/state.ts` (its canonical const+type home) for one-stop
 * neutral access.
 */
import type { Task } from './task.js';

export type { TaskRunState } from '../harnesses/engine/state.js';
import type { TaskRunState } from '../harnesses/engine/state.js';

export interface PersistedTaskRun {
  requestId: string;
  taskId: string | null;
  attemptIndex: number | null;
  taskCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  /**
   * Unix-seconds timestamp of the on-chain creation block (#1827). Resolved
   * once at claim() time via `publicClient.getBlock`; null when the RPC
   * lookup failed or hasn't run yet — never backfilled with a guess.
   * Threaded into `envelope.task.createdAt` by pack().
   */
  onchainCreationTimestamp: number | null;
  solverType: string | null;
  /** SolverNet manifest CID this task was posted under; null for legacy rows. */
  solverNetManifestCid: string | null;
  taskRole: 'restoration' | 'evaluation' | null;
  implName: string | null;

  state: TaskRunState;
  stateUpdatedAt: number;

  workingDir: string | null;
  implStateDir: string | null;

  windowStartTs: number;
  windowEndTs: number;
  /** Unix ms timestamp captured when this operator successfully claimed the run. */
  runStartedAt: number | null;

  preSnapshotCapturedAt: number | null;
  preSnapshotPayload: unknown | null;    // deserialized JSON
  postSnapshotCapturedAt: number | null;
  postSnapshotPayload: unknown | null;   // deserialized JSON
  fillsPayload: unknown[] | null;        // deserialized JSON
  gatingClaim: Record<string, unknown> | null;
  informationalClaim: Record<string, unknown> | null;

  artifactCids: Record<string, string> | null;  // { path: cid }
  manifestCid: string | null;
  deliveryTxHash: string | null;

  /** Persisted once at first PACKAGING entry; reused on retry for manifest CID determinism. */
  manifestGeneratedAt: number | null;
  /** keccak256 of signed manifest canonical JSON; used by deliver() as evidenceHash. */
  evidenceHash: string | null;

  /** Full Task payload as recorded at observe() time; null for pre-migration rows. */
  task: Task | null;

  /**
   * Serialised Solution from runImpl, persisted before the
   * RUNNING → PACKAGING transition. Used by pack() to recover solution outputs
   * after a crash so the manifest CID remains deterministic. Null for
   * pre-migration rows and tasks that have already been packed.
   * Added by WT-C for PACKAGING recovery fidelity.
   */
  solutionOutputsJson: string | null;
  /**
   * JSON array of prior failed unified diffs retained when runImpl overwrites
   * solution_outputs_json with a different patch (#1643 / spec §10 field 4).
   * Null when none retained (first success, or pre-migration rows).
   */
  intermediateFailureDiffsJson: string | null;
  runtimePluginsJson: string | null;

  /**
   * JSON array of corpus knowledge refs injected into
   * task.context.corpusKnowledge for this run (#1393). Null when the
   * autoload was disabled, found nothing, or the run predates the column.
   */
  consumedRefsJson: string | null;

  /**
   * Executor mode declared on this run ('train' | 'frozen').
   * Captured by `pack()` from the freeze-fence's HarnessExecutionMode and
   * read by `deliver()` to emit a payload v2 setMetadata. Null for legacy
   * rows that completed before payload v2 wiring (deliver() defaults to v1).
   */
  executorMode: 'train' | 'frozen' | null;
  /**
   * Executor codeDigest (`sha256:<hex>` form) declared on this run.
   * Captured by `pack()` from the freeze-fence and read by `deliver()` for
   * payload v2 setMetadata. Null for legacy rows; deliver() defaults to v1.
   */
  executorCodeDigest: string | null;

  failureReason: string | null;
  failureAt: number | null;
}
