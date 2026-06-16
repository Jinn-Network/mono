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
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JinnRepoSolutionPayloadSchema,
  type JinnRepoVerdictPayload,
} from '@jinn-network/sdk/solvernets/jinn-repo';
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

/** The two verdict values emitted by this evaluator. jinn-repo grades are
 *  binary: the gold tests either resolve or they don't (unscorable runs throw
 *  SkippableError and emit no verdict). Mirrors the swe-rebench-v2 pattern. */
type JinnRepoVerdict = 'PASS' | 'FAIL';

type GradeFn = (args: {
  task: JinnRepoPoolItem;
  solution: { patch: string };
}) => Promise<JinnRepoEvalResult>;

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
   */
  loadPool?: () => JinnRepoPoolItem[];
  /**
   * Grade-fn override (test injection). Defaults to a fresh
   * {@link JinnRepoEvaluator}'s `grade`.
   */
  grade?: GradeFn;
}

export class JinnRepoEvaluatorHarness implements Harness {
  readonly name = 'jinn-repo-evaluator';
  readonly version = '1.0.0';

  private readonly stub: boolean;
  private readonly implStateDir: string | undefined;
  private readonly loadPool: () => JinnRepoPoolItem[];
  private readonly grade: GradeFn;

  constructor(opts: JinnRepoEvaluatorHarnessOptions = {}) {
    this.stub = opts.stub ?? false;
    this.implStateDir = opts.implStateDir;
    this.loadPool = opts.loadPool ?? (() => loadJinnRepoPool());
    this.grade = opts.grade ?? ((args) => new JinnRepoEvaluator().grade(args));
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
}
