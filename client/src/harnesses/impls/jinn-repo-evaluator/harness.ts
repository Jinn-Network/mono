/**
 * jinn-repo Evaluator Harness — wraps the {@link JinnRepoEvaluator} grading
 * library as a first-class {@link Harness} so the daemon dispatches
 * `jinn-repo.v1` evaluation tasks to it.
 *
 * Mirrors {@link SweRebenchV2EvaluatorHarness} but needs no Docker: grading is
 * a repo-native git clone + `yarn install` + scoped test run (see
 * `./eval-runner.ts`). Readiness is therefore just "not a stub" — git + the
 * local pool are assumed present in any real daemon checkout.
 *
 * Two grading paths, keyed to the Task's `source` (issue #1891):
 *   - merged-pr: gold FAIL_TO_PASS grading against the PR's own test files
 *     (pool lookup, `./eval-runner.ts` — unchanged by #1891).
 *   - live-issue: no gold tests exist prospectively, so grading is Stage 1's
 *     thin mechanical evaluator (patch applies → typecheck → policy-scoped
 *     tests, `./live-eval-runner.ts`) reading the spec straight off the task
 *     — no pool lookup, since there is no gold to leak-protect.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4,
 * spec/2026-07-20-autopilot-marketplace-execution.md §"No new SolverType".
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JinnRepoSolutionPayloadSchema,
  type JinnRepoVerdictPayload,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  JinnRepoTaskSchema,
  isLiveIssueTask,
  type JinnRepoLiveIssueTask,
} from '../../../solver-types/jinn-repo.js';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { SignedEnvelopeSchema, normalizeEnvelopeRole } from '../../../types/envelope.js';
import {
  loadJinnRepoPool,
  type JinnRepoPoolItem,
} from '../../../solver-types/_jinn-repo-pool.js';
import { JinnRepoEvaluator } from './evaluator.js';
import type { JinnRepoEvalResult } from './eval-runner.js';
import { runJinnRepoLiveEval, type JinnRepoLiveEvalResult } from './live-eval-runner.js';

/** The two verdict values emitted by this evaluator. jinn-repo grades are
 *  binary: the gold tests either resolve or they don't (unscorable runs throw
 *  SkippableError and emit no verdict). Mirrors the swe-rebench-v2 pattern. */
type JinnRepoVerdict = 'PASS' | 'FAIL';

type GradeFn = (args: {
  task: JinnRepoPoolItem;
  solution: { patch: string };
}) => Promise<JinnRepoEvalResult>;

/** Live-issue grade-fn — no pool item; the full solver-visible spec IS the
 *  grading input (no gold to leak-protect). */
type LiveGradeFn = (args: {
  spec: JinnRepoLiveIssueTask;
  solution: { patch: string };
}) => Promise<JinnRepoLiveEvalResult>;

const DEFAULT_MONO_REPO_URL = 'https://github.com/Jinn-Network/mono.git';

export interface JinnRepoEvaluatorHarnessOptions {
  /** Marks a stub registry — `isReady()` reports requires-live-daemon. */
  stub?: boolean;
  /**
   * Per-impl state directory (e.g.
   * `~/.jinn-client/engine/impl-state/jinn-repo-evaluator`). Unused by the
   * grading path today (the evaluator clones into a throwaway temp dir), but
   * carried for parity with the swe-rebench harness and future caching.
   */
  implStateDir?: string;
  /**
   * Pool loader override (test injection). Defaults to {@link loadJinnRepoPool}.
   * Merged-pr grading only — live-issue grading never consults the pool.
   */
  loadPool?: () => JinnRepoPoolItem[];
  /**
   * Grade-fn override (test injection). Defaults to a fresh
   * {@link JinnRepoEvaluator}'s `grade`. Merged-pr grading only.
   */
  grade?: GradeFn;
  /**
   * Live-issue grade-fn override (test injection). Defaults to
   * {@link runJinnRepoLiveEval} resolved against `JINN_MONO_REPO_URL` (or the
   * public GitHub URL), mirroring {@link JinnRepoEvaluator}'s resolution order.
   */
  gradeLive?: LiveGradeFn;
}

export class JinnRepoEvaluatorHarness implements Harness {
  readonly name = 'jinn-repo-evaluator';
  readonly version = '1.0.0';

  private readonly stub: boolean;
  private readonly implStateDir: string | undefined;
  private readonly loadPool: () => JinnRepoPoolItem[];
  private readonly grade: GradeFn;
  private readonly gradeLive: LiveGradeFn;

  constructor(opts: JinnRepoEvaluatorHarnessOptions = {}) {
    this.stub = opts.stub ?? false;
    this.implStateDir = opts.implStateDir;
    this.loadPool = opts.loadPool ?? (() => loadJinnRepoPool());
    this.grade = opts.grade ?? ((args) => new JinnRepoEvaluator().grade(args));
    this.gradeLive =
      opts.gradeLive ??
      ((args) =>
        runJinnRepoLiveEval({
          spec: args.spec,
          patch: args.solution.patch,
          monoRepoUrl: process.env['JINN_MONO_REPO_URL'] ?? DEFAULT_MONO_REPO_URL,
        }));
  }

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'jinn-repo.v1' && ctx.role === 'evaluation';
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (task.solverType !== 'jinn-repo.v1') {
      return { ok: false, reason: 'solverType is not jinn-repo.v1' };
    }
    if (task.role !== 'evaluation') {
      return { ok: false, reason: 'role is not evaluation' };
    }
    // Both branches are gradeable (issue #1891): merged-pr against gold
    // FAIL_TO_PASS tests, live-issue against the mechanical evaluator
    // (applies/typecheck/tests). `run()` routes on the same parsed-spec
    // check used here.
    if (typeof task.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    // No Docker, no enable marker: the repo-native evaluator only needs git +
    // the bundled pool, both present in any real daemon. Always ready when live.
    return { ready: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.stub) {
      throw new Error(
        'jinn-repo-evaluator: stub registry cannot run evaluation (requires live daemon)',
      );
    }

    // Read instance_id from the evaluation task spec (the leak-controlled
    // solverView). The full pool item — including gold tests — is resolved
    // locally, never sent over the wire.
    const instanceId = (ctx.task.spec as Record<string, unknown> | undefined)?.['instance_id'];
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      throw new Error('jinn-repo-evaluator: task spec missing instance_id');
    }

    // Parse the solver's solution envelope and pull out the candidate patch.
    // Mirrors the swe-rebench harness: context.restorationResult is the signed
    // solution envelope JSON; assert solverType + solution role, then validate
    // the typed payload.
    const manifestJson = ctx.task.context!['restorationResult'] as string;
    const envelope = SignedEnvelopeSchema.parse(JSON.parse(manifestJson));
    if (
      envelope.solverType !== 'jinn-repo.v1' ||
      normalizeEnvelopeRole(envelope.role) !== 'solution'
    ) {
      throw new Error(
        `jinn-repo-evaluator: expected jinn-repo.v1/solution envelope, got ${envelope.solverType}/${envelope.role}`,
      );
    }
    const solutionPayload = JinnRepoSolutionPayloadSchema.parse(envelope.payload);

    // Route on `source`. A live-issue evaluation task's spec is the FULL
    // JinnRepoLiveIssueTask (nothing to leak-protect, so no separate
    // solverView()/pool-item split exists for it — unlike merged-pr). A
    // merged-pr evaluation task's spec is the leak-controlled solverView()
    // projection (see `_jinn-repo-pool.ts`), which omits required union
    // fields (e.g. `language`) and therefore never parses as either union
    // branch — that parse failure is itself the routing signal to the
    // (unchanged) merged-pr/gold path below. Mirrors the same check
    // `canAttempt` used before #1891 to reject live-issue tasks outright.
    const parsedSpec = JinnRepoTaskSchema.safeParse(ctx.task.spec);
    if (parsedSpec.success && isLiveIssueTask(parsedSpec.data)) {
      return this.runLive(ctx, parsedSpec.data, instanceId, solutionPayload.patch);
    }

    // Resolve the full pool item (gold tests + base commit) for this instance.
    // A missing instance must NOT silently pass — emit no verdict (SkippableError)
    // so the orchestrator records a skip rather than a bogus FAIL.
    const poolItem = this.loadPool().find((p) => p.instance_id === instanceId);
    if (!poolItem) {
      throw new SkippableError(
        'instance_not_in_pool',
        `jinn-repo-evaluator: ${instanceId} is not present in the local pool`,
      );
    }

    const result = await this.grade({ task: poolItem, solution: { patch: solutionPayload.patch } });

    // An unscorable run (clone/install/spawn failure, or a patch that did not
    // apply) carries no signal about the solver. Mirror swe-rebench's
    // EvalCouldNotGradeError → SkippableError: emit no verdict so the engine
    // records a skip. NEVER coerce unscorable → passed:false.
    if (result.unscorable || result.passed === null) {
      throw new SkippableError(
        'eval_unscorable',
        `jinn-repo-evaluator: could not grade ${instanceId}${result.logExcerpt ? `\n${result.logExcerpt}` : ''}`,
      );
    }

    const verdictPayload: JinnRepoVerdictPayload = {
      schemaVersion: 'jinn-repo-verdict.v1',
      passed: result.passed === true,
      test_log_excerpt: result.logExcerpt,
    };
    await writeFile(
      join(ctx.workingDir, 'jinn-repo-verdict.json'),
      `${JSON.stringify(verdictPayload, null, 2)}\n`,
      'utf8',
    );

    // Derive the engine-facing `verdict` from `passed`. The engine's
    // reputation-feedback hook (and `verdictCodeForTask`) keys on
    // `gating.verdict` — mirror the swe-rebench harness (jinn-mono-uy6v.10).
    const verdict: JinnRepoVerdict = verdictPayload.passed ? 'PASS' : 'FAIL';

    return {
      venueRef: { name: 'jinn-repo' },
      gating: {
        passed: verdictPayload.passed,
        verdict,
      },
      informational: {
        instance_id: instanceId,
      },
      verdictPayload: verdictPayload as unknown as Record<string, unknown>,
      artifacts: [
        {
          path: 'jinn-repo-verdict.json',
          artifactType: 'jinn_repo_verdict',
          metadata: {
            passed: verdictPayload.passed,
          },
          access: { priceUsdc: '0' },
        },
      ],
    };
  }

  /**
   * Live-issue grading path (issue #1891): no gold, so no pool lookup — the
   * mechanical evaluator (`./live-eval-runner.ts`) grades three AND-gated
   * checks (applies/typecheck/tests) straight off the task's own spec.
   */
  private async runLive(
    ctx: HarnessContext,
    spec: JinnRepoLiveIssueTask,
    instanceId: string,
    patch: string,
  ): Promise<Solution> {
    const result = await this.gradeLive({ spec, solution: { patch } });

    // Same unscorable convention as the merged-pr path: infra failure
    // (clone/install/spawn) carries no signal about the solver — emit no
    // verdict so the engine records a skip. NEVER coerce unscorable → FAIL.
    if (result.unscorable) {
      throw new SkippableError(
        'eval_unscorable',
        `jinn-repo-evaluator: could not grade ${instanceId}${result.logExcerpt ? `\n${result.logExcerpt}` : ''}`,
      );
    }

    const verdictPayload: JinnRepoVerdictPayload = {
      schemaVersion: 'jinn-repo-verdict.v2',
      passed: result.passed,
      test_log_excerpt: result.logExcerpt,
      gates: {
        applies: result.applies,
        typecheck: result.typecheck,
        tests: result.tests,
      },
    };
    await writeFile(
      join(ctx.workingDir, 'jinn-repo-verdict.json'),
      `${JSON.stringify(verdictPayload, null, 2)}\n`,
      'utf8',
    );

    const verdict: JinnRepoVerdict = verdictPayload.passed ? 'PASS' : 'FAIL';

    return {
      venueRef: { name: 'jinn-repo' },
      gating: {
        passed: verdictPayload.passed,
        verdict,
      },
      informational: {
        instance_id: instanceId,
      },
      verdictPayload: verdictPayload as unknown as Record<string, unknown>,
      artifacts: [
        {
          path: 'jinn-repo-verdict.json',
          artifactType: 'jinn_repo_verdict',
          metadata: {
            passed: verdictPayload.passed,
          },
          access: { priceUsdc: '0' },
        },
      ],
    };
  }
}
