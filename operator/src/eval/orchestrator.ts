/**
 * `jinn eval` held-out checkpoint orchestrator (issue #818).
 *
 * Runs a held-out slate against a checkpoint in FROZEN mode, persists per-task
 * pass/fail, and emits a Wilson-CI resolved-rate comparison vs the parent
 * checkpoint. Every external boundary is constructor-injected — this is the
 * thin slice #819 drives a deterministic slate against with NO Docker/IPFS.
 *
 * Acceptance criteria:
 *   AC#1 — run the slate frozen, write per-task pass/fail.
 *   AC#2 — emit a resolved-rate comparison vs the parent with a CI.
 *   AC#3 — the freeze-fence holds: a `runHarnessOnce` `{ violation }` throws
 *          LOUD and the instance is NOT recorded (no implStateDir mutation
 *          slips through; enforcement lives in `runHarnessWithFreezeFence`).
 *
 * Per log/decisions/2026-05-28-rl-eval-measurement.md §4: v1-simple. Only large
 * deltas are trustworthy (disjoint Wilson intervals). No seed control, no
 * multi-run averaging.
 */

import type { Harness, HarnessContext } from '../harnesses/types.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import type { LoadedHeldOutSlate } from '../solver-types/_swe-rebench-v2-held-out-slate.js';
import type { ResolvedSlateTask } from './resolve-slate-tasks.js';
import type { EvalAggregate, EvalResultRecord } from '../store/store.js';
import { compareRates, type RateComparison } from './wilson.js';
import { comparePaired, type PairedComparison, type PairedInput } from './paired.js';

/** Thrown when `runHarnessOnce` reports a freeze-fence violation (AC#3). */
export class FreezeFenceViolationError extends Error {
  constructor(public readonly instanceId: string) {
    super(
      `freeze-fence violation on instance ${instanceId}: the harness mutated implStateDir ` +
        `during a frozen-mode eval run — refusing to record a tainted result`,
    );
    this.name = 'FreezeFenceViolationError';
  }
}

/**
 * Thrown when the locally-evaluated impl-state's codeDigest does not match the
 * named checkpoint's manifest (C1). Guards against persisting + comparing
 * results under a checkpoint name while the operator's local impl-state has
 * drifted from that checkpoint.
 */
export class CheckpointStateMismatchError extends Error {
  constructor(
    public readonly checkpointCid: string,
    public readonly manifestCodeDigest: string,
    public readonly evaluatedCodeDigest: string,
  ) {
    super(
      `local impl-state does not match checkpoint ${checkpointCid}: ` +
        `manifest codeDigest=${manifestCodeDigest} but the evaluated impl-state hashes to ` +
        `${evaluatedCodeDigest}. Check out the impl-state for this checkpoint or pass the ` +
        `correct --impl-state-dir; refusing to record results under a codeDigest that is a lie`,
    );
    this.name = 'CheckpointStateMismatchError';
  }
}

/** Thrown when the parent checkpoint has no aggregate for this slate version (AC#2). */
export class ParentNotEvaluatedError extends Error {
  constructor(public readonly parentCheckpointCid: string, public readonly slateVersion: string) {
    super(
      `parent checkpoint ${parentCheckpointCid} has no eval results for slate ${slateVersion} — ` +
        `eval the parent checkpoint first (scores are only comparable within a slate version)`,
    );
    this.name = 'ParentNotEvaluatedError';
  }
}

/** A checkpoint whose recorded results carry slate hashes other than the current one. */
export interface SlateHashDrift {
  checkpointCid: string;
  /** The drifted hashes (each != the current slate hash). */
  hashes: string[];
}

/**
 * Thrown when EITHER compared checkpoint was scored on a DIFFERENT slate
 * *content* under the same version label (DR-2026-05-28 §2 — confounder control).
 * A slate is content-addressed and scores are comparable ONLY within identical
 * content; the store keys aggregates by version, so a content edit that skipped
 * the version bump (or re-derived the declared hash — which the slate loader
 * admits passes), or stale rows surviving `recordEvalResult`'s by-instance
 * upsert, would let the comparison silently compare two checkpoints scored on
 * different task sets. That is confounder #1 (task-selection) — exactly what the
 * held-out exam exists to defeat — so we refuse the comparison loudly instead.
 */
export class SlateHashMismatchError extends Error {
  constructor(
    public readonly slateVersion: string,
    public readonly currentSlateHash: string,
    public readonly drifted: ReadonlyArray<SlateHashDrift>,
  ) {
    const detail = drifted
      .map((d) => `${d.checkpointCid} carries [${d.hashes.join(', ')}]`)
      .join('; ');
    super(
      `a checkpoint was evaluated against a different slate content under the same version label ` +
        `${slateVersion}: current slate hash is ${currentSlateHash} but ${detail}. Same version must ` +
        `mean the same exam — a slate content change is a measurement discontinuity that must bump the ` +
        `version. Bump the slate version and re-evaluate; refusing to report a delta across two ` +
        `different task sets (confounder #1, task-selection)`,
    );
    this.name = 'SlateHashMismatchError';
  }
}

/**
 * Injected `runHarnessOnce`-shaped boundary. Mirrors the production
 * `runHarnessOnce` (freeze-fence + mode propagation) but also surfaces the
 * harness `solution` so the orchestrator can extract the patch to grade. On a
 * freeze violation it returns `{ violation }` and no solution.
 */
export type RunHarnessOnceForEval = (params: {
  harness: Harness;
  implStateDir: string;
  mode: 'train' | 'frozen';
  task?: HarnessContext['task'];
}) => Promise<{
  envelope?: { executor: { mode: 'train' | 'frozen'; codeDigest: string } };
  violation?: { taskId: string };
  solution?: { patch: string };
}>;

/**
 * The grade verdict the orchestrator consumes. It reads exactly two fields:
 * `passed_match` (→ per-task pass/fail) and `test_log` (→ recorded excerpt).
 * This is the swe-rebench-v2 verdict surface; the repo-native JinnRepoEvaluator
 * is projected onto it by the adapter in eval.ts. Anything unscorable is
 * signalled by THROWING (the orchestrator's catch records `unscorable`) — never
 * by a verdict flag — so both backends agree on the unscorable contract.
 */
export interface EvalGradeVerdict {
  passed_match: boolean;
  test_log: string;
}

/**
 * Minimal structural evaluator the orchestrator depends on. `SweRebenchV2Evaluator`
 * satisfies it directly (its verdict is a superset of `EvalGradeVerdict`); the
 * jinn-repo path supplies an adapter in eval.ts that wraps `JinnRepoEvaluator`,
 * translating the call and projecting its `{ passed, unscorable, logExcerpt }`
 * result onto this verdict (throwing on unscorable). `task`/`solutionPayload`/`row`
 * are the swe-rebench-v2 grade call; the orchestrator passes them verbatim and
 * the backend adapter interprets them.
 */
export interface SolutionEvaluator {
  grade(args: {
    task: { instance_id: string };
    solutionPayload: { schemaVersion: string; patch: string };
    row?: unknown;
  }): Promise<EvalGradeVerdict>;
}

export interface EvalOrchestratorDeps {
  harness: Harness;
  fetchImplStateDirToLocal(implStateDirCid: string, targetDir: string): Promise<string>;
  evaluator: SolutionEvaluator;
  runHarnessOnce: RunHarnessOnceForEval;
  store: {
    recordEvalResult(args: EvalResultRecord): void;
    getEvalAggregate(checkpointCid: string, slateVersion: string): EvalAggregate;
    /** Distinct slate_hash values the parent's results were recorded under (drift guard). */
    getEvalSlateHashes(checkpointCid: string, slateVersion: string): string[];
    /**
     * Optional: per-instance results for a (checkpoint, slate version). When
     * present, the orchestrator also emits the paired (matched-design) McNemar
     * verdict (DR-2026-06-02-b §2a) — the same slate is scored before & after, so
     * the matched test is the statistically correct one and is far more powerful
     * than the marginal disjoint-interval test. Reported ALONGSIDE `comparison`,
     * never replacing it (the exam is strengthened, not weakened).
     */
    getEvalResults?(checkpointCid: string, slateVersion: string): PairedInput[];
  };
}

export interface PerTaskResult {
  instance_id: string;
  /** null when unscorable. */
  passed: boolean | null;
  unscorable: boolean;
}

/**
 * Provenance of the graded artifact (Legibility). The CLI grades the operator's
 * LOCAL frozen impl-state — verified == the named checkpoint via the C1
 * codeDigest guard (CheckpointStateMismatchError) — NOT a state re-fetched from
 * the checkpoint CID. Surfacing this stops a reader from assuming the tool
 * fetched and graded the published checkpoint's state.
 */
export interface EvalProvenance {
  /** Local impl-state directory that was actually run. */
  implStateDir: string;
  /** Real codeDigest of the evaluated impl-state (verified == manifest.codeDigest). */
  codeDigest: string;
  /** Always true on a returned result — a mismatch throws CheckpointStateMismatchError. */
  matchedCheckpoint: true;
}

export interface EvalRunResult {
  perTask: PerTaskResult[];
  comparison: RateComparison;
  /**
   * Paired (matched-design) McNemar verdict vs the parent — present only when
   * the store exposes `getEvalResults`. The marginal `comparison` above is
   * conservative; this is the statistically correct test for the same-slate
   * before/after design and is reported alongside it (DR-2026-06-02-b §2a).
   */
  paired?: PairedComparison;
  /** What was actually graded (local impl-state), not the checkpoint identity. */
  evaluated: EvalProvenance;
}

/**
 * One slate instance normalised for the backend-agnostic run/grade loop. The
 * BACKEND (eval.ts) owns construction of both `harnessTask` (the LEAK-CONTROLLED
 * view the solver sees — for jinn-repo this is `solverView(item)`, never the
 * pool item) and `gradeTask`/`row` (what the evaluator needs — for jinn-repo the
 * full pool item incl. gold tests). The swe-rebench-v2 path derives these from
 * `tasksWithRows` via the default mapping below, unchanged.
 */
export interface EvalSlateInstance {
  instance_id: string;
  /** Task handed to the solver harness — already leak-controlled by the backend. */
  harnessTask: NonNullable<HarnessContext['task']>;
  /** Backend-specific grade payload; passed verbatim as the evaluator's `task`. */
  gradeTask: { instance_id: string };
  /** Solution payload `schemaVersion` the evaluator expects. */
  solutionSchemaVersion: string;
  /** swe-rebench-v2 HF row reused at grade time; absent for repo-native. */
  row?: unknown;
}

/**
 * Default swe-rebench-v2 instance mapping — preserves the exact harness `task`
 * envelope and grade call the orchestrator used before the backend seam existed.
 */
function sweRebenchSlateInstance(rt: ResolvedSlateTask): EvalSlateInstance {
  return {
    instance_id: rt.task.instance_id,
    // Carry the full SweRebenchV2Task in `spec` + the `solverType` dispatch key
    // so the harness can restore the repo (clone/checkout from
    // spec.repo/base_commit). id/description/role alone are insufficient.
    harnessTask: {
      id: rt.task.instance_id,
      description: rt.task.problem_statement,
      role: 'restoration',
      solverType: 'swe-rebench-v2.v1',
      spec: rt.task as unknown as Record<string, unknown>,
      window: { startTs: 0, endTs: Date.now() + 3_600_000 },
    },
    gradeTask: rt.task,
    solutionSchemaVersion: 'swe-rebench-v2-solution.v1',
    row: rt.row,
  };
}

export async function runEval(args: {
  checkpointManifest: HarnessCheckpointManifest;
  checkpointCid: string;
  slate: LoadedHeldOutSlate;
  /**
   * swe-rebench-v2 slate tasks (the historical input). When given, each is
   * normalised via the default swe-rebench mapping. Mutually informative with
   * `slateInstances`: a backend that builds its own leak-controlled instances
   * (jinn-repo) passes `slateInstances` directly instead.
   */
  tasksWithRows?: ResolvedSlateTask[];
  /** Pre-built, backend-normalised instances (jinn-repo path). Overrides `tasksWithRows`. */
  slateInstances?: EvalSlateInstance[];
  parentCheckpointCid: string;
  deps: EvalOrchestratorDeps;
  /** Working dir for the fetched impl-state-dir (defaults to a checkpoint-scoped tmp path). */
  implStateDir?: string;
}): Promise<EvalRunResult> {
  const { deps, slate, checkpointCid, parentCheckpointCid } = args;
  const slateInstances: EvalSlateInstance[] =
    args.slateInstances ?? (args.tasksWithRows ?? []).map(sweRebenchSlateInstance);

  // Confounder guard (DR-2026-05-28 §2). The store keys aggregates by slate
  // VERSION; if EITHER checkpoint has results recorded under a different slate
  // CONTENT for that version — a content edit that skipped the version bump, or
  // stale rows surviving recordEvalResult's by-instance upsert — comparing
  // child-vs-parent reintroduces confounder #1 (task-selection: two scores over
  // different task sets). Both arms' hashes are known up front, so detect drift
  // in EITHER before the loop and refuse — never burn N× real spend producing a
  // number we'd have to throw away.
  const drifted = [parentCheckpointCid, checkpointCid]
    .map((cid) => ({
      checkpointCid: cid,
      hashes: deps.store.getEvalSlateHashes(cid, slate.version).filter((hash) => hash !== slate.hash),
    }))
    .filter((arm) => arm.hashes.length > 0);
  if (drifted.length > 0) {
    throw new SlateHashMismatchError(slate.version, slate.hash, drifted);
  }

  // Hoist the impl-state-dir fetch outside the loop: every slate instance runs
  // against the SAME checkpoint state.
  const implStateDir = args.implStateDir ?? `/tmp/jinn-eval-${checkpointCid}`;
  const localImplStateDir = await deps.fetchImplStateDirToLocal(
    args.checkpointManifest.implStateDirCid,
    implStateDir,
  );

  const perTask: PerTaskResult[] = [];
  const runAtMs = Date.now();
  let digestChecked = false;
  // Real digest of the evaluated impl-state (from the freeze-fence), captured on
  // the first run for provenance. Falls back to the manifest digest, which the
  // C1 guard proves equal.
  let evaluatedDigest = args.checkpointManifest.codeDigest;

  for (const inst of slateInstances) {
    const task = inst.gradeTask;
    let passed: boolean | null;
    let unscorable = false;
    let logExcerpt = '';
    try {
      const run = await deps.runHarnessOnce({
        harness: deps.harness,
        implStateDir: localImplStateDir,
        mode: 'frozen',
        // The harness task is built by the BACKEND (eval.ts) and is already
        // leak-controlled (jinn-repo hands the solver `solverView(item)` only —
        // no gold tests / reference solution). swe-rebench-v2 carries the full
        // task in `spec` so the harness can restore the repo.
        task: inst.harnessTask,
      });

      // AC#3: a freeze violation is loud and terminal — do NOT record this
      // instance (its implStateDir mutation taints the run). Thrown OUTSIDE the
      // unscorable catch below so it propagates and aborts the whole eval.
      if (run.violation) {
        throw new FreezeFenceViolationError(inst.instance_id);
      }
      if (!run.solution) {
        throw new Error(`harness produced no solution for instance ${inst.instance_id}`);
      }

      // C1: on the FIRST successful run, verify the real digest of the evaluated
      // impl-state (computed by the freeze-fence) matches the named checkpoint's
      // manifest. Fail fast — before grading any instance — to avoid Docker spend
      // and to never persist a result under a codeDigest that is a lie.
      if (!digestChecked) {
        digestChecked = true;
        const runDigest = run.envelope?.executor.codeDigest;
        if (runDigest && runDigest !== args.checkpointManifest.codeDigest) {
          throw new CheckpointStateMismatchError(
            checkpointCid,
            args.checkpointManifest.codeDigest,
            runDigest,
          );
        }
        if (runDigest) evaluatedDigest = runDigest;
      }

      const verdict = await deps.evaluator.grade({
        task,
        solutionPayload: { schemaVersion: inst.solutionSchemaVersion, patch: run.solution.patch },
        ...(inst.row !== undefined ? { row: inst.row } : {}),
      });
      passed = verdict.passed_match;
      logExcerpt = verdict.test_log.slice(0, 1000);
    } catch (err) {
      // A freeze-fence violation taints the run and must stay a LOUD terminal
      // abort (AC#3). Likewise the C1 digest mismatch — never record results
      // under a codeDigest that is a lie. Both re-throw and abort the eval.
      if (err instanceof FreezeFenceViolationError || err instanceof CheckpointStateMismatchError) {
        throw err;
      }
      // Everything else is unscorable: excluded from the denominator, NEVER
      // coerced to a fail (#476). This covers both grade-side failures
      // (EvalCouldNotGradeError / InsufficientDiskError) and harness-run
      // failures (Defect A — harvest missing-artifact, "produced no patch",
      // clone/timeout, etc.); a harness/infra failure to produce a gradeable
      // solution is environment-side, not an agent capability fail. The slate
      // continues to the next instance.
      passed = null;
      unscorable = true;
      logExcerpt = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    }

    deps.store.recordEvalResult({
      checkpoint_cid: checkpointCid,
      slate_hash: slate.hash,
      slate_version: slate.version,
      instance_id: inst.instance_id,
      passed,
      unscorable,
      code_digest: args.checkpointManifest.codeDigest,
      run_at_ms: runAtMs,
      test_log_excerpt: logExcerpt,
    });

    perTask.push({ instance_id: inst.instance_id, passed, unscorable });
  }

  // AC#2: compare child vs parent at the SAME slate version. A parent with no
  // rows is a hard error — no cross-version compare, eval the parent first.
  const parentAgg = deps.store.getEvalAggregate(parentCheckpointCid, slate.version);
  if (parentAgg.scorable === 0 && parentAgg.unscorable === 0) {
    throw new ParentNotEvaluatedError(parentCheckpointCid, slate.version);
  }
  const childAgg = deps.store.getEvalAggregate(checkpointCid, slate.version);

  const comparison = compareRates(
    { passed: childAgg.passed, scorable: childAgg.scorable },
    { passed: parentAgg.passed, scorable: parentAgg.scorable },
  );

  // Paired (matched-design) verdict — same slate scored before & after, so the
  // matched McNemar test is the correct, higher-power one. Additive: only when
  // the store exposes per-instance results (DR-2026-06-02-b §2a).
  let paired: PairedComparison | undefined;
  if (deps.store.getEvalResults) {
    const parentResults = deps.store.getEvalResults(parentCheckpointCid, slate.version);
    const childResults = deps.store.getEvalResults(checkpointCid, slate.version);
    paired = comparePaired(parentResults, childResults);
  }

  return {
    perTask,
    comparison,
    ...(paired ? { paired } : {}),
    evaluated: { implStateDir: localImplStateDir, codeDigest: evaluatedDigest, matchedCheckpoint: true },
  };
}
