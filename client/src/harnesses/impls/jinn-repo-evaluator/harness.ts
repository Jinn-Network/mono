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
  AutopilotEvaluationContextSchema,
  JinnRepoAutopilotSessionTaskSchema,
  JinnRepoLegacySolutionPayloadSchema,
  bindAutopilotMutationDeliveryResult,
  type AutopilotMutationResult,
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
import {
  runAutopilotSemanticReview,
  type AutopilotMechanicalRunner,
  type SemanticAgentRunner,
  type SemanticAgentRunnerResolver,
  type SemanticRuntimeReadiness,
} from './autopilot-semantic.js';
import { ExactHeadMechanicalRunner } from './autopilot-mechanical-runner.js';
import type {
  ImmutableMechanicalVerifier,
} from './autopilot-mechanical-runner.js';
import {
  admitAutopilotEvaluationOpportunity,
} from './autopilot-evaluation-context.js';
import {
  AUTOPILOT_EVALUATION_CONTEXT_KEY,
  resolveSolutionEnvelopeCid,
} from '../evaluation-context.js';

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
const AUTOPILOT_READINESS_CACHE_MS = 30_000;

interface AutopilotReadinessCache {
  checkedAt?: number;
  status?: SemanticRuntimeReadiness;
  inFlight?: Promise<SemanticRuntimeReadiness>;
}

/**
 * The raw `source` field straight off an unparsed task spec — issue #1891
 * Finding 2's primary discriminator. Deliberately does NOT go through
 * `JinnRepoTaskSchema`: a full-schema parse can fail for two entirely
 * different reasons that must be routed differently —
 *   1. a merged-pr evaluation task's spec is the leak-controlled
 *      solverView() projection (see `_jinn-repo-pool.ts`), which omits
 *      required union fields and so never parses (raw `source` is absent, or
 *      `'merged-pr'`) — the existing pool-lookup path, unchanged.
 *   2. a live-issue spec with a field defect (missing `issue_number`, a
 *      malformed `base_commit`, etc.) also fails the full parse, but its raw
 *      `source` is unambiguously `'live-issue'` — that must be a loud,
 *      specific error, never a silent fall-through to #1's pool-lookup path
 *      (where it would surface a misleading `instance_not_in_pool` and be
 *      re-attempted forever).
 * Reading the raw field first makes the two cases distinguishable before any
 * validation happens.
 */
function rawTaskSpecSource(spec: Record<string, unknown> | undefined): unknown {
  return spec?.['source'];
}

/**
 * Short, single-line summary of a ZodError for error messages / rejection
 * reasons. Structurally typed (not zod's ZodError) so it accepts errors from
 * both zod majors — `JinnRepoTaskSchema` is authored in the SDK against
 * zod/v3, while this package's own `zod` is v4.
 */
function summarizeZodError(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
}): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

function parseAutopilotEvaluationTask(task: Task):
  | {
      ok: true;
      context: ReturnType<typeof AutopilotEvaluationContextSchema.parse>;
    }
  | {
      ok: false;
      reason: string;
    } {
  const parsedTask = JinnRepoAutopilotSessionTaskSchema.safeParse(task.spec);
  if (!parsedTask.success) {
    return {
      ok: false,
      reason: `malformed Autopilot source Task: ${summarizeZodError(parsedTask.error)}`,
    };
  }
  const parsedContext = AutopilotEvaluationContextSchema.safeParse(
    task.context?.[AUTOPILOT_EVALUATION_CONTEXT_KEY],
  );
  if (!parsedContext.success) {
    return {
      ok: false,
      reason: `context.${AUTOPILOT_EVALUATION_CONTEXT_KEY} must be an accepted strict evaluation context`,
    };
  }
  const resultJson = task.context?.['restorationResult'];
  if (typeof resultJson !== 'string') {
    return { ok: false, reason: 'context.restorationResult required' };
  }

  let envelope: ReturnType<typeof SignedEnvelopeSchema.parse>;
  try {
    envelope = SignedEnvelopeSchema.parse(JSON.parse(resultJson));
  } catch (error) {
    return {
      ok: false,
      reason: `malformed Autopilot Solution envelope: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    envelope.solverType !== 'jinn-repo.v1'
    || normalizeEnvelopeRole(envelope.role) !== 'solution'
  ) {
    return {
      ok: false,
      reason: `expected jinn-repo.v1/solution envelope, got ${envelope.solverType}/${envelope.role}`,
    };
  }
  const solutionEnvelopeCid = resolveSolutionEnvelopeCid(task);
  if (!solutionEnvelopeCid) {
    return {
      ok: false,
      reason: 'context.solutionEnvelopeCid required for Autopilot evaluation',
    };
  }
  let parsedSolution: AutopilotMutationResult;
  try {
    parsedSolution = bindAutopilotMutationDeliveryResult(
      envelope.payload,
      solutionEnvelopeCid,
    );
  } catch (error) {
    return {
      ok: false,
      reason: `malformed Autopilot mutation result: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const admission = admitAutopilotEvaluationOpportunity({
    task: parsedTask.data,
    solution: parsedSolution,
    taskId: parsedContext.data.correlation.taskId,
    attemptIndex: task.attemptNumber ?? -1,
    requestId: task.restorationRequestId ?? '',
    solutionEnvelopeCid,
    solutionOperatorSafe: envelope.participant.safeAddress,
    evaluatorOperatorSafe: parsedContext.data.operators.evaluatorSafe,
    observation: {
      state: 'accepted',
      context: parsedContext.data,
    },
  });
  if (admission.kind !== 'accepted') {
    return { ok: false, reason: admission.reason };
  }
  return { ok: true, context: admission.context };
}

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
  /** Deterministic exact-head checks, injectable for hermetic tests. */
  mechanicalRunner?: AutopilotMechanicalRunner;
  /** Isolated deterministic verifier used by the default exact-head runner. */
  immutableMechanicalVerifier?: ImmutableMechanicalVerifier;
  /** Per-SolverNet semantic runtime resolver, injectable for hermetic tests. */
  semanticAgentRunnerResolver?: SemanticAgentRunnerResolver;
}

export class JinnRepoEvaluatorHarness implements Harness {
  readonly name = 'jinn-repo-evaluator';
  readonly version = '1.0.0';

  private readonly stub: boolean;
  private readonly implStateDir: string | undefined;
  private readonly loadPool: () => JinnRepoPoolItem[];
  private readonly grade: GradeFn;
  private readonly gradeLive: LiveGradeFn;
  private readonly mechanicalRunner: AutopilotMechanicalRunner;
  private readonly immutableMechanicalVerifier: ImmutableMechanicalVerifier | undefined;
  private readonly semanticAgentRunnerResolver: SemanticAgentRunnerResolver | undefined;
  private readonly verifierReadinessCache: AutopilotReadinessCache = {};
  private readonly semanticReadinessCache =
    new WeakMap<SemanticAgentRunner, AutopilotReadinessCache>();

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
    this.immutableMechanicalVerifier = opts.immutableMechanicalVerifier;
    this.mechanicalRunner =
      opts.mechanicalRunner
      ?? new ExactHeadMechanicalRunner({
        monoRepoUrl: process.env['JINN_MONO_REPO_URL'] ?? DEFAULT_MONO_REPO_URL,
        immutableVerifier: opts.immutableMechanicalVerifier,
      });
    this.semanticAgentRunnerResolver = opts.semanticAgentRunnerResolver;
  }

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'jinn-repo.v1' && ctx.role === 'evaluation';
  }

  private async cachedReadiness(
    cache: AutopilotReadinessCache,
    probe: () => Promise<SemanticRuntimeReadiness>,
  ): Promise<SemanticRuntimeReadiness> {
    if (
      cache.status
      && cache.checkedAt !== undefined
      && Date.now() - cache.checkedAt < AUTOPILOT_READINESS_CACHE_MS
    ) {
      return cache.status;
    }
    if (cache.inFlight) return await cache.inFlight;

    const inFlight = probe();
    cache.inFlight = inFlight;
    try {
      const status = await inFlight;
      cache.status = status;
      cache.checkedAt = Date.now();
      return status;
    } finally {
      if (cache.inFlight === inFlight) cache.inFlight = undefined;
    }
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (task.solverType !== 'jinn-repo.v1') {
      return { ok: false, reason: 'solverType is not jinn-repo.v1' };
    }
    if (task.role !== 'evaluation') {
      return { ok: false, reason: 'role is not evaluation' };
    }
    if (rawTaskSpecSource(task.spec) === 'autopilot-session') {
      const parsed = parseAutopilotEvaluationTask(task);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      if (!this.semanticAgentRunnerResolver) {
        return {
          ok: false,
          reason: 'Autopilot semantic evaluator runtime is not configured',
        };
      }
      const semanticRuntime = await this.semanticAgentRunnerResolver.resolve({
        ...(task.solverNetManifestCid
          ? { manifestCid: task.solverNetManifestCid }
          : {}),
      });
      if (!semanticRuntime) {
        return {
          ok: false,
          reason:
            'Autopilot semantic evaluator runtime is not configured for SolverNet '
            + (task.solverNetManifestCid ?? '<unknown>'),
        };
      }
      const verifierReadiness = this.immutableMechanicalVerifier?.isReady
        ? await this.cachedReadiness(
            this.verifierReadinessCache,
            () => this.immutableMechanicalVerifier!.isReady!(),
          )
        : undefined;
      if (verifierReadiness && !verifierReadiness.ready) {
        return {
          ok: false,
          reason:
            verifierReadiness.reason
            ?? 'Autopilot immutable mechanical verifier is unavailable',
        };
      }
      let semanticReadiness: SemanticRuntimeReadiness | undefined;
      if (semanticRuntime.runner.isReady) {
        let cache = this.semanticReadinessCache.get(semanticRuntime.runner);
        if (!cache) {
          cache = {};
          this.semanticReadinessCache.set(semanticRuntime.runner, cache);
        }
        semanticReadiness = await this.cachedReadiness(
          cache,
          () => semanticRuntime.runner.isReady!(),
        );
      }
      if (semanticReadiness && !semanticReadiness.ready) {
        return {
          ok: false,
          reason:
            semanticReadiness.reason
            ?? 'Autopilot semantic evaluator runtime is unavailable',
        };
      }
      return { ok: true };
    }
    // A live-issue spec with a field defect (missing `issue_number`, a
    // malformed `base_commit`, etc.) is rejected here with a specific reason
    // — issue #1891 Finding 2 — rather than accepted blind and left to throw
    // deep inside `run()` on every daemon re-attempt.
    if (rawTaskSpecSource(task.spec) === 'live-issue') {
      const parsedSpec = JinnRepoTaskSchema.safeParse(task.spec);
      if (!parsedSpec.success) {
        return {
          ok: false,
          reason: `malformed live-issue task spec: ${summarizeZodError(parsedSpec.error)}`,
        };
      }
    }
    // Both branches are gradeable (issue #1891): merged-pr against gold
    // FAIL_TO_PASS tests, live-issue against the mechanical evaluator
    // (applies/typecheck/tests). `run()` routes on the raw `source` field
    // (same primary-discriminator check as above), never on parse-success
    // alone.
    if (typeof task.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    // Docker and semantic runtimes are Autopilot-only prerequisites. Probing
    // them here would disable legacy merged-pr/live-issue evaluations through
    // the harness-wide readiness gate. canAttempt() probes and caches them only
    // for an admitted Autopilot evaluation Task.
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
    // Route on the RAW `source` field, not full-parse success (issue #1891
    // Finding 2). A merged-pr evaluation task's spec is the leak-controlled
    // solverView() projection (see `_jinn-repo-pool.ts`), which has no raw
    // `source` field at all (legacy) or `source: 'merged-pr'` — either way it
    // falls through to the (unchanged) pool-lookup path below. A live-issue
    // evaluation task's spec is the FULL JinnRepoLiveIssueTask (nothing to
    // leak-protect, so no separate solverView()/pool-item split exists for
    // it). Discriminating on the RAW field first — before the full schema
    // parse — means a live-issue spec with a field defect (missing
    // `issue_number`, a malformed `base_commit`, etc.) is recognized as a
    // live-issue task that failed validation and throws a loud, specific
    // error here, rather than silently falling through to the pool-lookup
    // path below (where it would surface a misleading `instance_not_in_pool`
    // SkippableError and be re-attempted forever).
    const rawSource = rawTaskSpecSource(ctx.task.spec);
    if (rawSource === 'autopilot-session') {
      const parsed = parseAutopilotEvaluationTask(ctx.task);
      if (!parsed.ok) {
        throw new SkippableError(
          'autopilot_eval_pending',
          `jinn-repo-evaluator: ${parsed.reason}`,
        );
      }
      const semanticAgentRunnerResolver = this.semanticAgentRunnerResolver;
      if (!semanticAgentRunnerResolver) {
        throw new SkippableError(
          'autopilot_eval_pending',
          'jinn-repo-evaluator: Autopilot semantic evaluator runtime is not configured',
        );
      }
      const semanticRuntime = await semanticAgentRunnerResolver.resolve({
        ...(ctx.task.solverNetManifestCid
          ? { manifestCid: ctx.task.solverNetManifestCid }
          : {}),
        ...(ctx.solverNet ? { solverNet: ctx.solverNet } : {}),
      });
      if (!semanticRuntime) {
        const solverNetIdentity =
          ctx.solverNet?.name
          ?? ctx.task.solverNetManifestCid
          ?? '<unknown>';
        throw new SkippableError(
          'autopilot_eval_pending',
          `jinn-repo-evaluator: semantic evaluator runtime is not configured for SolverNet ${solverNetIdentity}`,
        );
      }
      const result = await runAutopilotSemanticReview({
        context: parsed.context,
        mechanicalRunner: this.mechanicalRunner,
        agentRunner: semanticRuntime.runner,
        ...(semanticRuntime.model ? { model: semanticRuntime.model } : {}),
        abort: ctx.abort,
      });
      const artifactPath = 'jinn-autopilot-review-result.json';
      await writeFile(
        join(ctx.workingDir, artifactPath),
        `${JSON.stringify(result.review, null, 2)}\n`,
        'utf8',
      );
      return {
        venueRef: { name: 'jinn-repo' },
        gating: result.gating,
        informational: {
          instance_id: instanceId,
          reviewTarget: parsed.context.reviewTarget,
          correlation: parsed.context.correlation,
          mechanical: result.mechanical,
          semanticRuntime: {
            provider: semanticRuntime.provider,
            ...(semanticRuntime.model ? { model: semanticRuntime.model } : {}),
          },
        },
        verdictPayload: result.review as unknown as Record<string, unknown>,
        artifacts: [{
          path: artifactPath,
          artifactType: 'jinn_autopilot_review_result',
          metadata: {
            outcome: result.review.outcome,
            reviewedHead: parsed.context.correlation.reviewedHead,
          },
          access: { priceUsdc: '0' },
        }],
      };
    }

    const solutionPayload = JinnRepoLegacySolutionPayloadSchema.parse(
      envelope.payload,
    );
    if (rawSource === 'live-issue') {
      const parsedSpec = JinnRepoTaskSchema.safeParse(ctx.task.spec);
      if (!parsedSpec.success || !isLiveIssueTask(parsedSpec.data)) {
        const detail = parsedSpec.success
          ? 'parsed as a non-live-issue task despite source: live-issue (unexpected)'
          : summarizeZodError(parsedSpec.error);
        throw new Error(`jinn-repo-evaluator: malformed live-issue task spec: ${detail}`);
      }
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
